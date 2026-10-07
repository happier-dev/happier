import { PUBLIC_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

import { requestRegisteredComposerPromptPicker } from '@/components/sessions/presentation/sessionComposerPresentationTargets';

type PromptPickerOpenRequest = Parameters<NonNullable<ActionExecutorDeps['uiPromptPickerOpen']>>[0];

export async function executePromptPickerOpenAction(request: PromptPickerOpenRequest): Promise<ActionExecuteResult> {
    request.context.signal?.throwIfAborted();
    const input = PUBLIC_ACTION_INPUT_SCHEMAS['ui.prompts.picker.open'].parse(request.input);
    const ref = input.composerRef ?? (request.context.defaultSessionId
        ? { kind: 'session' as const, sessionId: request.context.defaultSessionId }
        : undefined);
    const composerRef = requestRegisteredComposerPromptPicker({ ref, serverId: request.context.serverId });
    return { ok: true, result: composerRef
        ? { status: 'opened', composerRef }
        : { status: 'noEligibleComposer' } };
}
