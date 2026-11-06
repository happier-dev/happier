import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { VoiceHostTextPlayback } from '@happier-dev/plugin-sdk/voice/client';

import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import { getVoiceSessionSpokenActionConfirmation } from '@/voice/session/voiceSessionStore';

export type SpokenActionTurnOrigin = 'person' | 'synthetic';

/** Consume shared admission facts; the live carrier owns only read-back completion. */
export async function executeSpokenAction(
  execute: FrontDoorActionExecute,
  actionId: ActionId,
  input: unknown,
  context: UiActionExecutorContext,
  turnOrigin?: SpokenActionTurnOrigin,
  playHostText?: VoiceHostTextPlayback,
): Promise<ActionExecuteResult> {
  const carrier = getVoiceSessionSpokenActionConfirmation();
  if (!carrier) return execute(actionId, input, context);

  const prepared = await execute.prepare(actionId, input, context, { reviewOnly: true });
  if (prepared.kind === 'settled') return prepared.result;
  if (carrier !== getVoiceSessionSpokenActionConfirmation()) {
    return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  }
  const operation = prepared.operation;
  if (turnOrigin !== 'person' || !operation?.canConfirmInFlow || !context.actionRequestId) return prepared.invocation.run();
  if (operation.irreversible || operation.safety === 'danger') {
    if (!playHostText) return prepared.invocation.run();
    carrier.prepare({
      actionId, actionRequestId: context.actionRequestId,
      summary: operation.summary, normalizedInput: operation.normalizedInput,
      serverId: context.serverId, defaultSessionId: context.defaultSessionId,
      ...(operation.sessionTargetsV1 ? { sessionTargetsV1: operation.sessionTargetsV1 } : {}),
    });
    const readBack = carrier.readPending();
    let playback: Awaited<ReturnType<VoiceHostTextPlayback>>;
    try {
      playback = await playHostText({ text: operation.summary, signal: context.signal ?? new AbortController().signal });
    } catch (error) {
      if (carrier.readPending() === readBack) carrier.clear();
      throw error;
    }
    if (context.signal?.aborted || carrier !== getVoiceSessionSpokenActionConfirmation()
      || carrier.readPending() !== readBack || playback.status === 'cancelled') {
      if (carrier.readPending() === readBack) carrier.clear();
      return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    }
    if (playback.status === 'unavailable') { carrier.clear(); return prepared.invocation.run(); }
    if (!carrier.completeReadBack(readBack)) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    return execute.confirmed(actionId, operation.normalizedInput, {
      ...context, sessionTargetsV1: operation.sessionTargetsV1,
    });
  }
  return execute.confirmed(actionId, operation.normalizedInput, {
    ...context, sessionTargetsV1: operation.sessionTargetsV1,
  });
}
