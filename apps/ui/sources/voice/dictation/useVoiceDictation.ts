import * as React from 'react';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type {
    VoiceDictationFailure,
    VoiceDictationSnapshot,
    VoiceDictationToggleResult,
} from './VoiceDictationController';
import { voiceDictationController } from './voiceDictationRuntime';
export { voiceDictationController } from './voiceDictationRuntime';

const IDLE_DICTATION_SNAPSHOT = Object.freeze({
    sessionId: null,
    status: 'idle',
} as const);
const subscribeToNothing = (): (() => void) => () => {};

export function useVoiceDictation(
    composerControlId: string | undefined,
    isPresented = true,
    isEditable = true,
    transcriptionSessionId?: string | null,
): Readonly<{
    cancel: () => Promise<void>;
    discard: () => Promise<void>;
    retry: () => Promise<VoiceDictationToggleResult>;
    getSnapshot: () => VoiceDictationSnapshot;
    dismissFailure: (failureId: number) => void;
    failure: VoiceDictationFailure | null;
    status: VoiceDictationSnapshot['status'];
    toggle: () => Promise<VoiceDictationToggleResult>;
}> {
    // The capture runtime retains its historical `sessionId` field name, but
    // Dictation only needs one exact live Composer correlation identity. It may
    // therefore be a real Session id or an origin-neutral Composer reference key.
    const normalizedSessionId = composerControlId?.trim() ?? '';
    const presentedSessionId = isPresented ? normalizedSessionId : '';
    const voiceEnabled = useFeatureEnabled('voice');
    const snapshot = React.useSyncExternalStore(
        presentedSessionId
            ? voiceDictationController.subscribe
            : subscribeToNothing,
        presentedSessionId
            ? voiceDictationController.getSnapshot
            : () => IDLE_DICTATION_SNAPSHOT,
        presentedSessionId
            ? voiceDictationController.getSnapshot
            : () => IDLE_DICTATION_SNAPSHOT,
    );

    React.useEffect(() => {
        if (!normalizedSessionId) return;
        if (!voiceEnabled || !isPresented || !isEditable) {
            void voiceDictationController.cancel(normalizedSessionId);
            return;
        }
        return () => {
            void voiceDictationController.cancel(normalizedSessionId);
        };
    }, [isEditable, isPresented, normalizedSessionId, voiceEnabled]);

    const toggle = React.useCallback(async () => {
        if (!normalizedSessionId || !voiceEnabled || !isPresented || !isEditable) {
            return { kind: 'cancelled' } as const;
        }
        return await voiceDictationController.toggle({
            controlId: normalizedSessionId,
            // Preserve the released Session-addressed hook call shape. Only an
            // explicit null declares that this authoring surface has no Session.
            transcriptionSessionId: transcriptionSessionId === undefined
                ? normalizedSessionId
                : transcriptionSessionId?.trim() || null,
        });
    }, [isEditable, isPresented, normalizedSessionId, transcriptionSessionId, voiceEnabled]);

    const dismissFailure = React.useCallback((failureId: number) => {
        voiceDictationController.dismissFailure(failureId);
    }, []);

    const cancel = React.useCallback(() => voiceDictationController.cancel(normalizedSessionId), [normalizedSessionId]);
    const discard = React.useCallback(() => voiceDictationController.discard(normalizedSessionId), [normalizedSessionId]);
    const retry = React.useCallback(() => voiceDictationController.retry(normalizedSessionId), [normalizedSessionId]);
    const getSnapshot = React.useCallback(() => {
        const current = voiceDictationController.getSnapshot();
        return current.sessionId === normalizedSessionId || current.failure?.sessionId === normalizedSessionId
            ? current : IDLE_DICTATION_SNAPSHOT;
    }, [normalizedSessionId]);

    return {
        cancel,
        discard,
        retry,
        getSnapshot,
        status: snapshot.sessionId === presentedSessionId
            ? snapshot.status
            : 'idle',
        dismissFailure,
        failure: snapshot.failure?.sessionId === presentedSessionId
            ? snapshot.failure
            : null,
        toggle,
    };
}
