import { SessionSpawnNewActionVoiceInputV2Schema, type SessionSpawnNewActionAuthoringInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';

/** Voice validates its authoring ingress; the Action owner settles every default once. */
export function bindVoiceSessionSpawnInput(input: unknown): Readonly<{
  ok: true; input: SessionSpawnNewActionAuthoringInputV2;
}> | ActionExecuteFailure {
  const parsed = SessionSpawnNewActionVoiceInputV2Schema.safeParse(input);
  if (!parsed.success) return actionInputValidationFailure(parsed.error);
  // Forward the authored model and credential references together. The ordinary
  // creation owner resolves them against the final Agent and Machine.
  return { ok: true, input: parsed.data };
}
