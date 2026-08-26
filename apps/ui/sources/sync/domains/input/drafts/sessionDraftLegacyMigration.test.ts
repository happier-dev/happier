import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    sessionDrafts: {} as Record<string, string>,
    draftValues: {} as Record<string, Record<string, { v: number; lastEditedAt: number; value: unknown }>>,
    newDraft: null as Record<string, unknown> | null,
    acknowledged: false,
}));

const mocks = vi.hoisted(() => ({
    saveSessionDrafts: vi.fn((value: Record<string, string>) => { state.sessionDrafts = value; }),
    saveDraftValues: vi.fn((value: typeof state.draftValues) => { state.draftValues = value; }),
    clearNewDraft: vi.fn(() => { state.newDraft = null; }),
    writeExisting: vi.fn(),
    writeNew: vi.fn(),
    writeSupplement: vi.fn(),
    flush: vi.fn(async () => ({ status: state.acknowledged ? 'clean' as const : 'local-only' as const })),
}));

vi.mock('@/sync/domains/state/persistence', () => ({
    loadSessionDrafts: () => state.sessionDrafts,
    saveSessionDrafts: mocks.saveSessionDrafts,
    loadNewSessionDraft: () => state.newDraft,
    clearNewSessionDraft: mocks.clearNewDraft,
}));

vi.mock('@/sync/domains/state/sessionDraftValuesPersistence', () => ({
    loadPersistedSessionDraftValues: () => state.draftValues,
    savePersistedSessionDraftValues: mocks.saveDraftValues,
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    writeExistingSessionDraft: mocks.writeExisting,
    writeNewSessionDraft: mocks.writeNew,
    writeSessionDraftLocalSupplement: mocks.writeSupplement,
    flushSessionDraft: mocks.flush,
    isSessionDraftRemoteAcknowledged: () => state.acknowledged,
    getSessionDraftSnapshot: () => null,
    listNewSessionDraftProjections: () => [],
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => '00000000-0000-4000-8000-000000000777',
}));

import { migrateLegacySessionDrafts } from './sessionDraftLegacyMigration';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

describe('migrateLegacySessionDrafts', () => {
    beforeEach(() => {
        state.sessionDrafts = {};
        state.draftValues = {};
        state.newDraft = null;
        state.acknowledged = false;
        vi.clearAllMocks();
    });

    it('projects all legacy owners into the repository while preserving local sources until remote acknowledgement', async () => {
        state.sessionDrafts = { 'session-a': 'legacy text' };
        state.draftValues = {
            'session-a': {
                'routing.recipient': { v: 1, lastEditedAt: 1, value: null },
                'structuredInput.mentions': { v: 1, lastEditedAt: 1, value: [{ kind: 'session', tokenText: '@a', sessionId: 'a' }] },
            },
        };
        state.newDraft = {
            input: 'new legacy text',
            selectedMachineId: 'machine-a',
            selectedPath: '/workspace/repo',
            selectedProfileId: 'profile-a',
            selectedSecretId: 'secret-must-not-sync',
            sessionOnlySecretValueEncByProfileIdByEnvVarName: { 'profile-a': { TOKEN: 'ciphertext' } },
            agentType: 'codex',
            permissionMode: 'default',
            modelMode: 'default',
            acpSessionModeId: null,
            sessionConfigOptionOverrides: { apiKey: 'must-not-sync' },
            launchUserAttemptId: 'attempt-a',
            updatedAt: 10,
        };

        await migrateLegacySessionDrafts(scope);

        expect(mocks.writeExisting).toHaveBeenCalledWith(expect.objectContaining({
            scope,
            sessionId: 'session-a',
            patch: {
                text: 'legacy text',
                mentions: [{ kind: 'session', tokenText: '@a', sessionId: 'a' }],
                routing: { recipient: { mode: 'manual', recipient: null } },
            },
        }));
        expect(mocks.writeNew).toHaveBeenCalledWith(expect.objectContaining({
            scope,
            draftId: '00000000-0000-4000-8000-000000000777',
            patch: expect.objectContaining({
                text: 'new legacy text',
                authoring: expect.objectContaining({ machineId: 'machine-a', directory: '/workspace/repo' }),
            }),
        }));
        expect(mocks.writeNew.mock.calls[0]?.[0].patch.authoring).not.toEqual(expect.objectContaining({
            sessionConfigOptionOverrides: expect.anything(),
            selectedSecretId: expect.anything(),
            sessionOnlySecretValueEncByProfileIdByEnvVarName: expect.anything(),
        }));
        const newSessionSupplementWrite = mocks.writeSupplement.mock.calls
            .map(([params]) => params)
            .find((params) => params.address?.kind === 'newSession');
        expect(newSessionSupplementWrite).toEqual(expect.objectContaining({
            scope,
            address: { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000777' },
            patch: expect.objectContaining({
                launchUserAttemptId: 'attempt-a',
                legacyNewSessionDraftV1: true,
                newSessionLocalState: expect.objectContaining({
                    selectedSecretId: 'secret-must-not-sync',
                    sessionConfigOptionOverrides: { apiKey: 'must-not-sync' },
                    sessionOnlySecretValueEncByProfileIdByEnvVarName: { 'profile-a': { TOKEN: 'ciphertext' } },
                }),
            }),
        }));
        expect(state.sessionDrafts).toEqual({ 'session-a': 'legacy text' });
        expect(state.draftValues).toHaveProperty('session-a');
        expect(state.newDraft).not.toBeNull();
    });

    it('retires each legacy source only after the repository reports a remote acknowledgement', async () => {
        state.acknowledged = true;
        state.sessionDrafts = { 'session-a': 'legacy text' };
        state.draftValues = {
            'session-a': {
                'routing.executionRunDelivery': { v: 1, lastEditedAt: 1, value: 'interrupt' },
            },
        };
        state.newDraft = {
            input: 'new legacy text', selectedMachineId: null, selectedPath: null, selectedProfileId: null,
            agentType: 'codex', permissionMode: 'default', modelMode: 'default', acpSessionModeId: null, updatedAt: 10,
        };

        await migrateLegacySessionDrafts(scope);

        expect(state.sessionDrafts).toEqual({});
        expect(state.draftValues).toEqual({});
        expect(state.newDraft).toBeNull();
    });
});
