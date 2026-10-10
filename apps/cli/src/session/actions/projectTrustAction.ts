import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { StoredCredentials } from '@/persistence';
import { createProjectSetupTrustClient } from '@/workspaces/projectSetup/projectSetupTrust';

/** Thin exact-Home adapter. The mode-aware Trust client remains the sole row owner. */
export function createCliProjectTrustAction(params: Readonly<{
  credentials?: StoredCredentials;
  token: string;
  accountId: string | null;
  serverId?: string;
  serverHttpBaseUrl?: string;
}>): NonNullable<ActionExecutorDeps['projectAction']> {
  return async ({ actionId, input, context }) => {
    if (actionId !== 'projects.trust.list' && actionId !== 'projects.trust.revoke') {
      return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
    }
    const credentials = params.credentials;
    if (!credentials || credentials.token !== params.token || !params.accountId || !params.serverId || !params.serverHttpBaseUrl
      || (context.externalActionCredential && context.externalActionCredential.accountId !== params.accountId)
      || (context.externalActionExecutionAuthorization && context.externalActionExecutionAuthorization.binding.accountId !== params.accountId)
      || (context.runtimeAccountId && context.runtimeAccountId !== params.accountId)) {
      return { ok: false, errorCode: 'project_trust_access_denied', error: 'project_trust_access_denied' };
    }
    const parsed = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    if ((context.serverId && context.serverId !== params.serverId)
      || (parsed.data.project && parsed.data.project.serverId !== params.serverId)) {
      return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    }
    const client = createProjectSetupTrustClient({ credentials, serverHttpBaseUrl: params.serverHttpBaseUrl });
    try {
      context.signal?.throwIfAborted();
      if (actionId === 'projects.trust.list') {
        const request = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const trust = await client.list(request.project);
        context.signal?.throwIfAborted();
        if (trust.some(row => row.project.serverId !== params.serverId)) {
          return { ok: false, errorCode: 'project_trust_identity_mismatch', error: 'project_trust_identity_mismatch' };
        }
        return { trust };
      }
      const request = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.trust.revoke'].parse(input);
      const result = await client.revoke(request);
      // A confirmed Account mutation remains true after cancellation; read-only/no-effect
      // outcomes still obey the invocation's existing cancellation boundary.
      if (result.status !== 'updated') context.signal?.throwIfAborted();
      return { project: request.project, status: result.status === 'updated' ? 'removed' : result.status };
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : 'project_trust_storage_unavailable';
      if (code !== 'outcome_unknown' && context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      return { ok: false, errorCode: code, error: code };
    }
  };
}
