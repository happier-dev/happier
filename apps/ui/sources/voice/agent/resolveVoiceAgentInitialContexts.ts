import { buildVoiceInitialContext } from '@/voice/context/buildVoiceInitialContext';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export function resolveVoiceAgentInitialContexts(
  sessionId: string,
  options?: Readonly<{
    targetSessionId?: string | null;
    targetSessionAddress?: SessionAddress | null;
  }>,
): Readonly<{
  bootstrapInitialContext: string;
  deferredTargetSessionContext: (() => string) | null;
}> {
  const targetSessionAddress = options?.targetSessionAddress ?? null;
  const targetSessionId = normalizeNonEmptyString(
    targetSessionAddress?.sessionId ?? options?.targetSessionId,
  );
  const targetOptions = targetSessionAddress
    ? { targetSessionAddress }
    : { targetSessionId };
  if (targetSessionId && targetSessionId !== sessionId) {
    return {
      bootstrapInitialContext: buildVoiceInitialContext(sessionId),
      // Native approvals can settle without a model turn. Keep the bound target
      // identity, but project its context only when the first turn consumes it.
      deferredTargetSessionContext: () => buildVoiceInitialContext(sessionId, targetOptions),
    };
  }

  return {
    bootstrapInitialContext: buildVoiceInitialContext(sessionId, targetOptions),
    deferredTargetSessionContext: null,
  };
}
