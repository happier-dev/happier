import type { ProjectKeyV1, QualifiedProjectKeyV1, WorkspaceAddressV1, WorkspaceProjectFactsV1, WorkspaceRefV1 } from './workspaceRefV1.js';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '../scm/hostingRepositoryIdentity.js';

export type WorkspaceRefResolutionV1<T extends WorkspaceRefV1 = WorkspaceRefV1> =
  | Readonly<{ kind: 'resolved'; ref: T }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'ambiguous'; candidates: readonly T[] }>
  | Readonly<{ kind: 'invalid'; reason: string }>;

export type WorkspaceRefResolutionContextV1 = Readonly<{
  normalizeServerId?: (serverId: string) => string;
  normalizeRootPath?: (rootPath: string, ref?: WorkspaceRefV1) => string | null;
  rootsEqual?: (left: string, right: string) => boolean;
}>;

/** Existing checkout display semantics, shared by clients and native Project labels. */
export function resolveWorkspacePathBasenameV1(path: string): string | null {
  const normalized = path.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/).filter(segment => segment.length > 0);
  const terminalSegment = segments[segments.length - 1] ?? normalized;
  return terminalSegment.length > 0 ? terminalSegment : null;
}

/** Comparable target-platform spelling only; never expands a remote home on this machine. */
export function normalizeWorkspaceRootPathV1(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const path = value.trim().replace(/\\/g, '/');
  const device = /^\/\/\?\/unc\//i.test(path) ? `//${path.slice(8)}` : path.replace(/^\/\/\?\//, '');
  const unc = device.startsWith('//');
  const collapsed = unc ? `//${device.slice(2).replace(/\/{2,}/g, '/')}` : device.replace(/\/{2,}/g, '/');
  const trimmed = collapsed.replace(/\/+$/, '') || collapsed;
  return /^[a-z]:\//i.test(collapsed) || unc ? trimmed.toLowerCase() : trimmed;
}

/** One exact checkout decision. An unqualified id preserves all Homes as candidates. */
export function resolveWorkspaceRefV1<T extends WorkspaceRefV1>(
  refs: readonly T[], target: ProjectKeyV1 | WorkspaceAddressV1,
  context: WorkspaceRefResolutionContextV1 = {},
): WorkspaceRefResolutionV1<T> {
  if ('projectKey' in target) return { kind: 'invalid', reason: 'A Project anchor does not select an exact checkout' };
  const server = (value: string) => (context.normalizeServerId?.(value.trim()) ?? value.trim());
  const id = 'workspaceId' in target ? target.workspaceId.trim() : 'id' in target ? target.id.trim() : null;
  const serverId = target.serverId === undefined ? null : server(target.serverId);
  const hasRoot = 'rootPath' in target;
  const normalizeRoot = context.normalizeRootPath ?? normalizeWorkspaceRootPathV1;
  const rootPath = hasRoot ? normalizeRoot(target.rootPath) : null;
  const machineId = hasRoot ? target.machineId.trim() : null;
  if ((id !== null && !id) || (target.serverId !== undefined && !serverId)
      || (hasRoot && (!serverId || !rootPath || !machineId))) {
    return { kind: 'invalid', reason: 'Workspace address is incomplete' };
  }
  const candidates = refs.filter(ref => {
    if (serverId !== null && server(ref.serverId) !== serverId) return false;
    if (id !== null && ref.id.trim() !== id) return false;
    if (!hasRoot) return true;
    if (ref.machineId.trim() !== machineId) return false;
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

export function workspaceAddressFromRefV1(ref: WorkspaceRefV1): WorkspaceAddressV1 {
  return { serverId: ref.serverId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath };
}

/** Enrichment cannot replace a previously accepted presentation anchor. */
export function enrichWorkspaceRefV1<T extends WorkspaceRefV1>(ref: T, facts: WorkspaceProjectFactsV1 = {}): T {
  return { ...ref, ...facts, projectKey: ref.projectKey ?? ref.id };
}

/** Only a new accepted checkout can join a uniquely proven Project association. */
export function resolveWorkspaceProjectKeyV1(
  refs: readonly WorkspaceRefV1[], input: Readonly<{ serverId: string; id: string }> & WorkspaceProjectFactsV1,
  context: Pick<WorkspaceRefResolutionContextV1, 'normalizeServerId'> = {},
): string {
  const server = context.normalizeServerId ?? ((id: string) => id.trim());
  const identity = normalizeScmHostingRepositoryIdentity(input.repositoryIdentity);
  const matches = refs.filter(ref => server(ref.serverId) === server(input.serverId)
    && ((input.source && ref.source?.sourceId === input.source.sourceId)
      || (identity && sameScmHostingRepositoryIdentity(normalizeScmHostingRepositoryIdentity(ref.repositoryIdentity), identity))));
  const anchors = new Set(matches.map(ref => ref.projectKey ?? ref.id));
  // Competing accepted anchors cannot be merged by later repository/Source facts.
  if (anchors.size > 1) return input.id;
  return anchors.values().next().value ?? input.id;
}
