import { resolveActiveLocalVoiceAgentBinding } from '@/voice/context/resolveActiveLocalVoiceAgentBinding';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

export function resolveEffectiveVoiceTargetState(
    sessionId: string,
    options?: Readonly<{ targetSessionId?: string | null }>,
): Readonly<{
    primaryActionSessionId: string | null;
    trackedSessionIds: ReadonlyArray<string>;
}> {
    const store = useVoiceTargetStore.getState();
    const explicitTargetSessionId = normalizeNonEmptyString(options?.targetSessionId);
    const activeLocalBinding = resolveActiveLocalVoiceAgentBinding();
    const boundTargetSessionId =
        explicitTargetSessionId ?? normalizeNonEmptyString(activeLocalBinding?.binding?.targetSessionId);

    if (boundTargetSessionId !== sessionId) {
        return {
            primaryActionSessionId: store.primaryActionSessionId,
            trackedSessionIds: store.trackedSessionIds,
        };
    }

    return {
        primaryActionSessionId: sessionId,
        trackedSessionIds: store.trackedSessionIds.includes(sessionId)
            ? store.trackedSessionIds
            : [...store.trackedSessionIds, sessionId],
    };
}
