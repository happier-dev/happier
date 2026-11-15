import type { HomeGovernanceActionIdV1 } from '@happier-dev/protocol/home/governance';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { classifyHomeActionOutcome, type HomeActionFailure, type HomeActionOutcome } from './homeActionOutcome';

export type HomeGovernanceQueryOutcome<TValue> =
    | Readonly<{ kind: 'succeeded'; value: TValue }>
    | Readonly<{ kind: 'failed'; failure: HomeActionFailure }>;

/** Captures the exact Home before shared Action admission and approval can suspend. */
export async function executeHomeGovernanceAction(params: Readonly<{
    scope: ServerAccountScope;
    actionId: HomeGovernanceActionIdV1;
    input: unknown;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): Promise<HomeActionOutcome> {
    const execute = scopedHomeActionExecutor(params.scope, params.isCurrent
        ? { homeDomainReadCurrentness: params.isCurrent } : undefined);
    const result = await execute(params.actionId, params.input, {
        surface: 'ui',
        authority: 'present_user',
        serverId: params.scope.serverId,
        expectedAccountId: params.scope.accountId,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    return classifyHomeActionOutcome(result, params.actionId);
}

/** Reads, including result-required Ask, use the same admitted Action as mutations. */
export async function queryHomeGovernanceAction<TValue>(params: Readonly<{
    scope: ServerAccountScope;
    actionId: HomeGovernanceActionIdV1;
    input: unknown;
    parse: (value: unknown) => { success: true; data: TValue } | { success: false };
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): Promise<HomeGovernanceQueryOutcome<TValue>> {
    const outcome = await executeHomeGovernanceAction(params);
    if (outcome.kind === 'failed') {
        return Object.freeze({ kind: 'failed' as const, failure: outcome.failure });
    }
    if (outcome.kind === 'approval_pending') {
        return Object.freeze({
            kind: 'failed' as const,
            failure: Object.freeze({ kind: 'conflict' as const, retryable: false, code: null }),
        });
    }
    const parsed = params.parse(outcome.result);
    if (!parsed.success) {
        return Object.freeze({
            kind: 'failed' as const,
            failure: Object.freeze({ kind: 'invalid' as const, retryable: false, code: null }),
        });
    }
    return Object.freeze({ kind: 'succeeded' as const, value: parsed.data });
}
