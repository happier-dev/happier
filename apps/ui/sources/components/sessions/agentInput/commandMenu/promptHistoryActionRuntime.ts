import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

import { readRegisteredComposerPromptPickerTarget } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { UserMessageHistoryEntriesData } from '@/hooks/session/useUserMessageHistoryEntries';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

type PromptHistoryRequest = Parameters<NonNullable<ActionExecutorDeps['uiPromptHistory']>>[0];

/** Client-only access to the open picker's existing decrypted Account projection. */
export async function executePromptHistoryAction(request: PromptHistoryRequest): Promise<ActionExecuteResult> {
    throwIfAborted(request.context.signal);
    const input = request.input;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !lifetime.isCurrent()
        || (request.context.serverId && !areServerProfileIdentifiersEquivalent(request.context.serverId, lifetime.scope.serverId))
        || (request.context.expectedAccountId && request.context.expectedAccountId !== lifetime.scope.accountId)
        || (request.context.runtimeAccountId && request.context.runtimeAccountId !== lifetime.scope.accountId)) {
        return { ok: true, result: { status: 'unavailable', reason: 'noClient' } };
    }
    const ref = input.composerRef ?? (request.context.defaultSessionId
        ? { kind: 'session' as const, sessionId: request.context.defaultSessionId }
        : undefined);
    const options = { ref, scope: lifetime.scope };
    const mounted = readRegisteredComposerPromptPickerTarget(options);
    if (!mounted) return { ok: true, result: { status: 'noEligibleComposer' } };
    const picker = mounted.target.readPromptPicker?.();
    if (!picker) return { ok: true, result: { status: 'notOpen' } };

    let snapshot: UserMessageHistoryEntriesData;
    if (input.op === 'page') snapshot = await picker.history.page(request.context.signal);
    else if (input.op === 'retry') snapshot = await picker.history.retry(request.context.signal);
    else if (input.op === 'stop') snapshot = picker.history.stop();
    else snapshot = picker.history.read();
    throwIfAborted(request.context.signal);
    if (!lifetime.isCurrent() || readRegisteredComposerPromptPickerTarget(options)?.target !== mounted.target) {
        return { ok: true, result: { status: 'unavailable', reason: 'noClient' } };
    }
    if (mounted.target.readPromptPicker?.() !== picker) return { ok: true, result: { status: 'notOpen' } };
    // The hook also carries callbacks; only its admitted serializable projection crosses the Action.
    const { entries, coverage, hasMore, isLoading, error, progress } = snapshot;
    return { ok: true, result: { status: 'ready', composerRef: mounted.composerRef,
        entries, coverage, hasMore, isLoading, error, progress } };
}
