import type { VoiceSessionBinding } from './voiceConversationBindingTypes';
import {
    createVoiceConversationBindingResolver,
    voiceConversationBindingResolver,
} from './VoiceConversationBindingResolver';
import { voiceSessionBindingStore } from './voiceConversationBindingStore';

export type VoiceSessionComposerRouting = { kind: 'adapter_text'; binding: VoiceSessionBinding } | null;

type ComposerRoutingMemo = Readonly<{
    conversationSessionId: string;
    sessionMetadata: unknown;
    result: VoiceSessionComposerRouting;
}>;

/**
 * Single-slot memo for the default-singleton composer-routing lookup. Heavy
 * callers (e.g. `SessionView`) evaluate this on every render; reusing the shared
 * singleton resolver and returning a referentially-stable result when neither the
 * conversation id nor the session metadata changed avoids re-walking storage state
 * and re-allocating a resolver per render (audit F4).
 */
let composerRoutingMemo: ComposerRoutingMemo | null = null;

export function resolveVoiceSessionComposerRouting(params: Readonly<{
    conversationSessionId: string;
    store?: typeof voiceSessionBindingStore;
    sessionMetadata?: unknown;
}>): VoiceSessionComposerRouting {
    // A custom store (tests) bypasses the singleton memo and uses a scoped resolver.
    if (params.store && params.store !== voiceSessionBindingStore) {
        return createVoiceConversationBindingResolver({ store: params.store }).resolveComposerRouting(params);
    }

    if (
        composerRoutingMemo
        && composerRoutingMemo.conversationSessionId === params.conversationSessionId
        && composerRoutingMemo.sessionMetadata === (params.sessionMetadata ?? null)
    ) {
        return composerRoutingMemo.result;
    }

    const result = voiceConversationBindingResolver.resolveComposerRouting(params);
    composerRoutingMemo = {
        conversationSessionId: params.conversationSessionId,
        sessionMetadata: params.sessionMetadata ?? null,
        result,
    };
    return result;
}
