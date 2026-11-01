import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { VoiceActionConfirmationBinding } from '@happier-dev/protocol/voice/actions';
import type { VoiceHostTextPlayback } from '@happier-dev/plugin-sdk/voice/client';

import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import { getVoiceSessionSpokenActionConfirmation } from '@/voice/session/voiceSessionStore';

/** Consume shared admission facts; the live carrier owns only read-back completion. */
export async function executeSpokenAction(
  execute: FrontDoorActionExecute,
  actionId: ActionId,
  input: unknown,
  context: UiActionExecutorContext,
  confirmation?: VoiceActionConfirmationBinding,
  playHostText?: VoiceHostTextPlayback,
): Promise<ActionExecuteResult> {
  const carrier = getVoiceSessionSpokenActionConfirmation();
  if (!carrier) return execute(actionId, input, context);

  const pending = carrier.readPending()?.operation;
  if (confirmation && (!pending || pending.actionId !== actionId || pending.serverId !== context.serverId
    || !sameStrictJsonValue(input, pending.requestInput))) {
    return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
  }
  if (confirmation && pending?.actionId === actionId && pending.serverId === context.serverId
    && sameStrictJsonValue(input, pending.requestInput)) {
    if (!carrier.consume({ actionId, inputDigest: pending.inputDigest, confirmation })) {
      return { ok: true, result: carrier.prepare(pending) };
    }
    // The model's repeated selector and current pane never replace the operands
    // the person heard. Authority and the preference remain at the shared factory.
    return execute.confirmed(actionId, pending.normalizedInput, {
      ...context, defaultSessionId: pending.defaultSessionId,
      actionRequestId: pending.actionRequestId, sessionTargetsV1: pending.sessionTargetsV1,
    });
  }

  const prepared = await execute.prepare(actionId, input, context, { reviewOnly: true });
  if (prepared.kind === 'settled') return prepared.result;
  if (carrier !== getVoiceSessionSpokenActionConfirmation()) {
    return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  }
  const operation = prepared.operation;
  if (!operation?.canConfirmInFlow || !context.actionRequestId) return prepared.invocation.run();
  if (operation.irreversible || operation.safety === 'danger') {
    const result = carrier.prepare({
      actionId, actionRequestId: context.actionRequestId, inputDigest: operation.inputDigest,
      summary: operation.summary, normalizedInput: operation.normalizedInput,
      requestInput: projectNativeJsonValueForTransport(input),
      serverId: context.serverId, defaultSessionId: context.defaultSessionId,
      ...(operation.sessionTargetsV1 ? { sessionTargetsV1: operation.sessionTargetsV1 } : {}),
    });
    if (!playHostText) return { ok: true, result };
    const readBack = carrier.readPending();
    const playback = await playHostText({ text: operation.summary, signal: context.signal ?? new AbortController().signal });
    if (context.signal?.aborted || carrier !== getVoiceSessionSpokenActionConfirmation()
      || carrier.readPending() !== readBack || playback.status === 'cancelled') {
      if (carrier.readPending() === readBack) carrier.clear();
      return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    }
    if (playback.status === 'unavailable') { carrier.clear(); return prepared.invocation.run(); }
    if (!carrier.completeReadBack(readBack)) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    return executeSpokenAction(execute, actionId, input, context, result.confirmation);
  }
  return execute.confirmed(actionId, operation.normalizedInput, {
    ...context, sessionTargetsV1: operation.sessionTargetsV1,
  });
}
