import type {
  McpServerBindingOverridesV1,
  McpServerBindingTargetV1,
  McpServerBindingV1,
  McpServerCatalogEntryV1,
  McpValueRefV1,
} from './settingsV1.js';

export type ResolvedServerBindingV1 = Readonly<{
  binding: McpServerBindingV1 | null;
  bindingId: string | null;
  bindingTargetKind: McpServerBindingTargetV1['t'] | null;
  enabled: boolean;
  config: McpServerCatalogEntryV1;
}>;

export function defaultNormalizeMcpPathV1(path: string): string {
  let out = typeof path === 'string' ? path : '';
  out = out.replace(/\\/g, '/');

  const isDriveRoot = /^[A-Za-z]:\/$/.test(out);
  if (!isDriveRoot && out.length > 1) {
    out = out.replace(/\/+$/g, '');
  }

  return out;
}

function isPathWithinRoot(directory: string, workspaceRoot: string): boolean {
  if (!workspaceRoot) return false;
  if (directory === workspaceRoot) return true;
  return directory.startsWith(`${workspaceRoot}/`);
}

type BindingScore = Readonly<{
  rank: number;
  workspaceRootLength: number;
  updatedAt: number;
  createdAt: number;
  id: string;
}>;

function scoreBinding(binding: McpServerBindingV1, normalizedWorkspaceRoot: string | null): BindingScore {
  let rank = 0;
  let workspaceRootLength = 0;
  if (binding.target.t === 'allMachines') rank = 1;
  if (binding.target.t === 'machine') rank = 2;
  if (binding.target.t === 'workspace') {
    rank = 3;
    workspaceRootLength = normalizedWorkspaceRoot ? normalizedWorkspaceRoot.length : 0;
  }
  return {
    rank,
    workspaceRootLength,
    updatedAt: binding.updatedAt,
    createdAt: binding.createdAt,
    id: binding.id,
  };
}

function compareScores(a: BindingScore, b: BindingScore): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.workspaceRootLength !== b.workspaceRootLength) return a.workspaceRootLength - b.workspaceRootLength;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return b.id.localeCompare(a.id);
}

function isBindingApplicable(params: Readonly<{
  target: McpServerBindingTargetV1;
  machineId: string;
  normalizedDirectory: string;
  normalizePath: (value: string) => string;
}>): { ok: true; normalizedWorkspaceRoot: string | null } | { ok: false } {
  const t = params.target;
  if (t.t === 'allMachines') return { ok: true, normalizedWorkspaceRoot: null };
  if (t.t === 'machine') {
    if (t.machineId !== params.machineId) return { ok: false };
    return { ok: true, normalizedWorkspaceRoot: null };
  }
  if (t.t === 'workspace') {
    if (t.machineId !== params.machineId) return { ok: false };
    const root = params.normalizePath(t.workspaceRoot);
    if (!isPathWithinRoot(params.normalizedDirectory, root)) return { ok: false };
    return { ok: true, normalizedWorkspaceRoot: root };
  }
  return { ok: false };
}

function applyRecordPatch(
  base: Record<string, McpValueRefV1>,
  patch: Record<string, McpValueRefV1 | null> | undefined,
): Record<string, McpValueRefV1> {
  if (!patch) return base;
  let out: Record<string, McpValueRefV1> | null = null;

  const ensureOut = (): Record<string, McpValueRefV1> => {
    if (out) return out;
    out = { ...base };
    return out;
  };

  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      if (Object.prototype.hasOwnProperty.call(base, k)) {
        const next = ensureOut();
        delete next[k];
      }
      continue;
    }
    if (base[k] !== v) {
      const next = ensureOut();
      next[k] = v;
    }
  }
  return out ?? base;
}

function applyBindingOverrides(
  server: McpServerCatalogEntryV1,
  overrides: McpServerBindingOverridesV1 | null | undefined,
): McpServerCatalogEntryV1 {
  if (!overrides) return server;

  let out: McpServerCatalogEntryV1 = server;

  if (overrides.envPatch) {
    const nextEnv = applyRecordPatch(server.env, overrides.envPatch);
    if (nextEnv !== server.env) out = { ...out, env: nextEnv };
  }

  if (server.transport === 'stdio' && server.stdio && overrides.stdio) {
    const nextCommand = overrides.stdio.command ?? server.stdio.command;
    const nextArgs = overrides.stdio.args ?? server.stdio.args;
    if (nextCommand !== server.stdio.command || nextArgs !== server.stdio.args) {
      out = { ...out, stdio: { command: nextCommand, args: nextArgs } };
    }
  }

  if (server.transport !== 'stdio' && server.remote && overrides.remote) {
    const nextUrl = overrides.remote.url ?? server.remote.url;
    const nextHeaders = overrides.remote.headersPatch
      ? applyRecordPatch(server.remote.headers, overrides.remote.headersPatch)
      : server.remote.headers;
    if (nextUrl !== server.remote.url || nextHeaders !== server.remote.headers) {
      out = { ...out, remote: { url: nextUrl, headers: nextHeaders } };
    }
  }

  return out;
}

type BindingCandidate = Readonly<{
  binding: McpServerBindingV1;
  normalizedWorkspaceRoot: string | null;
  score: BindingScore;
}>;

function selectBestBinding(candidates: ReadonlyArray<BindingCandidate>): BindingCandidate | null {
  let winner: BindingCandidate | null = null;
  for (const candidate of candidates) {
    if (!winner || compareScores(candidate.score, winner.score) > 0) {
      winner = candidate;
    }
  }
  return winner;
}

export function resolveApplicableServerBindingV1(params: Readonly<{
  server: McpServerCatalogEntryV1;
  bindings: ReadonlyArray<McpServerBindingV1>;
  machineId: string;
  directory: string;
  normalizePath?: (value: string) => string;
}>): ResolvedServerBindingV1 {
  const normalizePath = params.normalizePath ?? defaultNormalizeMcpPathV1;
  const normalizedDirectory = normalizePath(params.directory);

  const candidates: BindingCandidate[] = [];
  for (const binding of params.bindings) {
    if (binding.serverId !== params.server.id) continue;
    const applicable = isBindingApplicable({
      target: binding.target,
      machineId: params.machineId,
      normalizedDirectory,
      normalizePath,
    });
    if (!applicable.ok) continue;
    candidates.push({
      binding,
      normalizedWorkspaceRoot: applicable.normalizedWorkspaceRoot,
      score: scoreBinding(binding, applicable.normalizedWorkspaceRoot),
    });
  }

  const winner = selectBestBinding(candidates);
  if (!winner) {
    return {
      binding: null,
      bindingId: null,
      bindingTargetKind: null,
      enabled: false,
      config: params.server,
    };
  }

  return {
    binding: winner.binding,
    bindingId: winner.binding.id,
    bindingTargetKind: winner.binding.target.t,
    enabled: winner.binding.enabled,
    config: applyBindingOverrides(params.server, winner.binding.overrides),
  };
}

export function resolvePortableServerBindingV1(params: Readonly<{
  server: McpServerCatalogEntryV1;
  bindings: ReadonlyArray<McpServerBindingV1>;
}>): ResolvedServerBindingV1 | null {
  const candidates: BindingCandidate[] = [];
  for (const binding of params.bindings) {
    if (binding.serverId !== params.server.id) continue;
    if (binding.target.t !== 'allMachines') continue;
    candidates.push({
      binding,
      normalizedWorkspaceRoot: null,
      score: scoreBinding(binding, null),
    });
  }

  const winner = selectBestBinding(candidates);
  if (!winner) return null;

  return {
    binding: winner.binding,
    bindingId: winner.binding.id,
    bindingTargetKind: 'allMachines',
    enabled: winner.binding.enabled,
    config: applyBindingOverrides(params.server, winner.binding.overrides),
  };
}
