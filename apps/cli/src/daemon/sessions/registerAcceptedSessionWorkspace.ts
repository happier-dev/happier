import { randomUUID } from 'node:crypto';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { resolveSessionProjectKeyV1, resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import type { Metadata } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { materializeWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { hasSameSessionCheckout } from '@/session/metadata/sessionCheckoutIdentity';
import { createProjectAccountSnapshotMutation, type ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';

export type AcceptedSessionWorkspaceCustody = Pick<AdmittedRequesterSessionBootstrap,
  'credentials' | 'attribution' | 'serverHttpBaseUrl' | 'getBoundSessionId' | 'isCurrent'> & Readonly<{ release(): Promise<void> }>;

/** Accepted Session facts enrich the private checkout library through its existing row writer. */
export function createAcceptedSessionWorkspaceRegistration(input: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  machineId: string;
  signal?: AbortSignal;
  inspectLocation?: typeof inspectWorkspaceLocationWithScmWorkspace;
  requesterSessionCustody?: Readonly<{
    resolve(sessionId: string): Promise<AcceptedSessionWorkspaceCustody | null>;
  }>;
}>): (metadata: Metadata, sessionId: string) => Promise<void> {
  return async (metadata, sessionId) => {
    // Session-private managed folders never become Account Projects, even if an Agent initializes SCM there.
    if (readSessionDirectoryKind(metadata) === 'managed') return;
    const observedPlacement = { ...metadata, machineId: input.machineId };
    const serverId = await resolveServerProfileHomeIdentityId(input.serverId);
    if (!serverId) throw Object.assign(new Error('workspace_registration_home_unavailable'), { code: 'workspace_registration_home_unavailable' });
    const custody = await input.requesterSessionCustody?.resolve(sessionId) ?? null;
    try {
      if (custody && (custody.getBoundSessionId() !== sessionId || custody.attribution.serverId !== input.serverId
        || custody.attribution.machineId !== input.machineId || !await custody.isCurrent())) {
        throw Object.assign(new Error('workspace_registration_requester_channel_unavailable'), { code: 'workspace_registration_requester_channel_unavailable' });
      }
      const credentials = custody?.credentials ?? input.credentials;
      const serverHttpBaseUrl = custody?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
      const session = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => fetchSessionByIdCompat({ reason: 'session-control',
        token: credentials.token, sessionId, signal: input.signal,
      }));
      // Custodian credentials cannot register a foreign Session. Admitted
      // requester custody must still prove ownership on its own Account channel.
      const role = session?.id === sessionId && (session.effectiveAccess !== undefined || session.share !== undefined)
        ? readSessionAccessProjectionRoleV1(session) : 'unavailable';
      if (!session || role !== 'owner' || custody && !await custody.isCurrent()) {
        const code = custody || role === 'recipient' ? 'workspace_registration_requester_channel_unavailable' : 'workspace_registration_owner_unavailable';
        throw Object.assign(new Error(code), { code });
      }
      const authority: ProjectAccountRowsInput = { credentials, serverId: input.serverId,
        ...(custody ? { sessionCustody: { serverId: custody.attribution.serverId, accountId: custody.attribution.accountId,
          serverHttpBaseUrl: custody.serverHttpBaseUrl, isCurrent: custody.isCurrent } } : {}) };
      const mutate = createProjectAccountSnapshotMutation(authority);
      const inspected = await (input.inspectLocation ?? inspectWorkspaceLocationWithScmWorkspace)({
        candidatePath: resolveSessionWorkspaceRootForMachine({ metadata, machineId: input.machineId,
          candidatePath: metadata.path }).machinePath,
        includeRepositoryIdentity: true, signal: input.signal,
      });
      // Automatic Projects come from positive SCM evidence, not arbitrary folders.
      // An explicit accepted checkout is already authoritative, including in a sandbox.
      if (!inspected && metadata.workspaceId == null) return;
      for (;;) {
        let acceptedWorkspaceId: string | null = null;
        const result = await mutate(snapshot => {
          acceptedWorkspaceId = null;
          if (metadata.workspaceId != null) {
            const existing = resolveSessionProjectKeyV1(metadata, serverId, snapshot.workspaceRefs);
            if (existing.kind !== 'resolved' || !existing.ref) return snapshot;
            acceptedWorkspaceId = existing.ref.id;
            // Only enrich an existing checkout with SCM facts observed at that exact placement.
            if (!inspected || resolveWorkspaceRefV1([existing.ref], { serverId, machineId: input.machineId,
              rootPath: inspected.inspection.rootPath }).kind !== 'resolved') return snapshot;
          }
          if (!inspected) return snapshot;
          const accepted = materializeWorkspaceRefForMachineRoot(snapshot.workspaceRefs, {
            serverId,
            machineId: input.machineId,
            rootPath: inspected.inspection.rootPath,
            ...(inspected.repositoryIdentity ? { repositoryIdentity: inspected.repositoryIdentity } : {}),
            nowMs: Date.now(),
            createId: randomUUID,
          });
          acceptedWorkspaceId = accepted.workspaceRef.id;
          return { ...snapshot, workspaceRefs: accepted.workspaceRefs };
        }, input.signal);
        if (result.status === 'applied' || result.status === 'unchanged') {
          if (!acceptedWorkspaceId) return;
          const accepted = resolveSessionProjectKeyV1({ workspaceId: acceptedWorkspaceId }, serverId, result.snapshot.workspaceRefs);
          if (accepted.kind !== 'resolved' || !accepted.ref) return;
          const projectKey = accepted.projectKey.projectKey;
          const keyChanged = session.projectKey !== projectKey;
          if (!keyChanged && metadata.workspaceId === accepted.ref.id && metadata.projectId === projectKey) return;
          const workspaceId = accepted.ref.id;
          await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => updateSessionMetadataWithRetry({
            token: credentials.token, credentials, sessionId, rawSession: session,
            ...(keyChanged ? { projectKey } : {}),
            updater: current => {
              const currentAssociation = current.workspaceId != null
                ? resolveSessionProjectKeyV1(current, serverId, result.snapshot.workspaceRefs) : null;
              const stillAccepted = current.workspaceId != null
                ? currentAssociation?.kind === 'resolved' && currentAssociation.ref?.id === workspaceId
                : hasSameSessionCheckout(current, observedPlacement);
              if (!stillAccepted) {
                throw Object.assign(new Error('Session checkout changed before Project publication'), {
                  code: 'session_publisher_authority_lost' as const, retryable: false as const,
                });
              }
              return { ...current, workspaceId, projectId: projectKey };
            },
            currentness: { signal: input.signal, ...(custody ? { verifyCurrent: custody.isCurrent } : {}) },
          }));
          return;
        }
        // Re-admit a conflicting acceptance against the mutator's next census.
        if (result.status === 'conflict') continue;
        const code = `workspace_registration_${result.status}`;
        throw Object.assign(new Error(code), { code });
      }
    } finally { await custody?.release(); }
  };
}
