import * as React from 'react';
import { useGlobalSearchParams } from 'expo-router';

import { fireAndForget } from '@/utils/system/fireAndForget';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import { resolveActiveLocalVoiceAgentBinding } from '@/voice/context/resolveActiveLocalVoiceAgentBinding';
import { isVoiceQaDebugRuntime } from '@/voice/qa/voiceQaDebugRuntime';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';

import { dispatchForegroundVoiceTextTurnQa } from './foregroundVoiceTextTurnQaBridge';

export const FOREGROUND_VOICE_TEXT_TURN_QA_QUERY_PARAM = 'happier_voice_e2e_text_turn';

/**
 * AppShell-only QA transport. It observes one explicit deep-link text value;
 * it neither reads or changes the foreground context nor owns a route, action,
 * binding, or persisted test state.
 */
export function useForegroundVoiceTextTurnQaBridge(): void {
    const params = useGlobalSearchParams<{
        happier_voice_e2e_text_turn?: string | string[];
    }>();
    const voiceSessionSnapshot = useVoiceSessionSnapshot();
    const deliveredTextRef = React.useRef<Readonly<{
        text: string;
        binding: VoiceSessionBinding;
    }> | null>(null);
    const inFlightTextRef = React.useRef<Readonly<{
        text: string;
        binding: VoiceSessionBinding;
    }> | null>(null);
    const runtimeEnabled = isVoiceQaDebugRuntime();
    const text = runtimeEnabled && typeof params[FOREGROUND_VOICE_TEXT_TURN_QA_QUERY_PARAM] === 'string'
        ? params[FOREGROUND_VOICE_TEXT_TURN_QA_QUERY_PARAM]
        : null;
    const activeBinding = text?.trim()
        ? resolveActiveLocalVoiceAgentBinding()?.binding ?? null
        : null;

    React.useEffect(() => {
        if (!text?.trim() || !activeBinding) return;
        const delivered = deliveredTextRef.current;
        if (delivered?.text === text && delivered.binding === activeBinding) return;
        const inFlight = inFlightTextRef.current;
        if (inFlight?.text === text && inFlight.binding === activeBinding) return;

        const dispatched = { text, binding: activeBinding };
        inFlightTextRef.current = dispatched;
        fireAndForget(dispatchForegroundVoiceTextTurnQa(text).then((binding) => {
            if (!binding) return;
            if (resolveActiveLocalVoiceAgentBinding()?.binding !== binding) return;
            deliveredTextRef.current = { text, binding };
        }).finally(() => {
            if (inFlightTextRef.current === dispatched) {
                inFlightTextRef.current = null;
            }
        }), {
            tag: 'foreground_voice_text_turn_qa',
        });
    }, [activeBinding, text, voiceSessionSnapshot]);
}
