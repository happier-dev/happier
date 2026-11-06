import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { Encryption } from '@/sync/encryption/encryption';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { createDeferred, createMachineFixture } from '@/dev/testkit';
import { fetchAndApplyMachines } from '@/sync/engine/machines/syncMachines';
import { buildMachineActivityPlaceholder, readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { readMachineEncryptionContextInput } from '@/sync/encryption/machineEncryption';
import { encodeBase64 } from '@happier-dev/protocol';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';
import { readMachineInventoryRowReadiness } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import * as executionRunActivityBus from '@/sync/runtime/executionRuns/executionRunActivityBus';

import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import { flushMachineActivityUpdates, handleEphemeralSocketUpdate, handleUpdateContainer } from './socket';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { subscribeActivityLocalNotifications } from '@/activity/notifications/runtime/activityLocalNotificationBus';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { subscribeMachineUpdates } from '@/sync/store/domains/machines';
import { isMachineOnlineV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';

const initialStorageState = storage.getState();
describe('Machine work-summary socket facts', () => {
    it('wakes summary demand only for a genuine work fact from its current Home', async () => {
        const updates: unknown[] = [];
        const release = subscribeMachineUpdates((serverId, machineIds, facts) => updates.push({ serverId, machineIds, facts }), { workSummary: true });
        try {
            await handleEphemeralSocketUpdate(buildEphemeralParams({ sourceServerId: 'home-b',
                update: { type: 'machine-work-summary-changed', machineId: 'machine' } }));
            await handleEphemeralSocketUpdate(buildEphemeralParams({ sourceServerId: 'home-a', shouldContinue: () => false,
                update: { type: 'machine-work-summary-changed', machineId: 'machine' } }));
            await handleEphemeralSocketUpdate(buildEphemeralParams({ sourceServerId: 'home-b',
                update: { type: 'machine-activity', id: 'machine', active: true, activeAt: Date.now(), workSummaryChanged: true } }));
            expect(updates).toEqual([{ serverId: 'home-b', machineIds: ['machine'], facts: { workSummaryChanged: true } }]);
        } finally { release(); }
    });
});
describe('committed usage source wake', () => {
    it('invalidates source readers after a content-free harvest settlement and rejects retired ingress', async () => {
        const homes: string[] = [];
        const release = subscribeHomeAccountChange(event => homes.push(event.serverId));
        try {
            const update = { type: 'usage-sources-invalidated', machineId: 'machine', installationId: 'installation' };
            await handleEphemeralSocketUpdate(buildEphemeralParams({ sourceServerId: 'home-b', update }));
            await handleEphemeralSocketUpdate(buildEphemeralParams({ sourceServerId: 'home-a', update, shouldContinue: () => false }));
            expect(homes).toEqual(['home-b']);
        } finally { release(); }
    });
    it.each(['session', null])('invalidates only the source Home and ignores retired usage ingress (Session id %s)', async sessionId => {
        const homes: string[] = [];
        const release = subscribeHomeAccountChange(event => homes.push(event.serverId));
        try {
            const update = { type: 'usage', id: sessionId, key: 'codex:model', tokens: { total: 1 }, cost: { total: 0 }, timestamp: 1000 };
            await handleEphemeralSocketUpdate(buildEphemeralParams({ sourceServerId: 'home-b', update }));
            await handleEphemeralSocketUpdate(buildEphemeralParams({ sourceServerId: 'home-a', update, shouldContinue: () => false }));
            expect(homes).toEqual(['home-b']);
        } finally { release(); }
    });
});
let machineContextOwner: Encryption;
beforeEach(async () => { machineContextOwner = await Encryption.create(new Uint8Array(32).fill(17)); });

describe('committed personal in-app facts', () => {
    afterEach(() => retirePresentationNotice());

    it('shows an untracked recipient a qualified transient fact without scheduling an OS notification', async () => {
        const osEvents: unknown[] = [];
        const unsubscribe = subscribeActivityLocalNotifications(event => osEvents.push(event));
        try {
            for (const event of ['directly_shared', 'assigned'] as const) {
                await handleEphemeralSocketUpdate(buildEphemeralParams({
                    sourceServerId: 'home-b',
                    update: { type: 'session-personal-event', sessionId: 'same-id', event, eventId: `committed-${event}` },
                }));
                expect(readPresentationNotice()).toMatchObject({
                    key: JSON.stringify(['home-b', 'same-id', `committed-${event}`]),
                    severity: 'info',
                    message: expect.any(String),
                });
            }
            expect(osEvents).toEqual([]);
        } finally {
            unsubscribe();
        }
    });

    it('does not show a retired Home receipt or reinterpret an unrelated snapshot as an event', async () => {
        await handleEphemeralSocketUpdate(buildEphemeralParams({
            sourceServerId: 'home-a', shouldContinue: () => false,
            update: { type: 'session-personal-event', sessionId: 'same-id', event: 'assigned', eventId: 'retired' },
        }));
        await handleEphemeralSocketUpdate(buildEphemeralParams({
            sourceServerId: 'home-b',
            update: { type: 'activity', id: 'same-id', active: true, activeAt: 1 },
        }));
        await handleEphemeralSocketUpdate(buildEphemeralParams({
            sourceServerId: 'home-b',
            update: { type: 'session-personal-event', sessionId: 'same-id', event: 'assigned', eventId: 'invalid', content: 'not a content channel' },
        }));
        expect(readPresentationNotice()).toBeNull();
    });
});

function buildBaseParams(overrides: Partial<Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'>> = {}) {
    const decryptEncryptionKey = vi.fn(async () => null as Uint8Array | null);
    const initializeMachines = vi.fn(async (_machineKeysMap: Map<string, Uint8Array | null>) => {});
    const params = {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
            decryptEncryptionKey,
            initializeMachines,
        },
        artifactDataKeys: new Map(),
        applySessions: vi.fn(),
        fetchSessions: vi.fn(),
        applyMessages: vi.fn(),
        onSessionVisible: vi.fn(),
        isSessionMessagesLoaded: vi.fn(() => false),
        getSessionMaterializedMaxSeq: vi.fn(() => 0),
        markSessionMaterializedMaxSeq: vi.fn(),
        onMessageGapDetected: vi.fn(),
        assumeUsers: vi.fn(async () => {}),
        applyTodoSocketUpdates: vi.fn(async () => {}),
        invalidateMachines: vi.fn(),
        invalidateSessions: vi.fn(),
        invalidateArtifacts: vi.fn(),
        invalidateFriends: vi.fn(),
        invalidateFriendRequests: vi.fn(),
        invalidateFeed: vi.fn(),
        invalidateAutomations: vi.fn(),
        invalidateTodos: vi.fn(),
        log: { log: vi.fn() },
        ...overrides,
    };
    return {
        ...params,
        readAccountMode: async () => 'e2ee' as const,
        ...overrides,
        encryption: params.encryption === null || typeof params.encryption !== 'object' || params.encryption instanceof Encryption
            ? params.encryption
            : Object.assign(machineContextOwner, params.encryption),
    };
}

function buildEphemeralParams(overrides: Partial<Parameters<typeof handleEphemeralSocketUpdate>[0]> = {}): Parameters<typeof handleEphemeralSocketUpdate>[0] {
    return {
        update: null,
        addActivityUpdate: () => {},
        addMachineActivityUpdate: () => {},
        getSessionEncryption: () => null,
        getSession: () => undefined,
        applyMessages: () => {},
        ...overrides,
    };
}

function buildSession(sessionId: string, encryptionMode: 'e2ee' | 'plain' = 'plain'): Session {
    return {
        id: sessionId,
        seq: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
        active: true,
        activeAt: 1_000,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        encryptionMode,
    };
}

function buildTranscriptStreamSegmentUpdate(sessionId: string, content: unknown, localId = 'segment-1') {
    return {
        type: 'transcript-stream-segment',
        sessionId,
        message: {
            localId,
            content,
            createdAt: 1_000,
            updatedAt: 1_010,
        },
    };
}

function buildPlainTranscriptStreamSegmentContent(text: string, localId = 'segment-1') {
    return {
        t: 'plain',
        v: buildRawTranscriptStreamSegmentRecord(text, localId),
    };
}

function buildRawTranscriptStreamSegmentRecord(text: string, localId = 'segment-1') {
    return {
        role: 'agent',
        content: {
            type: 'acp',
            agentId: 'codex',
            data: { type: 'message', message: text },
        },
        meta: {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: localId,
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_010,
            },
        },
    };
}

function buildEmptyCanonicalTurnDiffInput() {
    return {
        files: [],
        _happier: {
            sessionChangeScope: 'turn',
            workspaceMutationSignal: 'turn-change-set',
            turnId: 'turn-stream-1',
            sessionId: 'stream-session-1',
            provider: 'codex',
            rawToolName: 'RepositoryCheckpointDiff',
            canonicalToolName: 'Diff',
            source: 'scm_checkpoint',
            confidence: 'exact',
            turnStatus: 'completed',
            seqRange: {
                startSeqInclusive: 1,
                endSeqInclusive: 1,
            },
        },
    };
}

function buildEmptyCanonicalTurnDiffCallContent(callId: string) {
    return {
        t: 'plain',
        v: {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'codex',
                data: {
                    type: 'tool-call',
                    callId,
                    name: 'Diff',
                    input: JSON.stringify(buildEmptyCanonicalTurnDiffInput()),
                    id: `${callId}-call`,
                },
            },
        },
    };
}

function buildEmptyCanonicalTurnDiffResultContent(callId: string) {
    return {
        t: 'plain',
        v: {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'codex',
                data: {
                    type: 'tool-result',
                    callId,
                    output: JSON.stringify({ status: 'completed', files: [] }),
                    id: `${callId}-result`,
                },
            },
        },
    };
}

function enableTranscriptStreamingCoalescingForTest(): void {
    storage.setState((prev) => ({
        ...prev,
        settings: {
            ...prev.settings,
            transcriptStreamingCoalesceEnabled: true,
            transcriptStreamingCoalesceWindowMs: 50,
            transcriptStreamingCoalesceMaxBatchSize: 1_000,
        },
    }));
}

describe('socket update handling: new-machine', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('keeps a new Home-owned Machine online while full census hydration is pending', async () => {
        await handleUpdateContainer({ ...buildBaseParams({ encryption: null, readAccountMode: async () => 'plain' }),
            updateData: { id: 'presence-hint', seq: 1, createdAt: 100_000, body: {
                t: 'new-machine', machineId: 'presence-hint-machine', seq: 1,
                metadata: '{}', metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                active: true, activeAt: 100_000, presenceProtocolVersion: 1,
                createdAt: 100_000, updatedAt: 100_000,
            } },
        });
        const machine = storage.getState().machines['presence-hint-machine'];
        expect(machine).toBeDefined();
        expect(isMachineOnlineV1(machine!, 160_001)).toBe(true);
        expect(isMachineOnlineV1({ ...machine!, active: false }, 100_001)).toBe(false);
    });


    it('rejects a legacy Plain marker when the owning Account is E2EE', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        const params = buildBaseParams({ encryption, readAccountMode: async () => 'e2ee' });
        await handleUpdateContainer({ ...params, updateData: {
            id: 'marker-substitution', seq: 1, createdAt: 1,
            body: {
                t: 'new-machine', machineId: 'm-marker', seq: 1,
                metadata: '{}', metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                active: false, activeAt: 1, createdAt: 1, updatedAt: 1,
            },
        } });
        expect(storage.getState().machines['m-marker']?.availability?.kind).toBe('locked');
        expect(encryption.getMachineEncryption('m-marker')).toBeNull();
    });

    it('applies a placeholder machine and invalidates machines sync', async () => {
        const invalidateMachines = vi.fn();
        const params = buildBaseParams({ invalidateMachines });
        const updateData: ApiUpdateContainer = {
            id: 'u_machine_1',
            seq: 42,
            createdAt: 123,
            body: {
                t: 'new-machine',
                machineId: 'm1',
                seq: 7,
                metadata: 'AA==',
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                dataEncryptionKey: null,
                active: false,
                activeAt: 120,
                createdAt: 100,
                updatedAt: 110,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({ ...params, updateData });

        expect(invalidateMachines).toHaveBeenCalledTimes(1);

        const machine = storage.getState().machines['m1'] as Machine | undefined;
        expect(machine).toBeTruthy();
        expect(machine?.active).toBe(false);
        expect(machine?.activeAt).toBe(120);
        expect(machine?.seq).toBe(7);
        expect(machine?.metadata).toBeNull();
        expect(machine?.daemonState).toBeNull();
    });

    it('initializes machine encryption when a data encryption key is present', async () => {
        const invalidateMachines = vi.fn();
        const decryptEncryptionKey = vi.fn(async () => new Uint8Array(32).fill(3));
        const initializeMachines = vi.fn(async (
            _machineKeysMap: Map<string, Uint8Array | null>,
            _unavailableMachineIds?: ReadonlySet<string>,
        ) => {});
        const params = buildBaseParams({
            invalidateMachines,
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey,
                initializeMachines,
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
        });

        const updateData: ApiUpdateContainer = {
            id: 'u_machine_2',
            seq: 43,
            createdAt: 124,
            body: {
                t: 'new-machine',
                machineId: 'm2',
                seq: 8,
                metadata: 'AA==',
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                dataEncryptionKey: 'base64-envelope',
                active: true,
                activeAt: 121,
                createdAt: 101,
                updatedAt: 111,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({ ...params, updateData });

        expect(decryptEncryptionKey).toHaveBeenCalledTimes(1);
        expect(initializeMachines).toHaveBeenCalledTimes(1);
        expect(invalidateMachines).toHaveBeenCalledTimes(1);
    });

    it('fails a present unreadable envelope closed instead of using legacy Machine encryption', async () => {
        const invalidateMachines = vi.fn();
        const decryptEncryptionKey = vi.fn(async () => {
            throw new Error('bad envelope');
        });
        const initializeMachines = vi.fn(async (
            _machineKeysMap: Map<string, Uint8Array | null>,
            _unavailableMachineIds?: ReadonlySet<string>,
        ) => {});
        const params = buildBaseParams({
            invalidateMachines,
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey,
                initializeMachines,
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
        });

        const updateData: ApiUpdateContainer = {
            id: 'u_machine_3',
            seq: 44,
            createdAt: 125,
            body: {
                t: 'new-machine',
                machineId: 'm3',
                seq: 9,
                metadata: 'AA==',
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                dataEncryptionKey: 'broken-envelope',
                active: true,
                activeAt: 122,
                createdAt: 102,
                updatedAt: 112,
            },
        } as ApiUpdateContainer;

        await expect(handleUpdateContainer({ ...params, updateData })).resolves.toBeUndefined();

        expect(decryptEncryptionKey).toHaveBeenCalledTimes(1);
        expect(initializeMachines).toHaveBeenCalledTimes(1);
        expect(initializeMachines.mock.calls[0]?.[0]).toEqual(new Map());
        expect(initializeMachines.mock.calls[0]?.[1]).toEqual(new Set(['m3']));
        expect(invalidateMachines).toHaveBeenCalledTimes(1);

        const machine = storage.getState().machines['m3'] as Machine | undefined;
        expect(machine).toBeTruthy();
        expect(machine?.active).toBe(true);
        expect(machine?.activeAt).toBe(122);
        expect(machine?.metadata).toBeNull();
        expect(machine?.daemonState).toBeNull();
    });

    it('does not accept a Runner envelope from the socket hint without its creator proof', async () => {
        const invalidateMachines = vi.fn();
        const initializeMachines = vi.fn(async (
            _machineKeysMap: Map<string, Uint8Array | null>,
            _unavailableMachineIds?: ReadonlySet<string>,
        ) => {});
        const params = buildBaseParams({
            invalidateMachines,
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: vi.fn(async () => new Uint8Array(32).fill(8)),
                initializeMachines,
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
        });
        const updateData = {
            id: 'u_runner_machine', seq: 45, createdAt: 126,
            body: {
                t: 'new-machine', kind: 'ephemeral_session_runner', machineId: 'runner-1', seq: 10,
                metadata: 'AA==', metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
                dataEncryptionKey: 'runner-envelope', installationId: 'runner-installation',
                active: true, activeAt: 123, createdAt: 103, updatedAt: 113,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({ ...params, updateData });

        expect(initializeMachines.mock.calls[0]?.[0]).toEqual(new Map());
        expect(initializeMachines.mock.calls[0]?.[1]).toEqual(new Set(['runner-1']));
        expect(invalidateMachines).toHaveBeenCalledOnce();
    });
});

describe('socket update handling: update-machine (missing encryption)', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it.each(['registration', 'context', 'context-without-envelope'] as const)('settles a paired owner Machine when an unchanged %s update arrives during and after hydration', async (hint) => {
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        const machineId = 'paired-owner';
        const key = new Uint8Array(32).fill(23);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(key), 'base64');
        const access = { custodian: { accountId: 'account-1', displayName: 'Owner' }, role: 'manage' as const,
            resourceMode: 'e2ee' as const, accessState: 'ready' as const };
        const keyBasis = { dataEncryptionKey: envelope, metadataVersion: 1, daemonStateVersion: 1 };
        const machine = createMachineFixture({ id: machineId, dataEncryptionKey: envelope, keyBasis, access,
            storageMode: 'e2ee', activeAt: Date.now() });
        const state = { status: 'running', httpPort: 4000 };
        await encryption.initializeMachines(new Map([[machineId, key]]));
        const cipher = encryption.getMachineEncryption(machineId)!;
        const metadata = await cipher.encryptMetadata(machine.metadata!);
        const daemonState = await cipher.encryptDaemonState(state);
        encryption.removeMachineEncryption(machineId);
        storage.setState({ machines: {}, machineDisplayById: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
        storage.getState().applyMachines([buildMachineActivityPlaceholder({ id: machineId, active: true, activeAt: machine.activeAt })]);
        const entered = createDeferred<void>(), release = createDeferred<void>();
        const worker = createFakeCryptoWorker();
        encryption.configureNativeCryptoWorker({ routing: { mode: 'require', minPayloadBytes: 0 }, worker: {
            ...worker, decryptDataKeyEnvelopeV1: async request => {
                entered.resolve(); await release.promise; return worker.decryptDataKeyEnvelopeV1(request);
            },
        } });
        const credentials = { token: 'header.eyJzdWIiOiJhY2NvdW50LTEifQ==.signature', secret: encodeBase64(secret, 'base64url') };
        const sourceServerId = getActiveServerSnapshot().serverId;
        const params = buildBaseParams({ encryption, credentials, sourceServerId });
        await handleUpdateContainer({ ...params, updateData: { id: 'first-context', seq: 1, createdAt: machine.updatedAt,
            body: { t: 'update-machine', machineId, dataEncryptionKey: envelope, keyBasis, access } } });
        expect(storage.getState().machines[machineId]).toMatchObject({ metadata: null, daemonState: null,
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
        const heartbeatAt = machine.activeAt + 1;
        flushMachineActivityUpdates({ updates: new Map([[machineId, { id: machineId, active: true, activeAt: heartbeatAt }]]),
            sourceServerId });
        expect(readMachineActivity(storage.getState().machines[machineId]!).activeAt).toBe(heartbeatAt);
        const updateData: ApiUpdateContainer = { id: 'paired-owner-hint', seq: 2, createdAt: machine.updatedAt + 1,
            body: hint === 'registration'
                ? { ...machine, t: 'new-machine', machineId, dataEncryptionKey: envelope, metadata, daemonState }
                : { t: 'update-machine', machineId, keyBasis, access,
                    ...(hint === 'context' ? { dataEncryptionKey: envelope } : {}) } };
        const refresh = () => fetchAndApplyMachines({ credentials, encryption, expectedAccountMode: 'e2ee',
            sourceServerId, machineDataKeys: new Map(),
            request: async () => Response.json([{ ...machine, metadata, daemonState }]),
            getMachineSnapshot: () => storage.getState().machines,
            getExistingMachine: id => storage.getState().machines[id],
            applyMachineDisplayEntries: rows => storage.getState().replaceMachineDisplays(rows),
            applyMachines: (rows, replace) => storage.getState().applyMachines(rows, replace),
        });
        const pending = refresh();
        try {
            await entered.promise;
            // Registration also opens the envelope; let that boundary complete
            // with the already in-flight census, rather than awaiting it here.
            const socket = handleUpdateContainer({ ...params, updateData });
            if (hint !== 'registration') await socket;
            release.resolve(); await Promise.all([pending, socket]);
            expect(storage.getState().machines[machineId]).toMatchObject({ metadata: machine.metadata,
                daemonState: state, active: true, activeAt: heartbeatAt, availability: { kind: 'available' } });
            await handleUpdateContainer({ ...params, updateData: { ...updateData, id: 'after-hydration', seq: 3 } });
            expect(storage.getState().machines[machineId]).toMatchObject({ metadata: machine.metadata,
                daemonState: state, active: true, activeAt: heartbeatAt, availability: { kind: 'available' } });
            if (hint === 'registration') {
                const nextMetadata = { ...machine.metadata!, displayName: 'Updated registration' };
                const nextCipher = encryption.getMachineEncryption(machineId)!;
                await handleUpdateContainer({ ...params, updateData: { ...updateData, id: 'newer-registration', seq: 4,
                    body: { ...machine, t: 'new-machine', machineId, dataEncryptionKey: envelope,
                        metadata: await nextCipher.encryptMetadata(nextMetadata), metadataVersion: 2, daemonState,
                        keyBasis: { ...keyBasis, metadataVersion: 2 } } } });
                expect(storage.getState().machines[machineId]).toMatchObject({ metadata: nextMetadata, metadataVersion: 2,
                    daemonState: state, availability: { kind: 'available' } });
                await handleUpdateContainer({ ...params, updateData: { id: 'registration-role-downgrade', seq: 5, createdAt: 5,
                    body: { ...machine, t: 'new-machine', machineId, dataEncryptionKey: envelope,
                        metadata: await nextCipher.encryptMetadata(nextMetadata), metadataVersion: 2, daemonState,
                        keyBasis: { ...keyBasis, metadataVersion: 2 }, access: { ...access, role: 'use' } } } });
                expect(storage.getState().machines[machineId]?.access?.role).toBe('use');
            }
        } finally { release.resolve(); await pending; }
    });

    it('opens current metadata after a newer socket hint during key admission, without admitting the old daemon state', async () => {
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        const key = new Uint8Array(32).fill(23);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(key), 'base64');
        const machineId = 'cold-hint';
        await encryption.initializeMachines(new Map([[machineId, key]]));
        const cipher = encryption.getMachineEncryption(machineId)!;
        const machine = createMachineFixture({ id: machineId, metadataVersion: 1, daemonStateVersion: 1,
            activeAt: Date.now(), dataEncryptionKey: envelope, storageMode: 'e2ee',
            operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
            keyBasis: { dataEncryptionKey: envelope, metadataVersion: 1, daemonStateVersion: 1 } });
        const metadata = await cipher.encryptMetadata(machine.metadata!);
        const daemonState = await cipher.encryptDaemonState({ status: 'running', httpPort: 3000 });
        const nextState = { status: 'running', httpPort: 4000 };
        const nextCiphertext = await cipher.encryptDaemonState(nextState);
        encryption.removeMachineEncryption(machineId);
        storage.setState({ machines: {}, machineDisplayById: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
        const entered = createDeferred<void>(), release = createDeferred<void>();
        const worker = createFakeCryptoWorker();
        encryption.configureNativeCryptoWorker({ routing: { mode: 'require', minPayloadBytes: 0 }, worker: {
            ...worker, decryptDataKeyEnvelopeV1: async request => {
                entered.resolve(); await release.promise; return worker.decryptDataKeyEnvelopeV1(request);
            },
        } });
        const credentials = { token: 'header.eyJzdWIiOiJhY2NvdW50LTEifQ==.signature',
            secret: encodeBase64(secret, 'base64url') };
        const pending = fetchAndApplyMachines({ credentials, encryption, expectedAccountMode: 'e2ee',
            sourceServerId: 'home-1', machineDataKeys: new Map(),
            request: async () => Response.json([{ ...machine, metadata, daemonState }]),
            getMachineSnapshot: () => storage.getState().machines,
            getExistingMachine: id => storage.getState().machines[id],
            applyMachineDisplayEntries: rows => storage.getState().replaceMachineDisplays(rows),
            applyMachines: (rows, replace) => storage.getState().applyMachines(rows, replace),
        });
        const hint = { id: 'newer-state-hint', seq: 2, createdAt: machine.updatedAt + 1,
            body: { t: 'update-machine' as const, machineId,
                keyBasis: { dataEncryptionKey: envelope, metadataVersion: 1, daemonStateVersion: 2 },
                daemonState: { version: 2, value: nextCiphertext } } };
        try {
            await entered.promise;
            await handleUpdateContainer({ ...buildBaseParams({ encryption, credentials }), updateData: hint });
            release.resolve(); await pending;
            expect(storage.getState().machines[machineId]).toMatchObject({ metadata: machine.metadata, metadataVersion: 1,
                daemonStateVersion: 1, keyBasis: { daemonStateVersion: 2 } });
            expect(readMachineInventoryRowReadiness(storage.getState().machines[machineId]!)).toBe('pending');
            await handleUpdateContainer({ ...buildBaseParams({ encryption, credentials }), updateData: { ...hint, id: 'opened-state-hint', seq: 3 } });
            expect(storage.getState().machines[machineId]).toMatchObject({ metadata: machine.metadata, daemonState: nextState,
                daemonStateVersion: 2, availability: { kind: 'available' } });
            expect(readMachineInventoryRowReadiness(storage.getState().machines[machineId]!)).toBe('available');
        } finally { release.resolve(); await pending; }
    });

    it.each(['complete', 'content-only'] as const)('keeps an exact-read Machine cipher when its unchanged %s hint reaches a presence-only store row', async (hint) => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        const machineId = 'cold-exact-read';
        const key = new Uint8Array(32).fill(23);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(key), 'base64');
        const access = { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'use' as const,
            resourceMode: 'e2ee' as const, accessState: 'ready' as const };
        const keyBasis = { dataEncryptionKey: envelope, metadataVersion: 1, daemonStateVersion: 1 };
        // An exact RPC read can admit crypto before the fleet list has hydrated
        // its presence shell. That shell is not a second key-context authority.
        encryption.captureMachineEncryptionContext(machineId,
            readMachineEncryptionContextInput({ dataEncryptionKey: envelope, keyBasis, access }, 'owner'));
        await encryption.initializeMachines(new Map([[machineId, key]]));
        const cipher = encryption.getMachineEncryption(machineId);
        if (!cipher) throw new Error('Fixture Machine cipher was not admitted');
        const metadata = createMachineFixture().metadata!;
        const ciphertext = await cipher.encryptMetadata(metadata);
        storage.getState().applyMachines([buildMachineActivityPlaceholder({ id: machineId, active: true, activeAt: 200 })]);
        const params = buildBaseParams({ encryption,
            credentials: { token: `e30.${btoa(JSON.stringify({ sub: 'owner' }))}.signature` } });
        await handleUpdateContainer({ ...params, updateData: {
            id: 'unchanged-current-key-hint', seq: 2, createdAt: 200,
            body: { t: 'update-machine', machineId, keyBasis, metadata: { value: ciphertext, version: 1 },
                ...(hint === 'complete' ? { dataEncryptionKey: envelope, access } : {}) },
        } });
        expect(encryption.getMachineEncryption(machineId) === cipher).toBe(true);
        expect(storage.getState().machines[machineId]?.availability?.kind).not.toBe('locked');
        expect(storage.getState().machines[machineId]?.metadata?.host).toBe(metadata.host);
        // Retaining an unchanged context must not retain execution after the
        // same published envelope loses its recipient access.
        await handleUpdateContainer({ ...params, updateData: {
            id: 'recipient-access-withdrawn', seq: 3, createdAt: 201,
            body: { t: 'update-machine', machineId, dataEncryptionKey: envelope, keyBasis,
                access: { ...access, accessState: 'refused' } },
        } });
        expect(encryption.getMachineEncryption(machineId)).toBeNull();
        expect(storage.getState().machines[machineId]).toMatchObject({ metadata: null, daemonState: null,
            availability: { kind: 'locked' } });
    });

    it('does not let a held old list undo a later current key hint at unchanged content versions', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        const oldKey = new Uint8Array(32).fill(23);
        const oldEnvelope = encodeBase64(await encryption.encryptEncryptionKey(oldKey), 'base64');
        const nextEnvelope = encodeBase64(await encryption.encryptEncryptionKey(new Uint8Array(32).fill(24)), 'base64');
        encryption.captureMachineEncryptionContext('m-held', { dataEncryptionKey: oldEnvelope, expectedDataEncryptionKey: oldEnvelope });
        await encryption.initializeMachines(new Map([['m-held', oldKey]]));
        const machine = createMachineFixture({ id: 'm-held', dataEncryptionKey: oldEnvelope, metadataVersion: 1, daemonStateVersion: 0 });
        storage.getState().applyMachines([machine]);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const pending = fetchAndApplyMachines({
            credentials: { token: `e30.${btoa(JSON.stringify({ sub: 'owner' }))}.signature`, secret: encodeBase64(new Uint8Array(32).fill(17), 'base64') },
            encryption, machineDataKeys: new Map(), sourceServerId: 'home-1',
            request: async () => { entered.resolve(); await release.promise; return Response.json([{ ...machine, metadata: 'old-ciphertext', dataEncryptionKey: oldEnvelope }]); },
            getExistingMachine: (id) => storage.getState().machines[id],
            applyMachines: (machines, replace) => storage.getState().applyMachines(machines, replace),
        });
        await entered.promise;
        await handleUpdateContainer({ ...buildBaseParams(), encryption, updateData: {
            id: 'current-key-hint', seq: 2, createdAt: 2,
            body: { t: 'update-machine', machineId: machine.id, dataEncryptionKey: nextEnvelope,
                keyBasis: { dataEncryptionKey: nextEnvelope, metadataVersion: 1, daemonStateVersion: 0 } },
        } });
        release.resolve();
        await pending;
        expect(encryption.getMachineDataEncryptionKey(machine.id)).toBe(nextEnvelope);
        expect(encryption.getMachineEncryption(machine.id)).toBeNull();
    });

    it('retains newer canonical encryption when an older envelope hint arrives late', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        const key = new Uint8Array(32).fill(23);
        const currentEnvelope = 'current-envelope';
        encryption.captureMachineEncryptionContext('m-current', { dataEncryptionKey: currentEnvelope, expectedDataEncryptionKey: currentEnvelope });
        await encryption.initializeMachines(new Map([['m-current', key]]));
        const cipher = encryption.getMachineEncryption('m-current');
        const machine = createMachineFixture({ id: 'm-current', dataEncryptionKey: currentEnvelope, metadataVersion: 3, daemonStateVersion: 3 });
        storage.getState().applyMachines([machine]);
        const params = buildBaseParams({ encryption });
        await handleUpdateContainer({ ...params, encryption, updateData: {
            id: 'late-envelope', seq: 2, createdAt: 2,
            body: { t: 'update-machine', machineId: machine.id,
                dataEncryptionKey: 'old-envelope',
                keyBasis: { dataEncryptionKey: 'old-envelope', metadataVersion: 1, daemonStateVersion: 1 },
            },
        } });
        expect(encryption.getMachineEncryption(machine.id)).toBe(cipher);
        expect(storage.getState().machines[machine.id]).toBe(machine);
    });

    it('still applies freshness fields before invalidating machines sync', async () => {
        const invalidateMachines = vi.fn();
        const params = buildBaseParams({ invalidateMachines });

        const updateData: ApiUpdateContainer = {
            id: 'u_machine_up_1',
            seq: 99,
            createdAt: 200,
            body: {
                t: 'update-machine',
                machineId: 'm_missing_enc',
                active: true,
                activeAt: 200,
                metadata: { version: 2, value: 'cipher' },
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({ ...params, updateData });

        expect(invalidateMachines).toHaveBeenCalledTimes(1);
        const machine = storage.getState().machines['m_missing_enc'] as Machine | undefined;
        expect(machine).toBeTruthy();
        expect(machine?.active).toBe(true);
        expect(machine?.activeAt).toBe(200);
        expect(machine?.metadata).toBeNull();
        expect(machine?.daemonState).toBeNull();
    });
});

describe('socket update handling: machine-activity for unknown machine', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('routes update to addMachineActivityUpdate callback without directly writing to storage', () => {
        const addMachineActivityUpdate = vi.fn();
        expect(storage.getState().machines['m_unknown']).toBeUndefined();

        handleEphemeralSocketUpdate(buildEphemeralParams({
            update: { type: 'machine-activity', id: 'm_unknown', active: true, activeAt: 999 },
            addActivityUpdate: () => {},
            addMachineActivityUpdate,
        }));

        expect(addMachineActivityUpdate).toHaveBeenCalledWith({ id: 'm_unknown', active: true, activeAt: 999 });
        expect(storage.getState().machines['m_unknown']).toBeUndefined();
    });
});

describe('socket update handling: Action operation snapshot ephemerals', () => {
    it('routes the encrypted snapshot through the single observation ingress', async () => {
        const updateActionOperationSnapshot = vi.fn();

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: {
                type: 'action-operation-snapshot',
                machineId: 'machine-1',
                ciphertext: 'sealed-snapshot',
            },
            updateActionOperationSnapshot,
        }));

        expect(updateActionOperationSnapshot).toHaveBeenCalledWith({
            type: 'action-operation-updated',
            machineId: 'machine-1',
            content: { t: 'encrypted', c: 'sealed-snapshot' },
        });
    });

    it('normalizes the released 0.2.11 relay before the single observation ingress', async () => {
        const updateActionOperationSnapshot = vi.fn();

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: {
                type: 'action-operation-updated',
                machineId: 'machine-1',
                content: { t: 'encrypted', c: 'sealed-snapshot' },
            },
            updateActionOperationSnapshot,
        }));

        expect(updateActionOperationSnapshot).toHaveBeenCalledWith({
            type: 'action-operation-updated',
            machineId: 'machine-1',
            content: { t: 'encrypted', c: 'sealed-snapshot' },
        });
    });
});

describe('socket update handling: execution-run-updated ephemerals', () => {
    it('notifies execution run activity so polling can recheck quickly', () => {
        const listener = vi.fn();
        const unsubscribe = executionRunActivityBus.subscribeExecutionRunActivity({
            serverId: 'server-a',
            sessionId: 's1',
        }, listener);

        handleEphemeralSocketUpdate(buildEphemeralParams({
            sourceServerId: 'server-a',
            update: {
                type: 'execution-run-updated',
                sessionId: 's1',
                run: {
                    runId: 'run_1',
                    callId: 'call_1',
                    sidechainId: 'call_1',
                    intent: 'review',
                    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                    permissionMode: 'read_only',
                    retentionPolicy: 'ephemeral',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                    status: 'running',
                    startedAtMs: 123,
                },
            },
            addActivityUpdate: () => {},
            addMachineActivityUpdate: () => {},
        }));

        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    });
});

describe('socket update handling: transcript-stream-segment ephemerals', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        storage.setState((prev) => ({
            ...prev,
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: false,
            },
        }));
        resetSessionSurfaceVisibilityForTests();
    });

    afterEach(() => {
        resetSessionSurfaceVisibilityForTests();
        vi.useRealTimers();
    });

    it('normalizes and applies live transcript stream snapshots', async () => {
        const applyMessages = vi.fn();
        markSessionSurfaceVisible('s1');

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: {
                type: 'transcript-stream-segment',
                sessionId: 's1',
                message: {
                    localId: 'segment-1',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'agent',
                            content: {
                                type: 'acp',
                                agentId: 'codex',
                                data: { type: 'message', message: 'Hello there' },
                            },
                            meta: {
                                happierStreamSegmentV1: {
                                    v: 1,
                                    segmentKind: 'assistant',
                                    segmentLocalId: 'segment-1',
                                    segmentState: 'streaming',
                                    startedAtMs: 1_000,
                                    updatedAtMs: 1_025,
                                },
                            },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_025,
                },
            },
            getSession: () => ({ id: 's1', encryptionMode: 'plain' } as any),
            applyMessages,
        }));

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages).toHaveBeenCalledWith(
            's1',
            [
                expect.objectContaining({
                    id: 'segment-1',
                    localId: 'segment-1',
                    role: 'agent',
                    content: [expect.objectContaining({ type: 'text', text: 'Hello there' })],
                }),
            ],
        );
    });

    it('applies transcript stream segment deltas by reconstructing text for live-consumed sessions', async () => {

        const sessionId = 's-dispatch-delta';
        const applyMessages = vi.fn();
        markSessionSurfaceVisible(sessionId);
        const params = buildEphemeralParams({
            getSession: () => buildSession(sessionId, 'plain'),
            applyMessages,
        });

        await handleEphemeralSocketUpdate({
            ...params,
            update: {
                type: 'transcript-stream-segment',
                sessionId,
                message: {
                    localId: 'segment-1',
                    messageRole: 'agent',
                    tick: 1,
                    content: buildPlainTranscriptStreamSegmentContent('Hello'),
                    createdAt: 1_000,
                    updatedAt: 1_010,
                },
            },
        });
        await handleEphemeralSocketUpdate({
            ...params,
            update: {
                type: 'transcript-stream-segment-delta',
                sessionId,
                message: {
                    localId: 'segment-1',
                    messageRole: 'agent',
                    tick: 2,
                    baseLength: 5,
                    content: buildPlainTranscriptStreamSegmentContent(' world'),
                    createdAt: 1_000,
                    updatedAt: 1_040,
                },
            },
        });

        expect(applyMessages).toHaveBeenCalledTimes(2);
        expect(applyMessages.mock.calls[1]?.[1]).toEqual([
            expect.objectContaining({
                localId: 'segment-1',
                content: [expect.objectContaining({ type: 'text', text: 'Hello world' })],
            }),
        ]);

    });

    it('drops transcript stream segment deltas for sessions without a live transcript consumer', async () => {

        vi.useFakeTimers();
        const sessionId = 's-dispatch-delta-hidden';
        const applyMessages = vi.fn();
        const params = buildEphemeralParams({
            getSession: () => buildSession(sessionId, 'plain'),
            applyMessages,
        });

        await handleEphemeralSocketUpdate({
            ...params,
            update: {
                type: 'transcript-stream-segment-delta',
                sessionId,
                message: {
                    localId: 'segment-1',
                    messageRole: 'agent',
                    tick: 2,
                    baseLength: 5,
                    content: buildPlainTranscriptStreamSegmentContent(' world'),
                    createdAt: 1_000,
                    updatedAt: 1_040,
                },
            },
        });

        await vi.runAllTimersAsync();

        expect(applyMessages).not.toHaveBeenCalled();

    });

    it('shares empty canonical turn diff suppression across transcript stream segment updates', async () => {
        const sessionId = 'stream_empty_diff_session';
        const callId = 'stream-empty-diff-call';
        const applyMessages = vi.fn();
        markSessionSurfaceVisible(sessionId);
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildEmptyCanonicalTurnDiffCallContent(callId),
                'stream-empty-diff-call-message',
            ),
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        }));

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildEmptyCanonicalTurnDiffResultContent(callId),
                'stream-empty-diff-result-message',
            ),
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        }));

        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('drops off-screen transcript stream segment applies when the coalescing window flushes while hidden', async () => {
        vi.useFakeTimers();
        const sessionId = 'offscreen_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const applyMessages = vi.fn<(appliedSessionId: string, messages: NormalizedMessage[]) => void>();

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('off-screen live', 'segment-offscreen'),
                'segment-offscreen',
            ),
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        }));

        expect(applyMessages).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('drops hidden encrypted transcript stream segments at flush time without decrypting', async () => {
        vi.useFakeTimers();
        const sessionId = 'hidden_encrypted_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'e2ee')]);

        const decryptPayloads = vi.fn(async () => [
            decryptPayloads.mock.calls.length === 1
                ? buildRawTranscriptStreamSegmentRecord('hidden encrypted live', 'segment-hidden-encrypted')
                : buildRawTranscriptStreamSegmentRecord('visible encrypted live', 'segment-visible-encrypted'),
        ]);
        const sessionEncryption = new SessionEncryption(
            sessionId,
            {
                encrypt: async () => [],
                decrypt: decryptPayloads,
            },
            new EncryptionCache(),
        );
        const applyMessages = vi.fn<(appliedSessionId: string, messages: NormalizedMessage[]) => void>();
        const baseParams = buildEphemeralParams({
            getSessionEncryption: () => sessionEncryption,
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        });

        await handleEphemeralSocketUpdate({
            ...baseParams,
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                { t: 'encrypted', c: 'AA==' },
                'segment-hidden-encrypted',
            ),
        });

        expect(decryptPayloads).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(decryptPayloads).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('applies transcript stream segments immediately when the queued session becomes visible', async () => {
        vi.useFakeTimers();
        const sessionId = 'promoted_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const applyMessages = vi.fn<(appliedSessionId: string, messages: NormalizedMessage[]) => void>();
        const baseParams = buildEphemeralParams({
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        });

        await handleEphemeralSocketUpdate({
            ...baseParams,
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('queued while hidden', 'segment-hidden'),
                'segment-hidden',
            ),
        });

        expect(applyMessages).not.toHaveBeenCalled();

        markSessionSurfaceVisible(sessionId);

        await handleEphemeralSocketUpdate({
            ...baseParams,
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('visible live', 'segment-visible'),
                'segment-visible',
            ),
        });

        expect(applyMessages).toHaveBeenCalledTimes(2);
        expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            localId: 'segment-hidden',
            content: [{ type: 'text', text: 'queued while hidden' }],
        });
        expect(applyMessages.mock.calls[1]?.[1]?.[0]).toMatchObject({
            localId: 'segment-visible',
            content: [{ type: 'text', text: 'visible live' }],
        });

        await vi.runAllTimersAsync();

        expect(applyMessages).toHaveBeenCalledTimes(2);
    });

    it('coalesces stream segment applies behind an in-flight durable message window', async () => {
        vi.useFakeTimers();
        const sessionId = 'coalesced_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        markSessionSurfaceVisible(sessionId);
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const applyMessages = vi.fn<(appliedSessionId: string, messages: NormalizedMessage[]) => void>();
        const markSessionMaterializedMaxSeq = vi.fn();
        const baseParams = buildBaseParams({
            applyMessages,
            isSessionMessagesLoaded: vi.fn(() => true),
            markSessionMaterializedMaxSeq,
        });

        await handleUpdateContainer({
            ...baseParams,
            updateData: {
                id: 'durable_update_1',
                seq: 10,
                createdAt: 1_000,
                body: {
                    t: 'new-message',
                    sid: sessionId,
                    message: {
                        id: 'durable-message-1',
                        seq: 2,
                        localId: null,
                        createdAt: 1_000,
                        updatedAt: 1_000,
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'durable' } } },
                    },
                },
            } as ApiUpdateContainer,
        });

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith(sessionId, 2);

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: buildTranscriptStreamSegmentUpdate(sessionId, {
                t: 'plain',
                v: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'codex',
                        data: { type: 'message', message: 'live' },
                    },
                    meta: {
                        happierStreamSegmentV1: {
                            v: 1,
                            segmentKind: 'assistant',
                            segmentLocalId: 'segment-1',
                            segmentState: 'streaming',
                            updatedAtMs: 1_010,
                        },
                    },
                },
            }),
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        }));

        expect(applyMessages).toHaveBeenCalledTimes(1);

        await vi.runAllTimersAsync();

        expect(applyMessages).toHaveBeenCalledTimes(2);
        expect(applyMessages.mock.calls[1]?.[1]?.[0]).toMatchObject({
            localId: 'segment-1',
            role: 'agent',
            content: [{ type: 'text', text: 'live' }],
        });
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith(sessionId, 2);
    });

});

describe('socket update handling: external-session transcript invalidations', () => {
    it('forwards only the content-free qualified invalidation', async () => {
        const updateExternalSessionTranscript = vi.fn();

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: {
                v: 1,
                type: 'external-session-transcript-invalidated',
                binding: {
                    v: 1,
                    machineId: 'm1',
                    sessionId: 's1',
                    link: { generation: 'link-1', remoteSessionId: 'remote-1' },
                    source: {
                        qualifiedIdentity: {
                            v: 1,
                            agent: { pluginId: 'happier.claude', localId: 'claude' },
                            source: { kind: 'claudeConfig', contractVersion: 1 },
                        },
                        generation: 'source-1',
                    },
                    sourceCustody: { kind: 'development', registeredRootId: 'contribution-1' },
                    cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
                },
            },
            updateExternalSessionTranscript,
        }));

        expect(updateExternalSessionTranscript).toHaveBeenCalledTimes(1);
        expect(updateExternalSessionTranscript).toHaveBeenCalledWith(expect.objectContaining({
            type: 'external-session-transcript-invalidated',
            binding: expect.objectContaining({ sessionId: 's1' }),
        }));
    });

    it('ignores stale legacy direct-session transcript ephemeral names', async () => {
        const updateExternalSessionTranscript = vi.fn();

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: {
                type: 'direct-session-transcript-updated',
                sessionId: 's1',
                items: [],
            },
            updateExternalSessionTranscript,
        }));

        expect(updateExternalSessionTranscript).not.toHaveBeenCalled();
    });
});

describe('flushMachineActivityUpdates', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('patches known liveness without reading content or republishing unrelated Machine inputs', () => {
        const sourceServerId = getActiveServerSnapshot().serverId;
        const now = Date.now();
        storage.getState().applyMachines(Array.from({ length: 137 }, (_, index) =>
            createMachineFixture({ id: `activity-${index}`, activeAt: now })), true, { sourceServerId });
        const before = storage.getState();
        const row = before.machines['activity-0'];
        const metadata = row.metadata;
        const metadataRead = vi.fn(() => metadata);
        Object.defineProperty(row, 'metadata', { configurable: true, enumerable: true, get: metadataRead });
        const notify = vi.fn();
        const stop = storage.subscribe(notify);
        try {
            for (let index = 1; index <= 20; index++) flushMachineActivityUpdates({
                updates: new Map([[row.id, { id: row.id, active: true, activeAt: now + index }]]),
                sourceServerId,
            });
            expect(row.activeAt).toBe(now);
            expect(readMachineActivity(row).activeAt).toBe(now + 20);
            expect(storage.getState()).toBe(before);
            expect(notify).not.toHaveBeenCalled();
            expect(metadataRead).not.toHaveBeenCalled();
        } finally { stop(); Object.defineProperty(row, 'metadata', { configurable: true, enumerable: true, writable: true, value: metadata }); }
    });

    it('applies a placeholder machine so active status is not dropped', () => {
        const updates = new Map<string, { id: string; active: boolean; activeAt: number }>([
            ['m_unknown', { id: 'm_unknown', active: true, activeAt: 999 }],
        ]);
        flushMachineActivityUpdates({ updates });
        const machine = storage.getState().machines['m_unknown'] as Machine | undefined;
        expect(machine).toBeTruthy();
        expect(machine?.active).toBe(true);
        expect(machine?.activeAt).toBe(999);
    });

    it('keeps same-id Machine content and liveness isolated between Homes and ignores older arrivals', () => {
        const activeHome = getActiveServerSnapshot().serverId;
        const otherHome = 'machine-activity-other-home';
        const now = Date.now();
        const one = createMachineFixture({ id: 'same-id', activeAt: now });
        const other = createMachineFixture({ id: 'same-id', activeAt: now,
            metadata: { ...one.metadata!, host: 'another computer' } });
        storage.getState().applyMachines([one], true, { sourceServerId: activeHome });
        storage.getState().applyMachines([other], true, { sourceServerId: otherHome });
        for (const [active, activeAt] of [[true, now + 2], [false, now + 1]] as const) flushMachineActivityUpdates({
            updates: new Map([['same-id', { id: 'same-id', active, activeAt }]]), sourceServerId: otherHome,
        });
        expect(storage.getState().machines['same-id']).toBe(one);
        expect(one.activeAt).toBe(now);
        const foreign = storage.getState().machineListByServerId[otherHome]![0];
        expect(foreign).toMatchObject({ active: true, activeAt: now, metadata: { host: 'another computer' } });
        expect(readMachineActivity(foreign).activeAt).toBe(now + 2);
    });

    it('publishes an unknown Machine only in its source Home', () => {
        const updates = new Map<string, { id: string; active: boolean; activeAt: number }>([
            ['m_scoped', { id: 'm_scoped', active: true, activeAt: 999 }],
        ]);
        flushMachineActivityUpdates({ updates, sourceServerId: 'server-a' });
        expect(storage.getState().machineListByServerId['server-a']?.find(machine => machine.id === 'm_scoped'))
            .toMatchObject({ id: 'm_scoped', active: true, activeAt: 999 });
        expect(storage.getState().machines.m_scoped).toBeUndefined();
    });
});
