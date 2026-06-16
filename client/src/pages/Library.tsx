import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import {
  Plus, Upload, Download, Play, Pencil, Trash2,
  Inbox, FolderOpen, BarChart2, X, Loader,
  CheckCircle2, ChevronLeft, ExternalLink, Clock, Search, Settings,
  Folder, FolderOpen as FolderOpenIcon, ChevronRight, ChevronDown, ChevronUp, Image, BookOpen,
} from "lucide-react";
import * as api from "../lib/api";
import { relativeTime } from "../lib/utils";
import { ProjectSettingsModal } from "./Settings";

export default function Library() {
  const { projectId } = useParams<{ projectId: string }>();
  return <LibraryContent projectId={projectId!} />;
}

export function LibraryContent({ projectId, embedded = false }: { projectId: string; embedded?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [activeModuleId,  setActiveModuleId]  = useState<string | null>(null);
  const [showScenarioModal, setShowScenarioModal] = useState(false);
  const [editingScenario,   setEditingScenario]   = useState<api.Scenario | null>(null);
  const [initialTab,        setInitialTab]        = useState<"edit" | "run">("edit");
  const [defaultGroupId,    setDefaultGroupId]    = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ created: number; createdNames: string[]; errors: { row: number; error: string }[] } | null>(null);

  // Project settings modal
  const [showProjectSettings, setShowProjectSettings] = useState(false);

  // Group run state
  const [runningGroupId, setRunningGroupId] = useState<string | null>(null);
  const [groupRunResults, setGroupRunResults] = useState<GroupRunState | null>(null);

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "passed" | "failed" | "never">("all");
  const [flowFilter, setFlowFilter] = useState<"all" | "positif" | "negatif">("all");

  const { data: projects = [] } = useQuery<api.Project[]>({
    queryKey: ["projects"],
    queryFn: api.getProjects,
  });

  const activeProject = projects.find((p: api.Project) => p.id === projectId);
  const effectiveProjectId = activeProject?.id ?? "";
  const modules = activeProject?.modules ?? [];
  const activeModule = modules.find((m: api.Module) => m.id === activeModuleId);
  const scenarios = activeModule?.scenarios ?? [];

  // Batch fetch history for filtering
  const historyQueries = useQueries({
    queries: scenarios.map(s => ({
      queryKey: ["history", s.id],
      queryFn: () => api.getScenarioHistory(s.id),
      staleTime: 30_000,
    })),
  });
  const historyMap = useMemo(() => {
    const m = new Map<string, api.RunRecord[] | undefined>();
    scenarios.forEach((s, i) => m.set(s.id, historyQueries[i]?.data));
    return m;
  }, [scenarios, historyQueries]);

  const filteredScenarios = useMemo(() => {
    return scenarios.filter(s => {
      // Text search
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!(s.name.toLowerCase().includes(q) || s.scenarioRefId?.toLowerCase().includes(q) || (s.caseNumber != null && String(s.caseNumber).padStart(3,"0").includes(q)))) return false;
      }
      // Flow filter
      if (flowFilter !== "all") {
        const flow = s.tags.find(t => t === "positif" || t === "negatif");
        if (flow !== flowFilter) return false;
      }
      // Status filter
      if (statusFilter !== "all") {
        const last = historyMap.get(s.id)?.[0];
        if (statusFilter === "never" && last) return false;
        if (statusFilter === "passed" && (!last || !last.passed)) return false;
        if (statusFilter === "failed" && (!last || last.passed)) return false;
      }
      return true;
    });
  }, [scenarios, searchQuery, flowFilter, statusFilter, historyMap]);

  // ── Groups ─────────────────────────────────────────────────────────────────
  const { data: groups = [] } = useQuery<api.ScenarioGroup[]>({
    queryKey: ["groups", activeModuleId],
    queryFn: () => api.getGroups(activeModuleId!),
    enabled: !!activeModuleId,
  });
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null | "root">(null);

  const invalidateGroups = useCallback(() => qc.invalidateQueries({ queryKey: ["groups", activeModuleId] }), [qc, activeModuleId]);

  const createGroupMut = useMutation({
    mutationFn: ({ name, parentId }: { name: string; parentId?: string }) =>
      api.createGroup(activeModuleId!, { name, parentId }),
    onSuccess: (g) => {
      invalidateGroups();
      setExpandedGroups(prev => { const s = new Set(prev); if (g.parentId) s.add(g.parentId); return s; });
    },
  });
  const updateGroupMut = useMutation({
    mutationFn: ({ id, name, sortOrder }: { id: string; name?: string; sortOrder?: number }) => api.updateGroup(id, { name, sortOrder }),
    onSuccess: invalidateGroups,
  });
  const deleteGroupMut = useMutation({
    mutationFn: api.deleteGroup,
    onSuccess: invalidateGroups,
  });
  const moveGroupMut = useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) => api.moveGroup(id, parentId),
    onSuccess: invalidateGroups,
    onError: (err: Error) => alert(err.message),
  });
  const moveScenarioMut = useMutation({
    mutationFn: ({ id, groupId }: { id: string; groupId: string | null }) => api.moveScenario(id, groupId),
    onSuccess: () => { invalidate(); },
  });

  // Swap sortOrder with a sibling group
  const reorderGroup = useCallback((groupId: string, direction: -1 | 1) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    const siblings = groups
      .filter(g => (g.parentId ?? null) === (group.parentId ?? null))
      .sort((a, b) => a.sortOrder - b.sortOrder || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const idx = siblings.findIndex(g => g.id === groupId);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;
    const a = siblings[idx], b = siblings[swapIdx];
    // Normalize if sortOrders collide
    const aOrder = a.sortOrder === b.sortOrder ? (direction === -1 ? b.sortOrder - 1 : b.sortOrder + 1) : b.sortOrder;
    const bOrder = a.sortOrder === b.sortOrder ? a.sortOrder : a.sortOrder;
    updateGroupMut.mutate({ id: a.id, sortOrder: aOrder });
    updateGroupMut.mutate({ id: b.id, sortOrder: bOrder });
  }, [groups, updateGroupMut]);

  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: ["projects"] }), [qc]);

  // ── Module management ───────────────────────────────────────────────────────
  const [showModuleForm, setShowModuleForm] = useState(false);
  const [newModuleName,  setNewModuleName]  = useState("");

  const createModuleMut = useMutation({
    mutationFn: () => api.createModule({ projectId: effectiveProjectId, name: newModuleName.trim() }),
    onSuccess: (mod) => {
      setNewModuleName(""); setShowModuleForm(false);
      setActiveModuleId(mod.id); invalidate();
    },
  });

  const deleteModuleMut = useMutation({
    mutationFn: api.deleteModule,
    onSuccess: () => { setActiveModuleId(null); invalidate(); },
  });

  const [renamingModuleId, setRenamingModuleId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const updateModuleMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateModule(id, { name }),
    onSuccess: () => { setRenamingModuleId(null); invalidate(); },
  });

  function startRename(e: React.MouseEvent, m: api.Module) {
    e.stopPropagation();
    setRenamingModuleId(m.id);
    setRenameValue(m.name);
    setTimeout(() => renameInputRef.current?.select(), 0);
  }

  function commitRename(id: string) {
    const name = renameValue.trim();
    if (name && name !== modules.find((m: api.Module) => m.id === id)?.name) {
      updateModuleMut.mutate({ id, name });
    } else {
      setRenamingModuleId(null);
    }
  }

  // ── Scenario management ─────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  async function handleSaveScenario(data: Omit<api.Scenario, "id" | "createdAt" | "updatedAt">): Promise<api.Scenario | false> {
    setSaving(true);
    try {
      const result = editingScenario
        ? await api.updateScenario(editingScenario.id, data)
        : await api.createScenario(data);
      invalidate();
      return result;
    } catch {
      return false;
    } finally { setSaving(false); }
  }

  const deleteScenarioMut = useMutation({
    mutationFn: api.deleteScenario,
    onSuccess: invalidate,
  });

  // ── Import ──────────────────────────────────────────────────────────────────
  async function handleRunGroup(groupId: string) {
    setRunningGroupId(groupId);
    setGroupRunResults(null);
    try {
      const res = await api.runGroup(groupId, {});
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(part.replace(/^data:\s*/, ""));
            if (ev.type === "group-start") {
              setGroupRunResults({ groupId: ev.groupId, groupName: ev.groupName, total: ev.total, completed: 0, results: [], running: true, logs: [] });
            } else if (ev.type === "scenario-start") {
              setGroupRunResults(prev => prev ? { ...prev, currentScenarioName: ev.name } : prev);
            } else if (ev.type === "scenario-result") {
              setGroupRunResults(prev => prev ? { ...prev, completed: prev.completed + 1, results: [...prev.results, ev], currentScenarioName: undefined } : prev);
              qc.invalidateQueries({ queryKey: ["history", ev.scenarioId] });
            } else if (ev.type === "group-complete") {
              setGroupRunResults(prev => prev ? { ...prev, running: false } : prev);
              setRunningGroupId(null);
              invalidate();
            } else if (ev.type === "log") {
              setGroupRunResults(prev => {
                if (!prev) return prev;
                return { ...prev, logs: [...prev.logs, ev.message].slice(-50) };
              });
            } else if (ev.type === "error") {
              setGroupRunResults(prev => prev ? { ...prev, running: false } : prev);
              setRunningGroupId(null);
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setRunningGroupId(null);
    }
  }

  async function handleImport(files: FileList | File[]) {
    const arr = Array.from(files);
    const opts = effectiveProjectId
      ? { module: activeModule?.name ?? modules[0]?.name ?? "Katalon Import", projectId: effectiveProjectId }
      : undefined;
    const result = await api.importScenarios(arr, opts);
    setImportResult(result);
    if (result.created > 0) invalidate();
  }

  return (
    <div className={embedded ? "flex flex-col flex-1 min-h-0" : "flex flex-col h-screen"}>
      {/* Topbar — only in standalone mode */}
      {!embedded && (
        <header className="sticky top-0 z-10 bg-gray-950/80 backdrop-blur border-b border-gray-800 px-6 h-13 flex items-center justify-between shrink-0 gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => navigate("/")}
              className="flex items-center gap-1.5 text-gray-500 hover:text-gray-200 transition text-xs"
            >
              <ChevronLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Projects</span>
            </button>
            <div className="w-px h-5 bg-gray-800" />
            <div className="flex items-center gap-2">
              <div>
                <h1 className="text-base font-semibold text-white">{activeProject?.name ?? "Project"}</h1>
                {activeProject?.description && (
                  <p className="text-xs text-gray-500 mt-0.5 hidden sm:block">{activeProject.description}</p>
                )}
              </div>
              <button
                onClick={() => setShowProjectSettings(true)}
                title="Project settings"
                className="p-1.5 rounded-lg text-gray-500 hover:text-emerald-400 hover:bg-gray-800 transition"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <a href="/library/import/template" download
              className="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium px-3 py-2 rounded-lg transition">
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Template</span>
            </a>
            <label className="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium px-3 py-2 rounded-lg transition cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Import</span>
              <input type="file" accept=".xlsx,.xls,.csv,.tc,.groovy" multiple className="hidden"
                onChange={e => { if (e.target.files?.length) handleImport(e.target.files); e.target.value = ""; }} />
            </label>
            <button
              onClick={() => { setEditingScenario(null); setInitialTab("edit"); setShowScenarioModal(true); }}
              className="flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition"
            >
              <Plus className="w-4 h-4" /> New Scenario
            </button>
          </div>
        </header>
      )}

      {/* Action bar in embedded mode */}
      {embedded && (
        <div className="flex items-center justify-end gap-2 px-4 py-2 border-b border-gray-800 shrink-0">
          <a href="/library/import/template" download
            className="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium px-3 py-2 rounded-lg transition">
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Template</span>
          </a>
          <label className="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium px-3 py-2 rounded-lg transition cursor-pointer">
            <Upload className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Import</span>
            <input type="file" accept=".xlsx,.xls,.csv,.tc,.groovy" multiple className="hidden"
              onChange={e => { if (e.target.files?.length) handleImport(e.target.files); e.target.value = ""; }} />
          </label>
          <button
            onClick={() => { setEditingScenario(null); setInitialTab("edit"); setShowScenarioModal(true); }}
            className="flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition"
          >
            <Plus className="w-4 h-4" /> New Scenario
          </button>
        </div>
      )}

      {/* Two-panel body */}
      <div className="flex flex-1 min-h-0">
        {/* Left: Module list */}
        <aside className="w-64 flex-shrink-0 border-r border-gray-800 bg-gray-900 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <span className="text-sm font-semibold text-gray-400 uppercase tracking-widest">Modules</span>
            {effectiveProjectId && (
              <button onClick={() => setShowModuleForm(f => !f)} title="New module"
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-700 text-gray-500 hover:text-gray-200 transition">
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {showModuleForm && (
            <div className="px-3 py-2 border-b border-gray-800 space-y-1.5">
              <input
                value={newModuleName} onChange={e => setNewModuleName(e.target.value)}
                placeholder="Module name…" autoFocus
                onKeyDown={e => { if (e.key === "Enter" && newModuleName.trim()) createModuleMut.mutate(); if (e.key === "Escape") setShowModuleForm(false); }}
                className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-emerald-500"
              />
              <div className="flex gap-1">
                <button onClick={() => createModuleMut.mutate()} disabled={!newModuleName.trim()}
                  className="flex-1 text-xs bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white rounded px-2 py-1 transition">Save</button>
                <button onClick={() => { setShowModuleForm(false); setNewModuleName(""); }}
                  className="flex-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded px-2 py-1 transition">Cancel</button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto py-2">
            {!effectiveProjectId ? (
              <p className="px-4 py-2 text-sm text-gray-600 italic">Create a project first</p>
            ) : !modules.length ? (
              <p className="px-4 py-2 text-sm text-gray-600 italic">No modules yet</p>
            ) : modules.map((m: api.Module) => (
              <div
                key={m.id}
                onClick={() => { if (renamingModuleId !== m.id) setActiveModuleId(m.id); }}
                className={`flex items-center gap-2 px-3 py-2 rounded mx-1 cursor-pointer group transition
                  ${m.id === activeModuleId ? "bg-emerald-500/15 text-emerald-300" : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"}`}
              >
                {renamingModuleId === m.id ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(m.id)}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); commitRename(m.id); }
                      if (e.key === "Escape") setRenamingModuleId(null);
                    }}
                    onClick={e => e.stopPropagation()}
                    className="text-sm flex-1 bg-gray-700 text-gray-100 rounded px-1 py-0.5 outline-none min-w-0"
                    autoFocus
                  />
                ) : (
                  <span className="text-sm flex-1 min-w-0 break-words font-medium leading-snug">{m.name}</span>
                )}
                {renamingModuleId !== m.id && (
                  <span className="text-xs text-gray-600 mr-1">{(m as any).scenarios?.length ?? 0}</span>
                )}
                {renamingModuleId !== m.id && (
                  <button
                    onClick={e => startRename(e, m)}
                    className="w-4 h-4 flex items-center justify-center rounded hover:bg-gray-700 text-gray-600 hover:text-emerald-400 opacity-0 group-hover:opacity-100 transition flex-shrink-0"
                  >
                    <Pencil className="w-2.5 h-2.5" />
                  </button>
                )}
                {renamingModuleId !== m.id && (
                  <button
                    onClick={e => { e.stopPropagation(); if (confirm(`Delete module "${m.name}" and all its scenarios?`)) deleteModuleMut.mutate(m.id); }}
                    className="w-4 h-4 flex items-center justify-center rounded hover:bg-gray-700 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition flex-shrink-0"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </aside>

        {/* Right: Scenario cards */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Module name + search/filter bar */}
          <div className="px-4 py-2.5 border-b border-gray-800 space-y-2">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="text-sm min-w-0 truncate">
                {activeModule
                  ? <span className="text-gray-200 font-medium">{activeModule.name}</span>
                  : <span className="text-gray-600 italic">Select a module to view scenarios</span>}
              </span>
              <div className="flex items-center gap-2 flex-shrink-0">
                {activeModule && (
                  <button
                    onClick={() => {
                      const name = prompt("Group name:");
                      if (name?.trim()) createGroupMut.mutate({ name: name.trim() });
                    }}
                    title="Add group"
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-emerald-400 transition px-2 py-1 rounded hover:bg-gray-800"
                  >
                    <Folder className="w-3.5 h-3.5" /><Plus className="w-2.5 h-2.5" />
                    <span>Add Group</span>
                  </button>
                )}
                {activeModule && scenarios.length > 0 && (
                  <span className="text-xs text-gray-600">{filteredScenarios.length} of {scenarios.length}</span>
                )}
              </div>
            </div>
            {activeModule && scenarios.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 min-w-[180px] max-w-sm">
                  <Search className="w-3.5 h-3.5 text-gray-600 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search name, Kes ID, Scenario ID..."
                    className="w-full bg-gray-950 border border-gray-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-emerald-500 transition" />
                </div>
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)}
                  className="bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs text-gray-300 outline-none focus:border-emerald-500 transition">
                  <option value="all">All Status</option>
                  <option value="passed">Passed</option>
                  <option value="failed">Failed</option>
                  <option value="never">Never Run</option>
                </select>
                <select value={flowFilter} onChange={e => setFlowFilter(e.target.value as any)}
                  className="bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs text-gray-300 outline-none focus:border-emerald-500 transition">
                  <option value="all">All Flow</option>
                  <option value="positif">Positif</option>
                  <option value="negatif">Negatif</option>
                </select>
                {(searchQuery || statusFilter !== "all" || flowFilter !== "all") && (
                  <button onClick={() => { setSearchQuery(""); setStatusFilter("all"); setFlowFilter("all"); }}
                    className="text-xs text-gray-500 hover:text-gray-300 transition px-1.5">Clear</button>
                )}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {!effectiveProjectId ? (
              <EmptyState icon={<FolderOpen className="w-12 h-12 text-gray-700" />} text="Create a project to get started" />
            ) : !activeModuleId ? (
              <EmptyState icon={<FolderOpen className="w-12 h-12 text-gray-700" />} text="Select a module from the list" sub="or create a module to get started" />
            ) : (
              <div className="flex flex-col">
                {/* Table header — only when there are scenarios */}
                {scenarios.length > 0 && (
                  <div className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-widest border-b border-gray-800 sticky top-0 bg-gray-950 z-[1]">
                    <span className="w-6 shrink-0" />
                    <span className="w-16 shrink-0 hidden lg:block">ID</span>
                    <span className="w-40 shrink-0 hidden xl:block">Scenario ID</span>
                    <span className="flex-1 min-w-0">Scenario</span>
                    <span className="w-14 shrink-0 text-center hidden md:block">Flow</span>
                    <span className="w-16 shrink-0 text-center">Status</span>
                  </div>
                )}
                {/* Root drop zone */}
                <div
                  onDragOver={e => { e.preventDefault(); setDragOverGroupId("root"); }}
                  onDragLeave={() => setDragOverGroupId(null)}
                  onDrop={e => {
                    e.preventDefault();
                    const sid = e.dataTransfer.getData("scenarioId");
                    const gid = e.dataTransfer.getData("groupId");
                    if (sid) moveScenarioMut.mutate({ id: sid, groupId: null });
                    else if (gid) moveGroupMut.mutate({ id: gid, parentId: null });
                    setDragOverGroupId(null);
                  }}
                  className={`min-h-[4px] transition ${dragOverGroupId === "root" ? "bg-emerald-500/20 rounded" : ""}`}
                />
                {/* Group tree — always rendered so groups can be created even with no scenarios */}
                <GroupTree
                  groups={groups}
                  scenarios={filteredScenarios}
                  parentId={null}
                  depth={0}
                  expandedGroups={expandedGroups}
                  setExpandedGroups={setExpandedGroups}
                  dragOverGroupId={dragOverGroupId}
                  setDragOverGroupId={setDragOverGroupId}
                  onSelectScenario={s => { setEditingScenario(s); setInitialTab("run"); setShowScenarioModal(true); }}
                  onCreateGroup={(parentId) => {
                    const name = prompt("Group name:");
                    if (name?.trim()) createGroupMut.mutate({ name: name.trim(), parentId });
                  }}
                  onDeleteGroup={(id) => {
                    if (confirm("Delete group? Scenarios inside will be ungrouped.")) deleteGroupMut.mutate(id);
                  }}
                  onMoveScenario={(sid, gid) => moveScenarioMut.mutate({ id: sid, groupId: gid })}
                  onMoveGroup={(gid, parentId) => moveGroupMut.mutate({ id: gid, parentId })}
                  onRenameGroupInline={(id, name) => updateGroupMut.mutate({ id, name })}
                  onReorderGroup={reorderGroup}
                  onRunGroup={handleRunGroup}
                  onAddScenarioToGroup={(groupId) => { setDefaultGroupId(groupId); setEditingScenario(null); setInitialTab("edit"); setShowScenarioModal(true); }}
                  runningGroupId={runningGroupId}
                  moduleId={activeModuleId}
                />
                {/* Ungrouped scenarios */}
                {filteredScenarios.filter(s => !s.groupId).map((s: api.Scenario) => (
                  <ScenarioRow
                    key={s.id}
                    scenario={s}
                    depth={0}
                    onSelect={() => { setEditingScenario(s); setInitialTab("run"); setShowScenarioModal(true); }}
                  />
                ))}
                {/* Empty state when no scenarios exist yet */}
                {scenarios.length === 0 && (
                  <div className="flex flex-col items-center py-12 text-center">
                    <Inbox className="w-10 h-10 text-gray-700 mb-3" />
                    <p className="text-sm text-gray-500">No scenarios in this module</p>
                    <button
                      onClick={() => { setEditingScenario(null); setInitialTab("edit"); setShowScenarioModal(true); }}
                      className="mt-3 text-xs bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 px-3 py-1.5 rounded-lg transition"
                    >
                      + Add first scenario
                    </button>
                  </div>
                )}
                {filteredScenarios.length === 0 && scenarios.length > 0 && (
                  <div className="px-4 py-8 text-center text-xs text-gray-600">No scenarios match your filters</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Scenario Modal (Edit + Run) */}
      {showScenarioModal && activeProject && (
        <ScenarioModal
          scenario={editingScenario}
          project={activeProject}
          defaultModuleId={activeModuleId ?? ""}
          defaultGroupId={editingScenario ? undefined : (defaultGroupId ?? undefined)}
          saving={saving}
          onSave={handleSaveScenario}
          onDelete={() => {
            if (editingScenario && confirm(`Delete "${editingScenario.name}"?`)) {
              deleteScenarioMut.mutate(editingScenario.id);
              setShowScenarioModal(false);
              setEditingScenario(null);
            }
          }}
          onClose={() => { setShowScenarioModal(false); setEditingScenario(null); setDefaultGroupId(null); }}
          projectId={effectiveProjectId}
          onRefresh={invalidate}
          initialTab={initialTab}
        />
      )}

      {/* Import Result Modal */}
      {importResult && (
        <ImportResultModal result={importResult} onClose={() => setImportResult(null)} />
      )}

      {/* Project Settings Modal */}
      {showProjectSettings && effectiveProjectId && (
        <ProjectSettingsModal projectId={effectiveProjectId} onClose={() => setShowProjectSettings(false)} />
      )}

      {/* Group Run Modal */}
      {groupRunResults && (
        <GroupRunModal
          state={groupRunResults}
          onClose={() => { if (!groupRunResults.running) setGroupRunResults(null); }}
        />
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ icon, text, sub, action }: { icon: React.ReactNode; text: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {icon}
      <p className="text-sm text-gray-500 mt-3">{text}</p>
      {sub && <p className="text-xs text-gray-700 mt-1">{sub}</p>}
      {action}
    </div>
  );
}

// ─── Group Tree ───────────────────────────────────────────────────────────────
interface GroupTreeProps {
  groups: api.ScenarioGroup[];
  scenarios: api.Scenario[];
  parentId: string | null;
  depth: number;
  expandedGroups: Set<string>;
  setExpandedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  dragOverGroupId: string | null | "root";
  setDragOverGroupId: (id: string | null | "root") => void;
  onSelectScenario: (s: api.Scenario) => void;
  onCreateGroup: (parentId?: string) => void;
  onDeleteGroup: (id: string) => void;
  onMoveScenario: (sid: string, gid: string | null) => void;
  onMoveGroup: (gid: string, parentId: string | null) => void;
  onRenameGroupInline: (id: string, name: string) => void;
  onReorderGroup: (id: string, direction: -1 | 1) => void;
  onRunGroup: (groupId: string) => void;
  onAddScenarioToGroup: (groupId: string) => void;
  runningGroupId: string | null;
  moduleId: string;
}

function GroupTree(props: GroupTreeProps) {
  const {
    groups, scenarios, parentId, depth,
    expandedGroups, setExpandedGroups,
    dragOverGroupId, setDragOverGroupId,
    onSelectScenario, onCreateGroup, onDeleteGroup,
    onMoveScenario, onMoveGroup, onRenameGroupInline, onReorderGroup,
    onRunGroup, onAddScenarioToGroup, runningGroupId,
  } = props;

  const siblings = groups
    .filter(g => (g.parentId ?? null) === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return (
    <>
      {siblings.map((group, idx) => {
        const isOpen = expandedGroups.has(group.id);
        const childScenarios = scenarios.filter(s => s.groupId === group.id);
        const hasChildren = groups.some(g => g.parentId === group.id) || childScenarios.length > 0;
        const isDragOver = dragOverGroupId === group.id;
        return (
          <GroupRow
            key={group.id}
            group={group}
            depth={depth}
            isOpen={isOpen}
            hasChildren={hasChildren}
            isDragOver={isDragOver}
            canMoveUp={idx > 0}
            canMoveDown={idx < siblings.length - 1}
            canAddSub={depth < 4}
            onToggle={() => setExpandedGroups(prev => {
              const s = new Set(prev);
              s.has(group.id) ? s.delete(group.id) : s.add(group.id);
              return s;
            })}
            onDragStartGroup={e => {
              e.dataTransfer.setData("groupId", group.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverGroupId(group.id); }}
            onDragLeave={() => setDragOverGroupId(null)}
            onDrop={e => {
              e.preventDefault(); e.stopPropagation();
              const sid = e.dataTransfer.getData("scenarioId");
              const gid = e.dataTransfer.getData("groupId");
              if (sid) {
                onMoveScenario(sid, group.id);
                setExpandedGroups(p => { const s = new Set(p); s.add(group.id); return s; });
              } else if (gid && gid !== group.id) {
                onMoveGroup(gid, group.id);
                setExpandedGroups(p => { const s = new Set(p); s.add(group.id); return s; });
              }
              setDragOverGroupId(null);
            }}
            onAddSub={() => depth < 4 && onCreateGroup(group.id)}
            onDelete={() => onDeleteGroup(group.id)}
            onRename={name => onRenameGroupInline(group.id, name)}
            onMoveUp={() => onReorderGroup(group.id, -1)}
            onMoveDown={() => onReorderGroup(group.id, 1)}
            onRunGroup={() => onRunGroup(group.id)}
            onAddScenario={() => onAddScenarioToGroup(group.id)}
            isRunning={group.id === runningGroupId}
            hasScenarios={scenarios.some(s => {
              const allGroupIds = (function collect(id: string): string[] {
                return [id, ...groups.filter(g => g.parentId === id).flatMap(g => collect(g.id))];
              })(group.id);
              return allGroupIds.includes(s.groupId ?? "");
            })}
          >
            {isOpen && (
              <>
                <GroupTree {...props} parentId={group.id} depth={depth + 1} />
                {childScenarios.map(s => (
                  <ScenarioRow key={s.id} scenario={s} depth={depth + 1} onSelect={() => onSelectScenario(s)} />
                ))}
              </>
            )}
          </GroupRow>
        );
      })}
    </>
  );
}

function GroupRow({
  group, depth, isOpen, hasChildren, isDragOver,
  canMoveUp, canMoveDown, canAddSub,
  onToggle, onDragStartGroup, onDragOver, onDragLeave, onDrop,
  onAddSub, onDelete, onRename, onMoveUp, onMoveDown, onRunGroup, onAddScenario, isRunning, hasScenarios, children,
}: {
  group: api.ScenarioGroup; depth: number; isOpen: boolean;
  hasChildren: boolean; isDragOver: boolean;
  canMoveUp: boolean; canMoveDown: boolean; canAddSub: boolean;
  onToggle: () => void;
  onDragStartGroup: React.DragEventHandler;
  onDragOver: React.DragEventHandler;
  onDragLeave: React.DragEventHandler;
  onDrop: React.DragEventHandler;
  onAddSub: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRunGroup: () => void;
  onAddScenario: () => void;
  isRunning: boolean;
  hasScenarios: boolean;
  children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(group.name);
  const indent = depth * 16;

  function commitRename() {
    if (editName.trim() && editName.trim() !== group.name) onRename(editName.trim());
    setEditing(false);
  }

  return (
    <div>
      <div
        draggable={!editing}
        onDragStart={onDragStartGroup}
        onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
        className={`flex items-center gap-1.5 px-4 py-1.5 border-b border-gray-800/40 group/group transition cursor-grab active:cursor-grabbing
          ${isDragOver ? "bg-emerald-500/15 border-emerald-500/40" : "hover:bg-gray-900/50"}`}
        style={{ paddingLeft: `${16 + indent}px` }}
      >
        <button onClick={onToggle} className="w-4 h-4 flex items-center justify-center text-gray-600 hover:text-gray-400 shrink-0">
          {hasChildren ? (isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />) : <span className="w-3" />}
        </button>
        {isOpen ? <FolderOpenIcon className="w-3.5 h-3.5 text-yellow-500/70 shrink-0" /> : <Folder className="w-3.5 h-3.5 text-yellow-500/70 shrink-0" />}

        {editing ? (
          <input
            autoFocus value={editName}
            onChange={e => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setEditing(false); }}
            className="flex-1 bg-gray-800 border border-emerald-500 rounded px-1.5 py-0.5 text-xs text-gray-200 outline-none"
          />
        ) : (
          <span
            className="flex-1 text-xs text-gray-300 font-medium truncate cursor-default select-none"
            onDoubleClick={() => { setEditName(group.name); setEditing(true); }}
            title="Double-click to rename · Drag to move"
          >{group.name}</span>
        )}

        <div className="flex items-center gap-0.5 opacity-0 group-hover/group:opacity-100 transition">
          <button
            onClick={e => { e.stopPropagation(); onAddScenario(); }}
            title="Add test scenario to this group"
            className="flex items-center gap-0.5 px-1.5 h-5 rounded hover:bg-gray-700 text-gray-600 hover:text-emerald-400 text-xs"
          >
            <Plus className="w-3 h-3" />
            <span>Add</span>
          </button>
          <button
            onClick={e => { e.stopPropagation(); onRunGroup(); }}
            disabled={isRunning || !hasScenarios}
            title={!hasScenarios ? "No test items in this group" : "Run all scenarios in this group"}
            className="flex items-center gap-0.5 px-1.5 h-5 rounded hover:bg-gray-700 text-gray-600 hover:text-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-xs"
          >
            {isRunning ? <Loader className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            <span>Run</span>
          </button>
          <button onClick={onMoveUp} disabled={!canMoveUp} title="Move up"
            className="flex items-center gap-0.5 px-1.5 h-5 rounded hover:bg-gray-700 text-gray-600 hover:text-gray-300 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-600 text-xs">
            <ChevronUp className="w-3 h-3" /><span>Up</span>
          </button>
          <button onClick={onMoveDown} disabled={!canMoveDown} title="Move down"
            className="flex items-center gap-0.5 px-1.5 h-5 rounded hover:bg-gray-700 text-gray-600 hover:text-gray-300 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-600 text-xs">
            <ChevronDown className="w-3 h-3" /><span>Down</span>
          </button>
          {canAddSub && (
            <button onClick={onAddSub} title="Add sub-group"
              className="flex items-center gap-0.5 px-1.5 h-5 rounded hover:bg-gray-700 text-gray-600 hover:text-emerald-400 text-xs">
              <Plus className="w-3 h-3" /><span>Sub</span>
            </button>
          )}
          <button onClick={onDelete} title="Delete group"
            className="flex items-center gap-0.5 px-1.5 h-5 rounded hover:bg-gray-700 text-gray-600 hover:text-red-400 text-xs">
            <X className="w-3 h-3" /><span>Del</span>
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

// ─── Group Run Types & Modal ──────────────────────────────────────────────────
interface ScenarioRunResult {
  scenarioId: string;
  name: string;
  passed: boolean;
  summary: string;
  reportId?: string;
  durationMs: number;
}

interface GroupRunState {
  groupId: string;
  groupName: string;
  total: number;
  completed: number;
  results: ScenarioRunResult[];
  running: boolean;
  currentScenarioName?: string;
  logs: string[];
}

function GroupRunModal({ state, onClose }: { state: GroupRunState; onClose: () => void }) {
  const pct = state.total > 0 ? Math.round((state.completed / state.total) * 100) : 0;
  const passed = state.results.filter(r => r.passed).length;
  const failed = state.results.filter(r => !r.passed).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-sm font-semibold text-gray-100">Running group: <span className="text-emerald-400">{state.groupName}</span></h2>
            <p className="text-xs text-gray-500 mt-0.5">{state.completed} / {state.total} scenarios</p>
          </div>
          <button
            onClick={onClose}
            disabled={state.running}
            className="text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Progress bar */}
        <div className="px-5 pt-3">
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Currently running */}
        {state.running && state.currentScenarioName && (
          <div className="px-5 pt-3 flex items-center gap-2 text-xs text-gray-400">
            <Loader className="w-3 h-3 animate-spin text-emerald-400 shrink-0" />
            <span className="truncate">Running: {state.currentScenarioName}</span>
          </div>
        )}

        {/* Results list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1 min-h-0">
          {state.results.map(r => (
            <div key={r.scenarioId} className="flex items-center gap-2 text-xs py-1 border-b border-gray-800/40">
              {r.passed
                ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                : <X className="w-3.5 h-3.5 text-red-400 shrink-0" />}
              <span className={`flex-1 truncate ${r.passed ? "text-gray-300" : "text-gray-400"}`}>{r.name}</span>
              <span className="text-gray-600 shrink-0">{(r.durationMs / 1000).toFixed(1)}s</span>
              {r.reportId && (
                <a
                  href={`/playwright-report/${r.reportId}/index.html`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-gray-600 hover:text-emerald-400 shrink-0"
                  title="View report"
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          ))}
          {state.running && state.results.length === 0 && (
            <p className="text-xs text-gray-600 text-center py-4">Waiting for first result…</p>
          )}
        </div>

        {/* Footer summary */}
        {!state.running && (
          <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-3 text-xs">
              <span className="text-emerald-400 font-medium">{passed} passed</span>
              {failed > 0 && <span className="text-red-400 font-medium">{failed} failed</span>}
            </div>
            <button
              onClick={onClose}
              className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded-lg transition"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Scenario Row (clickable list view) ──────────────────────────────────────
function ScenarioRow({ scenario: s, depth = 0, onSelect }: {
  scenario: api.Scenario;
  depth?: number;
  onSelect: () => void;
}) {
  const { data: history } = useQuery({
    queryKey: ["history", s.id],
    queryFn: () => api.getScenarioHistory(s.id),
  });
  const lastRun = history?.[0];
  const flowTag = s.tags.find(t => t === "positif" || t === "negatif");
  const indent = depth * 16;

  return (
    <div
      onClick={onSelect}
      draggable
      onDragStart={e => e.dataTransfer.setData("scenarioId", s.id)}
      className="flex items-center gap-2 px-4 py-2 border-b border-gray-800/60 hover:bg-gray-900/70 cursor-pointer transition"
      style={{ paddingLeft: `${16 + indent + 20}px` }}
    >
      {/* Status dot */}
      <span className="w-6 flex justify-center shrink-0">
        {lastRun ? (
          <span className={`w-2 h-2 rounded-full ${lastRun.passed ? "bg-green-500" : "bg-red-500"}`} />
        ) : (
          <span className="w-2 h-2 rounded-full bg-gray-700" />
        )}
      </span>

      {/* Case number */}
      <span className="w-16 shrink-0 hidden lg:block text-xs text-gray-500 font-mono">
        {s.caseNumber != null ? String(s.caseNumber).padStart(3, "0") : "—"}
      </span>

      {/* Scenario ID */}
      <span className="w-40 shrink-0 hidden xl:block text-xs text-gray-600 font-mono truncate">
        {s.scenarioRefId || "—"}
      </span>

      {/* Name */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="text-xs text-gray-200 truncate">{s.name && s.name.length > 60 ? s.name.slice(0, 60) + "…" : s.name}</p>
      </div>

      {/* Flow */}
      <div className="w-14 hidden md:flex justify-center shrink-0">
        {flowTag ? (
          <span className={`text-xs px-1.5 py-0.5 rounded ${flowTag === "positif" ? "bg-blue-900/40 text-blue-300" : "bg-orange-900/40 text-orange-300"}`}>
            {flowTag === "positif" ? "Positif" : "Negatif"}
          </span>
        ) : null}
      </div>

      {/* Status */}
      <div className="w-16 text-center text-xs shrink-0">
        {lastRun ? (
          <span className={lastRun.passed ? "text-green-500" : "text-red-400"}>
            {lastRun.passed ? "Passed" : "Failed"}
          </span>
        ) : (
          <span className="text-gray-700">—</span>
        )}
      </div>
    </div>
  );
}

// ─── Scenario Modal (Edit + Run) ─────────────────────────────────────────────
function ScenarioModal({ scenario, project, defaultModuleId, defaultGroupId, saving, onSave, onDelete, onClose, projectId, onRefresh, initialTab = "edit" }: {
  scenario: api.Scenario | null;
  project: api.Project;
  defaultModuleId: string;
  defaultGroupId?: string;
  saving: boolean;
  onSave: (data: Omit<api.Scenario, "id" | "createdAt" | "updatedAt">) => Promise<api.Scenario | false>;
  onDelete: () => void;
  onClose: () => void;
  projectId: string;
  onRefresh: () => void;
  initialTab?: "edit" | "run";
}) {
  const projectModules = project.modules ?? [];

  // track the live scenario (updated after create/save so Run tab unlocks)
  const [activeScenario, setActiveScenario] = useState<api.Scenario | null>(scenario);
  const [tab, setTab] = useState<"edit" | "run">(activeScenario?.id ? initialTab : "edit");

  // ── Edit state ─────────────────────────────────────────────────────────────
  const [moduleId,      setModuleId]      = useState(activeScenario?.moduleId ?? defaultModuleId);
  const [name,          setName]          = useState(activeScenario?.name ?? "");
  const [url,           setUrl]           = useState(activeScenario?.url ?? "");
  const [customSpec,    setCustomSpec]    = useState<string | null>(activeScenario?.customSpec ?? null);
  const [testUsername,  setTestUsername]  = useState(activeScenario?.authConfig?.email ?? "");
  const [testPassword,  setTestPassword]  = useState(activeScenario?.authConfig?.password ?? "");
  const [showPassword,  setShowPassword]  = useState(false);
  const [savedAt,         setSavedAt]         = useState<number | null>(null);
  const [showInstruction, setShowInstruction] = useState(false);
  const [snapshot,        setSnapshot]        = useState(() => JSON.stringify({ moduleId, name, url, customSpec, testUsername, testPassword }));
  const isDirty = () => JSON.stringify({ moduleId, name, url, customSpec, testUsername, testPassword }) !== snapshot;

  // ── Run state ──────────────────────────────────────────────────────────────
  const [running,       setRunning]       = useState(false);
  const [logs,          setLogs]          = useState<string[]>([]);
  const [result,        setResult]        = useState<{ passed: boolean; text: string; screenshotUrl?: string } | null>(null);
  const [reportUrl,     setReportUrl]     = useState<string | null>(null);
  const [logTab,        setLogTab]        = useState<"live" | "history">("live");
  const [selectedEnvId, setSelectedEnvId] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  const { data: environments = [] } = useQuery({
    queryKey: ["environments", projectId],
    queryFn: () => api.getEnvironments(projectId),
    enabled: !!projectId && !!activeScenario?.id,
  });
  const { data: history, refetch: refetchHistory } = useQuery({
    queryKey: ["history", activeScenario?.id],
    queryFn: () => api.getScenarioHistory(activeScenario!.id),
    enabled: !!activeScenario?.id,
  });
  const lastRun = history?.[0];
  const lastReportUrl = lastRun?.reportId ? `/playwright-report/${lastRun.reportId}/index.html` : null;
  const effectiveReportUrl = reportUrl ?? lastReportUrl;

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !running) onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [running, onClose]);

  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 3000);
    return () => clearTimeout(t);
  }, [savedAt]);

  function confirmAndClose() {
    if (isDirty()) {
      if (confirm("You have unsaved changes. Discard them?")) onClose();
    } else {
      onClose();
    }
  }

  async function submit() {
    if (!moduleId || !name.trim()) { alert("Module and name are required."); return; }
    const result = await onSave({
      moduleId, name: name.trim(),
      url: url.trim(),
      testTypes: ["smoke"] as any,
      tags: activeScenario?.tags ?? [],
      groupId: activeScenario?.groupId ?? defaultGroupId ?? undefined,
      customSpec: customSpec?.trim() || undefined,
      authConfig: (testUsername.trim() || testPassword.trim())
        ? { loginUrl: "", email: testUsername.trim(), password: testPassword.trim() }
        : undefined,
    });
    if (result) {
      setActiveScenario(result);
      setSavedAt(Date.now());
      setSnapshot(JSON.stringify({ moduleId, name, url, customSpec, testUsername, testPassword }));
    }
  }

  async function run() {
    if (!activeScenario?.id) return;
    setRunning(true); setResult(null); setReportUrl(null); setLogTab("live");
    setLogs(["▶ Starting test…"]);
    try {
      const res = await fetch(`/library/scenarios/${activeScenario.id}/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useCustomSpec: !!activeScenario.customSpec, environmentId: selectedEnvId || undefined }),
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(part.replace(/^data:\s*/, ""));
            if (ev.type === "log") setLogs(p => [...p, ev.message]);
            if (ev.type === "result") {
              const text = ev.passed ? "✅ Test Passed" : "❌ Test Failed";
              setResult({ passed: ev.passed, text, screenshotUrl: ev.screenshotUrl });
              setLogs(p => [...p, "", text]);
              if (ev.reportId) setReportUrl(`/playwright-report/${ev.reportId}/index.html`);
              onRefresh(); refetchHistory();
            }
            if (ev.type === "error") {
              setResult({ passed: false, text: `Error: ${ev.message}` });
              setLogs(p => [...p, `❌ Error: ${ev.message}`]);
            }
          } catch {}
        }
      }
    } catch (err) {
      setLogs(p => [...p, `❌ ${(err as Error).message}`]);
      setResult({ passed: false, text: (err as Error).message });
    } finally { setRunning(false); }
  }

  const inputCls = "w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-emerald-500 transition";
  const labelCls = "block text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1";

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="shrink-0">
          <div className="flex items-start justify-between px-6 pt-4 pb-3">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] text-gray-600 uppercase tracking-widest">{project.name}</p>
              <h2 className="text-sm font-semibold text-white mt-0.5">
                {activeScenario
                  ? <span className="flex items-center gap-2">
                      {activeScenario.caseNumber != null && <span className="text-xs bg-gray-800 text-gray-400 font-mono px-2 py-0.5 rounded">#{String(activeScenario.caseNumber).padStart(3, "0")}</span>}
                      {activeScenario.name}
                    </span>
                  : "New Scenario"}
              </h2>
              {lastRun && (
                <p className="text-xs text-gray-600 mt-0.5 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Last run {relativeTime(lastRun.runAt)} — <span className={lastRun.passed ? "text-green-500" : "text-red-400"}>{lastRun.passed ? "Passed" : "Failed"}</span>
                </p>
              )}
            </div>
            <button onClick={confirmAndClose} className="text-gray-500 hover:text-gray-200 transition text-xl leading-none ml-4">&times;</button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-800 px-2">
            {(["edit", "run"] as const).map(t => (
              <button key={t} onClick={() => { if (t === "run" && !activeScenario?.id) return; setTab(t); }}
                disabled={t === "run" && !activeScenario?.id}
                className={`relative px-4 py-2.5 text-xs font-semibold uppercase tracking-wider transition flex items-center gap-1.5
                  ${tab === t ? "text-emerald-400" : activeScenario?.id || t === "edit" ? "text-gray-500 hover:text-gray-300" : "text-gray-700 cursor-not-allowed"}`}>
                {t === "edit" ? <Pencil className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                {t === "edit" ? "Edit" : "Run"}
                {t === "run" && !activeScenario?.id && <span className="text-[9px] text-gray-700 normal-case tracking-normal font-normal">— save first</span>}
                {tab === t && <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-emerald-500 rounded-full" />}
              </button>
            ))}
          </div>
        </div>

        {/* ── Edit Tab ───────────────────────────────────────────────────── */}
        {tab === "edit" && (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Module</label>
                  <select value={moduleId} onChange={e => setModuleId(e.target.value)} className={inputCls}>
                    <option value="">— select module —</option>
                    {projectModules.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Scenario Name</label>
                  <input value={name} onChange={e => setName(e.target.value)} autoFocus
                    placeholder="e.g. Login page smoke test" className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>URL</label>
                  <input value={url} onChange={e => setUrl(e.target.value)} type="url"
                    placeholder="https://example.com" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Username <span className="normal-case text-gray-600 font-normal tracking-normal">— available as <code className="text-emerald-500 bg-gray-800 px-1 rounded">TEST_USERNAME</code> in script</span></label>
                  <input value={testUsername} onChange={e => setTestUsername(e.target.value)}
                    placeholder="e.g. admin" autoComplete="off" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Password <span className="normal-case text-gray-600 font-normal tracking-normal">— available as <code className="text-emerald-500 bg-gray-800 px-1 rounded">TEST_PASSWORD</code> in script</span></label>
                  <div className="relative">
                    <input value={testPassword} onChange={e => setTestPassword(e.target.value)}
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••" autoComplete="new-password" className={inputCls + " pr-10"} />
                    <button type="button" onClick={() => setShowPassword(p => !p)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-300 transition text-[10px]">
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <label className={labelCls + " mb-0"}>Playwright Script</label>
                    <button onClick={() => setShowInstruction(true)}
                      className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-emerald-400 transition font-medium">
                      <BookOpen className="w-3 h-3" /> View Instruction
                    </button>
                  </div>
                  {customSpec && (
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] text-emerald-500">{customSpec.split("\n").length} lines</span>
                      <button onClick={() => setCustomSpec(null)}
                        className="p-1 rounded text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition" title="Clear">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
                <textarea value={customSpec ?? ""} onChange={e => setCustomSpec(e.target.value || null)}
                  spellCheck={false}
                  placeholder={`import { test, expect } from '@playwright/test';\n\ntest('my scenario', async ({ page }) => {\n  await page.goto('https://example.com');\n  // paste your Playwright code here\n});`}
                  className="w-full text-xs font-mono text-gray-300 bg-gray-950 border border-gray-800 rounded-lg p-3 h-72 resize-y outline-none focus:border-emerald-500 transition placeholder-gray-700"
                />
              </div>
            </div>
            <div className="px-6 py-3 border-t border-gray-800 flex items-center gap-2 shrink-0">
              <button onClick={confirmAndClose}
                className="px-4 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm py-2 rounded-lg transition">
                Cancel
              </button>
              {activeScenario?.id && (
                <button onClick={onDelete}
                  className="flex items-center gap-1 px-3 text-xs bg-gray-800 hover:bg-red-900/40 text-gray-500 hover:text-red-400 py-2 rounded-lg transition">
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              )}
              <div className="flex-1" />
              {savedAt && <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Saved</span>}
              <button onClick={submit} disabled={saving || !moduleId || !name.trim()}
                className="bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-semibold px-6 py-2 rounded-lg transition">
                {saving ? "Saving…" : activeScenario ? "Save Changes" : "Create Scenario"}
              </button>
            </div>
          </>
        )}

        {/* ── Run Tab ────────────────────────────────────────────────────── */}
        {tab === "run" && activeScenario?.id && (
          <div className="flex flex-1 min-h-0 overflow-hidden">

            {/* Left: controls */}
            <div className="w-60 shrink-0 border-r border-gray-800 p-4 flex flex-col gap-3 overflow-y-auto">

              {environments.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-1">Environment</p>
                  <select value={selectedEnvId} onChange={e => setSelectedEnvId(e.target.value)}
                    className="w-full bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none focus:border-emerald-500 transition">
                    <option value="">Default</option>
                    {environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
                  </select>
                </div>
              )}

              <button onClick={() => run()} disabled={running}
                className={`w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-white py-2.5 rounded-lg transition-all cursor-pointer disabled:cursor-not-allowed
                  ${running
                    ? "bg-emerald-700 ring-2 ring-emerald-400/40 ring-offset-1 ring-offset-gray-900"
                    : "bg-emerald-500 hover:bg-emerald-600"}`}>
                {running
                  ? <><Loader className="w-3.5 h-3.5 animate-spin" /> Running…</>
                  : <><Play className="w-3.5 h-3.5" /> Run Test</>}
              </button>

              <div className="flex-1" />

              {effectiveReportUrl && (
                <div className="flex gap-2">
                  <a href={effectiveReportUrl} target="_blank" rel="noreferrer"
                    className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 py-2 rounded-lg transition">
                    <BarChart2 className="w-3.5 h-3.5" /> View Report
                  </a>
                  {(() => {
                    const rid = effectiveReportUrl.split("/playwright-report/")[1]?.split("/")[0];
                    return rid ? (
                      <>
                        <a href={`/playwright-report/${rid}/download`} title="Download ZIP"
                          className="flex items-center justify-center text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 py-2 px-3 rounded-lg transition">
                          <Download className="w-3.5 h-3.5" />
                        </a>
                        {result?.screenshotUrl && (
                          <a href={result.screenshotUrl} target="_blank" rel="noreferrer" title="View Screenshot"
                            className="flex items-center justify-center text-xs bg-gray-800 hover:bg-gray-700 text-blue-400 py-2 px-3 rounded-lg transition">
                            <Image className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </>
                    ) : null;
                  })()}
                </div>
              )}
            </div>

            {/* Right: logs + history */}
            <div className="flex-1 flex flex-col min-w-0 min-h-0">
              <div className="px-4 py-2 border-b border-gray-800 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-1">
                  {(["live", "history"] as const).map(t => (
                    <button key={t} onClick={() => setLogTab(t)}
                      className={`text-xs font-semibold px-2.5 py-1 rounded transition ${logTab === t ? "bg-gray-800 text-gray-200" : "text-gray-500 hover:text-gray-300"}`}>
                      {t === "live" ? "Live Output" : `History${history?.length ? ` (${history.length})` : ""}`}
                    </button>
                  ))}
                </div>
                {logTab === "live" && running && (
                  <span className="text-xs text-emerald-400 flex items-center gap-1.5"><Loader className="w-3 h-3 animate-spin" /> Running…</span>
                )}
                {logTab === "live" && result && !running && (
                  <span className={`text-xs font-semibold ${result.passed ? "text-green-400" : "text-red-400"}`}>{result.text}</span>
                )}
              </div>

              {logTab === "live" && (
                <div className="flex-1 flex flex-col min-h-0 bg-gray-950">
                  <div ref={logRef} className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed">
                    {logs.length === 0
                      ? <p className="text-gray-700 italic">Click "Run" to start a test…</p>
                      : logs.map((line, i) => (
                          <div key={i} className={`whitespace-pre-wrap ${
                            line.startsWith("✅") ? "text-green-400 font-semibold" :
                            line.startsWith("❌") ? "text-red-400 font-semibold" :
                            line.startsWith("▶") ? "text-emerald-400" :
                            line.startsWith("[AUTH]") || line.startsWith("🔐") ? "text-amber-400" :
                            line.startsWith("[stderr]") ? "text-orange-400" :
                            "text-gray-400"
                          }`}>{line}</div>
                        ))
                    }
                  </div>
                  {result?.screenshotUrl && (
                    <div className="shrink-0 border-t border-gray-800 p-3">
                      <p className="text-[10px] text-gray-600 uppercase tracking-widest mb-2">Screenshot</p>
                      <a href={result.screenshotUrl} target="_blank" rel="noreferrer">
                        <img src={result.screenshotUrl} alt="Test screenshot"
                          className="w-full max-h-48 object-cover object-top rounded border border-gray-800 hover:border-gray-600 transition cursor-zoom-in" />
                      </a>
                    </div>
                  )}
                </div>
              )}

              {logTab === "history" && (
                <div className="flex-1 overflow-y-auto bg-gray-950">
                  {!history?.length
                    ? <p className="text-gray-700 italic text-xs p-4">No run history yet</p>
                    : history.map(run => (
                        <details key={run.id} className="border-b border-gray-800/50">
                          <summary className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-gray-900/70 transition text-xs select-none">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${run.passed ? "bg-green-500" : "bg-red-500"}`} />
                            <span className={`font-semibold ${run.passed ? "text-green-400" : "text-red-400"}`}>{run.passed ? "Passed" : "Failed"}</span>
                            <span className="text-gray-500">{relativeTime(run.runAt)}</span>
                            {run.screenshotUrl && (
                              <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">📷</span>
                            )}
                            <span className="text-gray-700 ml-auto">{(run.durationMs / 1000).toFixed(1)}s</span>
                          </summary>
                          <div className="px-4 pb-3 space-y-2">
                            <p className="text-xs text-gray-500">{run.summary}</p>
                            {run.screenshotUrl && (
                              <a href={run.screenshotUrl} target="_blank" rel="noreferrer">
                                <img src={run.screenshotUrl} alt="Test screenshot"
                                  className="w-full max-h-36 object-cover object-top rounded border border-gray-800 hover:border-gray-600 transition cursor-zoom-in" />
                              </a>
                            )}
                            {run.reportId && (
                              <div className="flex items-center gap-3 flex-wrap">
                                <a href={`/playwright-report/${run.reportId}/index.html`} target="_blank" rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:underline">
                                  <BarChart2 className="w-3 h-3" /> View Report
                                </a>
                                <a href={`/playwright-report/${run.reportId}/download`}
                                  className="inline-flex items-center gap-1 text-xs text-gray-400 hover:underline">
                                  <Download className="w-3 h-3" /> Download ZIP
                                </a>
                                {run.screenshotUrl && (
                                  <a href={run.screenshotUrl} target="_blank" rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-xs text-blue-400 hover:underline">
                                    <Image className="w-3 h-3" /> View Photo
                                  </a>
                                )}
                              </div>
                            )}
                            {run.logs
                              ? <pre className="text-xs font-mono text-gray-500 bg-gray-900 border border-gray-800 rounded-lg p-3 max-h-48 overflow-auto whitespace-pre-wrap">{run.logs}</pre>
                              : <p className="text-xs text-gray-700 italic">No logs saved for this run</p>
                            }
                          </div>
                        </details>
                      ))
                  }
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </div>

    {showInstruction && <PlaywrightInstructionModal onClose={() => setShowInstruction(false)} />}
    </>
  );
}

// ─── Playwright Instruction Modal ─────────────────────────────────────────────
function PlaywrightInstructionModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[88vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">How to Write a Playwright Script</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 transition text-xl leading-none">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 text-xs text-gray-300">

          {/* Option A */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="bg-emerald-500/20 text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">Option A</span>
              <span className="font-semibold text-white">Long / complex flow — Record it</span>
            </div>
            <p className="text-gray-500 mb-3">Best for flows with many steps. You click through the app and the script writes itself.</p>
            <div className="mb-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">
              <p className="text-yellow-400 text-[11px] font-semibold mb-1">Prerequisites — do this once</p>
              <p className="text-gray-400 text-[11px] mb-1">Install Node.js (if not already), then run:</p>
              <pre className="bg-gray-950 border border-gray-800 rounded px-3 py-2 font-mono text-emerald-400 text-[11px]">npm install -g playwright{"\n"}npx playwright install chromium</pre>
            </div>
            <div className="space-y-2">
              {[
                { n: 1, text: "Open terminal on your laptop and run:", code: "npx playwright codegen https://yoursite.com" },
                { n: 2, text: "A browser opens — click through your entire flow (login, navigate, fill forms, submit)." },
                { n: 3, text: "Copy the generated script from the Inspector window on the right." },
                { n: 4, text: "Paste it here → Save → go to Run tab → Run Test." },
              ].map(s => (
                <div key={s.n} className="flex gap-3">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-gray-800 text-gray-400 flex items-center justify-center font-bold text-[10px]">{s.n}</span>
                  <div>
                    <p className="text-gray-400">{s.text}</p>
                    {s.code && (
                      <pre className="mt-1 bg-gray-950 border border-gray-800 rounded px-3 py-2 font-mono text-emerald-400 text-[11px]">{s.code}</pre>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-gray-800" />

          {/* Option B */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="bg-blue-500/20 text-blue-400 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">Option B</span>
              <span className="font-semibold text-white">Short / simple flow — Generate with AI</span>
            </div>
            <p className="text-gray-500 mb-3">Best for simple flows under 10 steps. Use Claude.ai or ChatGPT — no API key needed.</p>
            <div className="space-y-2">
              {[
                { n: 1, text: "Open Claude.ai or ChatGPT in your browser." },
                { n: 2, text: "Upload your test script document (Word, PDF, Excel) as an attachment." },
                { n: 3, text: "Send this prompt:" },
                { n: 4, text: "Copy the generated script from the AI response." },
                { n: 5, text: "Fill in Username and Password fields in this form (above the script box). The system will inject them automatically — no credentials in the script itself." },
                { n: 6, text: "In the script, use TEST_USERNAME and TEST_PASSWORD wherever credentials are needed:" },
                { n: 7, text: "Paste the script here → Save → go to Run tab → Run Test." },
                { n: 8, text: "If it fails, check the screenshot in the History tab, then ask AI to fix it:" },
              ].map(s => (
                <div key={s.n} className="flex gap-3">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-gray-800 text-gray-400 flex items-center justify-center font-bold text-[10px]">{s.n}</span>
                  <div className="flex-1">
                    <p className="text-gray-400">{s.text}</p>
                    {s.n === 3 && (
                      <pre className="mt-1 bg-gray-950 border border-gray-800 rounded px-3 py-2 font-mono text-gray-300 text-[10px] whitespace-pre-wrap leading-relaxed">{`I have attached my test script document.
Convert it to a Playwright test script using @playwright/test format.

Rules:
- Use: import { test, expect } from '@playwright/test'
- Use async ({ page }) fixture
- Do NOT use chromium.launch() or browser.newPage()
- Use TEST_USERNAME and TEST_PASSWORD variables for any login credentials (do not hardcode values)
- Add expect() assertions to verify each expected result
- Use the URL from the test script document`}</pre>
                    )}
                    {s.n === 6 && (
                      <pre className="mt-1 bg-gray-950 border border-gray-800 rounded px-3 py-2 font-mono text-emerald-400 text-[10px] whitespace-pre-wrap leading-relaxed">{`await page.fill('#username', TEST_USERNAME);
await page.fill('#password', TEST_PASSWORD);`}</pre>
                    )}
                    {s.n === 8 && (
                      <pre className="mt-1 bg-gray-950 border border-gray-800 rounded px-3 py-2 font-mono text-gray-300 text-[10px] whitespace-pre-wrap leading-relaxed">{`The test failed at this error: [paste error here]
The screenshot shows: [describe what you see]
Please fix the selector or add a wait before that step.`}</pre>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-gray-800" />

          {/* Quick reference */}
          <div>
            <p className="font-semibold text-white mb-2">Which option should I use?</p>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-600 border-b border-gray-800">
                  <th className="text-left pb-1.5 font-medium">Situation</th>
                  <th className="text-left pb-1.5 font-medium">Use</th>
                </tr>
              </thead>
              <tbody className="text-gray-400">
                {[
                  ["Many steps / complex flow", "Option A (codegen)"],
                  ["Simple flow (under 10 steps)", "Option B (AI)"],
                  ["Have a test script document", "Option B (upload doc to AI)"],
                  ["Script works but missing assertions", "Option B — ask AI to add assertions only"],
                  ["Script fails with wrong selector", "Option A — re-record that section"],
                ].map(([sit, use]) => (
                  <tr key={sit} className="border-b border-gray-800/50">
                    <td className="py-1.5 pr-4">{sit}</td>
                    <td className="py-1.5 text-emerald-400 font-medium">{use}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-800 shrink-0">
          <button onClick={onClose}
            className="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-semibold py-2 rounded-lg transition">
            Got it
          </button>
        </div>

      </div>
    </div>
  );
}

// ─── Import Result Modal ──────────────────────────────────────────────────────
function ImportResultModal({ result, onClose }: {
  result: { created: number; createdNames: string[]; errors: { row: number; error: string }[] };
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
          <h2 className="text-sm font-semibold text-white">Import Result</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 transition text-xl leading-none">×</button>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4 text-sm">
          {result.created > 0 && (
            <div className="flex items-start gap-3 bg-green-900/20 border border-green-800/50 rounded-lg px-4 py-3">
              <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-green-300 font-semibold">{result.created} scenario{result.created !== 1 ? "s" : ""} imported</p>
                <ul className="mt-1 space-y-0.5 text-xs text-green-700">
                  {result.createdNames.map(n => <li key={n}>✓ {n}</li>)}
                </ul>
              </div>
            </div>
          )}
          {result.errors.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-red-400 uppercase tracking-widest mb-2">{result.errors.length} skipped</p>
              <ul className="space-y-1 text-xs border border-gray-800 rounded-lg px-3 py-2 max-h-40 overflow-y-auto">
                {result.errors.map((e, i) => (
                  <li key={i} className="flex items-start gap-2 text-gray-400">
                    <span className="text-red-500 flex-shrink-0">{e.row > 0 ? `Row ${e.row}:` : "Error:"}</span>
                    <span>{e.error}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.created === 0 && !result.errors.length && (
            <p className="text-gray-500">No data rows found. Check the format matches the template.</p>
          )}
          <p className="text-xs text-gray-600 border-t border-gray-800 pt-3">
            Excel/CSV columns: Module · Scenario Name · URL · Test Types · Description · Tags · Login URL · Login Email · Login Password
            {" — "}<a href="/library/import/template" download className="text-emerald-400 hover:underline">Download template</a>
            <br />Katalon: upload <span className="text-gray-400">.tc</span> files (optionally with companion <span className="text-gray-400">.groovy</span> scripts for URL extraction).
          </p>
        </div>
        <div className="px-6 py-4 border-t border-gray-800 flex-shrink-0">
          <button onClick={onClose} className="w-full bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold py-2 rounded-lg transition">Done</button>
        </div>
      </div>
    </div>
  );
}
