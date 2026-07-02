import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsDefaults, settingsParse } from '../settings/settings';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { ServerAccountScope } from '../scope/serverAccountScope';

const store = vi.hoisted(() => new Map<string, string>());

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

        getAllKeys() {
            return [...store.keys()];
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
        getPreferredLanguage: () => 'en',
    });
});

import '../settings/settings';

import {
    clearPersistence,
    loadNewSessionDraft,
    saveNewSessionDraft,
    clearNewSessionDraft,
    prepareSessionLocalStateScopeForActivation,
    loadPendingSettings,
    savePendingSettings,
    loadSettings,
    loadSessionModelModes,
    saveSessionModelModes,
    loadSessionMaterializedMaxSeqById,
    saveSessionMaterializedMaxSeqById,
    loadChangesCursor,
    saveChangesCursor,
    loadExternalSessionTailCursor,
    saveExternalSessionTailCursor,
    pruneStaleInstanceChangesCursors,
    loadLastChangesCursorByAccountId,
    saveLastChangesCursorByAccountId,
    loadSessionReviewCommentsDrafts,
    saveSessionReviewCommentsDrafts,
    loadWorkspaceReviewCommentsDrafts,
    saveWorkspaceReviewCommentsDrafts,
    loadSessionActionDrafts,
    saveSessionActionDrafts,
    loadSessionPermissionModes,
    saveSessionPermissionModes,
    loadLocalPetSourcesBySourceKey,
    saveLocalPetSourcesBySourceKey,
    loadThemeRuntimeLocalState,
    type ChangesCursorScope,
} from './persistence';

type CursorScopeObject = Exclude<ChangesCursorScope, string>;

function cursorScope(overrides: Partial<CursorScopeObject> = {}): CursorScopeObject {
    return {
        accountId: 'a1',
        ...overrides,
    };
}

const sessionLocalScopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
const sessionLocalScopeB: ServerAccountScope = { serverId: 'server-a', accountId: 'account-b' };

describe('persistence', () => {
    beforeEach(() => {
        clearPersistence();
    });

    it('clears all persisted settings scopes and legacy settings state', () => {
        store.set('settings', JSON.stringify({ settings: settingsDefaults, version: 1 }));
        store.set('pending-settings', JSON.stringify({ analyticsOptOut: true }));
        store.set('account-settings:v2:8:server-a9:account-a', JSON.stringify({ settings: settingsDefaults, version: 2 }));
        store.set('pending-account-settings:v2:8:server-a9:account-a', JSON.stringify({ viewInline: true }));
        store.set('profile', JSON.stringify({ id: 'account-a' }));

        clearPersistence();

        expect([...store.keys()]).toEqual([]);
    });

    describe('session model modes', () => {
        it('loads default settings without touching the settings store bootstrap path', () => {
            expect(loadSettings()).toBeTruthy();
        });

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

    describe('session permission modes', () => {
        it('returns an empty object when nothing is persisted', () => {
            expect(loadSessionPermissionModes()).toEqual({});
        });

        it('roundtrips valid persisted permission modes', () => {
            saveSessionPermissionModes({ abc: 'yolo', def: 'default' });
            expect(loadSessionPermissionModes()).toEqual({ abc: 'yolo', def: 'default' });
        });

        it('filters out invalid persisted permission modes', () => {
            store.set(
                'session-permission-modes',
                JSON.stringify({ ok: 'yolo', bad: 'not-a-mode', num: 12 }),
            );
            expect(loadSessionPermissionModes()).toEqual({ ok: 'yolo' });
        });

        it('returns an empty object when persisted permission modes are not an object', () => {
            store.set('session-permission-modes', JSON.stringify(['yolo']));
            expect(loadSessionPermissionModes()).toEqual({});
        });
    });

    describe('local pet sources', () => {
        it('returns an empty object when nothing is persisted', () => {
            expect(loadLocalPetSourcesBySourceKey()).toEqual({});
        });

        it('roundtrips validated local pet source metadata', () => {
            saveLocalPetSourcesBySourceKey({
                'managed:blink': {
                    sourceKey: 'managed:blink',
                    source: {
                        kind: 'happierManagedLocal',
                        packagePath: '/Users/tester/.happy-dev/pets/imports/blink',
                        sourceKey: 'managed:blink',
                    },
                    displayName: 'Blink local',
                    manifest: {
                        id: 'blink-local',
                        displayName: 'Blink local',
                        description: 'Imported from Codex.',
                        spritesheetPath: 'spritesheet.webp',
                    },
                    mediaType: 'image/webp',
                    digest: 'sha256:local',
                    sizeBytes: 256,
                    daemonTarget: {
                        serverId: 'server-pets',
                        machineId: 'machine-pets',
                    },
                },
            });

            expect(loadLocalPetSourcesBySourceKey()).toEqual({
                'managed:blink': expect.objectContaining({
                    sourceKey: 'managed:blink',
                    displayName: 'Blink local',
                    mediaType: 'image/webp',
                    daemonTarget: {
                        serverId: 'server-pets',
                        machineId: 'machine-pets',
                    },
                }),
            });
        });

        it('salvages valid pet sources and drops preview bytes from persisted entries', () => {
            store.set('local-pet-sources-v1', JSON.stringify({
                valid: {
                    sourceKey: 'valid',
                    source: {
                        kind: 'happierManagedLocal',
                        packagePath: '/Users/tester/.happy-dev/pets/imports/blink',
                        sourceKey: 'valid',
                    },
                    displayName: 'Blink local',
                    manifest: {
                        id: 'blink-local',
                        displayName: 'Blink local',
                        description: 'Imported from Codex.',
                        spritesheetPath: 'spritesheet.webp',
                    },
                    mediaType: 'image/webp',
                    digest: 'sha256:local',
                    sizeBytes: 256,
                    daemonTarget: {
                        serverId: 'server-pets',
                        machineId: 'machine-pets',
                    },
                    dataBase64: 'not-allowed',
                    bytes: [1, 2, 3],
                },
                invalid: {
                    sourceKey: '',
                    displayName: 'Broken',
                },
            }));

            const loaded = loadLocalPetSourcesBySourceKey();

            expect(Object.keys(loaded)).toEqual(['valid']);
            expect(JSON.stringify(loaded)).not.toContain('dataBase64');
            expect(JSON.stringify(loaded)).not.toContain('bytes');
        });
    });

    describe('theme runtime local state', () => {
        it('returns default theme runtime state when local settings JSON is malformed', () => {
            store.set('local-settings', '{not json');
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

            expect(loadThemeRuntimeLocalState()).toEqual({
                themePreference: 'adaptive',
                themeProfiles: {
                    profiles: [],
                    activeProfileId: null,
                },
            });
            consoleError.mockRestore();
        });

        it('drops malformed profile state while preserving theme preference at startup', () => {
            store.set('local-settings', JSON.stringify({
                themePreference: 'dark',
                themeProfiles: 'bad',
            }));

            expect(loadThemeRuntimeLocalState()).toEqual({
                themePreference: 'dark',
                themeProfiles: {
                    profiles: [],
                    activeProfileId: null,
                },
            });
        });

        it('heals deprecated theme profile token ids in persisted local settings at startup', () => {
            store.set('local-settings', JSON.stringify({
                themePreference: 'light',
                themeProfiles: {
                    activeProfileId: 'ocean',
                    profiles: [{
                        schemaVersion: 1,
                        id: 'ocean',
                        name: 'Ocean',
                        createdAt: '2026-05-11T00:00:00.000Z',
                        updatedAt: '2026-05-11T00:00:00.000Z',
                        base: { light: 'light', dark: 'dark' },
                        overrides: {
                            light: { 'groupped.background': '#fafafa' },
                            dark: { surfaceHigh: '#111111' },
                        },
                    }],
                },
            }));

            const state = loadThemeRuntimeLocalState();
            const healed = JSON.parse(store.get('local-settings') ?? '{}') as {
                themeProfiles?: { profiles?: Array<{ overrides?: unknown }> };
            };

            expect(state.themeProfiles.profiles[0]?.overrides).toEqual({
                light: { 'background.canvas': '#fafafa' },
                dark: { 'surface.inset': '#111111' },
            });
            expect(healed.themeProfiles?.profiles?.[0]?.overrides).toEqual(state.themeProfiles.profiles[0]?.overrides);
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
        it('returns null when no account id is provided', () => {
            expect(loadChangesCursor()).toBeNull();
        });

        it('roundtrips cursor per account id', () => {
            const scope = cursorScope();
            expect(loadChangesCursor(scope)).toBeNull();

            saveChangesCursor('123', scope);
            expect(loadChangesCursor(scope)).toBe('123');
        });

        it('salvages cursor from the legacy numeric map', () => {
            store.set('last-changes-cursor-by-account-id-v1', JSON.stringify({ a1: 7 }));
            expect(loadChangesCursor(cursorScope())).toBe('7');
        });

        it('clears the key when saving an empty cursor', () => {
            const scope = cursorScope();
            saveChangesCursor('9', scope);
            expect(loadChangesCursor(scope)).toBe('9');

            saveChangesCursor('', scope);
            expect(loadChangesCursor(scope)).toBeNull();
        });

        it('isolates cursor values by server scope when provided', () => {
            const serverA = cursorScope({ serverScope: 'server-a' });
            const serverB = cursorScope({ serverScope: 'server-b' });

            saveChangesCursor('11', serverA);
            expect(loadChangesCursor(serverA)).toBe('11');
            expect(loadChangesCursor(serverB)).toBeNull();

            saveChangesCursor('21', serverB);
            expect(loadChangesCursor(serverA)).toBe('11');
            expect(loadChangesCursor(serverB)).toBe('21');
        });

        it('does not read unscoped cursor when explicit server scope is requested', () => {
            const accountOnly = cursorScope();
            const serverA = cursorScope({ serverScope: 'server-a' });

            saveChangesCursor('77', accountOnly);
            expect(loadChangesCursor(serverA)).toBeNull();
            expect(loadChangesCursor(accountOnly)).toBe('77');
        });

        it('isolates cursor values by server scope and sync instance id', () => {
            const tabA = cursorScope({ serverScope: 'server-a', instanceId: 'tab-a' });
            const tabB = cursorScope({ serverScope: 'server-a', instanceId: 'tab-b' });
            const serverBTabA = cursorScope({ serverScope: 'server-b', instanceId: 'tab-a' });

            saveChangesCursor('11', { ...tabA, nowMs: 100 });
            saveChangesCursor('21', { ...tabB, nowMs: 200 });

            expect(loadChangesCursor(tabA)).toBe('11');
            expect(loadChangesCursor(tabB)).toBe('21');
            expect(loadChangesCursor(serverBTabA)).toBeNull();
        });

        it('uses the explicit account id instead of a stale persisted profile id', () => {
            store.set('profile', JSON.stringify({ id: 'account-a', timestamp: 0, firstName: null, lastName: null, avatar: null }));
            const accountBScope = {
                serverScope: 'server-a',
                accountId: 'account-b',
                instanceId: 'tab-a',
                nowMs: 100,
            };
            const accountAScope = {
                serverScope: 'server-a',
                accountId: 'account-a',
                instanceId: 'tab-a',
            };

            saveChangesCursor('account-b-cursor', accountBScope);

            expect(loadChangesCursor(accountBScope)).toBe('account-b-cursor');
            expect(loadChangesCursor(accountAScope)).toBeNull();
        });

        it('uses the explicit account id even when no profile is persisted', () => {
            const scope = {
                serverScope: 'server-a',
                accountId: 'account-b',
                instanceId: 'tab-a',
                nowMs: 100,
            };

            saveChangesCursor('account-b-cursor', scope);

            expect(loadChangesCursor(scope)).toBe('account-b-cursor');
        });

        it('uses the authenticated cursor account id for direct-session tail cursors', () => {
            store.set('profile', JSON.stringify({ id: 'account-a', timestamp: 0, firstName: null, lastName: null, avatar: null }));
            const accountBScope = {
                serverScope: 'server-a',
                accountId: 'account-b',
                instanceId: 'tab-a',
            };
            const accountAScope = {
                serverScope: 'server-a',
                accountId: 'account-a',
                instanceId: 'tab-a',
            };

            saveExternalSessionTailCursor('session-1', 'tail-b', accountBScope);

            expect(loadExternalSessionTailCursor('session-1', accountBScope)).toBe('tail-b');
            expect(loadExternalSessionTailCursor('session-1', accountAScope)).toBeNull();
        });

        it('uses legacy server-scoped cursor only as an instance bootstrap fallback', () => {
            const serverA = cursorScope({ serverScope: 'server-a' });
            const tabA = cursorScope({ serverScope: 'server-a', instanceId: 'tab-a' });

            saveChangesCursor('7', serverA);
            expect(loadChangesCursor(tabA)).toBe('7');

            saveChangesCursor('12', { ...tabA, nowMs: 100 });

            expect(loadChangesCursor(tabA)).toBe('12');
            expect(loadChangesCursor(serverA)).toBe('7');
        });

        it('prunes stale instance-scoped cursors by last write time only', () => {
            const serverA = cursorScope({ serverScope: 'server-a' });
            const oldTab = cursorScope({ serverScope: 'server-a', instanceId: 'tab-old' });
            const freshTab = cursorScope({ serverScope: 'server-a', instanceId: 'tab-fresh' });
            saveChangesCursor('old-tab', { ...oldTab, nowMs: 1_000 });
            saveChangesCursor('fresh-tab', { ...freshTab, nowMs: 10_000 });
            saveChangesCursor('legacy', serverA);

            const pruned = pruneStaleInstanceChangesCursors({
                nowMs: 10_000,
                retentionMs: 5_000,
            });

            expect(pruned).toBe(1);
            expect(loadChangesCursor(oldTab)).toBe('legacy');
            expect(loadChangesCursor(freshTab)).toBe('fresh-tab');
            expect(loadChangesCursor(serverA)).toBe('legacy');
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

        it('does not synthesize local-neural execution defaults inside pending voice deltas', () => {
            store.set('pending-settings', JSON.stringify({
                voice: {
                    adapters: {
                        local_direct: {
                            tts: {
                                provider: 'local_neural',
                                localNeural: {
                                    model: 'kokoro',
                                    assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                                },
                            },
                            stt: {
                                provider: 'local_neural',
                                localNeural: {
                                    assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                                },
                            },
                        },
                    },
                },
            }));

            const pending = loadPendingSettings() as any;
            expect(pending.voice?.adapters?.local_direct?.tts?.localNeural?.execution).toBeUndefined();
            expect(pending.voice?.adapters?.local_direct?.stt?.localNeural?.execution).toBeUndefined();
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

    describe('markdown rich editor settings (UI registry)', () => {
        it('exposes the three markdown rich editor settings at their registered defaults', () => {
            // settingsParse() is the effective-load path: it applies registry
            // defaults for keys absent from the stored blob (loadSettings() returns
            // the raw stored blob, not defaults-applied).
            const settings = settingsParse({}) as any;
            expect(settings.markdownDefaultEditMode).toBe('rich');
            expect(settings.filesMarkdownRichEditorMaxBytes).toBe(256_000);
            expect(settings.filesMarkdownRichEditorHtmlRoundTripMaxBytes).toBe(50_000);
        });

        it('exposes the same defaults via settingsDefaults', () => {
            expect((settingsDefaults as any).markdownDefaultEditMode).toBe('rich');
            expect((settingsDefaults as any).filesMarkdownRichEditorMaxBytes).toBe(256_000);
            expect((settingsDefaults as any).filesMarkdownRichEditorHtmlRoundTripMaxBytes).toBe(50_000);
        });

        it('keeps an empty pending delta empty without synthesizing the new settings (no .default() on the schema)', () => {
            store.set('pending-settings', JSON.stringify({}));
            const pending = loadPendingSettings() as any;
            expect(pending).toEqual({});
            expect(pending.markdownDefaultEditMode).toBeUndefined();
            expect(pending.filesMarkdownRichEditorMaxBytes).toBeUndefined();
            expect(pending.filesMarkdownRichEditorHtmlRoundTripMaxBytes).toBeUndefined();
        });

        it('parses a single markdown setting in pending without injecting the other two as defaults', () => {
            store.set('pending-settings', JSON.stringify({ markdownDefaultEditMode: 'raw' }));
            const pending = loadPendingSettings() as any;
            expect(pending).toEqual({ markdownDefaultEditMode: 'raw' });
            expect(Object.keys(pending)).toEqual(['markdownDefaultEditMode']);
        });

        it('drops an invalid markdown edit mode from pending', () => {
            store.set('pending-settings', JSON.stringify({ markdownDefaultEditMode: 'fancy' }));
            expect(loadPendingSettings()).toEqual({});
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

    describe('workspace review comment drafts', () => {
        it('roundtrips persisted drafts and drops invalid entries', () => {
            saveWorkspaceReviewCommentsDrafts({
                'srv1:m1:/repo': [{
                    id: 'c1',
                    filePath: 'src/a.ts',
                    source: 'file',
                    anchor: { kind: 'fileLine', startLine: 1 },
                    snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                    body: 'nit',
                    createdAt: 1,
                }],
            });

            store.set('workspace-review-comments-draft-v1', JSON.stringify({
                'srv1:m1:/repo': [
                    {
                        id: 'c1',
                        filePath: 'src/a.ts',
                        source: 'file',
                        anchor: { kind: 'fileLine', startLine: 1 },
                        snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                        body: 'nit',
                        createdAt: 1,
                    },
                    { id: '', filePath: 'src/a.ts' },
                ],
                '   ': [{ id: 'x', filePath: 'src/a.ts', source: 'file', anchor: { kind: 'fileLine', startLine: 1 }, snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] }, body: 'nit', createdAt: 1 }],
            }));

            expect(loadWorkspaceReviewCommentsDrafts()).toEqual({
                'srv1:m1:/repo': [{
                    id: 'c1',
                    filePath: 'src/a.ts',
                    source: 'file',
                    anchor: { kind: 'fileLine', startLine: 1 },
                    snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                    body: 'nit',
                    createdAt: 1,
                }],
            });
        });

        it('deletes the persisted key when saving an empty map', () => {
            saveWorkspaceReviewCommentsDrafts({
                'srv1:m1:/repo': [{
                    id: 'c1',
                    filePath: 'src/a.ts',
                    source: 'file',
                    anchor: { kind: 'fileLine', startLine: 1 },
                    snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                    body: 'nit',
                    createdAt: 1,
                }],
            });
            expect(store.get('workspace-review-comments-draft-v1')).toBeTruthy();

            saveWorkspaceReviewCommentsDrafts({});
            expect(store.get('workspace-review-comments-draft-v1')).toBeUndefined();
            expect(loadWorkspaceReviewCommentsDrafts()).toEqual({});
        });
    });

    describe('new session draft', () => {
        it('roundtrips acpSessionModeId when persisted', () => {
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
                    acpSessionModeId: 'plan',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect((draft as any)?.acpSessionModeId).toBe('plan');
        });

        it('roundtrips sessionConfigOptionOverrides when persisted', () => {
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
                    sessionConfigOptionOverrides: {
                        v: 1,
                        updatedAt: 123,
                        overrides: {
                            speed: {
                                updatedAt: 123,
                                value: 'fast',
                            },
                        },
                    },
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect((draft as any)?.sessionConfigOptionOverrides).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: {
                        updatedAt: 123,
                        value: 'fast',
                    },
                },
            });
        });

        it('roundtrips transcriptStorage when persisted', () => {
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
                    transcriptStorage: 'direct',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect((draft as any)?.transcriptStorage).toBe('direct');
        });

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

        it('roundtrips backendTarget when persisted', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'customAcp',
                    backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
                    permissionMode: 'default',
                    modelMode: 'default',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect((draft as any)?.backendTarget).toMatchObject({
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
            });
        });

        it('roundtrips a selected target server id when persisted', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    targetServerId: '  server-b  ',
                    agentType: 'claude',
                    permissionMode: 'default',
                    modelMode: 'default',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            expect(loadNewSessionDraft()?.targetServerId).toBe('server-b');
        });

        it('drops blank selected target server ids when hydrating drafts', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    targetServerId: '   ',
                    agentType: 'claude',
                    permissionMode: 'default',
                    modelMode: 'default',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            expect(loadNewSessionDraft()).not.toEqual(expect.objectContaining({
                targetServerId: expect.anything(),
            }));
        });

        it('roundtrips the machine-scoped Windows remote launch override when persisted', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: 'machine-1',
                    selectedPath: null,
                    selectedProfileId: null,
                    windowsRemoteSessionLaunchModeOverride: {
                        machineId: '  machine-1  ',
                        mode: 'console',
                    },
                    agentType: 'claude',
                    permissionMode: 'default',
                    modelMode: 'default',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            expect(loadNewSessionDraft()?.windowsRemoteSessionLaunchModeOverride).toEqual({
                machineId: 'machine-1',
                mode: 'console',
            });
        });

        it('drops invalid Windows remote launch overrides when hydrating drafts', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: 'machine-1',
                    selectedPath: null,
                    selectedProfileId: null,
                    windowsRemoteSessionLaunchModeOverride: {
                        machineId: 'machine-1',
                        mode: 'invalid',
                    },
                    agentType: 'claude',
                    permissionMode: 'default',
                    modelMode: 'default',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            expect(loadNewSessionDraft()).not.toEqual(expect.objectContaining({
                windowsRemoteSessionLaunchModeOverride: expect.anything(),
            }));
        });

        it('roundtrips codexBackendMode when persisted', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'codex',
                    permissionMode: 'default',
                    modelMode: 'default',
                    codexBackendMode: 'appServer',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect((draft as any)?.codexBackendMode).toBe('appServer');
        });

        it('normalizes legacy codexBackendMode aliases and whitespace when hydrating drafts', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'codex',
                    permissionMode: 'default',
                    modelMode: 'default',
                    codexBackendMode: '  mcp_resume  ',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect((draft as any)?.codexBackendMode).toBe('acp');
        });

        it('ignores the legacy sessionType field when hydrating a canonical draft', () => {
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
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect(draft?.agentType).toBe('claude');
            expect((draft as any)?.sessionType).toBeUndefined();
        });

        it('migrates legacy auggieAllowIndexing into backend-target keyed new-session option state', () => {
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
            const auggieTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'auggie' });
            expect((draft as any)?.backendNewSessionOptionStateByTargetKey?.[auggieTargetKey]?.allowIndexing).toBe(true);
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

        it('isolates new session launch drafts by server account scope', () => {
            const draft = {
                input: 'launch for account A',
                selectedMachineId: 'machine-a',
                selectedPath: '/repo-a',
                selectedProfileId: 'profile-a',
                selectedSecretId: 'secret-a',
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueEncByProfileIdByEnvVarName: {},
                agentType: 'claude',
                permissionMode: 'default',
                modelMode: 'default',
                acpSessionModeId: null,
                resumeSessionId: 'resume-a',
                updatedAt: Date.now(),
            } satisfies NonNullable<ReturnType<typeof loadNewSessionDraft>>;

            saveNewSessionDraft(draft, sessionLocalScopeA);

            expect(loadNewSessionDraft(sessionLocalScopeA)).toEqual(expect.objectContaining({
                input: 'launch for account A',
                selectedMachineId: 'machine-a',
                selectedProfileId: 'profile-a',
                selectedSecretId: 'secret-a',
                resumeSessionId: 'resume-a',
            }));
            expect(loadNewSessionDraft(sessionLocalScopeB)).toBeNull();
            expect(loadNewSessionDraft()).toBeNull();

            clearNewSessionDraft(sessionLocalScopeA);
            expect(loadNewSessionDraft(sessionLocalScopeA)).toBeNull();
        });

        it('drops legacy new session launch drafts during scope activation', () => {
            const legacyDraft = {
                input: 'legacy launch must not cross accounts',
                selectedMachineId: 'legacy-machine',
                selectedPath: '/legacy-repo',
                selectedProfileId: 'legacy-profile',
                selectedSecretId: 'legacy-secret',
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueEncByProfileIdByEnvVarName: {},
                agentType: 'claude',
                permissionMode: 'default',
                modelMode: 'default',
                acpSessionModeId: null,
                updatedAt: Date.now(),
            } satisfies NonNullable<ReturnType<typeof loadNewSessionDraft>>;

            saveNewSessionDraft(legacyDraft);

            prepareSessionLocalStateScopeForActivation(sessionLocalScopeB);

            expect(loadNewSessionDraft()).toBeNull();
            expect(loadNewSessionDraft(sessionLocalScopeB)).toBeNull();
        });

        it('migrates legacy workspace review comment drafts during scope activation', () => {
            saveWorkspaceReviewCommentsDrafts({
                'server-a:machine-1:/repo-a': [{
                    id: 'c1',
                    filePath: 'src/a.ts',
                    source: 'file',
                    anchor: { kind: 'fileLine', startLine: 1 },
                    snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                    body: 'nit',
                    createdAt: 1,
                }],
            });

            prepareSessionLocalStateScopeForActivation(sessionLocalScopeB);

            expect(loadWorkspaceReviewCommentsDrafts()).toEqual({});
            expect(loadWorkspaceReviewCommentsDrafts(sessionLocalScopeB)).toEqual({
                'server-a:machine-1:/repo-a': [{
                    id: 'c1',
                    filePath: 'src/a.ts',
                    source: 'file',
                    anchor: { kind: 'fileLine', startLine: 1 },
                    snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                    body: 'nit',
                    createdAt: 1,
                }],
            });
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
