import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const getString = vi.fn((key: string) => store.get(key));
const set = vi.fn((key: string, value: string) => {
    store.set(key, value);
});
const deleteKey = vi.fn((key: string) => {
    store.delete(key);
});

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return getString(key);
        }

        set(key: string, value: string) {
            set(key, value);
        }

        delete(key: string) {
            deleteKey(key);
        }

        getAllKeys() {
            return [...store.keys()];
        }

        trim() {}
    }

    return { MMKV };
});

import {
    clearWarmCacheAccountScope,
    loadMachineDisplayWarmCacheEntries,
    loadSessionListWarmCacheEntries,
    loadUsageSummaryWarmCache,
    resolveWarmCacheAccountScope,
    saveMachineDisplayWarmCacheEntries,
    scheduleMachineDisplayWarmCacheEntriesSave,
    saveSessionListWarmCacheEntries,
    saveUsageSummaryWarmCache,
    setWarmCacheAccountScope,
    loadFoundWarmCacheEntry,
    saveFoundWarmCacheEntry,
} from './warmCachePersistence';
import { SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { DaemonMcpServersDetectResponseSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { prepareWarmCacheEncryptionKey } from './warmCacheEncryptionKey';
import * as warmCache from './warmCachePersistence';
import { suspendServerProfilePersistenceForDemo, resumeServerProfilePersistenceForDemo } from '@/sync/domains/server/serverProfiles';
import { projectSessionDisplayV1,
    sealSessionOwnerDisplayEnvelopeV1, openSessionOwnerDisplayEnvelopeV1 } from '@happier-dev/protocol/sessions';
import { SessionOwnerMetadataV1Schema} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionUsageLimitRecoveryV1Schema} from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { SESSION_LIST_DOCUMENT_ADMISSION, admitOpenedSessionListDisplayProjection,
    hasCurrentSessionListDisplayMetadata } from '@/sync/domains/session/sessionDocumentAdmission';
import { SESSION_OWNER_METADATA_PROJECTION } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { buildSessionListCacheEntryFromRenderable, readSessionListWarmCacheDisplay } from './warmCacheAdapters';

describe('warmCachePersistence', () => {
    beforeEach(async () => {
        // Nothing reads or writes the cache until its at-rest key resolves, exactly as on a device.
        await prepareWarmCacheEncryptionKey();
        store.clear();
        getString.mockClear();
        set.mockClear();
        deleteKey.mockClear();
        clearWarmCacheAccountScope();
    });

    it.each(['recovery', 'retained fork'] as const)('reloads proved sidecar %s display without full-document authority', (leaf) => {
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { name: 'Sidecar title', path: '/repo' },
            ...(leaf === 'recovery' ? { runtime: { sessionUsageLimitRecoveryV1: {
                v: 1, status: 'waiting', issueFingerprint: 'issue', armedAtMs: 2, resetAtMs: 20, nextCheckAtMs: 20,
                attemptCount: 1, maxAttempts: 3, lastProbeError: null,
                selectedAuth: { kind: 'profile', serviceId: 'anthropic', profileId: 'private-profile' },
            } } } : { history: { forkV1: { v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 1,
                createdAtMs: 2, strategy: 'retained-provider-strategy', requestId: 'private-request' } } }),
        });
        const semantic = projectSessionDisplayV1({ sharedMetadata: { v: 1 }, ownerMetadata });
        const sealed = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'plain', display: semantic.owner! });
        if (!sealed.ok) throw new Error(sealed.reason);
        const opened = openSessionOwnerDisplayEnvelopeV1({ accountMode: 'plain', envelope: sealed.envelope });
        if (!opened.ok) throw new Error(opened.reason);
        const descriptor = { scope: 'same-home-account', encryptionMode: 'plain' as const,
            metadataLayoutVersion: 1, dataEncryptionKey: null, metadataAudience: 'owner' as const };
        const row = buildSessionListRenderableFromSession({ ...createSessionFixture({ id: 'sidecar', metadata: null,
            metadataLayoutVersion: 1, metadataVersion: 3, agentState: null,
            encryptionMode: 'plain', encryptedContentAvailability: 'ready' }),
            metadataUndecided: true,
            [SESSION_LIST_DOCUMENT_ADMISSION]: admitOpenedSessionListDisplayProjection(descriptor, 3),
        }, undefined, undefined, undefined, { shared: semantic.shared, owner: opened.display });
        saveSessionListWarmCacheEntries('sidecar-home', leaf, { sidecar: buildSessionListCacheEntryFromRenderable(row) });
        const key = `session-list-warm-cache-v1:sidecar-home:${leaf}`;
        const persisted = store.get(key)!;
        expect(persisted).not.toContain('private-profile');
        expect(persisted).not.toContain('private-request');
        // Different bytes force the genuine cold parser rather than the unchanged-byte memory shortcut.
        store.set(key, JSON.stringify(JSON.parse(persisted), null, 2));
        const loaded = loadSessionListWarmCacheEntries('sidecar-home', leaf).sidecar;
        expect(loaded).toBeDefined();
        const restored = readSessionListWarmCacheDisplay(loaded, descriptor, { id: 'sidecar', metadataVersion: 3 });
        expect(restored?.metadata?.name).toBe('Sidecar title');
        expect(restored?.metadata?.sessionUsageLimitRecoveryV1).toEqual(opened.display.sessionUsageLimitRecoveryV1);
        expect(restored?.forkV1).toEqual(opened.display.forkV1);
        expect(restored && hasCurrentSessionListDisplayMetadata(restored)).toBe(true);
        expect(restored?.[SESSION_LIST_DOCUMENT_ADMISSION]?.openedAgentStateVersion).toBeUndefined();
        expect(restored?.[SESSION_OWNER_METADATA_PROJECTION]).toBeUndefined();
        expect(restored).not.toHaveProperty('agentState');
        expect(restored?.agentTargetKey).toBeUndefined();
        expect(SessionUsageLimitRecoveryV1Schema.safeParse(restored?.metadata?.sessionUsageLimitRecoveryV1).success).toBe(false);
        expect(readSessionListWarmCacheDisplay(loaded, { ...descriptor, scope: 'different-account' },
            { id: 'sidecar', metadataVersion: 3 })).toBeUndefined();
        const stale = readSessionListWarmCacheDisplay(loaded, descriptor, { id: 'sidecar', metadataVersion: 4 });
        expect(stale?.metadataVersion).toBe(3);
        expect(stale && hasCurrentSessionListDisplayMetadata({ ...stale, metadataVersion: 4 })).toBe(false);
    });

    it('projects legacy full recovery to display without persisting selected-auth identity', () => {
        const recovery = SessionUsageLimitRecoveryV1Schema.parse({ v: 1, status: 'waiting', issueFingerprint: 'legacy-issue',
            armedAtMs: 2, resetAtMs: 20, nextCheckAtMs: 20, attemptCount: 1, maxAttempts: 3, lastProbeError: null,
            selectedAuth: { kind: 'profile', serviceId: 'anthropic', profileId: 'private-profile' } });
        const row = buildSessionListRenderableFromSession(createSessionFixture({ id: 'legacy-recovery',
            metadata: { path: '/repo', host: 'home', sessionUsageLimitRecoveryV1: recovery } }));
        const entry = buildSessionListCacheEntryFromRenderable(row);
        saveSessionListWarmCacheEntries('legacy-home', 'legacy-account', { 'legacy-recovery': entry });
        const key = 'session-list-warm-cache-v1:legacy-home:legacy-account';
        expect(store.get(key)).not.toContain('private-profile');
        const compact = JSON.parse(store.get(key)!)['legacy-recovery'].sessionUsageLimitRecoveryV1;
        expect(compact).toHaveProperty('authSelectionKind', 'profile');
        expect(compact).not.toHaveProperty('selectedAuth');
        expect(SessionUsageLimitRecoveryV1Schema.safeParse(compact).success).toBe(false);
    });

    it.each(['QuotaExceededError', 'SecurityError'])('keeps the latest warm value in memory when a write raises %s', (name) => {
        const accountId = `failed-write-${name}`;
        const entries = { m1: { machineId: 'm1', metadataVersion: 1,
            updatedAt: 1, active: true, activeAt: 1, revokedAt: null } };
        saveMachineDisplayWarmCacheEntries('server-a', accountId, entries);
        const latest = { m1: { ...entries.m1, updatedAt: 2 } };
        set.mockImplementationOnce(() => { throw Object.assign(new Error('storage failed'), { name }); });
        expect(() => saveMachineDisplayWarmCacheEntries('server-a', accountId, latest)).not.toThrow();
        expect(loadMachineDisplayWarmCacheEntries('server-a', accountId)).toEqual(latest);
        expect(warmCache.peekMachineDisplayWarmCacheEntries('server-a', accountId)).toBe(latest);
        // Security denial does not establish storage pressure and must not evict a recoverable record.
        expect(store.has(`machine-display-warm-cache-v1:server-a:${accountId}`)).toBe(name === 'SecurityError');
        // A later update can persist normally; the failed write never restores the older disk value.
        const recovered = { m1: { ...latest.m1, updatedAt: 3 } };
        saveMachineDisplayWarmCacheEntries('server-a', accountId, recovered);
        expect(JSON.parse(store.get(`machine-display-warm-cache-v1:server-a:${accountId}`)!)).toEqual(recovered);
    });

    it('keeps a failed removal empty and treats unavailable storage reads as warm misses', () => {
        const accountId = 'failed-removal';
        saveMachineDisplayWarmCacheEntries('server-a', accountId, { m1: { machineId: 'm1', metadataVersion: 1,
            updatedAt: 1, active: true, activeAt: 1, revokedAt: null } });
        deleteKey.mockImplementationOnce(() => { throw new Error('storage failed'); });
        expect(() => saveMachineDisplayWarmCacheEntries('server-a', accountId, {})).not.toThrow();
        expect(loadMachineDisplayWarmCacheEntries('server-a', accountId)).toEqual({});
        getString.mockImplementationOnce(() => { throw new Error('storage failed'); });
        expect(loadMachineDisplayWarmCacheEntries('server-a', 'unreadable')).toEqual({});
    });

    it('keeps the latest projection if storage also refuses quota recovery removal', () => {
        const accountId = 'quota-removal-failed';
        const previous = { m1: { machineId: 'm1', metadataVersion: 1, updatedAt: 1,
            active: true, activeAt: 1, revokedAt: null } };
        saveMachineDisplayWarmCacheEntries('server-a', accountId, previous);
        const latest = { m1: { ...previous.m1, updatedAt: 2 } };
        set.mockImplementationOnce(() => { throw Object.assign(new Error('storage full'), { name: 'QuotaExceededError' }); });
        deleteKey.mockImplementationOnce(() => { throw Object.assign(new Error('storage unavailable'), { name: 'SecurityError' }); });
        expect(() => saveMachineDisplayWarmCacheEntries('server-a', accountId, latest)).not.toThrow();
        expect(loadMachineDisplayWarmCacheEntries('server-a', accountId)).toEqual(latest);
        expect(JSON.parse(store.get(`machine-display-warm-cache-v1:server-a:${accountId}`)!)).toEqual(previous);
    });

    it('releases a quota-rejected warm record so settings and transcript progress can still persist', async () => {
        // Browser warm caches and durable local state share MMKV's default localStorage namespace.
        vi.stubGlobal('window', globalThis);
        vi.stubGlobal('document', {});
        const persistence = await import('./persistence');
        const local = persistence.loadLocalSettings();
        persistence.saveLocalSettings(local);
        const draftKey = 'new-session-draft-v1';
        const draft = JSON.stringify({ input: 'Keep this unsent draft' });
        store.set(draftKey, draft);
        const previous = { m1: { machineId: 'm1', metadataVersion: 1, updatedAt: 1,
            active: true, activeAt: 1, revokedAt: null, host: 'x'.repeat(4096) } };
        const latest = { m1: { ...previous.m1, updatedAt: 2, host: previous.m1.host.repeat(2) } };
        const key = 'machine-display-warm-cache-v1:quota-home:quota-account';
        saveMachineDisplayWarmCacheEntries('quota-home', 'quota-account', previous);
        const storedSettings = store.get('local-settings');
        // The fixture quota is exactly the occupied storage: even a cursor cannot be added until
        // the rejected cache releases its old disk copy. No production size/count cutoff is used.
        const quota = [...store].reduce((total, [key, value]) => total + key.length + value.length, 0);
        set.mockImplementation((key, value) => {
            const candidate = new Map(store).set(key, value);
            const size = [...candidate].reduce((total, [key, value]) => total + key.length + value.length, 0);
            if (size > quota) throw Object.assign(new Error('storage full'), { name: 'QuotaExceededError' });
            store.set(key, value);
        });
        try {
            saveMachineDisplayWarmCacheEntries('quota-home', 'quota-account', latest);
            expect(loadMachineDisplayWarmCacheEntries('quota-home', 'quota-account')).toEqual(latest);
            expect(store.has(key)).toBe(false);
            expect(store.get('local-settings')).toBe(storedSettings);
            expect(store.get(draftKey)).toBe(draft);
            const nextLocal = { ...local, debugMode: !local.debugMode };
            expect(() => persistence.saveLocalSettings(nextLocal)).not.toThrow();
            expect(persistence.loadLocalSettings().debugMode).toBe(nextLocal.debugMode);
            persistence.saveSessionMaterializedMaxSeqById({ session: 12 });
            expect(persistence.loadSessionMaterializedMaxSeqById()).toEqual({ session: 12 });
        } finally {
            set.mockImplementation((key, value) => { store.set(key, value); });
            vi.unstubAllGlobals();
        }
    });

    it('retains Found results by kind, machine, Home and Account without lending online authority', () => {
        const result = { kind: 'mcp_server' as const, machineId: 'machine-a', observedAt: 10,
            result: DaemonMcpServersDetectResponseSchema.parse({ ok: true, servers: [{ provider: 'claude', name: 'one',
            transport: 'stdio', stdio: { command: 'tool', args: [] }, envKeys: ['API_KEY'], enabled: true,
            source: { kind: 'user', path: '/config.json' } }] }) };
        warmCache.saveFoundWarmCacheEntry('server-a', 'account-a', result);
        const notified = vi.fn();
        const unsubscribe = warmCache.subscribeFoundWarmCacheEntry('server-a', 'account-a', 'mcp_server', 'machine-a', notified);
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            warmCache.saveFoundWarmCacheEntry('server-a', 'account-a', structuredClone(result));
            expect(stringify).not.toHaveBeenCalled();
            expect(notified).not.toHaveBeenCalled();
            warmCache.saveFoundWarmCacheEntry('server-a', 'account-a', { ...result, observedAt: 11 });
            expect(notified).toHaveBeenCalledTimes(1);
        } finally {
            stringify.mockRestore();
            unsubscribe();
        }
        warmCache.saveFoundWarmCacheEntry('server-a', 'account-a', result);
        expect(warmCache.loadFoundWarmCacheEntry('server-a', 'account-a', 'mcp_server', 'machine-a')).toEqual(result);
        expect(warmCache.loadFoundWarmCacheEntry('server-b', 'account-a', 'mcp_server', 'machine-a')).toBeNull();
        expect(warmCache.loadFoundWarmCacheEntry('server-a', 'account-b', 'mcp_server', 'machine-a')).toBeNull();
        expect(warmCache.loadFoundWarmCacheEntry('server-a', 'account-a', 'mcp_server', 'machine-b')).toBeNull();
        expect(warmCache.loadFoundWarmCacheEntry('server-a', 'account-a', 'skill', 'machine-a')).toBeNull();
    });

    it('keeps dated Found results isolated by Home, Account, kind and Machine without file bytes', () => {
        const entry = { kind: 'skill' as const, machineId: 'machine', observedAt: 123,
            result: SkillFoundListResultV1Schema.parse({ scannedAt: 123, roots: [], items: [] }) };
        saveFoundWarmCacheEntry('home', 'account', entry);
        expect(loadFoundWarmCacheEntry('home', 'account', 'skill', 'machine')).toEqual(entry);
        expect(loadFoundWarmCacheEntry('other', 'account', 'skill', 'machine')).toBeNull();
        expect(loadFoundWarmCacheEntry('home', 'other', 'skill', 'machine')).toBeNull();
        expect(loadFoundWarmCacheEntry('home', 'account', 'skill', 'other')).toBeNull();
    });

    it('retains each account reading time in the scoped usage cache', () => {
        const entry = {
            key: 'claude:work', serviceLabel: 'Claude', profileLabel: 'Work',
            planLabel: null, meters: [], fetchedAt: 1000,
        };
        const usage = { v: 1 as const, entries: [
            entry, { ...entry, key: 'claude:personal', fetchedAt: 5000 },
        ] };
        saveUsageSummaryWarmCache('server-a', 'account-a', usage);
        expect(loadUsageSummaryWarmCache('server-a', 'account-a')).toEqual(usage);
        expect(loadUsageSummaryWarmCache('server-b', 'account-a')).toBeNull();
        expect(loadUsageSummaryWarmCache('server-a', 'account-b')).toBeNull();
    });

    it('restores nested stored runtime facts with retired fields without deleting the cache', () => {
        // Open the native encrypted cache and finish legacy plaintext retirement before seeding its bytes.
        loadSessionListWarmCacheEntries('server-a', 'account-a');
        const key = 'session-list-warm-cache-v1:server-a:account-a';
        store.set(key, JSON.stringify({ s1: { sessionId: 's1', metadataVersion: 1, agentStateVersion: 1,
            updatedAt: 20, createdAt: 10, active: true, activeAt: 20, archivedAt: null, path: '/repo',
            pendingActivationAuthorization: { status: 'waiting', requestId: 'request-a', requestedAt: 10, retired: true },
        } }));
        expect(loadSessionListWarmCacheEntries('server-a', 'account-a').s1?.pendingActivationAuthorization)
            .toEqual({ status: 'waiting', requestId: 'request-a', requestedAt: 10 });
        expect(store.has(key)).toBe(true);
    });

    it('roundtrips session list entries by server and account scope', () => {
        saveSessionListWarmCacheEntries('server-a', 'account-a', {
            s1: {
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                updatedAt: 20,
                createdAt: 10,
                active: true,
                activeAt: 20,
                archivedAt: null,
                pendingCount: 1,
                pendingVersion: 4,
                accessLevel: 'edit',
                canApprovePermissions: true,
                name: 'Repo',
                summaryText: 'Summary',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                keepVisibleWhenInactive: true,
                hiddenSystemSession: false,
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: true,
            },
        });

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({
            s1: expect.objectContaining({
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                name: 'Repo',
                keepVisibleWhenInactive: true,
            }),
        });
        expect(loadSessionListWarmCacheEntries('server-b', 'account-a')).toEqual({});
        expect(loadSessionListWarmCacheEntries('server-a', 'account-b')).toEqual({});
    });

    it('persists canonical external-session agent identity without providerId', () => {
        store.set(
            'session-list-warm-cache-v1:server-a:account-a',
            JSON.stringify({
                s1: {
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                updatedAt: 20,
                createdAt: 10,
                active: true,
                activeAt: 20,
                archivedAt: null,
                path: '/home/u/repo',
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
                },
            }),
        );

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a').s1?.externalSessionV1).toEqual({
            v: 1,
            agentId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'codexHome', home: 'user' },
        });
    });

    it('normalizes released external-session Codex affinity before rehydrating the cache', () => {
        store.set(
            'session-list-warm-cache-v1:server-a:account-a',
            JSON.stringify({
                s1: {
                    sessionId: 's1',
                    metadataVersion: 2,
                    agentStateVersion: 3,
                    updatedAt: 20,
                    createdAt: 10,
                    active: true,
                    activeAt: 20,
                    archivedAt: null,
                    path: '/home/u/repo',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'codex',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'codexHome', home: 'user' },
                        codexBackendMode: 'mcp',
                    },
                },
            }),
        );

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a').s1?.externalSessionV1).toMatchObject({
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer', providerSessionId: 'remote-1' },
            },
        });
        expect(loadSessionListWarmCacheEntries('server-a', 'account-a').s1?.externalSessionV1)
            .not.toHaveProperty('codexBackendMode');
    });

    it('rehydrates rollback eligibility from persisted session list entries', () => {
        store.set(
            'session-list-warm-cache-v1:server-a:account-a',
            JSON.stringify({
                s1: {
                    sessionId: 's1',
                    metadataVersion: 2,
                    agentStateVersion: 3,
                    updatedAt: 20,
                    createdAt: 10,
                    active: true,
                    activeAt: 20,
                    archivedAt: null,
                    path: '/home/u/repo',
                    rollbackEligibleTurnStarts: [2, 8],
                },
            }),
        );

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({
            s1: expect.objectContaining({
                rollbackEligibleTurnStarts: [2, 8],
            }),
        });
    });

    it('drops invalid payloads safely', () => {
        store.set(
            'session-list-warm-cache-v1:server-a:account-a',
            JSON.stringify({ s1: { sessionId: 's1', metadataVersion: 'bad' } }),
        );
        store.set(
            'machine-display-warm-cache-v1:server-a:account-a',
            JSON.stringify({ m1: { machineId: 'm1', metadataVersion: 'bad' } }),
        );

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({});
        expect(loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual({});
    });

    it('roundtrips machine display entries by server and account scope', () => {
        saveMachineDisplayWarmCacheEntries('server-a', 'account-a', {
            m1: {
                machineId: 'm1',
                metadataVersion: 5,
                updatedAt: 22,
                active: true,
                activeAt: 22,
                revokedAt: null,
                replacedByMachineId: 'm2',
                replacedAt: 23,
                replacementReason: 'reinstalled',
                replacementSource: 'automatic',
                replacementActorUserId: 'user-1',
                lockedReason: 'decryption_failed',
                displayName: 'Work Mac',
                host: 'mbp',
                homeDir: '/home/u',
            },
        });

        expect(loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual({
            m1: expect.objectContaining({
                machineId: 'm1',
                metadataVersion: 5,
                displayName: 'Work Mac',
                replacedByMachineId: 'm2',
                replacedAt: 23,
                replacementReason: 'reinstalled',
                replacementSource: 'automatic',
                replacementActorUserId: 'user-1',
                lockedReason: 'decryption_failed',
            }),
        });
    });

    it('coalesces pending machine display writes by cache scope', async () => {
        vi.useFakeTimers();
        try {
            const first = {
                m1: {
                    machineId: 'm1',
                    metadataVersion: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    revokedAt: null,
                },
            };
            const latest = {
                m1: {
                    ...first.m1,
                    updatedAt: 2,
                    activeAt: 2,
                },
            };

            scheduleMachineDisplayWarmCacheEntriesSave('server-a', 'account-a', first);
            scheduleMachineDisplayWarmCacheEntriesSave('server-a', 'account-a', latest);

            expect(set).not.toHaveBeenCalled();
            await vi.runAllTimersAsync();
            expect(set).toHaveBeenCalledTimes(1);
            expect(loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual({
                m1: expect.objectContaining({ updatedAt: 2, activeAt: 2 }),
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('preserves admitted machine snapshots while declining demo writes and delayed demo captures', async () => {
        vi.useFakeTimers();
        const entries = (updatedAt: number) => ({ m1: { machineId: 'm1', metadataVersion: 1,
            updatedAt, active: true, activeAt: updatedAt, revokedAt: null } });
        let suspended = false;
        try {
            saveMachineDisplayWarmCacheEntries('server-a', 'account-a', entries(1));
            expect(loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual(entries(1));
            scheduleMachineDisplayWarmCacheEntriesSave('server-a', 'account-a', entries(2));
            suspendServerProfilePersistenceForDemo();
            suspended = true;
            saveMachineDisplayWarmCacheEntries('server-a', 'account-a', entries(99));
            expect(loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual(entries(1));
            await vi.runAllTimersAsync();
            expect(loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual(entries(2));
            scheduleMachineDisplayWarmCacheEntriesSave('server-a', 'account-a', entries(99));
            resumeServerProfilePersistenceForDemo();
            suspended = false;
            await vi.runAllTimersAsync();
            expect(loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual(entries(2));
            saveMachineDisplayWarmCacheEntries('server-a', 'account-a', entries(3));
            expect(loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual(entries(3));
        } finally {
            if (suspended) resumeServerProfilePersistenceForDemo();
            vi.useRealTimers();
        }
    });

    it('skips identical warm-cache writes for session list entries', () => {
        const entries = {
            s1: {
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                updatedAt: 20,
                createdAt: 10,
                active: true,
                activeAt: 20,
                archivedAt: null,
                pendingCount: 1,
                pendingVersion: 4,
                accessLevel: 'edit' as const,
                canApprovePermissions: true,
                name: 'Repo',
                summaryText: 'Summary',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                hiddenSystemSession: false,
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: true,
            },
        };

        saveSessionListWarmCacheEntries('server-a', 'account-a', entries);
        saveSessionListWarmCacheEntries('server-a', 'account-a', entries);

        expect(set).toHaveBeenCalledTimes(1);
        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({
            s1: expect.objectContaining({
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                name: 'Repo',
            }),
        });
    });

    it('skips re-serializing the same warm-cache object twice for session list entries', () => {
        const stringifySpy = vi.spyOn(JSON, 'stringify');
        const entries = {
            s1: {
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                updatedAt: 20,
                createdAt: 10,
                active: true,
                activeAt: 20,
                archivedAt: null,
                pendingCount: 1,
                pendingVersion: 4,
                accessLevel: 'edit' as const,
                canApprovePermissions: true,
                name: 'Repo',
                summaryText: 'Summary',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                hiddenSystemSession: false,
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: true,
            },
        };

        // The MMKV boundary is reset between cases; the process-owned admitted
        // snapshots intentionally outlive it. Give this first-save assertion its own scope.
        try {
            saveSessionListWarmCacheEntries('same-object-home', 'same-object-account', entries);
            saveSessionListWarmCacheEntries('same-object-home', 'same-object-account', entries);
            expect(stringifySpy).toHaveBeenCalledTimes(1);
            expect(set).toHaveBeenCalledTimes(1);
        } finally {
            stringifySpy.mockRestore();
        }
    });

    it('serializes only changed Home/Account resource scopes across repeated hydration arrivals', () => {
        const session = {
            sessionId: 's1', metadataVersion: 1, agentStateVersion: 1,
            path: '/workspace/hydration',
            updatedAt: 20, createdAt: 10, active: true, activeAt: 20,
            archivedAt: null, pendingCount: 0, pendingVersion: 0,
        };
        const sessions = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
            const sessionId = `s${index + 1}`;
            return [sessionId, { ...session, sessionId }];
        }));
        const inventory = {
            binding: 'binding-a', cursor: '1', artifacts: Array.from({ length: 2000 }, (_, index) => ({
                id: `a${index}`, rawHeader: { title: 'Retained header' }, isDecrypted: true,
                storageMode: 'plain' as const, headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            })),
        };
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            for (let arrival = 0; arrival < 20; arrival++) {
                const revision = arrival < 10 ? 1 : 2;
                saveSessionListWarmCacheEntries('hydration-home', 'hydration-account', {
                    ...sessions,
                    s1: { ...session, metadataVersion: revision },
                });
                warmCache.saveArtifactInventoryWarmCache('hydration-home', 'hydration-account', {
                    ...inventory, artifacts: inventory.artifacts.map(row => ({ ...row, rawHeader: { ...row.rawHeader } })),
                });
            }
            expect(stringify).toHaveBeenCalledTimes(3); // Two Session revisions; one unchanged inventory.
            expect(set).toHaveBeenCalledTimes(3);
            expect(loadSessionListWarmCacheEntries('hydration-home', 'hydration-account').s1.metadataVersion).toBe(2);
            expect(warmCache.loadArtifactInventoryWarmCache('hydration-home', 'hydration-account', inventory.binding))
                .toEqual(inventory);
            // Identical content on another Home or Account remains an independently durable scope.
            saveSessionListWarmCacheEntries('other-home', 'hydration-account', { s1: session });
            saveSessionListWarmCacheEntries('hydration-home', 'other-account', { s1: session });
            expect(stringify).toHaveBeenCalledTimes(5);
            expect(set).toHaveBeenCalledTimes(5);
            // Cursor-only progress is a real durable change even if the header rows are unchanged.
            warmCache.saveArtifactInventoryWarmCache('hydration-home', 'hydration-account', { ...inventory, cursor: '2' });
            expect(stringify).toHaveBeenCalledTimes(6);
            expect(set).toHaveBeenCalledTimes(6);
        } finally {
            stringify.mockRestore();
        }
    });

    it('retries an equal scope after failed persistence and still observes externally replaced raw bytes', () => {
        const entry = { m1: { machineId: 'm1', kind: 'persistent' as const, metadataVersion: 1, updatedAt: 1,
            active: true, activeAt: 1, revokedAt: null } };
        saveMachineDisplayWarmCacheEntries('retry-home', 'retry-account', entry);
        const changed = { m1: { ...entry.m1, metadataVersion: 2 } };
        set.mockImplementationOnce(() => { throw new Error('storage temporarily unavailable'); });
        saveMachineDisplayWarmCacheEntries('retry-home', 'retry-account', changed);
        expect(loadMachineDisplayWarmCacheEntries('retry-home', 'retry-account')).toEqual(changed);
        saveMachineDisplayWarmCacheEntries('retry-home', 'retry-account', { m1: { ...changed.m1 } });
        const key = 'machine-display-warm-cache-v1:retry-home:retry-account';
        expect(JSON.parse(store.get(key)!)).toEqual(changed);
        const external = { m1: { ...changed.m1, metadataVersion: 3 } };
        store.set(key, JSON.stringify(external));
        expect(loadMachineDisplayWarmCacheEntries('retry-home', 'retry-account')).toEqual(external);
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            saveMachineDisplayWarmCacheEntries('retry-home', 'retry-account', { m1: { ...external.m1 } });
            expect(stringify).not.toHaveBeenCalled();
        } finally {
            stringify.mockRestore();
        }
    });

    it('does not delete absent warm-cache entries when saving an empty session list', () => {
        const keysSpy = vi.spyOn(Object, 'keys');

        saveSessionListWarmCacheEntries('server-a', 'account-a', {});

        expect(deleteKey).not.toHaveBeenCalled();
        expect(set).not.toHaveBeenCalled();
        expect(keysSpy).not.toHaveBeenCalled();
        keysSpy.mockRestore();
    });

    it('prefers the authenticated runtime account scope over stale persisted profile ids', () => {
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('persisted-account');

        setWarmCacheAccountScope('authenticated-account');
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('authenticated-account');

        clearWarmCacheAccountScope();
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('persisted-account');
    });

    it('reuses shared empty objects for empty warm-cache loads', () => {
        const keysSpy = vi.spyOn(Object, 'keys');

        const firstSessionLoad = loadSessionListWarmCacheEntries('server-a', 'account-a');
        const secondSessionLoad = loadSessionListWarmCacheEntries('server-b', 'account-b');
        const firstMachineLoad = loadMachineDisplayWarmCacheEntries('server-a', 'account-a');
        const secondMachineLoad = loadMachineDisplayWarmCacheEntries('server-b', 'account-b');

        expect(firstSessionLoad).toEqual(secondSessionLoad);
        expect(firstMachineLoad).toEqual(secondMachineLoad);
        expect(firstSessionLoad).toBe(firstMachineLoad);
        expect(firstSessionLoad).toEqual({});
        expect(firstMachineLoad).toEqual({});
        expect(keysSpy).not.toHaveBeenCalled();
        keysSpy.mockRestore();
    });

    it('reuses shared empty objects when legacy persisted warm-cache payloads are empty objects', () => {
        store.set('session-list-warm-cache-v1:server-a:account-a', '{}');
        store.set('machine-display-warm-cache-v1:server-a:account-a', '{}');

        const firstSessionLoad = loadSessionListWarmCacheEntries('server-a', 'account-a');
        const secondSessionLoad = loadSessionListWarmCacheEntries('server-a', 'account-a');
        const firstMachineLoad = loadMachineDisplayWarmCacheEntries('server-a', 'account-a');
        const secondMachineLoad = loadMachineDisplayWarmCacheEntries('server-a', 'account-a');

        expect(firstSessionLoad).toBe(secondSessionLoad);
        expect(firstMachineLoad).toBe(secondMachineLoad);
        expect(firstSessionLoad).toEqual({});
        expect(firstMachineLoad).toEqual({});
    });

    it('reuses loaded warm-cache objects for repeated non-empty loads', () => {
        store.set(
            'session-list-warm-cache-v1:server-a:account-a',
            JSON.stringify({
                s1: {
                    sessionId: 's1',
                    metadataVersion: 2,
                    agentStateVersion: 3,
                    updatedAt: 20,
                    createdAt: 10,
                    active: true,
                    activeAt: 20,
                    archivedAt: null,
                    pendingCount: 1,
                    pendingVersion: 4,
                    accessLevel: 'edit',
                    canApprovePermissions: true,
                    name: 'Repo',
                    summaryText: 'Summary',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    host: 'mbp',
                    machineId: 'm1',
                    hiddenSystemSession: false,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: true,
                },
            }),
        );
        store.set(
            'machine-display-warm-cache-v1:server-a:account-a',
            JSON.stringify({
                m1: {
                    machineId: 'm1',
                    metadataVersion: 5,
                    updatedAt: 22,
                    active: true,
                    activeAt: 22,
                    revokedAt: null,
                    displayName: 'Work Mac',
                    host: 'mbp',
                    homeDir: '/home/u',
                },
            }),
        );

        const firstSessionLoad = loadSessionListWarmCacheEntries('server-a', 'account-a');
        const secondSessionLoad = loadSessionListWarmCacheEntries('server-a', 'account-a');
        const firstMachineLoad = loadMachineDisplayWarmCacheEntries('server-a', 'account-a');
        const secondMachineLoad = loadMachineDisplayWarmCacheEntries('server-a', 'account-a');

        expect(firstSessionLoad).toBe(secondSessionLoad);
        expect(firstMachineLoad).toBe(secondMachineLoad);
        expect(firstSessionLoad).toEqual({
            s1: expect.objectContaining({
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                name: 'Repo',
            }),
        });
        expect(firstMachineLoad).toEqual({
            m1: expect.objectContaining({
                machineId: 'm1',
                metadataVersion: 5,
                displayName: 'Work Mac',
            }),
        });
    });
});
