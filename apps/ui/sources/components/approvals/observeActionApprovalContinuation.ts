import { isAccountCurrentnessEntityIdV1 } from '@happier-dev/protocol/changes';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { InvalidateSync } from '@/utils/sessions/sync';
import { createActionApprovalContinuationObserver, resumeActionExecutionResult } from './actionApprovalContinuation';

/** Headless adapter for the same exact-Home Artifact observation used by mounted approvals. */
export function observeActionApprovalContinuation(input: Readonly<{
    observer: ReturnType<typeof createActionApprovalContinuationObserver>;
    scope: ServerAccountScope;
    isCurrent(): boolean;
    fetchArtifact(artifactId: string): Promise<DecryptedArtifact | null>;
}>): () => void {
    const read = new InvalidateSync(async () => {
        const registration = input.observer.getSnapshot().approval;
        if (!registration || !input.isCurrent()) return;
        try {
            const artifact = await input.fetchArtifact(registration.artifactId);
            if (!input.isCurrent() || input.observer.getSnapshot().approval !== registration) return;
            const invalid = Boolean(artifact?.isDecrypted !== false && artifact && typeof artifact.body === 'string'
                && !approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body));
            input.observer.observeArtifact(artifact, invalid);
        } catch {
            // Missing transport evidence is not a terminal approval disposition; the next push/reconnect re-reads.
        }
    });
    const onChange = (event: HomeAccountChangeEvent) => {
        const artifactId = input.observer.getSnapshot().approval?.artifactId;
        if (artifactId && areServerProfileIdentifiersEquivalent(event.serverId, input.scope.serverId)
            && (event.entityIds === undefined || event.entityIds.includes(artifactId)
                || event.entityIds.some(isAccountCurrentnessEntityIdV1))) read.invalidate();
    };
    const wake = subscribeHomeAccountChange(onChange, {
        reconnect: { readNotCurrent: () => Boolean(input.observer.getSnapshot().approval) } });
    const observePending = () => {
        if (input.observer.getSnapshot().approval) read.invalidate();
    };
    const observe = input.observer.subscribe(observePending);
    observePending();
    return () => { read.stop(); observe(); wake(); };
}

/** Recover the exact recorded result without deciding or dispatching the child again. */
export async function waitForDeferredActionResult(input: Readonly<{
    result: ActionExecuteResult;
    actionId: ActionId;
    requestId: string;
    lifetime: ServerAccountScopeLifetime;
    signal?: AbortSignal;
    fetchArtifact(artifactId: string, signal: AbortSignal): Promise<DecryptedArtifact | null>;
}>): Promise<ActionExecuteResult> {
    const { lifetime } = input;
    const ended = new AbortController();
    const retirement = lifetime.onRetire(() => ended.abort());
    if (!lifetime.isCurrent()) ended.abort();
    const cancellation = mergeAbortSignals([input.signal, ended.signal]);
    const observer = createActionApprovalContinuationObserver({ onExecuted: () => {} });
    const deliver = observer.subscribe(observer.deliverSettlement);
    const unobserve = observeActionApprovalContinuation({ observer, scope: lifetime.scope,
        isCurrent: () => lifetime.isCurrent() && !cancellation.signal.aborted,
        fetchArtifact: id => input.fetchArtifact(id, cancellation.signal) });
    try {
        return await resumeActionExecutionResult({ result: input.result, actionId: input.actionId,
            requestId: input.requestId, scope: lifetime.scope, signal: cancellation.signal,
            aborted: () => lifetime.isCurrent()
                ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
                : { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' },
            onApprovalPending: observer.requestApproval });
    } finally {
        unobserve();
        deliver();
        observer.dispose();
        cancellation.dispose();
        retirement.dispose();
    }
}
