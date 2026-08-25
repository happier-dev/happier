import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
    capture: vi.fn(),
    captureLaunch: vi.fn(),
    clear: vi.fn(async () => true),
    clearLaunch: vi.fn(() => true),
    readLaunch: vi.fn(),
}));
const settingsRuntime = vi.hoisted(() => ({
    applySettings: vi.fn(),
    settings: { newSessionOrdinaryEntryDraftId: 'draft-a' },
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    captureSessionDraftCurrentness: repository.capture,
    captureSessionDraftLaunchCurrentness: repository.captureLaunch,
    clearSessionDraftCurrentness: repository.clear,
    clearSessionDraftLaunchCurrentness: repository.clearLaunch,
    readSessionDraftLaunchCurrentness: repository.readLaunch,
}));
vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => ({ getState: () => ({ settings: settingsRuntime.settings }) }),
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ applySettings: settingsRuntime.applySettings }),
}));

import {
    captureNewSessionDraftLaunchCurrentness,
    clearCapturedNewSessionDraftAfterLaunch,
} from './newSessionDraftLifecycle';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const draftId = '4a506d8a-85bd-4c42-a662-6f502f3acc45';
const otherDraftId = 'fa142bd3-1ec5-487b-a38c-16e7d4f0ab1d';
const address = { kind: 'newSession' as const, draftId };
const currentness = { address, mutationIds: { 'composer.text': 'mutation-a' } };

beforeEach(() => {
    repository.capture.mockReset();
    repository.capture.mockReturnValue(currentness);
    repository.captureLaunch.mockReset();
    repository.captureLaunch.mockReturnValue(currentness);
    repository.clear.mockReset();
    repository.clear.mockResolvedValue(true);
    repository.clearLaunch.mockReset();
    repository.clearLaunch.mockReturnValue(true);
    repository.readLaunch.mockReset();
    repository.readLaunch.mockReturnValue(currentness);
    settingsRuntime.applySettings.mockReset();
    settingsRuntime.settings = { newSessionOrdinaryEntryDraftId: draftId };
});

describe('newSessionDraftLifecycle', () => {
    it('captures exact field currentness and persists it beside action custody', () => {
        expect(captureNewSessionDraftLaunchCurrentness({
            scope,
            draftId,
            launchUserAttemptId: 'attempt-a',
        })).toBe(currentness);
        expect(repository.captureLaunch).toHaveBeenCalledWith({
            scope,
            address,
            userAttemptId: 'attempt-a',
        });
    });

    it('clears only captured field revisions and then releases local custody', async () => {
        await clearCapturedNewSessionDraftAfterLaunch({
            scope,
            draftId,
            launchUserAttemptId: 'attempt-a',
        });

        expect(repository.readLaunch).toHaveBeenCalledWith({ scope, address, userAttemptId: 'attempt-a' });
        expect(repository.clear).toHaveBeenCalledWith({ scope, address, currentness });
        expect(repository.clearLaunch).toHaveBeenCalledWith({ scope, address, userAttemptId: 'attempt-a' });
        expect(settingsRuntime.applySettings).toHaveBeenCalledWith(
            { newSessionOrdinaryEntryDraftId: null },
            { source: 'ui' },
        );
    });

    it('does not clear a different ordinary-entry pointer after launch', async () => {
        settingsRuntime.settings = { newSessionOrdinaryEntryDraftId: otherDraftId };

        await clearCapturedNewSessionDraftAfterLaunch({
            scope,
            draftId,
            launchUserAttemptId: 'attempt-a',
        });

        expect(settingsRuntime.applySettings).not.toHaveBeenCalled();
    });
});
