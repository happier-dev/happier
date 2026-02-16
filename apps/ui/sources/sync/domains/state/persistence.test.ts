import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

import {
    clearPersistence,
    loadNewSessionDraft,
    loadPendingSettings,
    savePendingSettings,
    loadSessionModelModes,
    saveSessionModelModes,
    loadSessionMaterializedMaxSeqById,
    saveSessionMaterializedMaxSeqById,
    loadChangesCursor,
    saveChangesCursor,
    loadLastChangesCursorByAccountId,
    saveLastChangesCursorByAccountId,
    loadSessionReviewCommentsDrafts,
    saveSessionReviewCommentsDrafts,
    loadSessionActionDrafts,
    saveSessionActionDrafts,
} from './persistence';

describe('persistence', () => {
    beforeEach(() => {
        clearPersistence();
    });

    describe('session model modes', () => {
        it('returns an empty object when nothing is persisted', () => {
            expect(loadSessionModelModes()).toEqual({});
        });

        it('roundtrips session model modes', () => {
            saveSessionModelModes({ abc: 'gemini-2.5-pro' });
            expect(loadSessionModelModes()).toEqual({ abc: 'gemini-2.5-pro' });
        });

        it('filters out invalid persisted model modes', () => {
            store.set(
                'session-model-modes',
                JSON.stringify({ abc: 'gemini-2.5-pro', bad: '   ', num: 12 }),
            );
            expect(loadSessionModelModes()).toEqual({ abc: 'gemini-2.5-pro' });
        });

        it('preserves non-empty freeform model ids (for providers without a fixed catalog)', () => {
            store.set(
                'session-model-modes',
                JSON.stringify({ abc: 'gemini-2.5-pro', custom: 'claude-3-5-sonnet-latest', bad: '   ' }),
            );
            expect(loadSessionModelModes()).toEqual({ abc: 'gemini-2.5-pro', custom: 'claude-3-5-sonnet-latest' });
        });
    });

    describe('session materialized max seq', () => {
        it('returns an empty object when nothing is persisted', () => {
            expect(loadSessionMaterializedMaxSeqById()).toEqual({});
        });

        it('roundtrips session materialized max seq', () => {
            saveSessionMaterializedMaxSeqById({ abc: 12 });
            expect(loadSessionMaterializedMaxSeqById()).toEqual({ abc: 12 });
        });

        it('filters out invalid persisted values', () => {
            store.set(
                'session-materialized-max-seq-v1',
                JSON.stringify({ ok: 5, neg: -1, nan: NaN, str: 'nope' }),
            );
            expect(loadSessionMaterializedMaxSeqById()).toEqual({ ok: 5 });
        });
    });

    describe('last changes cursor', () => {
        it('returns an empty object when nothing is persisted', () => {
            expect(loadLastChangesCursorByAccountId()).toEqual({});
        });

        it('roundtrips last changes cursor', () => {
            saveLastChangesCursorByAccountId({ a1: 5, a2: 9 });
            expect(loadLastChangesCursorByAccountId()).toEqual({ a1: 5, a2: 9 });
        });

        it('filters out invalid persisted values', () => {
            store.set(
                'last-changes-cursor-by-account-id-v1',
                JSON.stringify({ ok: 5, neg: -1, nan: NaN, str: 'nope' }),
            );
            expect(loadLastChangesCursorByAccountId()).toEqual({ ok: 5 });
        });
    });

    describe('changes cursor (string)', () => {
        it('returns null when no profile is persisted', () => {
            expect(loadChangesCursor()).toBeNull();
        });

        it('roundtrips cursor per account id', () => {
            store.set('profile', JSON.stringify({ id: 'a1', timestamp: 0, firstName: null, lastName: null, avatar: null }));
            expect(loadChangesCursor()).toBeNull();

            saveChangesCursor('123');
            expect(loadChangesCursor()).toBe('123');
        });

        it('salvages cursor from the legacy numeric map', () => {
            store.set('profile', JSON.stringify({ id: 'a1', timestamp: 0, firstName: null, lastName: null, avatar: null }));
            store.set('last-changes-cursor-by-account-id-v1', JSON.stringify({ a1: 7 }));
            expect(loadChangesCursor()).toBe('7');
        });

        it('clears the key when saving an empty cursor', () => {
            store.set('profile', JSON.stringify({ id: 'a1', timestamp: 0, firstName: null, lastName: null, avatar: null }));
            saveChangesCursor('9');
            expect(loadChangesCursor()).toBe('9');

            saveChangesCursor('');
            expect(loadChangesCursor()).toBeNull();
        });

        it('isolates cursor values by server scope when provided', () => {
            store.set('profile', JSON.stringify({ id: 'a1', timestamp: 0, firstName: null, lastName: null, avatar: null }));

            (saveChangesCursor as any)('11', 'server-a');
            expect((loadChangesCursor as any)('server-a')).toBe('11');
            expect((loadChangesCursor as any)('server-b')).toBeNull();

            (saveChangesCursor as any)('21', 'server-b');
            expect((loadChangesCursor as any)('server-a')).toBe('11');
            expect((loadChangesCursor as any)('server-b')).toBe('21');
        });

        it('does not read unscoped cursor when explicit server scope is requested', () => {
            store.set('profile', JSON.stringify({ id: 'a1', timestamp: 0, firstName: null, lastName: null, avatar: null }));

            saveChangesCursor('77');
            expect((loadChangesCursor as any)('server-a')).toBeNull();
            expect(loadChangesCursor()).toBe('77');
        });
    });

    describe('pending settings', () => {
        it('returns empty object when nothing is persisted', () => {
            expect(loadPendingSettings()).toEqual({});
        });

        it('does not materialize schema defaults when persisted pending is {}', () => {
            // Historically, parsing pending via SettingsSchema.partial().parse({}) would
            // synthesize defaults (secrets, dismissedCLIWarnings, etc) once defaults were
            // added to the schema. Pending must remain delta-only.
            store.set('pending-settings', JSON.stringify({}));
            expect(loadPendingSettings()).toEqual({});
        });

        it('returns empty object when pending-settings JSON is invalid', () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            store.set('pending-settings', '{ this is not json');
            expect(loadPendingSettings()).toEqual({});
            spy.mockRestore();
        });

        it('returns empty object when persisted pending is not an object', () => {
            store.set('pending-settings', JSON.stringify(null));
            expect(loadPendingSettings()).toEqual({});

            store.set('pending-settings', JSON.stringify('oops'));
            expect(loadPendingSettings()).toEqual({});

            store.set('pending-settings', JSON.stringify(123));
            expect(loadPendingSettings()).toEqual({});

            store.set('pending-settings', JSON.stringify([1, 2, 3]));
            expect(loadPendingSettings()).toEqual({});
        });

        it('drops unknown keys from pending', () => {
            store.set('pending-settings', JSON.stringify({ unknownFutureKey: 1, viewInline: true }));
            expect(loadPendingSettings()).toEqual({ viewInline: true });
        });

        it('drops invalid known keys from pending (type mismatch)', () => {
            store.set('pending-settings', JSON.stringify({ viewInline: 'nope', analyticsOptOut: 123 }));
            expect(loadPendingSettings()).toEqual({});
        });

        it('salvages voice pending delta even when nested fields are invalid (preserves BYO apiKey)', () => {
            store.set('pending-settings', JSON.stringify({
                voice: {
                    providerId: 'realtime_elevenlabs',
                    // Invalid nested type that would fail strict VoiceSettingsSchema parsing.
                    privacy: { recentMessagesCount: 'nope' },
                    adapters: {
                        realtime_elevenlabs: {
                            billingMode: 'byo',
                            byo: {
                                agentId: 'agent_1',
                                apiKey: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'abc' } },
                            },
                        },
                    },
                },
            }));

            const pending = loadPendingSettings() as any;
            expect(Object.keys(pending).sort()).toEqual(['voice']);
            expect(pending.voice?.adapters?.realtime_elevenlabs?.byo?.agentId).toBe('agent_1');
            expect(pending.voice?.adapters?.realtime_elevenlabs?.byo?.apiKey).toEqual(
                { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'abc' } },
            );
        });

        it('keeps valid secrets delta and does not inject other defaults', () => {
            store.set('pending-settings', JSON.stringify({
                secrets: [{
                    id: 'k1',
                    name: 'Test',
                    kind: 'apiKey',
                    encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'abc' } },
                    createdAt: 1,
                    updatedAt: 1,
                }],
            }));
            const pending = loadPendingSettings() as any;
            expect(Object.keys(pending).sort()).toEqual(['secrets']);
            expect(pending.secrets).toHaveLength(1);
            expect(pending.secrets[0].id).toBe('k1');
        });

        it('drops invalid secrets delta (missing value) and does not inject defaults', () => {
            store.set('pending-settings', JSON.stringify({
                secrets: [{ id: 'k1', name: 'Missing value', encryptedValue: { _isSecretValue: true } }],
            }));
            expect(loadPendingSettings()).toEqual({});
        });

        it('deletes pending-settings key when saving empty object', () => {
            savePendingSettings({ someUnknownKey: 1 } as any);
            expect(store.get('pending-settings')).toBeTruthy();
            savePendingSettings({});
            expect(store.get('pending-settings')).toBeUndefined();
        });
    });

    describe('session action drafts', () => {
        it('returns an empty object when nothing is persisted', () => {
            expect(loadSessionActionDrafts()).toEqual({});
        });

        it('roundtrips session action drafts and drops invalid entries', () => {
            saveSessionActionDrafts({
                s1: [{
                    id: 'd1',
                    sessionId: 's1',
                    actionId: 'review.start',
                    createdAt: 1,
                    status: 'editing',
                    input: { a: 1 },
                    error: null,
                }],
            });

            // Inject invalid session id and invalid draft shape alongside the valid one.
            store.set('session-action-drafts-v1', JSON.stringify({
                s1: [
                    {
                        id: 'd1',
                        sessionId: 's1',
                        actionId: 'review.start',
                        createdAt: 1,
                        status: 'editing',
                        input: { a: 1 },
                        error: null,
                    },
                    { id: '', sessionId: 's1' },
                ],
                '   ': [{ id: 'x', sessionId: 'x', actionId: 'a', createdAt: 1, status: 'editing', input: {} }],
            }));

            expect(loadSessionActionDrafts()).toEqual({
                s1: [{
                    id: 'd1',
                    sessionId: 's1',
                    actionId: 'review.start',
                    createdAt: 1,
                    status: 'editing',
                    input: { a: 1 },
                    error: null,
                }],
            });
        });
    });

    describe('new session draft', () => {
        it('preserves valid non-session modelMode values', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'claude',
                    permissionMode: 'default',
                    modelMode: 'adaptiveUsage',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect(draft?.modelMode).toBe('adaptiveUsage');
        });

        it('preserves freeform model ids in the new session draft', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'claude',
                    permissionMode: 'default',
                    modelMode: 'claude-3-5-sonnet-latest',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect(draft?.modelMode).toBe('claude-3-5-sonnet-latest');
        });

        it('roundtrips resumeSessionId when persisted', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'claude',
                    permissionMode: 'default',
                    modelMode: 'default',
                    sessionType: 'simple',
                    resumeSessionId: 'abc123',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect(draft?.resumeSessionId).toBe('abc123');
        });

        it('migrates legacy auggieAllowIndexing into agentNewSessionOptionStateByAgentId', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'auggie',
                    permissionMode: 'default',
                    modelMode: 'default',
                    sessionType: 'simple',
                    auggieAllowIndexing: true,
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect((draft as any)?.agentNewSessionOptionStateByAgentId?.auggie?.allowIndexing).toBe(true);
        });

        it('clamps invalid permissionMode to default', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'gemini',
                    permissionMode: 'bogus',
                    modelMode: 'default',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect(draft?.permissionMode).toBe('default');
        });

        it('clamps invalid modelMode to default', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'gemini',
                    permissionMode: 'default',
                    modelMode: '   ',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect(draft?.modelMode).toBe('default');
        });

        it('roundtrips automation draft when automation is enabled', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'gemini',
                    permissionMode: 'default',
                    modelMode: 'default',
                    sessionType: 'simple',
	                    automationDraft: {
	                        enabled: true,
	                        name: 'Nightly',
	                        description: 'sync',
	                        scheduleKind: 'interval',
	                        everyMinutes: 30,
	                        cronExpr: '0 * * * *',
	                        timezone: 'UTC',
	                    },
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect(draft?.automationDraft?.enabled).toBe(true);
            expect(draft?.automationDraft?.name).toBe('Nightly');
            expect(draft?.automationDraft?.everyMinutes).toBe(30);
        });
    });

    describe('session review comment drafts', () => {
        it('returns an empty object when nothing is persisted', () => {
            expect(loadSessionReviewCommentsDrafts()).toEqual({});
        });

        it('roundtrips persisted drafts', () => {
            saveSessionReviewCommentsDrafts({
                s1: [
                    {
                        id: 'c1',
                        filePath: 'src/a.ts',
                        source: 'file',
                        anchor: { kind: 'fileLine', startLine: 1 },
                        snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                        body: 'nit',
                        createdAt: 1,
                    },
                ],
            });
            expect(loadSessionReviewCommentsDrafts().s1).toHaveLength(1);
        });

        it('salvages valid drafts when persisted data contains invalid entries', () => {
            store.set('session-review-comments-draft-v1', JSON.stringify({
                s1: [
                    {
                        id: 'c1',
                        filePath: 'src/a.ts',
                        source: 'file',
                        anchor: { kind: 'fileLine', startLine: 1 },
                        snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                        body: 'nit',
                        createdAt: 1,
                    },
                    null,
                    { nope: true },
                ],
                bad: 'nope',
            }));
            const loaded = loadSessionReviewCommentsDrafts();
            expect(Object.keys(loaded)).toEqual(['s1']);
            expect(loaded.s1).toHaveLength(1);
            expect(loaded.s1[0].id).toBe('c1');
        });
    });
});
