import type { MachineWorkspaceRefV1, ManagedWorkspaceLocatorV2, ManagedWorkspaceRefV2, ProjectKeyV1, QualifiedProjectKeyV1, WorkspaceAddressV1, WorkspaceAddressV2, WorkspaceProjectFactsV1, WorkspaceRefV1 } from './workspaceRefV1.js';
import { isManagedWorkspaceRefV2 } from './workspaceRefV1.js';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '../scm/hostingRepositoryIdentity.js';
import { resolveSessionWorkspaceRootForMachine } from '../sessions/metadata/sessionWorkspaceLocationV1.js';
import { readSessionDirectoryKind } from '../sessions/metadata/sessionDirectoryV1.js';

export type WorkspaceRefResolutionV1<T extends WorkspaceRefV1 = WorkspaceRefV1> =
  | Readonly<{ kind: 'resolved'; ref: T }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'ambiguous'; candidates: readonly T[] }>
  | Readonly<{ kind: 'invalid'; reason: string }>;

export type WorkspaceRefResolutionContextV1 = Readonly<{
  normalizeServerId?: (serverId: string) => string;
  normalizeRootPath?: (rootPath: string, ref?: WorkspaceRefV1) => string | null;
  rootsEqual?: (left: string, right: string) => boolean;
  /** Accepted non-content Session row projection, independent of private metadata/ref availability. */
  projectKey?: string | null;
  /** Supplied refs are a complete admitted census unless explicitly marked incomplete. */
  censusComplete?: boolean;
  /** Collection-owned index over this same admitted census; never a second identity decision. */
  sessionProjectKeyResolver?: (metadata: unknown, serverId: string, projectKey?: string | null) => SessionProjectKeyResolutionV1;
}>;

/** Existing checkout display semantics, shared by clients and native Project labels. */
export function resolveWorkspacePathBasenameV1(path: string): string | null {
  const normalized = path.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/).filter(segment => segment.length > 0);
  const terminalSegment = segments[segments.length - 1] ?? normalized;
  return terminalSegment.length > 0 ? terminalSegment : null;
}

/** Comparable target-platform spelling only; never expands a remote home on this machine. */
export function normalizeWorkspaceRootPathV1(value: unknown, platform?: 'win32' | 'posix' | null): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const path = value.trim().replace(/\\/g, '/');
  const device = /^\/\/\?\/unc\//i.test(path) ? `//${path.slice(8)}` : path.replace(/^\/\/\?\//, '');
  const unc = device.startsWith('//');
  const collapsed = unc ? `//${device.slice(2).replace(/\/{2,}/g, '/')}` : device.replace(/\/{2,}/g, '/');
  const trimmed = collapsed.replace(/\/+$/, '') || collapsed;
  const caseInsensitive = platform === 'win32' || (platform == null && (/^[a-z]:\//i.test(collapsed) || unc));
  return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

/** Absolute-root admission shares normalization, including drive roots and device prefixes. */
export function isAbsoluteWorkspaceRootPathV1(value: unknown): boolean {
  const normalized = normalizeWorkspaceRootPathV1(value);
  if (normalized === null || typeof value !== 'string') return false;
  return normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)
    || /^[a-z]:$/i.test(normalized) && /[\\/]$/.test(value.trim());
}

/** Comparison only: roots and display values retain their original spelling. */
export function isWorkspacePathWithinRootV1(directory: string, root: string, platform?: 'win32' | 'posix' | null): boolean {
  const normalizedDirectory = normalizeWorkspaceRootPathV1(directory, platform);
  const normalizedRoot = normalizeWorkspaceRootPathV1(root, platform);
  if (!normalizedDirectory || !normalizedRoot) return false;
  return normalizedDirectory === normalizedRoot
    || normalizedDirectory.startsWith(normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`);
}

/** One exact checkout decision. An unqualified id preserves all Homes as candidates. */
export function resolveWorkspaceRefV1<T extends WorkspaceRefV1>(
  refs: readonly T[], target: (WorkspaceAddressV1 | Extract<ProjectKeyV1, { machineId: string }>) & { kind?: never },
  context?: WorkspaceRefResolutionContextV1,
): WorkspaceRefResolutionV1<Extract<T, MachineWorkspaceRefV1>>;
export function resolveWorkspaceRefV1<T extends WorkspaceRefV1>(
  refs: readonly T[], target: ProjectKeyV1 | WorkspaceAddressV2 | ManagedWorkspaceLocatorV2,
  context?: WorkspaceRefResolutionContextV1,
): WorkspaceRefResolutionV1<T>;
export function resolveWorkspaceRefV1<T extends WorkspaceRefV1>(
  refs: readonly T[], target: ProjectKeyV1 | WorkspaceAddressV2 | ManagedWorkspaceLocatorV2,
  context: WorkspaceRefResolutionContextV1 = {},
): WorkspaceRefResolutionV1<T> {
  if ('projectKey' in target) return { kind: 'invalid', reason: 'A Project anchor does not select an exact checkout' };
  const server = (value: string) => (context.normalizeServerId?.(value.trim()) ?? value.trim());
  const id = 'workspaceId' in target ? target.workspaceId.trim() : 'id' in target ? target.id.trim() : null;
  const serverId = target.serverId === undefined ? null : server(target.serverId);
  const hasRoot = 'rootPath' in target;
  const managedTarget = isManagedWorkspaceRefV2(target) ? target : null;
  const normalizeRoot = context.normalizeRootPath ?? ((path: string) => normalizeWorkspaceRootPathV1(path));
  const rootPath = hasRoot ? normalizeRoot(target.rootPath) : null;
  const machineId = hasRoot && !isManagedWorkspaceRefV2(target) ? target.machineId.trim() : null;
  if ((id !== null && !id) || (target.serverId !== undefined && !serverId)
      || (hasRoot && (!serverId || !rootPath || (managedTarget
        ? !managedTarget.managedId.trim() || !managedTarget.controller.machineId.trim() || !managedTarget.controller.installationId.trim()
        : !machineId)))) {
    return { kind: 'invalid', reason: 'Workspace address is incomplete' };
  }
  const candidates = refs.filter(ref => {
    const identity: WorkspaceRefV1 = ref;
    if (serverId !== null && server(ref.serverId) !== serverId) return false;
    if (id !== null && ref.id.trim() !== id) return false;
    if (!hasRoot) return true;
    if (managedTarget) {
      if (!isManagedWorkspaceRefV2(ref) || ref.managedId.trim() !== managedTarget.managedId.trim()
        || ref.controller.machineId.trim() !== managedTarget.controller.machineId.trim()
        || ref.controller.installationId.trim() !== managedTarget.controller.installationId.trim()) return false;
    } else if (isManagedWorkspaceRefV2(identity) || identity.machineId.trim() !== machineId) return false;
    return context.rootsEqual
      ? context.rootsEqual(normalizeRoot(ref.rootPath, ref) ?? ref.rootPath, rootPath!)
      : normalizeRoot(ref.rootPath, ref) === rootPath;
  });
  return candidates.length === 0 ? { kind: 'missing' }
    : candidates.length === 1 ? { kind: 'resolved', ref: candidates[0]! }
      : { kind: 'ambiguous', candidates };
}

export function projectWorkspaceRefV1(ref: WorkspaceRefV1): QualifiedProjectKeyV1 {
  return { serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id };
}

export type SessionProjectKeyResolutionV1<T extends WorkspaceRefV1 = WorkspaceRefV1> =
  | Readonly<{ kind: 'resolved'; projectKey: QualifiedProjectKeyV1; ref?: T }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * Which Project a stamped key belongs to now (owner 11-08): a key that is a Project's anchor is that Project; otherwise
 * the Project of the checkout whose own id it is. This is the membership `projectScopeKeysV1` gives a Project (its
 * anchor plus each member's own id), read in the other direction. A key no checkout carries stays as it is.
 */
export function createProjectAnchorOfKeyV1(
  refs: readonly WorkspaceRefV1[] | undefined,
  context: Pick<WorkspaceRefResolutionContextV1, 'normalizeServerId'> = {},
): (serverId: string, key: string) => string {
  const normalizeServerId = context.normalizeServerId ?? ((value: string) => value.trim());
  // This census and its lookups share one normalization per distinct Home identifier.
  const homes = new Map<string, string>();
  const home = (identifier: string) => {
    const known = homes.get(identifier);
    if (known !== undefined) return known;
    const normalized = normalizeServerId(identifier);
    homes.set(identifier, normalized);
    return normalized;
  };
  const anchors = new Set<string>();
  const anchorById = new Map<string, string>();
  for (const ref of refs ?? []) {
    const anchor = ref.projectKey ?? ref.id;
    anchors.add(JSON.stringify([home(ref.serverId), anchor]));
    anchorById.set(JSON.stringify([home(ref.serverId), ref.id]), anchor);
  }
  return (serverId, key) => {
    const qualified = JSON.stringify([home(serverId), key]);
    return anchors.has(qualified) ? key : anchorById.get(qualified) ?? key;
  };
}

/**
 * One accepted Project association for row grouping, filtering and private Project consumers. With the census, a
 * Session stamped before its checkout joined or left a Project resolves to the Project it belongs to now.
 */
export function resolveSessionProjectKeyV1<T extends WorkspaceRefV1>(
  metadata: unknown,
  serverId: string,
  refs?: readonly T[],
  context: WorkspaceRefResolutionContextV1 = {},
): SessionProjectKeyResolutionV1<T> {
  return resolveSessionProjectKeyUsingV1(metadata, serverId, refs, context,
    target => resolveWorkspaceRefV1(refs ?? [], target, context), refs ? createProjectAnchorOfKeyV1(refs, context) : null);
}

export type SessionProjectCheckoutTargetV1 =
  | Readonly<{ serverId: string; id: string }>
  | Readonly<{ serverId: string; machineId: string; rootPath: string }>;

/**
 * `resolveWorkspaceRefV1` for many lookups over one census: each ref is normalized once and a
 * lookup resolves only among its exact-key bucket, so N lookups cost N + refs, not N × refs.
 */
export function createWorkspaceRefResolverV1<T extends WorkspaceRefV1>(
  refs: readonly T[] | undefined,
  context: WorkspaceRefResolutionContextV1 = {},
): (target: SessionProjectCheckoutTargetV1) => WorkspaceRefResolutionV1<T> {
  const home = context.normalizeServerId ?? ((value: string) => value.trim());
  const normalizeRoot = context.normalizeRootPath ?? ((value: string) => normalizeWorkspaceRootPathV1(value));
  const byId = new Map<string, T[]>();
  const byRoot = new Map<string, T[]>();
  const append = (index: Map<string, T[]>, key: string, ref: T) => {
    const previous = index.get(key);
    if (previous) previous.push(ref); else index.set(key, [ref]);
  };
  for (const ref of refs ?? []) {
    const identity: WorkspaceRefV1 = ref;
    append(byId, JSON.stringify([home(ref.serverId.trim()), ref.id.trim()]), ref);
    if (!isManagedWorkspaceRefV2(identity)) {
      append(byRoot, JSON.stringify([home(ref.serverId.trim()), identity.machineId.trim(), normalizeRoot(ref.rootPath, ref)]), ref);
    }
  }
  return (target) => {
    const candidates = 'id' in target
      ? byId.get(JSON.stringify([home(target.serverId.trim()), target.id.trim()])) ?? []
      : context.rootsEqual ? refs ?? []
        : byRoot.get(JSON.stringify([home(target.serverId.trim()), target.machineId.trim(), normalizeRoot(target.rootPath)])) ?? [];
    return resolveWorkspaceRefV1(candidates, target, context);
  };
}

/** A visible collection shares one admitted census index; it retains no Session bodies. */
export function createSessionProjectKeyResolverV1<T extends WorkspaceRefV1>(
  refs: readonly T[] | undefined,
  context: WorkspaceRefResolutionContextV1 = {},
): (metadata: unknown, serverId: string, projectKey?: string | null) => SessionProjectKeyResolutionV1<T> {
  const resolve = createWorkspaceRefResolverV1(refs, context);
  const anchorOf = refs ? createProjectAnchorOfKeyV1(refs, context) : null;
  return (metadata, serverId, projectKey = context.projectKey) => resolveSessionProjectKeyUsingV1(
    metadata, serverId, refs, { ...context, projectKey }, resolve, anchorOf);
}

function resolveSessionProjectKeyUsingV1<T extends WorkspaceRefV1>(
  metadata: unknown,
  serverId: string,
  refs: readonly T[] | undefined,
  context: WorkspaceRefResolutionContextV1,
  resolveRef: (target: SessionProjectCheckoutTargetV1) => WorkspaceRefResolutionV1<T>,
  anchorOf: ((serverId: string, key: string) => string) | null = null,
): SessionProjectKeyResolutionV1<T> {
  const home = context.normalizeServerId ?? ((value: string) => value.trim());
  const qualifiedHome = home(serverId);
  if (!qualifiedHome) return { kind: 'unavailable' };
  if (context.projectKey != null) {
    return context.projectKey.trim()
      ? { kind: 'resolved', projectKey: { serverId: qualifiedHome, projectKey: anchorOf ? anchorOf(qualifiedHome, context.projectKey) : context.projectKey } }
      : { kind: 'unavailable' };
  }
  if (readSessionDirectoryKind(metadata) === 'managed') return { kind: 'none' };
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || refs === undefined || context.censusComplete === false) {
    return { kind: 'unavailable' };
  }
  const workspaceId: unknown = Reflect.get(metadata, 'workspaceId');
  const projectId: unknown = Reflect.get(metadata, 'projectId');
  const explicit = workspaceId !== undefined && workspaceId !== null;
  if (explicit && (typeof workspaceId !== 'string' || !workspaceId.trim())) return { kind: 'unavailable' };
  const machineId: unknown = Reflect.get(metadata, 'machineId');
  const path: unknown = Reflect.get(metadata, 'path');
  const target = typeof workspaceId === 'string'
    ? { serverId: qualifiedHome, id: workspaceId }
    : typeof machineId === 'string' && machineId.trim() && typeof path === 'string' && path.trim()
      ? { serverId: qualifiedHome, machineId, rootPath: resolveSessionWorkspaceRootForMachine({ metadata, machineId, candidatePath: path }).machinePath }
      : null;
  if (!target) return { kind: projectId != null ? 'unavailable' : 'none' };
  const resolved = resolveRef(target);
  if (resolved.kind === 'missing' && !explicit && projectId == null) return { kind: 'none' };
  if (resolved.kind !== 'resolved') return { kind: 'unavailable' };
  const projectKey = projectWorkspaceRefV1(resolved.ref);
  // A Project id stamped before the checkout joined or left a Project still names it through its current Project.
  const stampedProject = typeof projectId === 'string' && anchorOf ? anchorOf(qualifiedHome, projectId) : projectId;
  if (projectId != null && stampedProject !== projectKey.projectKey) return { kind: 'unavailable' };
  return { kind: 'resolved', projectKey: { ...projectKey, serverId: home(projectKey.serverId) }, ref: resolved.ref };
}

type WorkspaceAddressIdentityV2 = Pick<MachineWorkspaceRefV1, 'id' | 'serverId' | 'machineId' | 'rootPath'>
  | Pick<ManagedWorkspaceRefV2, 'v' | 'kind' | 'id' | 'serverId' | 'managedId' | 'controller' | 'rootPath'>;

export function workspaceAddressFromRefV1(ref: WorkspaceAddressIdentityV2): WorkspaceAddressV1 {
  if (isManagedWorkspaceRefV2(ref)) {
    throw Object.assign(new Error('A managed workspace is not a Machine workspace address'), { code: 'workspace_managed_target_required' });
  }
  return { serverId: ref.serverId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath };
}

export function workspaceAddressFromRefV2(ref: WorkspaceAddressIdentityV2): WorkspaceAddressV2 {
  return isManagedWorkspaceRefV2(ref) ? {
    v: 2, kind: 'managed', serverId: ref.serverId, workspaceId: ref.id,
    managedId: ref.managedId, controller: ref.controller, rootPath: ref.rootPath,
  } : workspaceAddressFromRefV1(ref);
}

/**
 * Enrichment keeps an accepted anchor, with one moment of grouping (owner 11-08): when a checkout that is still its
 * own Project learns its repository for the first time, it joins that repository's Project
 * (`resolveWorkspaceProjectKeyV1` over `refs`, the accepted census). A known identity never regroups again, so a
 * checkout the person separated stays separate, and a joined checkout (a worktree, a person's grouping) keeps its anchor.
 */
export function enrichWorkspaceRefV1<T extends WorkspaceRefV1>(
  ref: T, facts: WorkspaceProjectFactsV1 = {}, refs?: readonly WorkspaceRefV1[],
  context: Pick<WorkspaceRefResolutionContextV1, 'normalizeServerId'> = {},
): T {
  const anchor = ref.projectKey ?? ref.id;
  const identityArrives = !normalizeScmHostingRepositoryIdentity(ref.repositoryIdentity)
    && normalizeScmHostingRepositoryIdentity(facts.repositoryIdentity) !== null;
  const projectKey = refs && identityArrives && anchor === ref.id
    ? resolveWorkspaceProjectKeyV1(refs.filter(candidate => candidate !== ref && candidate.id !== ref.id),
      { serverId: ref.serverId, id: ref.id, repositoryIdentity: facts.repositoryIdentity }, context)
    : anchor;
  return { ...ref, ...facts, projectKey };
}

/** An executable repository choice must belong to the exact admitted Source pin. */
export function matchesRepositoryWorkspaceIntentV1(ref: WorkspaceRefV1, expected: Readonly<{
  source: NonNullable<WorkspaceRefV1['source']>;
  repositoryIdentity: NonNullable<WorkspaceRefV1['repositoryIdentity']>;
}>): boolean {
  return ref.source?.sourceId === expected.source.sourceId && ref.source.revision === expected.source.revision
    && sameScmHostingRepositoryIdentity(ref.repositoryIdentity, expected.repositoryIdentity);
}

/** Source/repository enrichment suggests candidates; it never chooses an exact checkout or merges accepted anchors. */
export function findWorkspaceProjectCandidatesV1<T extends WorkspaceRefV1>(
  refs: readonly T[], input: Readonly<{ serverId: string }> & WorkspaceProjectFactsV1,
  context: Pick<WorkspaceRefResolutionContextV1, 'normalizeServerId'> = {},
): readonly T[] {
  const server = context.normalizeServerId ?? ((id: string) => id.trim());
  const identity = normalizeScmHostingRepositoryIdentity(input.repositoryIdentity);
  return refs.filter(ref => server(ref.serverId) === server(input.serverId)
    && ((input.source && ref.source?.sourceId === input.source.sourceId)
      || (identity && sameScmHostingRepositoryIdentity(normalizeScmHostingRepositoryIdentity(ref.repositoryIdentity), identity))));
}

/**
 * The person's grouping (owner 11-08, `projects.workspace.update {projectKey}`): join an existing Project of the same
 * Home by its key, or `'self'` to separate the checkout into its own Project. The explicit key it yields wins over
 * upstream grouping, which only happens at accept and when a repository identity first arrives.
 */
export function resolveWorkspaceGroupingV1(
  refs: readonly WorkspaceRefV1[], ref: WorkspaceRefV1, request: string,
  context: Pick<WorkspaceRefResolutionContextV1, 'normalizeServerId'> = {},
): Readonly<{ ok: true; projectKey: string } | { ok: false; code: 'project_not_found' }> {
  if (request === 'self') return { ok: true, projectKey: ref.id };
  const server = context.normalizeServerId ?? ((id: string) => id.trim());
  const exists = refs.some(candidate => server(candidate.serverId) === server(ref.serverId) && (candidate.projectKey ?? candidate.id) === request);
  return exists ? { ok: true, projectKey: request } : { ok: false, code: 'project_not_found' };
}

/**
 * The Project a checkout joins when it is accepted or first learns its repository (owner 11-08): the anchor of the
 * earliest-added checkout with the same Source or upstream repository. No match (no remote, local-only, a fork with
 * its own repository): its own Project. Existing Projects are never merged here; the person groups them.
 */
export function resolveWorkspaceProjectKeyV1(
  refs: readonly WorkspaceRefV1[], input: Readonly<{ serverId: string; id: string }> & WorkspaceProjectFactsV1,
  context: Pick<WorkspaceRefResolutionContextV1, 'normalizeServerId'> = {},
): string {
  const earliest = [...findWorkspaceProjectCandidatesV1(refs, input, context)]
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))[0];
  return earliest ? earliest.projectKey ?? earliest.id : input.id;
}
