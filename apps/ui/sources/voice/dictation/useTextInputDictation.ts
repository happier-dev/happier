import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { useVoiceDictation } from './useVoiceDictation';
import { resolveVoiceDictationFailureTranslationKey, resolveVoiceDictationStartErrorTranslationKey } from './voiceDictationErrorCopy';

export type TextInputDictation = Readonly<{
    status: ReturnType<typeof useVoiceDictation>['status'];
    onPress(): Promise<void>;
}>;

/** Shared composer/author-input delivery adapter; capture, engine, language and permission stay canonical. */
export function useTextInputDictation(input: Readonly<{
    controlId: string;
    enabled: boolean;
    presented: boolean;
    editable: boolean;
    transcriptionSessionId: string | null;
    onTranscription(text: string): void;
}>): TextInputDictation {
    const authorityRef = React.useRef(input);
    authorityRef.current = input;
    React.useEffect(() => () => {
        if (authorityRef.current.controlId !== input.controlId) return;
        authorityRef.current = { ...authorityRef.current, controlId: '', enabled: false, presented: false, editable: false };
    }, [input.controlId]);
    const dictation = useVoiceDictation(input.controlId || undefined, input.presented && input.enabled, input.editable, input.transcriptionSessionId);

    React.useEffect(() => {
        if (!dictation.failure) return;
        if (dictation.failure.kind !== 'mic_permission_denied') {
            Modal.alert(t('common.error'), t(resolveVoiceDictationFailureTranslationKey(dictation.failure.reason)));
        }
        dictation.dismissFailure(dictation.failure.id);
    }, [dictation.dismissFailure, dictation.failure]);

    const onPress = React.useCallback(async () => {
        const current = authorityRef.current;
        if (!current.enabled || !current.presented || !current.editable || !input.controlId) return;
        const admittedKey = input.controlId;
        try {
            const result = await dictation.toggle();
            if (result.kind !== 'completed') return;
            const owner = authorityRef.current;
            if (owner.controlId !== admittedKey || !owner.enabled || !owner.presented || !owner.editable) return;
            if (!result.text) {
                Modal.alert(t('voiceAssistant.dictationNoSpeech'));
                return;
            }
            owner.onTranscription(result.text);
        } catch (error) {
            if (error instanceof Error && error.message === 'mic_permission_denied') return;
            const key = resolveVoiceDictationStartErrorTranslationKey(error);
            Modal.alert(t('common.error'), t(key ?? 'errors.dictationFailed'));
        }
    }, [dictation.toggle, input.controlId]);
    return { status: dictation.status, onPress };
}
