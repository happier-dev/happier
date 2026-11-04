import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import {
    flushSessionDraftLocally,
    reloadSessionDraftFromLocalPersistence,
    subscribeSessionDraft,
} from './sessionDraftRepository';

/** The shell releases its mounted composer after this existing local durability barrier. */
export async function prepareSessionDraftWindowTransfer(target: ExactSessionMachineTargetIdentity): Promise<void> {
    await flushSessionDraftLocally({ scope: target });
}

/** Subscribe before reacquiring the previous presenter's persisted replica, then mount the composer. */
export async function resumeSessionDraftWindowPresentation(
    target: ExactSessionMachineTargetIdentity,
    onChange: () => void = () => {},
): Promise<() => void> {
    const address = { kind: 'session' as const, sessionId: target.sessionId };
    const unsubscribe = subscribeSessionDraft(target, address, onChange);
    try {
        await reloadSessionDraftFromLocalPersistence({ scope: target, address });
        return unsubscribe;
    } catch (error) {
        unsubscribe();
        throw error;
    }
}
