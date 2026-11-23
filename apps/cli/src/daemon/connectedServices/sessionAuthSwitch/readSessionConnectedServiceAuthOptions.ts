import type { SessionConnectedServiceAuthSwitchOptionsResult } from '@happier-dev/protocol/connect/sessionConnectedServiceAuthSwitch';

import { fetchAccountProfile } from '@/api/accountProfile';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { projectRpcRequesterWorkAttribution } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { RequesterSessionAccountContextCustody } from '@/daemon/sessionEncryption/requesterSessionAccountContextCustody';
import type { RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { resolveTrackedSessionCatalogAgentId } from '@/daemon/sessions/resolveTrackedSessionCatalogAgentId';
import type { TrackedSession } from '@/daemon/types';
import type { StoredCredentials } from '@/persistence';
import { readSessionTeamCredentialResourceCatalog } from '@/session/services/sessionTeamCredentialCatalog';

import { resolveTrackedConnectedServiceBindingsRaw } from '../trackedSessionConnectedServiceBindings';
import { readConnectedServiceBindingsOrEmpty } from './credentialApplicationState';
import { resolveInactiveConnectedServiceSessionContext } from './persistedState';
import { projectSessionConnectedServiceAuthSwitchOptions } from './projectSessionConnectedServiceAuthSwitchOptions';

export type ReadSessionConnectedServiceAuthOptions = (
  sessionId: string, context?: RpcHandlerContext,
) => Promise<SessionConnectedServiceAuthSwitchOptionsResult>;

export function createSessionConnectedServiceAuthOptionsReader(params: Readonly<{
  machineId: string;
  serverId: string;
  requesterCustodyServerId: string;
  serverHttpBaseUrl: string;
  credentials: StoredCredentials;
  findTrackedSession: (sessionId: string) => TrackedSession | null | undefined;
  withSessionAccountContext: RequesterSessionAccountContextCustody['withSessionAccountContext'];
  isRetired: () => boolean;
}>): ReadSessionConnectedServiceAuthOptions {
  return async (sessionId, context) => {
    const signal = context?.signal;
    signal?.throwIfAborted();
    if (params.isRetired()) return { ok: false, errorCode: 'unavailable' };

    const read = async (requester: RequesterSessionRuntimeContext | null): Promise<SessionConnectedServiceAuthSwitchOptionsResult> => {
      signal?.throwIfAborted();
      const credentials = requester?.bootstrap.credentials ?? params.credentials;
      const serverHttpBaseUrl = requester?.bootstrap.serverHttpBaseUrl ?? params.serverHttpBaseUrl;
      return await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
        const tracked = params.findTrackedSession(sessionId);
        const inactive = tracked ? null : await resolveInactiveConnectedServiceSessionContext({
          token: credentials.token, credentials, sessionId, currentMachineId: params.machineId, signal,
        });
        if (!tracked && !inactive?.cwd) return { ok: false, errorCode: 'session_not_found' };
        const agentId = tracked ? resolveTrackedSessionCatalogAgentId(tracked) : inactive?.agentId;
        if (!agentId) return { ok: false, errorCode: 'agent_mismatch' };
        const bindings = tracked
          ? readConnectedServiceBindingsOrEmpty(resolveTrackedConnectedServiceBindingsRaw(tracked))
          : inactive!.connectedServices;
        const { homeDomainAction } = createAccountServerActionDeps({
          token: credentials.token,
          serverId: requester?.bootstrap.attribution.serverId ?? params.serverId,
          serverHttpBaseUrl,
        });
        const [profile, teamResources] = await Promise.all([
          fetchAccountProfile({ token: credentials.token, signal }),
          readSessionTeamCredentialResourceCatalog({
            homeDomainAction, applications: [], executionMachineId: params.machineId, signal,
          }),
        ]);
        return { ok: true, options: projectSessionConnectedServiceAuthSwitchOptions({ agentId, bindings, profile, teamResources }) };
      });
    };

    return await params.withSessionAccountContext(sessionId, read,
      projectRpcRequesterWorkAttribution(context, params.requesterCustodyServerId), signal, context);
  };
}
