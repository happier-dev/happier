import { isSameMachineLocality, resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol';
import {
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  type RpcErrorCarrier,
} from '@happier-dev/protocol/rpcErrors';
import { resolveSessionMachineRpcTarget } from '@/sync/domains/session/resolveSessionReachableMachineId';
import { resolveSessionDisplayTarget } from '@/sync/domains/machines/identity/resolveSessionMachineTargets';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { resolveSessionMachineId } from '@/sync/domains/session/directSessions/resolveSessionMachineId';
import { normalizeKnownProjectMachineId } from '@/sync/runtime/orchestration/projectKeyIdentity';
import { resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';

type SessionTargetMetadataLike = Readonly<{
  machineId?: string | null;
  path?: string | null;
  host?: string | null;
  homeDir?: string | null;
  sessionWorkspaceLocationV1?: unknown;
  directSessionV1?: Readonly<{
    v?: number;
    providerId?: string | null;
    machineId?: string | null;
    remoteSessionId?: string | null;
  }> | null;
}> | null | undefined;

type MachineTargetLikeState = Readonly<{
  sessions?: Record<string, {
    active?: boolean;
    updatedAt?: number;
    metadata?: SessionTargetMetadataLike;
  }>;
  machines?: Record<string, Machine>;
  machineDisplayById?: Record<string, MachineDisplayRenderable>;
  getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
}>;

export type SessionMachineTargetState = MachineTargetLikeState;

export type SessionMachineControlTarget = Readonly<{
  machineId: string;
  basePath: string;
  agentBasePath?: string;
  confidence: 'reachable' | 'metadata_direct';
}>;

export type SessionMachineTarget = Readonly<{
  machineId: string;
  basePath: string;
  agentBasePath?: string;
}>;

type MachineControlCandidate = Readonly<{
  id: string;
  active?: boolean;
  revokedAt?: number | null;
  replacedByMachineId?: string | null;
  metadata?: Readonly<{
    host?: string | null;
    homeDir?: string | null;
  }> | null;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveUniqueActiveMachineByHost(
  machines: ReadonlyArray<MachineControlCandidate>,
  host: string | null,
): MachineControlCandidate | null {
  if (!host) return null;
  const matches = machines.filter((machine) => {
    const machineHost = normalizeNonEmptyString(machine.metadata?.host);
    return machine.active === true
      && !machine.revokedAt
      && !machine.replacedByMachineId
      && machineHost === host;
  });
  return matches.length === 1 ? matches[0] ?? null : null;
}

function resolveUniqueActiveMachineByHostAndHome(input: Readonly<{
  machines: ReadonlyArray<MachineControlCandidate>;
  host: string | null;
  homeDir: string | null;
}>): MachineControlCandidate | null {
  if (!input.host || !input.homeDir) return null;
  const matches = input.machines.filter((machine) => {
    const machineHost = normalizeNonEmptyString(machine.metadata?.host);
    const machineHomeDir = normalizeNonEmptyString(machine.metadata?.homeDir);
    return machine.active === true
      && !machine.revokedAt
      && !machine.replacedByMachineId
      && isSameMachineLocality({
        sessionHost: input.host,
        sessionHomeDir: input.homeDir,
        currentHost: machineHost,
        currentHomeDir: machineHomeDir,
        homeDir: machineHomeDir,
      });
  });
  return matches.length === 1 ? matches[0] ?? null : null;
}

function resolveLegacyHostMachineTarget(input: Readonly<{
  metadata: SessionTargetMetadataLike;
  projectMachineId?: string | null;
  machines: ReadonlyArray<Machine>;
}>): { machineId: string; basePath: string } | null {
  if (resolveSessionMachineId(input.metadata)) return null;
  if (normalizeNonEmptyString(input.projectMachineId)) return null;

  const basePath = normalizeNonEmptyString(input.metadata?.path);
  if (!basePath) return null;

  const machine = resolveUniqueActiveMachineByHost(input.machines, normalizeNonEmptyString(input.metadata?.host));
  return machine ? { machineId: machine.id, basePath } : null;
}

export function resolveMachineTargetForSessionFromState(
  state: SessionMachineTargetState,
  sessionId: string,
): SessionMachineTarget | null {
  const session = state.sessions?.[sessionId];
  const metadata = session?.metadata ?? null;
  const project = typeof state.getProjectForSession === 'function' ? state.getProjectForSession(sessionId) : null;

  const machinesById = state.machines ?? {};
  // Project keys use a synthetic "unknown" machine scope for sessions without a
  // machineId; it is a grouping key, not a machine, and must not steer targeting.
  const projectMachineId = normalizeKnownProjectMachineId(project?.key?.machineId);
  const target = resolveSessionMachineRpcTarget({
    sessionId,
    sessionActive: session?.active === true,
    sessionMachineId: resolveSessionMachineId(metadata),
    sessionPath: normalizeNonEmptyString(metadata?.path),
    projectMachineId,
    projectPath: normalizeNonEmptyString(project?.key?.path),
    machines: machinesById,
  });
  // Only the legacy host-match fallback needs to *scan* machines, and `??` reaches it only when
  // id-based targeting already failed — so the list is materialised on that path alone.
  const resolvedTarget = target ?? resolveLegacyHostMachineTarget({
    metadata,
    projectMachineId,
    machines: Object.values(machinesById) as Machine[],
  });
  return resolveWorkspaceLocationForMachineTarget(metadata, resolvedTarget);
}

function resolveWorkspaceLocationForMachineTarget(
  metadata: SessionTargetMetadataLike,
  target: Readonly<{ machineId: string; basePath: string }> | null,
): SessionMachineTarget | null {
  if (!target) return null;
  const resolved = resolveSessionWorkspaceRootForMachine({
    metadata,
    machineId: target.machineId,
    candidatePath: target.basePath,
  });
  if (!resolved.agentPath || resolved.machinePath === resolved.agentPath) return target;
  return {
    machineId: target.machineId,
    basePath: resolved.machinePath,
    agentBasePath: resolved.agentPath,
  };
}

function hasKnownUnavailableMachineState(machine: MachineControlCandidate | undefined): boolean {
  if (!machine) return false;
  if (machine.revokedAt && machine.revokedAt > 0) return true;
  if (machine.replacedByMachineId) return true;
  return machine.active !== true;
}

function resolveMachineControlCandidates(state: SessionMachineTargetState): ReadonlyArray<MachineControlCandidate> {
  const byId = new Map<string, MachineControlCandidate>();
  for (const machine of Object.values(state.machineDisplayById ?? {})) {
    byId.set(machine.id, machine);
  }
  for (const machine of Object.values(state.machines ?? {})) {
    byId.set(machine.id, machine);
  }
  return Array.from(byId.values());
}

function resolveStaleInactiveMachineControlTarget(input: Readonly<{
  displayTarget: { machineId: string; basePath: string } | null;
  metadata: SessionTargetMetadataLike;
  knownMachine: MachineControlCandidate | undefined;
  machines: ReadonlyArray<MachineControlCandidate>;
}>): SessionMachineControlTarget | null {
  const knownMachine = input.knownMachine;
  if (knownMachine) {
    if (knownMachine.revokedAt && knownMachine.revokedAt > 0) return null;
    if (knownMachine.replacedByMachineId) return null;
    if (knownMachine.active === true) return null;
  }

  const basePath = normalizeNonEmptyString(input.displayTarget?.basePath)
    ?? normalizeNonEmptyString(input.metadata?.path);
  if (!basePath) return null;

  const host = normalizeNonEmptyString(input.metadata?.host)
    ?? normalizeNonEmptyString(knownMachine?.metadata?.host);
  const homeDir = normalizeNonEmptyString(input.metadata?.homeDir)
    ?? normalizeNonEmptyString(knownMachine?.metadata?.homeDir);
  const activeMachine = resolveUniqueActiveMachineByHostAndHome({
    machines: input.machines,
    host,
    homeDir,
  });
  if (!activeMachine) return null;

  const workspaceTarget = resolveWorkspaceLocationForMachineTarget(input.metadata, {
    machineId: activeMachine.id,
    basePath,
  });
  if (!workspaceTarget) return null;
  return {
    ...workspaceTarget,
    confidence: 'reachable',
  };
}

export function resolveMachineControlTargetForSessionFromState(
  state: SessionMachineTargetState,
  sessionId: string,
): SessionMachineControlTarget | null {
  const reachableTarget = resolveMachineTargetForSessionFromState(state, sessionId);
  if (reachableTarget) {
    return {
      ...reachableTarget,
      confidence: 'reachable',
    };
  }

  const displayTarget = resolveDisplayMachineTargetForSessionFromState({ state, sessionId });
  if (!displayTarget) return null;

  const controlMachines = resolveMachineControlCandidates(state);
  const knownMachine = controlMachines.find((machine) => machine.id === displayTarget.machineId);
  if (hasKnownUnavailableMachineState(knownMachine)) {
    return resolveStaleInactiveMachineControlTarget({
      displayTarget,
      metadata: state.sessions?.[sessionId]?.metadata ?? null,
      knownMachine,
      machines: controlMachines,
    });
  }
  if (!knownMachine) {
    const replacement = resolveStaleInactiveMachineControlTarget({
      displayTarget,
      metadata: state.sessions?.[sessionId]?.metadata ?? null,
      knownMachine,
      machines: controlMachines,
    });
    if (replacement) return replacement;
  }

  const session = state.sessions?.[sessionId];
  const project = typeof state.getProjectForSession === 'function' ? state.getProjectForSession(sessionId) : null;
  const sessionMachineId = resolveSessionMachineId(session?.metadata ?? null);
  const projectMachineId = normalizeNonEmptyString(project?.key?.machineId);
  if (
    sessionMachineId
    && !knownMachine
    && projectMachineId
    && projectMachineId !== sessionMachineId
    && !projectMachineId.startsWith('host:')
  ) {
    return null;
  }

  // The display target can carry the synthetic "unknown" project machine scope for
  // sessions without a machineId. That placeholder is not a routable machine — handing
  // it out as a control target produces RPCs that can never be delivered and whose
  // failures surface nowhere.
  if (normalizeKnownProjectMachineId(displayTarget.machineId) === null) {
    return null;
  }

  const workspaceTarget = resolveWorkspaceLocationForMachineTarget(session?.metadata ?? null, displayTarget);
  if (!workspaceTarget) return null;
  return {
    ...workspaceTarget,
    confidence: 'metadata_direct',
  };
}

export function readMachineTargetForSession(
  sessionId: string,
): SessionMachineTarget | null {
  return resolveMachineTargetForSessionFromState(storage.getState() as SessionMachineTargetState, sessionId);
}

export function readMachineControlTargetForSession(
  sessionId: string,
): SessionMachineControlTarget | null {
  return resolveMachineControlTargetForSessionFromState(storage.getState() as SessionMachineTargetState, sessionId);
}

export function resolveDisplayMachineTargetForSessionFromState(input: Readonly<{
  state: SessionMachineTargetState;
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): { machineId: string; basePath: string } | null {
  const sessionId = normalizeNonEmptyString(input.sessionId);
  if (sessionId) {
    const session = input.state.sessions?.[sessionId];
    const metadata = session?.metadata ?? input.metadata ?? null;
    const project = typeof input.state.getProjectForSession === 'function'
      ? input.state.getProjectForSession(sessionId)
      : null;
    return resolveSessionDisplayTarget({
      sessionActive: session?.active === true,
      sessionMachineId: resolveSessionMachineId(metadata),
      sessionPath: normalizeNonEmptyString(metadata?.path),
      projectMachineId: project?.key?.machineId ?? null,
      projectPath: normalizeNonEmptyString(project?.key?.path),
      // The store's own id-keyed record, handed over as-is. This resolver is called once per
      // session inside store-write loops, so materialising a list here rebuilt the machine index
      // per session — O(sessions x machines) allocation on the hottest write path in the app.
      machines: input.state.machines ?? {},
    });
  }

  const metadata = input.metadata ?? null;
  return resolveSessionDisplayTarget({
    sessionActive: false,
    sessionMachineId: resolveSessionMachineId(metadata),
    sessionPath: normalizeNonEmptyString(metadata?.path),
    projectMachineId: null,
    projectPath: null,
    machines: input.state.machines ?? {},
  });
}

export function readDisplayMachineTargetForSession(input: Readonly<{
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): { machineId: string; basePath: string } | null {
  return resolveDisplayMachineTargetForSessionFromState({
    state: storage.getState() as SessionMachineTargetState,
    sessionId: input.sessionId,
    metadata: input.metadata,
  });
}

/**
 * What a session row shows: the machine it is attributed to and the path under it, each falling
 * back to the session's own metadata when no display target resolves.
 *
 * Both values come out of one target resolution. Asking for them separately resolved the same
 * target — and re-read the project for the same session — twice per row, which is pure waste for
 * any caller that needs both (every session-row and recent-path projection does).
 */
export type SessionDisplayIdentity = Readonly<{
  machineId: string;
  basePath: string;
}>;

export function resolveDisplayIdentityForSessionFromState(input: Readonly<{
  state: SessionMachineTargetState;
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): SessionDisplayIdentity {
  const target = resolveDisplayMachineTargetForSessionFromState({
    state: input.state,
    sessionId: normalizeNonEmptyString(input.sessionId),
    metadata: input.metadata,
  });
  return {
    machineId: target?.machineId || resolveSessionMachineId(input.metadata) || '',
    basePath: target?.basePath || normalizeNonEmptyString(input.metadata?.path) || '',
  };
}

export function resolveDisplayMachineIdForSessionFromState(input: Readonly<{
  state: SessionMachineTargetState;
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): string {
  return resolveDisplayIdentityForSessionFromState(input).machineId;
}

export function resolveDisplayPathForSessionFromState(input: Readonly<{
  state: SessionMachineTargetState;
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): string {
  return resolveDisplayIdentityForSessionFromState(input).basePath;
}

export function readDisplayMachineIdForSession(input: Readonly<{
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): string {
  return resolveDisplayMachineIdForSessionFromState({
    state: storage.getState() as SessionMachineTargetState,
    sessionId: input.sessionId,
    metadata: input.metadata,
  });
}

export function readDisplayPathForSession(input: Readonly<{
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): string {
  return resolveDisplayPathForSessionFromState({
    state: storage.getState() as SessionMachineTargetState,
    sessionId: input.sessionId,
    metadata: input.metadata,
  });
}

export function readDisplayIdentityForSession(input: Readonly<{
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): SessionDisplayIdentity {
  return resolveDisplayIdentityForSessionFromState({
    state: storage.getState() as SessionMachineTargetState,
    sessionId: input.sessionId,
    metadata: input.metadata,
  });
}

export function resolveMachinePathFromSessionBase(input: {
  basePath: string;
  agentBasePath?: string;
  requestPath?: string;
}): string {
  const requestPath = input.requestPath;
  if (!requestPath || requestPath === '.') return input.basePath;
  if (requestPath.startsWith('~')) return requestPath;

  const isAbsolutePosix = requestPath.startsWith('/');
  const isAbsoluteWindows = /^[a-zA-Z]:[\\/]/.test(requestPath) || requestPath.startsWith('\\\\');
  if (isAbsolutePosix || isAbsoluteWindows) {
    const relative = input.agentBasePath
      ? resolvePathRelativeToRoot({ path: requestPath, root: input.agentBasePath })
      : null;
    if (relative === null) return requestPath;
    if (relative === '.') return input.basePath;
    const separator = input.basePath.includes('\\') ? '\\' : '/';
    const base = input.basePath.endsWith(separator) ? input.basePath.slice(0, -1) : input.basePath;
    return `${base}${separator}${relative.replace(/[\\/]/g, separator)}`;
  }

  const separator = input.basePath.includes('\\') ? '\\' : '/';
  const base = input.basePath.endsWith(separator) ? input.basePath.slice(0, -1) : input.basePath;
  const rel = requestPath.startsWith(separator) ? requestPath.slice(1) : requestPath;
  return `${base}${separator}${rel}`;
}

export function shouldFallbackFromMachineRpc(error: unknown): boolean {
  if (error instanceof Error && typeof error.message === 'string') {
    if (error.message.includes('Machine encryption not found')) return true;
    if (error.message.includes('Socket not connected')) return true;
    if (error.message.includes('Scoped RPC socket connection timeout')) return true;
    if (error.message.includes('Scoped RPC socket connection failed')) return true;
  }

  if (error && typeof error === 'object') {
    const rpcError: RpcErrorCarrier = {
      rpcErrorCode:
        typeof (error as { rpcErrorCode?: unknown }).rpcErrorCode === 'string'
          ? (error as { rpcErrorCode: string }).rpcErrorCode
          : undefined,
      message:
        typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : undefined,
    };
    return isRpcMethodNotAvailableError(rpcError)
      || isRpcMethodNotFoundError(rpcError);
  }

  return false;
}

export function shouldFallbackToSessionRpc(sessionId: string, error: unknown): boolean {
  if (!shouldFallbackFromMachineRpc(error)) return false;
  return canUseSessionRpc(sessionId);
}

export function canUseSessionRpc(sessionId: string): boolean {
  const state = storage.getState();
  const session = state.sessions?.[sessionId];
  if (!session) return true;
  return session.active !== false;
}
