import { randomUUID } from 'node:crypto';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';

import type { Metadata } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { materializeWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { createProjectAccountSnapshotMutation } from '@/workspaces/projectAccountRows';

/** Accepted Session facts enrich the private checkout library through its existing row writer. */
export function createAcceptedSessionWorkspaceRegistration(input: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  machineId: string;
  signal?: AbortSignal;
  inspectLocation?: typeof inspectWorkspaceLocationWithScmWorkspace;
}>): (metadata: Metadata, sessionId: string) => Promise<void> {
  const mutate = createProjectAccountSnapshotMutation(input.credentials);
  return async (metadata, sessionId) => {
    // Session-private managed folders never become Account Projects, even if an Agent initializes SCM there.
    if (readSessionDirectoryKind(metadata) === 'managed') return;
    const session = await fetchSessionByIdCompat({ token: input.credentials.token, sessionId, signal: input.signal });
    // A shared machine executes requester-owned Sessions too. Its custodian's
    // credential is not a channel to that requester's private Project library.
    const role = session?.id === sessionId && (session.effectiveAccess !== undefined || session.share !== undefined)
      ? readSessionAccessProjectionRoleV1(session) : 'unavailable';
    if (role !== 'owner') {
      const code = role === 'recipient' ? 'workspace_registration_requester_channel_unavailable' : 'workspace_registration_owner_unavailable';
      throw Object.assign(new Error(code), { code });
    }
    const inspected = await (input.inspectLocation ?? inspectWorkspaceLocationWithScmWorkspace)({
      candidatePath: metadata.path, includeRepositoryIdentity: true, signal: input.signal,
    });
    // Automatic Projects come from positive SCM evidence, not arbitrary folders.
    if (!inspected) return;
    for (;;) {
      const result = await mutate(snapshot => {
        const accepted = materializeWorkspaceRefForMachineRoot(snapshot.workspaceRefs, {
          serverId: input.serverId,
          machineId: input.machineId,
          rootPath: inspected.inspection.rootPath,
          ...(inspected.repositoryIdentity ? { repositoryIdentity: inspected.repositoryIdentity } : {}),
          nowMs: Date.now(),
          createId: randomUUID,
        });
        return { ...snapshot, workspaceRefs: accepted.workspaceRefs };
      }, input.signal);
      if (result.status === 'applied' || result.status === 'unchanged') return;
      // A concurrent accepted checkout can advance the shared topology row.
      // Re-admit this same root against the mutator's next authoritative census.
      if (result.status === 'conflict') continue;
      const code = `workspace_registration_${result.status}`;
      throw Object.assign(new Error(code), { code });
    }
  };
}
