import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { projectWorkspaceRefV1, resolveSessionProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SessionListQueryV1 } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { fetchSessionsQueryPage, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { publishAcceptedSessionProject, publishSessionWithoutProject, withoutRetiredSessionCheckout } from '@/session/metadata/publishAcceptedSessionProject';
import type { ProjectAccountRowsSnapshotListener } from '@/workspaces/projectAccountRows';

type CensusSnapshot = Readonly<{ scopeKey: string; workspaceRefs: readonly WorkspaceRefV1[] }>;
export type MachineSessionCandidatePage = Readonly<{ sessions: readonly RawSessionRecord[]; hasNext: boolean; nextCursor: string | null }>;

/**
 * When this Machine's accepted checkouts change (a folder opened as a Project, or a checkout forgotten),
 * the daemon reclassifies the Sessions it owns on this Machine at once instead of at their next start.
 * It reuses the one classifier (`resolveSessionProjectKeyV1`, exact checkout roots) and the one
 * publication owner, and reads only the affected rows: owner-published no-Project rows when checkouts
 * arrive, and the retired checkouts' Project keys when checkouts leave. Other Machines' Sessions are
 * left to their own daemon, which receives the same Project row change.
 */
export function createMachineSessionProjectReclassification(input: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  /** This daemon's Home identity, the same one Session registration publishes with. */
  resolveHomeServerId(): Promise<string | null>;
  signal?: AbortSignal;
  readCandidates?: (query: SessionListQueryV1, signal?: AbortSignal) => Promise<MachineSessionCandidatePage>;
}>): (previous: CensusSnapshot, next: CensusSnapshot) => Promise<void> {
  const readCandidates = input.readCandidates ?? ((query, signal) => fetchSessionsQueryPage({
    token: input.credentials.token, query, ...(signal ? { signal } : {}) }));
  const onMachine = (ref: WorkspaceRefV1) => ref.machineId.trim() === input.machineId;
  const identity = (ref: WorkspaceRefV1) => JSON.stringify([ref.serverId, ref.id]);
  return async (previous, next) => {
    if (previous.scopeKey !== next.scopeKey) return;
    const before = new Map(previous.workspaceRefs.filter(onMachine).map(ref => [identity(ref), ref]));
    const after = new Map(next.workspaceRefs.filter(onMachine).map(ref => [identity(ref), ref]));
    const arrived = [...after].some(([key, ref]) => before.get(key)?.rootPath !== ref.rootPath);
    const retired = [...before].filter(([key, ref]) => after.get(key)?.rootPath !== ref.rootPath).map(([, ref]) => ref);
    if (!arrived && retired.length === 0) return;
    const serverId = await input.resolveHomeServerId();
    if (!serverId) return;
    const currentness = await fetchAccountEncryptionCurrentness({ credentials: input.credentials, token: input.credentials.token });
    const refs = next.workspaceRefs;
    const retiredIds = new Set(retired.map(ref => ref.id));
    const failures: unknown[] = [];
    const visit = async (projectKeys: NonNullable<SessionListQueryV1['projectKeys']>, apply: (row: RawSessionRecord, metadata: Record<string, unknown>) => Promise<void>) => {
      for (const storage of ['active', 'archived'] as const) {
        let cursor: string | undefined;
        do {
          input.signal?.throwIfAborted();
          const page = await readCandidates({ v: 1, storage, includeInactive: true, scope: 'all_accessible', attention: 'any',
            audiences: [], tagIds: [], projectKeys, includeAttention: false, ...(cursor ? { cursor } : {}) }, input.signal);
          for (const row of page.sessions) {
            if (readSessionAccessProjectionRoleV1(row) !== 'owner') continue;
            const metadata = tryDecryptSessionOwnerMetadataView({ credentials: input.credentials,
              accountEncryptionMode: currentness.mode, rawSession: row });
            if (!metadata || metadata.machineId !== input.machineId) continue;
            // One Session losing its CAS (changed checkout, lost authority) must not strand the others.
            try { await apply(row, metadata); } catch (error) { failures.push(error); }
          }
          cursor = page.hasNext && page.nextCursor ? page.nextCursor : undefined;
        } while (cursor);
      }
    };
    const publish = { credentials: input.credentials, serverId, workspaceRefs: refs, accountEncryptionCurrentness: currentness,
      currentness: { ...(input.signal ? { signal: input.signal } : {}) } };
    const reclassify = async (row: RawSessionRecord, metadata: Record<string, unknown>, retiredWorkspaceId?: string) => {
      const observedMetadata = withoutRetiredSessionCheckout(metadata, retiredWorkspaceId);
      const resolved = resolveSessionProjectKeyV1(observedMetadata, serverId, refs);
      const strip = retiredWorkspaceId === undefined ? {}
        : { updateMetadata: (current: Record<string, unknown>) => withoutRetiredSessionCheckout(current, retiredWorkspaceId) };
      if (resolved.kind === 'resolved' && resolved.ref) {
        await publishAcceptedSessionProject({ ...publish, ...strip, sessionId: row.id, rawSession: row,
          observedMetadata, workspaceId: resolved.ref.id });
      } else if (resolved.kind === 'none') {
        await publishSessionWithoutProject({ ...publish, sessionId: row.id, rawSession: row, observedMetadata: metadata,
          ...(retiredWorkspaceId === undefined ? {} : { retiredWorkspaceId }) });
      }
    };
    if (arrived) await visit({ include: [], exclude: [], none: true }, (row, metadata) => reclassify(row, metadata));
    if (retired.length > 0) {
      const keys = [...new Set(retired.map(ref => projectWorkspaceRefV1(ref).projectKey))].sort();
      await visit({ include: keys, exclude: [] }, async (row, metadata) => {
        const stamped = typeof metadata.workspaceId === 'string' ? metadata.workspaceId : null;
        if (row.projectKey == null || stamped === null || !retiredIds.has(stamped)) return;
        await reclassify(row, metadata, stamped);
      });
    }
    if (failures.length > 0) {
      throw Object.assign(new AggregateError(failures, 'session_project_reclassification_partial'),
        { code: 'session_project_reclassification_partial' });
    }
  };
}

/** Serializes reclassification behind each real census change; a failure is reported and never blocks the next one. */
export function subscribeMachineSessionProjectReclassification(input: Readonly<{
  subscribe(listener: ProjectAccountRowsSnapshotListener): () => void;
  reclassify: ReturnType<typeof createMachineSessionProjectReclassification>;
  onError(error: unknown): void;
}>): () => void {
  let tail: Promise<void> = Promise.resolve();
  return input.subscribe((previous, next) => {
    // Installation (no previous census) and withdrawal carry no observed change to apply.
    if (!previous || !next || previous.workspaceRefs === next.workspaceRefs) return;
    tail = tail.then(() => input.reclassify(previous, next)).catch(input.onError);
  });
}
