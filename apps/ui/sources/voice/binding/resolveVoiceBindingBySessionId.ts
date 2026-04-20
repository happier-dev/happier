import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { voiceConversationBindingResolver } from './VoiceConversationBindingResolver';
import type { VoiceSessionBinding } from './voiceConversationBindingTypes';

type BindingResolverLike = Readonly<{
    resolveByControlSessionId: (params: {
        controlSessionId: string;
        adapterId?: string | null;
    }) => VoiceSessionBinding | null;
    resolveByConversationSessionId: (params: {
        conversationSessionId: string;
    }) => VoiceSessionBinding | null;
}>;

export function resolveVoiceBindingBySessionId(params: Readonly<{
    sessionId: string;
    adapterId?: string | null;
    resolver?: BindingResolverLike;
}>): VoiceSessionBinding | null {
    const sessionId = normalizeNonEmptyString(params.sessionId);
    if (!sessionId) return null;

    const adapterId = normalizeNonEmptyString(params.adapterId);
    const resolver = params.resolver ?? voiceConversationBindingResolver;

    return (
        resolver.resolveByControlSessionId({
            controlSessionId: sessionId,
            ...(adapterId ? { adapterId } : {}),
        })
        ?? resolver.resolveByConversationSessionId({ conversationSessionId: sessionId })
        ?? null
    );
}
