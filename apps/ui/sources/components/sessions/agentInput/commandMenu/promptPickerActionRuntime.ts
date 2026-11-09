import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

import { requestRegisteredComposerPromptPicker } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { readRegisteredComposerPromptPickerTarget } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

type PromptPickerOpenRequest = Parameters<NonNullable<ActionExecutorDeps['uiPromptPickerOpen']>>[0];

export async function executePromptPickerOpenAction(request: PromptPickerOpenRequest): Promise<ActionExecuteResult> {
    throwIfAborted(request.context.signal);
    const input = request.input;
    const ref = input.composerRef ?? (request.context.defaultSessionId
        ? { kind: 'session' as const, sessionId: request.context.defaultSessionId }
        : undefined);
    const composerRef = requestRegisteredComposerPromptPicker({ ref, serverId: request.context.serverId });
    return { ok: true, result: composerRef
        ? { status: 'opened', composerRef }
        : { status: 'noEligibleComposer' } };
}

type PromptPickerActionRequest = Parameters<NonNullable<ActionExecutorDeps['uiPromptPickerAction']>>[0];

/** Selection and application stay on the real open leaf and mounted controller. */
export async function executePromptPickerAction(request: PromptPickerActionRequest): Promise<ActionExecuteResult> {
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
        ? { kind: 'session' as const, sessionId: request.context.defaultSessionId } : undefined);
    const mounted = readRegisteredComposerPromptPickerTarget({ ref, scope: lifetime.scope });
    if (!mounted) return { ok: true, result: { status: 'noEligibleComposer' } };
    const port = mounted.target.readPromptPicker?.();
    if (!port) return { ok: true, result: { status: 'notOpen' } };
    if ('selection' in input) {
        const status = port.select(input.selection);
        return { ok: true, result: status === 'selected' ? { status, composerRef: mounted.composerRef } : { status } };
    }
    const accepted = await port.apply(input.mode, request.context.signal);
    throwIfAborted(request.context.signal);
    if (!lifetime.isCurrent()) return { ok: true, result: { status: 'unavailable', reason: 'noClient' } };
    return { ok: true, result: accepted
        ? { status: 'applied', composerRef: mounted.composerRef } : { status: 'refused' } };
}
