import axios from '@/api/client/credentialAxios';
import { AutomationV3RunMutationResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { automationOccurrenceRequest } from '@happier-dev/protocol/automations/occurrenceActions';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { CliActionDepsParams } from './types';
import { AUTOMATION_HTTP_TIMEOUT_MS } from '@/api/automations';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { createExternalActionHeaderRefusalError } from '@/api/externalActionHeaderRefusal';

/** Account placement uses the held Home and credentials, including after approval replay. */
export function createCliOccurrenceAction(params: Pick<CliActionDepsParams, 'credentials' | 'isCredentialCurrent'>,
    home: Readonly<{ serverId: string; serverHttpBaseUrl: string; accountId: string | null }>,
    resolveServerRequestHeaders: (context: ActionExecutorContext, actionId: string,
        request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null,
): NonNullable<ActionExecutorDeps['automationOccurrenceAction']> {
    return async ({ actionId, input, context }) => {
        const failure = (code: string) => ({ ok: false as const, errorCode: code, error: code });
        if (!params.credentials) return failure('not_authenticated');
        if (context.serverId && !await isServerProfileHomeIdentity(home.serverId, context.serverId)) return failure('server_scope_mismatch');
        const requester = context.externalActionCredential?.accountId
            ?? context.externalActionExecutionAuthorization?.binding.accountId ?? context.runtimeAccountId;
        if (requester && requester !== home.accountId) return failure('credential_scope_denied');
        context.signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) return failure('action_account_scope_changed');
        context.signal?.throwIfAborted();
        const request = automationOccurrenceRequest(actionId, input);
        const headers = resolveServerRequestHeaders(context, actionId, { method: 'POST', ...request });
        if (!headers) throw createExternalActionHeaderRefusalError();
        const response = await axios.post(home.serverHttpBaseUrl + request.path, request.body, {
            headers: { ...headers,
                'Content-Type': request.body === undefined ? false : 'application/json' },
            signal: context.signal, timeout: AUTOMATION_HTTP_TIMEOUT_MS, validateStatus: () => true,
        });
        if (response.status < 200 || response.status >= 300) {
            const body: unknown = response.data;
            const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
                ? body.error : 'automation_api_request_failed';
            return failure(code);
        }
        return AutomationV3RunMutationResponseSchema.parse(response.data);
    };
}
