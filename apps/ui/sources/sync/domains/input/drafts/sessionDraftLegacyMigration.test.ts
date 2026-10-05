import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDraftRepository } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

const state = vi.hoisted(() => ({
    sessionDrafts: {} as Record<string, string>,
    draftValues: {} as Record<string, Record<string, { v: number; lastEditedAt: number; value: unknown }>>,
    newDraft: null as Record<string, unknown> | null,
    acknowledged: false,
    repository: null as SessionDraftRepository | null,
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
    writeExistingSessionDraft: (...args: Parameters<SessionDraftRepository['writeExistingSessionDraft']>) => (
        state.repository ? state.repository.writeExistingSessionDraft(...args) : mocks.writeExisting(...args)
    ),
    writeNewSessionDraft: mocks.writeNew,
    writeSessionDraftLocalSupplement: (...args: Parameters<SessionDraftRepository['writeSessionDraftLocalSupplement']>) => (
        state.repository ? state.repository.writeSessionDraftLocalSupplement(...args) : mocks.writeSupplement(...args)
    ),
    flushSessionDraft: (...args: Parameters<SessionDraftRepository['flushSessionDraft']>) => (
        state.repository ? state.repository.flushSessionDraft(...args) : mocks.flush()
    ),
    isSessionDraftRemoteAcknowledged: (...args: Parameters<SessionDraftRepository['isSessionDraftRemoteAcknowledged']>) => (
        state.repository ? state.repository.isSessionDraftRemoteAcknowledged(...args) : state.acknowledged
    ),
    getSessionDraftSnapshot: (...args: Parameters<SessionDraftRepository['getSessionDraftSnapshot']>) => (
        state.repository ? state.repository.getSessionDraftSnapshot(...args) : null
    ),
    listNewSessionDraftProjections: () => [],
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => '00000000-0000-4000-8000-000000000777',
}));

import { migrateLegacySessionDrafts, parseLegacySessionDraftMentions } from './sessionDraftLegacyMigration';
import { parseComposerStructuredInputMentionsForText } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

describe('migrateLegacySessionDrafts', () => {
    beforeEach(() => {
        state.sessionDrafts = {};
        state.draftValues = {};
        state.newDraft = null;
        state.acknowledged = false;
        state.repository = null;
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
                mentions: [expect.objectContaining({ kind: 'happier.session', ref: 'session:a', tokenText: '@a', start: 0, end: 2 })],
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
                    executionTarget: { kind: 'machine', target: { serverId: 'server-a', machineId: 'machine-a' } },
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
        state.draftValues = {};
        state.newDraft = {
            input: 'new legacy text', selectedMachineId: null, selectedPath: null, selectedProfileId: null,
            agentType: 'codex', permissionMode: 'default', modelMode: 'default', acpSessionModeId: null, updatedAt: 10,
        };

        await migrateLegacySessionDrafts(scope);

        expect(state.sessionDrafts).toEqual({});
        expect(state.draftValues).toEqual({});
        expect(state.newDraft).toBeNull();
    });

    it('places validated predecessor references once without rebinding exact current occurrences or losing catalog data', () => {
        const text = '@same @vendor @skill @future @same';
        const last = text.lastIndexOf('@same');
        const exact = { kind: 'partner.reference', ref: 'partner:second', tokenText: '@same', start: last, end: last + 5 };
        // Positionless leaves are observed 0.2 storage. A mixed retained collection is a derived migration input.
        const value = [
            { kind: 'session', sessionId: 'predecessor-session', tokenText: '@same', label: 'Prior session' },
            { kind: 'vendorPlugin', vendorPluginRef: 'vendor:plugin-a', tokenText: '@vendor', backendId: 'claude', label: 'Plugin' },
            { kind: 'skill', id: 'skill-a', name: 'Review', tokenText: '@skill', path: '/workspace/skills/review',
                description: 'Review changes', origin: 'happier', projectionRef: 'projection-a', agentId: 'claude' },
            { kind: 'partner.reference', ref: 'partner:first', tokenText: '@future', extra: { safe: true } },
            exact,
        ];
        const result = parseLegacySessionDraftMentions(value, text);
        expect(result.fullyDecoded).toBe(true);
        expect(result.mentions).toEqual([
            expect.objectContaining({ kind: 'happier.session', ref: 'session:predecessor-session', start: 0, end: 5 }),
            expect.objectContaining({ kind: 'vendorPlugin', vendorPluginRef: 'vendor:plugin-a', backendId: 'claude', start: 6, end: 13 }),
            expect.objectContaining({ kind: 'skill', id: 'skill-a', name: 'Review', path: '/workspace/skills/review',
                description: 'Review changes', projectionRef: 'projection-a', agentId: 'claude', start: 14, end: 20 }),
            expect.objectContaining({ kind: 'partner.reference', ref: 'partner:first', extra: { safe: true }, start: 21, end: 28 }),
            exact,
        ]);
        expect(parseComposerStructuredInputMentionsForText(value, text)).toEqual({ mentions: [exact], fullyDecoded: false });
    });

    it('seeds valid partial legacy data while retaining its undecodable source after acknowledgement', async () => {
        state.acknowledged = true;
        state.sessionDrafts = { 'session-a': '@a' };
        state.draftValues = { 'session-a': { 'structuredInput.mentions': {
            v: 1, lastEditedAt: 1, value: [
                { kind: 'session', tokenText: '@a', sessionId: 'a' },
                { kind: 'vendorPlugin', tokenText: '@a', vendorPluginRef: 42 },
            ],
        } } };
        await migrateLegacySessionDrafts(scope);
        expect(state.sessionDrafts).toEqual({ 'session-a': '@a' });
        expect(state.draftValues).toHaveProperty('session-a');
        expect(mocks.writeExisting).toHaveBeenCalledWith(expect.objectContaining({ patch: {
            text: '@a', mentions: [expect.objectContaining({ ref: 'session:a', start: 0, end: 2 })],
        } }));
        expect(mocks.writeSupplement).toHaveBeenCalledWith(expect.objectContaining({ patch: { legacyExistingSessionDraftV1: true } }));
    });

    it('preserves per-occurrence skill catalog fields when the same predecessor identity appears twice', () => {
        const base = { kind: 'skill', id: 'skill-a', origin: 'happier', name: 'Review', tokenText: '@skill' };
        const result = parseLegacySessionDraftMentions([
            { ...base, description: 'First saved context', path: '/first' },
            { ...base, description: 'Second saved context', path: '/second' },
        ], '@skill @skill');
        expect(result.fullyDecoded).toBe(true);
        expect(result.mentions).toMatchObject([
            { description: 'First saved context', path: '/first', start: 0, end: 6 },
            { description: 'Second saved context', path: '/second', start: 7, end: 13 },
        ]);
    });

    it('retains previously captured but undecoded predecessor references after the actual repository acknowledges its empty projection', async () => {
        const actual = await vi.importActual<typeof import('@/sync/ops/sessionDrafts/sessionDraftRepository')>(
            '@/sync/ops/sessionDrafts/sessionDraftRepository',
        );
        const { createSessionDraftPrivatePayloadV2 } = await import('@happier-dev/protocol');
        const values = new Map<string, string>();
        // Storage, encryption and remote transport are system boundaries; the repository and migration logic are real.
        const repository = actual.createSessionDraftRepository({
            scope, syncEnabled: true,
            storage: { getString: key => values.get(key), set: (key, value) => { values.set(key, value); }, delete: key => { values.delete(key); } },
            cipher: { seal: async (address, document) => ({ t: 'plain', v: createSessionDraftPrivatePayloadV2(address, document) }),
                open: async (_address, content) => content.t === 'plain' ? content.v.document : null },
            transport: { read: async () => ({ status: 'absent' }), list: async () => ({ items: [] }),
                mutate: async ({ address, content, expectedRevision }) => ({ status: 'updated', record: {
                    address, revision: typeof expectedRevision === 'number' ? expectedRevision + 1 : 0, content, createdAt: 1, updatedAt: 1,
                } }) },
        });
        const address = { kind: 'session', sessionId: 'session-a' } as const;
        const text = '@a legacy text';
        const legacy = [{ kind: 'session', tokenText: '@a', sessionId: 'a' }];
        // Reproduce the old migration's exact strict-parser output, not a reconstructed document fixture.
        const oldProjection = parseComposerStructuredInputMentionsForText(legacy, text);
        expect(oldProjection).toEqual({ mentions: [], fullyDecoded: false });
        repository.writeExistingSessionDraft({ scope, sessionId: address.sessionId, patch: { text, mentions: oldProjection.mentions }, materializationIntent: 'seeded' });
        repository.writeSessionDraftLocalSupplement({ scope, address, patch: { legacyExistingSessionDraftV1: true } });
        expect((await repository.flushSessionDraft({ scope, address })).status).toBe('clean');
        state.repository = repository;
        expect(repository.isSessionDraftRemoteAcknowledged(scope, address)).toBe(true);
        const oldCanonicalDocument = repository.getSessionDraftSnapshot(scope, address)?.document;
        state.sessionDrafts = { 'session-a': text };
        state.draftValues = { 'session-a': { 'structuredInput.mentions': { v: 1, lastEditedAt: 1, value: legacy } } };
        await migrateLegacySessionDrafts(scope);
        expect(state.sessionDrafts).toEqual({ 'session-a': text });
        expect(state.draftValues).toHaveProperty('session-a');
        expect(state.draftValues['session-a']['structuredInput.mentions'].value).toEqual(legacy);
        expect(repository.getSessionDraftSnapshot(scope, address)?.document).toEqual(oldCanonicalDocument);
        repository.writeExistingSessionDraft({ scope, sessionId: address.sessionId, patch: { text: 'Edited canonical draft' } });
        await repository.flushSessionDraft({ scope, address });
        const editedCanonicalDocument = repository.getSessionDraftSnapshot(scope, address)?.document;
        await migrateLegacySessionDrafts(scope);
        expect(repository.getSessionDraftSnapshot(scope, address)?.document.composer.text.value).toBe('Edited canonical draft');
        expect(state.sessionDrafts).toEqual({ 'session-a': text });
        expect(state.draftValues).toHaveProperty('session-a');
        expect(state.draftValues['session-a']['structuredInput.mentions'].value).toEqual(legacy);
        expect(repository.getSessionDraftSnapshot(scope, address)?.document).toEqual(editedCanonicalDocument);
        // Control: a real correctly captured repository record retires normally.
        repository.writeExistingSessionDraft({ scope, sessionId: address.sessionId, patch: { text, mentions: parseLegacySessionDraftMentions(legacy, text).mentions } });
        await repository.flushSessionDraft({ scope, address });
        const correctlyCapturedDocument = repository.getSessionDraftSnapshot(scope, address)?.document;
        await migrateLegacySessionDrafts(scope);
        expect(state.sessionDrafts).toEqual({});
        expect(state.draftValues).toEqual({});
        expect(repository.getSessionDraftSnapshot(scope, address)?.document).toEqual(correctlyCapturedDocument);
    });
});
