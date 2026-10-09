import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindMachineAccessActionHttpRequestV1, classifyHomeDomainHttpMutationFailureV1, MachineAccessActionIdSchema } from '@happier-dev/protocol/actions';
import { MachineTargetV1Schema, MachineAccessRefusalV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';

export class MachineAccessApiError extends Error {
    constructor(readonly code: string, readonly status?: number) {
        super(code);
        this.name = 'MachineAccessApiError';
    }
}

/** Captured Home/Account transport. Public grant Actions carry permissions, never key material. */
export async function executeMachineAccessHttpAction(params: Readonly<{
    scope: ServerAccountScope; actionId: ActionId; input: unknown;
    isCurrent?: () => boolean; signal?: AbortSignal;
}>): Promise<unknown> {
    const family = MachineAccessActionIdSchema.safeParse(params.actionId);
    if (!family.success) throw new MachineAccessApiError('unsupported_action');
    const actionId = family.data;
    const spec = getActionSpec(actionId);
    const input = spec.inputSchema.parse(params.input);
    // serverId is routing authority, not a field forwarded to the permission endpoint.
    const target = MachineTargetV1Schema.parse({
        serverId: (input as Readonly<{ serverId: string }>).serverId,
        machineId: (input as Readonly<{ machineId: string }>).machineId,
    });
    if (target.serverId !== params.scope.serverId) throw new MachineAccessApiError('machine_access_stale_scope');
    return runWithServerAccountScopeRequestGuard({
        scope: params.scope, isCurrent: params.isCurrent, signal: params.signal,
        staleError: () => new MachineAccessApiError('machine_access_stale_scope'),
    }, async ({ check, signal, isCurrent }) => {
        check();
        const prepare = async () => {
            const owner = await import('./machineDataKeyEnvelopesApi');
            check();
            return owner.prepareMachineDataKeyEnvelopesForScope({ scope: params.scope,
                machineId: target.machineId, isCurrent, signal });
        };
        if (actionId === 'machines.access.prepareKeys') return prepare();
        const bound = bindMachineAccessActionHttpRequestV1(actionId, input);
        const value = await runWithServerRequestAuthorityForServerAccountScope({
            scope: params.scope,
            activeRequest: async () => { throw new MachineAccessApiError('machine_access_stale_scope'); },
        }, async authority => {
            check();
            let issued = false;
            let response: Response;
            let payload: unknown;
            try {
                response = await authority.request(bound.path, { method: bound.method, signal,
                    ...(bound.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bound.body) }),
                }, { onIssued: () => { issued = true; } });
                check();
                payload = await response.json().catch(() => null);
                check();
            } catch (error) {
                if (actionId !== 'machines.access.grants.list') {
                    const failure = classifyHomeDomainHttpMutationFailureV1({ error, issued, aborted: signal.aborted });
                    if (failure !== 'not_dispatched') throw new MachineAccessApiError(failure);
                }
                if (signal.aborted) throw new MachineAccessApiError('cancelled');
                throw error;
            }
            if (!response.ok) {
                const refusal = MachineAccessRefusalV1Schema.safeParse(payload);
                throw new MachineAccessApiError(refusal.success ? refusal.data.code
                    : response.status === 403 ? 'access_denied' : response.status === 404 ? 'machine_unavailable' : 'machine_access_request_failed', response.status);
            }
            if (!spec.outputSchema) throw new MachineAccessApiError('unsupported_action');
            const parsed = spec.outputSchema.safeParse(payload);
            if (!parsed.success) throw new MachineAccessApiError(actionId === 'machines.access.grants.list'
                ? 'machine_access_invalid_response' : 'outcome_unknown');
            return parsed.data;
        });
        // Permission is already committed. A pending physical continuation must not turn a
        // successful grant into a retryable permission failure, nor fabricate readiness.
        if (actionId === 'machines.access.grant.set' && value && typeof value === 'object'
            && 'kind' in value && value.kind === 'saved' && 'canPrepareKeys' in value && value.canPrepareKeys === true) {
            await prepare().catch(() => undefined);
        }
        return value;
    });
}
