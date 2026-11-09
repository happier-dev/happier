import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    captureSessionDraftCurrentness,
    getSessionComposerDraftSnapshot,
    readSessionDraftLaunchCurrentness,
    resetSessionDraftRepositoryForTests,
    writeNewSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { clearPersistenceStorage, getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { readOrdinaryNewSessionDraftId, rememberOrdinaryNewSessionDraftId } from '@/sync/domains/state/newSessionTargetUiState';
import {
    captureNewSessionDraftLaunchCurrentness,
    clearCapturedNewSessionDraftAfterLaunch,
    preserveCreatedSessionDraftAfterUnacceptedFirstTurn,
    readCapturedNewSessionFirstTurnText,
} from './newSessionDraftLifecycle';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const draftId = '4a506d8a-85bd-4c42-a662-6f502f3acc45';
const otherDraftId = 'fa142bd3-1ec5-487b-a38c-16e7d4f0ab1d';
const address = { kind: 'newSession' as const, draftId };

beforeEach(() => {
    resetSessionDraftRepositoryForTests();
    clearPersistenceStorage();
    writeNewSessionDraft({ scope, draftId, patch: { text: 'Captured prompt' }, materializationIntent: 'userEdit' });
    rememberOrdinaryNewSessionDraftId(scope, draftId);
});
afterEach(() => { vi.restoreAllMocks(); resetSessionDraftRepositoryForTests(); clearPersistenceStorage(); });

describe('newSessionDraftLifecycle', () => {
    it('captures exact field currentness and persists it beside action custody', () => {
        const currentness = captureSessionDraftCurrentness({ scope, address });
        expect(captureNewSessionDraftLaunchCurrentness({ scope, draftId, launchUserAttemptId: 'attempt-a' }))
            .toEqual(currentness);
        expect(readSessionDraftLaunchCurrentness({ scope, address, userAttemptId: 'attempt-a' })).toEqual(currentness);
    });

    it('clears only captured field revisions and then releases local custody without a Settings write', async () => {
        captureNewSessionDraftLaunchCurrentness({ scope, draftId, launchUserAttemptId: 'attempt-a' });
        writeNewSessionDraft({ scope, draftId, patch: { text: 'Newer unsent text' }, materializationIntent: 'userEdit' });
        const deviceWrite = vi.spyOn(getPersistenceStorage(), 'set');

        await clearCapturedNewSessionDraftAfterLaunch({ scope, draftId, launchUserAttemptId: 'attempt-a' });

        expect(readSessionDraftLaunchCurrentness({ scope, address, userAttemptId: 'attempt-a' })).toBeNull();
        expect(getSessionComposerDraftSnapshot(scope, address)?.composer.text.value).toBe('Newer unsent text');
        expect(readOrdinaryNewSessionDraftId(scope)).toBeNull();
        expect(deviceWrite.mock.calls.filter(([key]) => key === 'settings' || key.startsWith('account-settings:'))).toHaveLength(0);
    });

    it('does not clear a different ordinary-entry pointer after launch', async () => {
        captureNewSessionDraftLaunchCurrentness({ scope, draftId, launchUserAttemptId: 'attempt-a' });
        rememberOrdinaryNewSessionDraftId(scope, otherDraftId);
        await clearCapturedNewSessionDraftAfterLaunch({ scope, draftId, launchUserAttemptId: 'attempt-a' });
        expect(readOrdinaryNewSessionDraftId(scope)).toBe(otherDraftId);
    });

    it('moves an unaccepted first turn into the created session draft', () => {
        preserveCreatedSessionDraftAfterUnacceptedFirstTurn({ scope, sessionId: 'session-created',
            draftText: '  Keep this prompt editable  ' });
        expect(getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 'session-created' })?.composer.text.value)
            .toBe('Keep this prompt editable');
    });

    it('reads the captured first-turn text only while its mutation is still current', () => {
        captureNewSessionDraftLaunchCurrentness({ scope, draftId, launchUserAttemptId: 'attempt-a' });
        expect(readCapturedNewSessionFirstTurnText({ scope, draftId, launchUserAttemptId: 'attempt-a' })).toBe('Captured prompt');
        writeNewSessionDraft({ scope, draftId, patch: { text: 'Changed prompt' }, materializationIntent: 'userEdit' });
        expect(readCapturedNewSessionFirstTurnText({ scope, draftId, launchUserAttemptId: 'attempt-a' })).toBeNull();
    });
});
