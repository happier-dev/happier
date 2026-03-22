import { buildVoiceInitialContext } from '@/voice/context/buildVoiceInitialContext';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

export function resolveVoiceAgentInitialContexts(
  sessionId: string,
  options?: Readonly<{ targetSessionId?: string | null }>,
): Readonly<{
  bootstrapInitialContext: string;
  deferredTargetSessionContext: string;
}> {
  const targetSessionId = normalizeNonEmptyString(options?.targetSessionId);
  if (targetSessionId && targetSessionId !== sessionId) {
    return {
      bootstrapInitialContext: buildVoiceInitialContext(sessionId),
      deferredTargetSessionContext: buildVoiceInitialContext(sessionId, { targetSessionId }),
    };
  }

  return {
    bootstrapInitialContext: buildVoiceInitialContext(sessionId, {
      targetSessionId,
    }),
    deferredTargetSessionContext: '',
  };
}
