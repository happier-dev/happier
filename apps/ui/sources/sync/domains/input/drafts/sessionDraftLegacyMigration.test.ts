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
    loadRawSessionDraftValues: () => state.draftValues,
    saveRawSessionDraftValues: mocks.saveDraftValues,
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
        state.sessionDrafts = { 'session-a': '@a legacy text' };
        state.draftValues = {
            'session-a': {
                'routing.recipient': { v: 1, lastEditedAt: 1, value: null },
                'structuredInput.mentions': { v: 1, lastEditedAt: 1, value: [{ kind: 'session', tokenText: '@a', sessionId: 'a' }] },
                'structuredInput.composerAttachments': { v: 1, lastEditedAt: 1, value: [{
                    v: 1,
                    instanceId: 'issue-42',
                    attachment: { pluginId: 'acme.issues', localId: 'issue' },
                    key: '42',
                    value: { issueId: 42 },
                    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                }] },
            },
        };
        state.newDraft = {
            input: 'new legacy text',
            composerAttachments: [{
                v: 1,
                instanceId: 'attachment-a',
                pluginId: 'plugin-a',
                rendererId: 'renderer-a',
                value: { safe: true },
                fallbackPresentation: { title: 'Plugin attachment' },
                stagedMediaHandle: { mediaId: 'media-a', targetId: 'target-a' },
            }],
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
                text: '@a legacy text',
                mentions: [],
                attachments: [expect.objectContaining({ instanceId: 'issue-42', key: '42' })],
                routing: { recipient: { mode: 'manual', recipient: null } },
            },
        }));
        expect(mocks.writeNew).toHaveBeenCalledWith(expect.objectContaining({
            scope,
            draftId: '00000000-0000-4000-8000-000000000777',
            patch: expect.objectContaining({
                text: 'new legacy text',
                attachments: [expect.objectContaining({
                    instanceId: 'attachment-a',
                    value: { safe: true },
                })],
                authoring: expect.objectContaining({
                    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                    directory: '/workspace/repo',
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                }),
            }),
        }));
        expect(mocks.writeNew.mock.calls[0]?.[0].patch.authoring).not.toEqual(expect.objectContaining({
            machineId: expect.anything(),
            agentId: expect.anything(),
            backendTarget: expect.anything(),
            sessionConfigOptionOverrides: expect.anything(),
            selectedSecretId: expect.anything(),
            sessionOnlySecretValueEncByProfileIdByEnvVarName: expect.anything(),
        }));
        expect(mocks.writeSupplement).toHaveBeenCalledWith(expect.objectContaining({
            patch: expect.objectContaining({
                launchUserAttemptId: 'attempt-a',
                legacyNewSessionDraftV1: true,
                newSessionLocalState: expect.objectContaining({
                    selectedSecretId: 'secret-must-not-sync',
                    sessionConfigOptionOverrides: { apiKey: 'must-not-sync' },
                    sessionOnlySecretValueEncByProfileIdByEnvVarName: {
                        'profile-a': { TOKEN: 'ciphertext' },
                    },
                }),
            }),
        }));
        expect(state.sessionDrafts).toEqual({ 'session-a': '@a legacy text' });
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
