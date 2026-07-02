import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64, encrypt } from '@/api/encryption';
import { materializeNextPendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import {
    buildProviderAccountUsageRecordId,
    type ConnectedServiceBindingsV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type { TrackedSession } from '../types';
import type { SessionConnectedServiceAuthSwitchResult } from '../connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';
import { startDaemonControlServer } from '../controlServer';
import { resolveConnectedServiceMaterializedRootDir } from '../connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';

const connectedServiceMaterializationIdentity = {
    v: 1,
    id: 'csm_stable_switch',
    createdAt: 111,
} as const;

const createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock = vi.hoisted(() => vi.fn((params: unknown) => ({
    __testParams: params,
})));
const handleConnectedServiceRuntimeAuthFailureForSessionMock = vi.hoisted(() => vi.fn<(_input: unknown) => Promise<unknown>>(async (_input) => ({
    handled: false,
    reason: 'unhandled',
})));
const dispatchActivityNotificationAsyncMock = vi.hoisted(() => vi.fn(async () => ({
    sent: true,
    deliveries: [],
})));
const getActiveAccountSettingsSnapshotMock = vi.hoisted(() => vi.fn(() => ({
    settings: null,
    settingsSecretsReadKeys: [],
})));
type FetchSessionByIdCompatMockResult = {
    id: string;
    metadata: string;
    metadataVersion: number;
    encryptionMode: string;
} | null;
const fetchSessionByIdMock = vi.hoisted(() => vi.fn(async () => ({
    id: 'sess-runtime',
    encryptionMode: 'plain',
})));
const fetchSessionByIdCompatMock = vi.hoisted(() => vi.fn<() => Promise<FetchSessionByIdCompatMockResult>>(async () => ({
    id: 'sess-gemini-connected',
    metadata: '{}',
    metadataVersion: 1,
    encryptionMode: 'plain',
})));
const updateSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn(async ({ updater }: {
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
}) => ({
    version: 2,
    metadata: updater({}),
})));
const commitSessionStoredMessageMock = vi.hoisted(() => vi.fn(async () => ({
    didWrite: true,
    messageId: 'msg-runtime-switch',
    seq: 1,
    createdAt: 1_000,
})));
const commitRuntimeAuthRecoverySessionEventMock = vi.hoisted(() => vi.fn(async () => {}));
const requestConnectedServiceSessionRestartSignalMock = vi.hoisted(() => vi.fn(async () => {}));
const drainRuntimeAuthFailureReportOutboxToDaemonMock = vi.hoisted(() => vi.fn(async () => ({
    delivered: 0,
    retried: 0,
    dropped: 0,
})));
const clearRuntimeAuthFailureReportOutboxForSupersessionMock = vi.hoisted(() => vi.fn(async () => {}));
const recoveryIntentFileStoresMock = vi.hoisted(() => ({
    storesByPath: new Map<string, Map<string, unknown>>(),
}));
const applyConnectedServiceAuthGenerationToTrackedSessionMock = vi.hoisted(() => vi.fn<() => Promise<SessionConnectedServiceAuthSwitchResult>>(async () => ({
    ok: true,
    action: 'hot_applied',
    normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
            'openai-codex': {
                source: 'connected',
                selection: 'group',
                groupId: 'codex-main',
                profileId: 'backup',
            },
        },
    },
    continuityByServiceId: { 'openai-codex': 'hot_apply' },
    warnings: [],
})));
const refreshAccountSettingsForMinimumVersionMock = vi.hoisted(() => vi.fn(async () => ({
    source: 'network',
    settings: { schemaVersion: 2 },
    settingsVersion: 42,
    loadedAtMs: 1_000,
    settingsSecretsReadKeys: [],
})));
const resolveConnectedServiceSwitchContinuityMock = vi.hoisted(() => vi.fn());

function resetFetchSessionByIdCompatMock(): void {
    fetchSessionByIdCompatMock.mockReset();
    fetchSessionByIdCompatMock.mockImplementation(async () => ({
        id: 'sess-gemini-connected',
        metadata: '{}',
        metadataVersion: 1,
        encryptionMode: 'plain',
    }));
}

vi.mock('@/configuration', () => ({
    configuration: {
        daemonSpawnExistingSessionWaitForExitMs: 0,
        daemonSpawnExistingSessionWaitForExitPollIntervalMs: 50,
        daemonStopSessionWaitForExitMs: 0,
        daemonStopSessionWaitForExitPollIntervalMs: 50,
        happyHomeDir: '/tmp/happier-test-home',
        activeServerDir: '/tmp/happier-test-home/servers/default',
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('@/api/session/pendingQueueV2Transport', () => ({
    materializeNextPendingQueueV2MessageViaHttp: vi.fn(async () => ({
        didMaterialize: false,
        localId: null,
        didWrite: false,
        pendingQueueState: null,
        message: null,
    })),
}));

vi.mock('../controlServer', () => ({
    startDaemonControlServer: vi.fn(async () => ({
        port: 43210,
        stop: vi.fn(async () => {}),
    })),
}));

vi.mock('./executeSpawnSessionRequest', () => ({
    executeSpawnSessionRequest: vi.fn(async () => ({
        type: 'success',
        sessionId: 'spawned-session',
    })),
}));

vi.mock('@/backends/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/backends/catalog')>();
    resolveConnectedServiceSwitchContinuityMock.mockImplementation(actual.resolveConnectedServiceSwitchContinuity);
    return {
        ...actual,
        resolveConnectedServiceSwitchContinuity: resolveConnectedServiceSwitchContinuityMock,
    };
});

vi.mock('../connectedServices/runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator', () => ({
    createDaemonConnectedServiceAuthGroupSwitchCoordinator: createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock,
}));

vi.mock('../connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession', () => ({
    handleConnectedServiceRuntimeAuthFailureForSession: handleConnectedServiceRuntimeAuthFailureForSessionMock,
}));

vi.mock('../connectedServices/runtimeAuth/commitConnectedServiceRuntimeAuthRecoverySessionEvent', () => ({
    commitConnectedServiceRuntimeAuthRecoverySessionEvent: commitRuntimeAuthRecoverySessionEventMock,
}));

vi.mock('../connectedServices/recoveryScheduler/recoveryIntentFileStore', () => ({
    createRecoveryIntentFileStore: vi.fn((path: string) => {
        const store = recoveryIntentFileStoresMock.storesByPath.get(path) ?? new Map<string, unknown>();
        recoveryIntentFileStoresMock.storesByPath.set(path, store);
        return {
            read: (sessionId: string) => store.get(sessionId) ?? null,
            readAll: () => [...store.entries()],
            write: (sessionId: string, intent: unknown) => {
                store.set(sessionId, intent);
            },
            remove: (sessionId: string) => {
                store.delete(sessionId);
            },
        };
    }),
}));

vi.mock('../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal', () => ({
    requestConnectedServiceSessionRestartSignal: requestConnectedServiceSessionRestartSignalMock,
}));

vi.mock('../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutboxDrain', () => ({
    drainRuntimeAuthFailureReportOutboxToDaemon: drainRuntimeAuthFailureReportOutboxToDaemonMock,
}));

vi.mock('../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutboxSupersession', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutboxSupersession')>();
    return {
        ...actual,
        clearRuntimeAuthFailureReportOutboxForSupersession: clearRuntimeAuthFailureReportOutboxForSupersessionMock,
    };
});

vi.mock('../connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth')>();
    return {
        ...actual,
        applyConnectedServiceAuthGenerationToTrackedSession: applyConnectedServiceAuthGenerationToTrackedSessionMock,
    };
});

vi.mock('@/notifications/activity/dispatchActivityNotification', () => ({
    dispatchActivityNotificationAsync: dispatchActivityNotificationAsyncMock,
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
    getActiveAccountSettingsSnapshot: getActiveAccountSettingsSnapshotMock,
}));

vi.mock('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion', () => ({
    refreshAccountSettingsForMinimumVersion: refreshAccountSettingsForMinimumVersionMock,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
    fetchSessionById: fetchSessionByIdMock,
    fetchSessionByIdCompat: fetchSessionByIdCompatMock,
    commitSessionStoredMessage: commitSessionStoredMessageMock,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
    updateSessionMetadataWithRetry: updateSessionMetadataWithRetryMock,
}));

describe('startDaemonSessionControlRuntime', () => {
    function readStartDaemonSessionControlRuntimeSource(): string {
        return readFileSync(new URL('./startDaemonSessionControlRuntime.ts', import.meta.url), 'utf8');
    }

    beforeEach(() => {
        recoveryIntentFileStoresMock.storesByPath.clear();
        drainRuntimeAuthFailureReportOutboxToDaemonMock.mockClear();
        clearRuntimeAuthFailureReportOutboxForSupersessionMock.mockClear();
        vi.mocked(startDaemonControlServer).mockClear();
        vi.mocked(executeSpawnSessionRequest).mockClear();
        vi.mocked(materializeNextPendingQueueV2MessageViaHttp).mockReset();
        vi.mocked(materializeNextPendingQueueV2MessageViaHttp).mockImplementation(async () => ({
            didMaterialize: false,
            localId: null,
            didWrite: false,
            pendingQueueState: null,
            message: null,
        }));
        createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mockClear();
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        dispatchActivityNotificationAsyncMock.mockClear();
        fetchSessionByIdMock.mockReset();
        fetchSessionByIdMock.mockImplementation(async () => ({
            id: 'sess-runtime',
            encryptionMode: 'plain',
        }));
        resetFetchSessionByIdCompatMock();
        updateSessionMetadataWithRetryMock.mockReset();
        updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: {
            updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
        }) => ({
            version: 2,
            metadata: updater({}),
        }));
        commitSessionStoredMessageMock.mockClear();
        commitRuntimeAuthRecoverySessionEventMock.mockClear();
        requestConnectedServiceSessionRestartSignalMock.mockReset();
        requestConnectedServiceSessionRestartSignalMock.mockImplementation(async () => {});
        applyConnectedServiceAuthGenerationToTrackedSessionMock.mockReset();
        applyConnectedServiceAuthGenerationToTrackedSessionMock.mockImplementation(async () => ({
            ok: true,
            action: 'hot_applied',
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'codex-main',
                        profileId: 'backup',
                    },
                },
            },
            continuityByServiceId: { 'openai-codex': 'hot_apply' },
            warnings: [],
        }));
        refreshAccountSettingsForMinimumVersionMock.mockReset();
        refreshAccountSettingsForMinimumVersionMock.mockImplementation(async () => ({
            source: 'network',
            settings: { schemaVersion: 2 },
            settingsVersion: 42,
            loadedAtMs: 1_000,
            settingsSecretsReadKeys: [],
        }));
        getActiveAccountSettingsSnapshotMock.mockReset();
        getActiveAccountSettingsSnapshotMock.mockImplementation(() => ({
            settings: null,
            settingsSecretsReadKeys: [],
        }));
        resolveConnectedServiceSwitchContinuityMock.mockClear();
    });

    it('summarizes managed-server claims through catalog descriptors instead of OpenCode host branches', () => {
        const source = readStartDaemonSessionControlRuntimeSource();
        expect(source).toMatch(/listManagedServerClaimDescriptors/);
        expect(source).not.toMatch(/OpenCodeManagedServerClaimSnapshot/);
        expect(source).not.toMatch(/isTrackedOpenCodeSession/);
        expect(source).not.toMatch(/opencode/);
        expect(source).not.toMatch(/HAPPIER_OPENCODE_SERVER_STATE_PATH/);
    });

    it('registers canonical provider account usage snapshots through daemon control startup wiring', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const registerProviderAccountUsageSnapshotPlain = vi.fn(async () => {});
        const recordKey = {
            providerId: 'claude',
            accountSubjectId: 'acct_123',
            subjectKind: 'account',
            quotaScope: 'account',
        } as const;
        const snapshot: ProviderAccountUsageSnapshotV1 = {
            v: 1,
            recordId: buildProviderAccountUsageRecordId(recordKey),
            recordKey,
            providerId: 'claude',
            accountSubject: { kind: 'providerSubject', id: 'acct_123' },
            aliases: [],
            observedAtMs: 1_000,
            fetchedAtMs: 1_000,
            staleAfterMs: 60_000,
            source: 'runtimeSignal',
            confidence: 'confirmed',
            state: 'loaded_data',
            planLabel: 'Pro',
            accountLabel: null,
            meters: [],
        };

        await startDaemonSessionControlRuntime({
            machineId: 'machine-usage',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getAccountEncryptionMode: vi.fn(async () => 'plain'),
                registerProviderAccountUsageSnapshotPlain,
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map<number, TrackedSession>([
                [1234, { startedBy: 'daemon', pid: 1234, happySessionId: 'sess_usage' }],
            ]),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        expect(controlServerInput?.handleProviderAccountUsageSnapshot).toEqual(expect.any(Function));
        await expect(controlServerInput?.handleProviderAccountUsageSnapshot?.({
            sessionId: 'sess_usage',
            snapshot,
        })).resolves.toEqual({
            status: 'recorded',
            recordId: snapshot.recordId,
            persisted: true,
        });
        for (let attempt = 0; attempt < 20 && registerProviderAccountUsageSnapshotPlain.mock.calls.length === 0; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
            recordId: snapshot.recordId,
            content: {
                t: 'plain',
                v: expect.objectContaining({
                    recordId: snapshot.recordId,
                    aliases: expect.arrayContaining([
                        expect.objectContaining({
                            kind: 'runtimeSession',
                            providerId: 'claude',
                            sessionId: 'sess_usage',
                            accountSubjectId: 'acct_123',
                        }),
                    ]),
                }),
            },
        }));
    });

    it('wires daemon local-service inventory routes into the control server', async () => {
        vi.mocked(startDaemonControlServer).mockClear();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-local-services',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {
                HAPPIER_FEATURE_LOCAL_SERVICES__ENABLED: '1',
                HAPPIER_FEATURE_LOCAL_SERVICES_INVENTORY__ENABLED: '1',
            },
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        expect(controlServerInput?.localServicesInventory).toEqual(expect.objectContaining({
            getSnapshot: expect.any(Function),
            refreshSnapshot: expect.any(Function),
            patchLabel: expect.any(Function),
        }));

        await runtime.stopControlServer();
    });

    it('builds a predictive soft-switch guard that suppresses restart-only Claude sessions while keeping Codex eligible', async () => {
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-soft-switch-guard',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        await expect(runtime.connectedServiceRecoverySwitchGuard({
            sessionId: 'session-claude',
            serviceId: 'claude-subscription',
            groupId: 'claude-team',
            activeProfileId: 'batiplus',
            agentId: 'claude',
            reason: 'soft_threshold',
        })).resolves.toEqual({
            status: 'suppress',
            reason: 'predictive_soft_switch_restart_required',
        });

        await expect(runtime.connectedServiceRecoverySwitchGuard({
            sessionId: 'session-codex',
            serviceId: 'openai-codex',
            groupId: 'codex-team',
            activeProfileId: 'codex4',
            agentId: 'codex',
            reason: 'soft_threshold',
        })).resolves.toEqual({ status: 'allow' });

        await runtime.stopControlServer();
    });

    it('forces respawn for connected-service restart-request exits before clearing the restart marker', async () => {
        vi.mocked(executeSpawnSessionRequest).mockClear();
        const connectedServicesRestartRequestedPids = new Set<number>([9999]);
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                9999,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-connected-service-restart',
                    pid: 9999,
                    spawnOptions: {
                        directory: '/tmp/project',
                        backendTarget: { kind: 'backend', backendId: 'gemini', sourceKind: 'built_in' },
                        connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
                        connectedServices: {
                            v: 1,
                            bindingsByServiceId: {
                                gemini: { source: 'connected', selection: 'profile', profileId: 'gemini-backup' },
                            },
                        },
                    },
                },
            ],
        ]);

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession,
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids,
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {
                HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: 'false',
                HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS: '50',
                HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS: '0',
            },
        });

        runtime.onChildExited(9999, { reason: 'process-exited', code: null, signal: 'SIGTERM' });
        expect(connectedServicesRestartRequestedPids.has(9999)).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 75));

        expect(executeSpawnSessionRequest).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                existingSessionId: 'sess-connected-service-restart',
                backendTarget: { kind: 'backend', backendId: 'gemini', sourceKind: 'built_in' },
                connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        gemini: { source: 'connected', selection: 'profile', profileId: 'gemini-backup' },
                    },
                },
            }),
        }));

        vi.mocked(executeSpawnSessionRequest).mockClear();
        await runtime.stopControlServer();
    });

    it('transfers connected-service PID ownership when a live runner replaces its wrapper', async () => {
        const wrapperPid = 9997;
        const runnerPid = 9996;
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                wrapperPid,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-wrapper-promotion',
                    pid: wrapperPid,
                    sessionRunnerPid: runnerPid,
                    spawnOptions: {
                        directory: '/tmp/project',
                        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                    },
                },
            ],
        ]);
        const connectedServicesRestartRequestedPids = new Set<number>([wrapperPid]);
        const refreshCoordinator = {
            transferPid: vi.fn(),
            unregisterPid: vi.fn(),
        };
        const quotasCoordinator = {
            transferPid: vi.fn(),
            unregisterPid: vi.fn(),
        };
        const originalKill = process.kill.bind(process);
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
            if (targetPid === runnerPid && signal === 0) {
                return true;
            }
            return originalKill(targetPid, signal as any);
        }) as any);

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => refreshCoordinator as never,
            getConnectedServiceQuotasCoordinator: () => quotasCoordinator as never,
            pidToTrackedSession,
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids,
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        runtime.onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

        expect(refreshCoordinator.transferPid).toHaveBeenCalledWith(wrapperPid, runnerPid);
        expect(quotasCoordinator.transferPid).toHaveBeenCalledWith(wrapperPid, runnerPid);
        expect(refreshCoordinator.unregisterPid).toHaveBeenCalledWith(wrapperPid);
        expect(quotasCoordinator.unregisterPid).toHaveBeenCalledWith(wrapperPid);
        expect(refreshCoordinator.transferPid.mock.invocationCallOrder[0]).toBeLessThan(
            refreshCoordinator.unregisterPid.mock.invocationCallOrder[0],
        );
        expect(quotasCoordinator.transferPid.mock.invocationCallOrder[0]).toBeLessThan(
            quotasCoordinator.unregisterPid.mock.invocationCallOrder[0],
        );
        expect(connectedServicesRestartRequestedPids.has(wrapperPid)).toBe(false);
        expect(connectedServicesRestartRequestedPids.has(runnerPid)).toBe(true);
        expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
        expect(pidToTrackedSession.get(runnerPid)).toEqual(expect.objectContaining({
            happySessionId: 'sess-wrapper-promotion',
            pid: runnerPid,
        }));

        killSpy.mockRestore();
        await runtime.stopControlServer();
    });

    it('wires the Codex ChatGPT refresh bridge through the daemon control server', async () => {
        const refreshOpenAiCodexChatGptTokensForBridge = vi.fn(async () => ({
            accessToken: 'fresh-access',
            chatgptAccountId: 'acct_123',
            chatgptPlanType: 'plus',
        }));

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => ({
                refreshOpenAiCodexChatGptTokensForBridge,
            }) as never,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await expect(controlServerInput?.handleCodexChatGptAuthTokensRefresh?.({
            sessionId: 'sess_1',
            selection: {
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'codex-profile',
            },
            chatgptPlanType: 'plus',
        })).resolves.toEqual({
            accessToken: 'fresh-access',
            chatgptAccountId: 'acct_123',
            chatgptPlanType: 'plus',
        });
        expect(refreshOpenAiCodexChatGptTokensForBridge).toHaveBeenCalledWith({
            selection: {
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'codex-profile',
            },
            chatgptPlanType: 'plus',
        });
    });

    it('drains pending runtime-auth failure reports after the control server starts', async () => {
        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        expect(drainRuntimeAuthFailureReportOutboxToDaemonMock).toHaveBeenCalledOnce();
    });

    it('clears stale runtime-auth failure reports when a turn is cancelled', async () => {
        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });
        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];

        await controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-cancelled',
            event: 'turn_cancelled',
        });

        expect(clearRuntimeAuthFailureReportOutboxForSupersessionMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-cancelled',
            event: { kind: 'turn_lifecycle', event: 'turn_cancelled' },
            removeForSession: expect.any(Function),
        }));
    });

    it('does not read session detail for continuation recovery when session-started metadata has no pending recovery', async () => {
        resetFetchSessionByIdCompatMock();
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                9999,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-ordinary-attach',
                    pid: 9999,
                    spawnOptions: {
                        directory: '/tmp/project',
                        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                    },
                },
            ],
        ]);

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession,
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        fetchSessionByIdCompatMock.mockClear();
        controlServerInput?.onHappySessionWebhook('sess-ordinary-attach', {
            path: '/tmp/project',
            host: 'host-1',
            homeDir: '/tmp/home',
            happyHomeDir: '/tmp/happier-test-home',
            happyLibDir: '/tmp/happier-lib',
            happyToolsDir: '/tmp/happier-tools',
            hostPid: 9999,
            startedBy: 'daemon',
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
    });

    it('repairs missing connected-service materialization identity only through provider-certified continuity and CAS metadata', async () => {
        vi.mocked(executeSpawnSessionRequest).mockClear();
        fetchSessionByIdCompatMock.mockClear();
        updateSessionMetadataWithRetryMock.mockClear();
        resolveConnectedServiceSwitchContinuityMock.mockClear();
        resolveConnectedServiceSwitchContinuityMock.mockResolvedValueOnce({ mode: 'restart_same_home' });

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        await runtime.spawnSession({
            directory: '/tmp/project',
            existingSessionId: 'sess-claude-repair',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        });

        const spawnRequest = vi.mocked(executeSpawnSessionRequest).mock.calls[0]?.[0];
        const repairMissingConnectedServiceMaterializationIdentityForSpawn =
            spawnRequest?.repairMissingConnectedServiceMaterializationIdentityForSpawn;
        expect(repairMissingConnectedServiceMaterializationIdentityForSpawn).toBeDefined();

        const connectedServices = {
            v: 1,
            bindingsByServiceId: {
                'claude-subscription': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'claude-work',
                },
            },
        } satisfies ConnectedServiceBindingsV1;
        const repairedIdentity = await repairMissingConnectedServiceMaterializationIdentityForSpawn?.({
            sessionId: 'sess-claude-repair',
            agentId: 'claude',
            connectedServices,
            vendorResumeId: 'claude-vendor-session-1',
        });

        expect(repairedIdentity).toEqual(expect.objectContaining({
            v: 1,
            id: expect.stringMatching(/^csm_/),
        }));
        expect(resolveConnectedServiceSwitchContinuityMock).toHaveBeenCalledWith('claude', expect.objectContaining({
            sessionId: 'sess-claude-repair',
            serviceId: 'claude-subscription',
            previousBinding: expect.objectContaining({
                source: 'connected',
                selection: 'profile',
                profileId: 'claude-work',
            }),
            nextBinding: expect.objectContaining({
                source: 'connected',
                selection: 'profile',
                profileId: 'claude-work',
            }),
            vendorResumeId: 'claude-vendor-session-1',
        }));
        expect(fetchSessionByIdCompatMock).toHaveBeenCalledWith({
            token: 'token-daemon',
            sessionId: 'sess-claude-repair',
        });
        expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledWith(expect.objectContaining({
            token: 'token-daemon',
            sessionId: 'sess-claude-repair',
        }));
        await expect(updateSessionMetadataWithRetryMock.mock.results[0]?.value).resolves.toEqual(expect.objectContaining({
            metadata: expect.objectContaining({
                connectedServices,
                connectedServicesUpdatedAt: expect.any(Number),
            }),
        }));

        vi.mocked(executeSpawnSessionRequest).mockClear();
        await runtime.stopControlServer();
    });

    it('applies persisted runtime state before connected-service restart respawn', async () => {
        vi.mocked(executeSpawnSessionRequest).mockClear();
        const rawSession = {
            id: 'sess-connected-service-runtime-refresh',
            encryptionMode: 'plain',
            metadata: JSON.stringify({
                flavor: 'claude',
                claudeSessionId: 'claude-fresh-thread',
                path: '/tmp/project',
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 500,
                sessionModeOverrideV1: { v: 1, updatedAt: 501, modeId: 'plan' },
                modelOverrideV1: { v: 1, updatedAt: 502, modelId: 'claude-opus-4-7' },
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'claude-subscription': {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'fresh-claude-profile',
                        },
                    },
                },
                connectedServicesUpdatedAt: 503,
            }),
            metadataVersion: 1,
        };
        fetchSessionByIdCompatMock
            .mockResolvedValueOnce(rawSession)
            .mockResolvedValueOnce(rawSession);
        const connectedServicesRestartRequestedPids = new Set<number>([9998]);
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                9998,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-connected-service-runtime-refresh',
                    pid: 9998,
                    vendorResumeId: 'claude-stale-thread',
                    spawnOptions: {
                        directory: '/tmp/project',
                        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                        existingSessionId: 'sess-connected-service-runtime-refresh',
                        resume: 'claude-stale-thread',
                        permissionMode: 'default',
                        permissionModeUpdatedAt: 100,
                        connectedServices: { v: 1, bindingsByServiceId: {} },
                    },
                },
            ],
        ]);

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession,
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids,
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {
                HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: 'false',
                HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS: '50',
                HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS: '0',
            },
        });

        runtime.onChildExited(9998, { reason: 'process-exited', code: null, signal: 'SIGTERM' });
        await new Promise((resolve) => setTimeout(resolve, 75));

        expect(executeSpawnSessionRequest).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                existingSessionId: 'sess-connected-service-runtime-refresh',
                resume: 'claude-fresh-thread',
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 500,
                agentModeId: 'plan',
                agentModeUpdatedAt: 501,
                modelId: 'claude-opus-4-7',
                modelUpdatedAt: 502,
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'claude-subscription': {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'fresh-claude-profile',
                        },
                    },
                },
            }),
        }));

        vi.mocked(executeSpawnSessionRequest).mockClear();
        await runtime.stopControlServer();
    });

    it('materializes pending queue with daemon credentials when an existing session is already active', async () => {
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                process.pid,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-live',
                    pid: process.pid,
                    spawnOptions: {
                        directory: '/tmp/project',
                        existingSessionId: 'sess-live',
                    },
                },
            ],
        ]);

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            // Test fixture boundary: existing-session short-circuit means API methods are not invoked.
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession,
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const optionsWithUnexpectedToken: SpawnSessionOptions & { token: string } = {
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            existingSessionId: 'sess-live',
            token: 'token-from-spawn-options',
        };

        await expect(runtime.spawnSession(optionsWithUnexpectedToken)).resolves.toEqual({
            type: 'success',
            sessionId: 'sess-live',
        });

        expect(materializeNextPendingQueueV2MessageViaHttp).toHaveBeenCalledWith({
            token: 'token-daemon',
            sessionId: 'sess-live',
        });
        expect(executeSpawnSessionRequest).not.toHaveBeenCalled();

        await runtime.stopControlServer();
    });

    it('applies persisted runtime state when an existing session is already active', async () => {
        const rawSession = {
            id: 'sess-live-runtime',
            encryptionMode: 'plain',
            metadata: JSON.stringify({
                flavor: 'codex',
                codexSessionId: 'codex-thread-fresh',
                path: '/tmp/project',
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 200,
                sessionModeOverrideV1: { v: 1, updatedAt: 201, modeId: 'plan' },
                modelOverrideV1: { v: 1, updatedAt: 202, modelId: 'gpt-5.1' },
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'fresh-profile',
                        },
                    },
                },
                connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
            }),
            metadataVersion: 1,
        };
        fetchSessionByIdCompatMock
            .mockResolvedValueOnce(rawSession)
            .mockResolvedValueOnce(rawSession);
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                process.pid,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-live-runtime',
                    pid: process.pid,
                    vendorResumeId: 'codex-thread-stale',
                    spawnOptions: {
                        directory: '/tmp/project',
                        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                        existingSessionId: 'sess-live-runtime',
                        permissionMode: 'default',
                        permissionModeUpdatedAt: 100,
                    },
                },
            ],
        ]);

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession,
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        await expect(runtime.spawnSession({
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            existingSessionId: 'sess-live-runtime',
            permissionMode: 'default',
            permissionModeUpdatedAt: 100,
        })).resolves.toEqual({
            type: 'success',
            sessionId: 'sess-live-runtime',
        });

        expect(pidToTrackedSession.get(process.pid)?.vendorResumeId).toBe('codex-thread-fresh');
        expect(pidToTrackedSession.get(process.pid)?.spawnOptions).toEqual(expect.objectContaining({
            existingSessionId: 'sess-live-runtime',
            resume: 'codex-thread-fresh',
            permissionMode: 'yolo',
            permissionModeUpdatedAt: 200,
            agentModeId: 'plan',
            agentModeUpdatedAt: 201,
            modelId: 'gpt-5.1',
            modelUpdatedAt: 202,
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'fresh-profile',
                    },
                },
            },
        }));
        expect(executeSpawnSessionRequest).not.toHaveBeenCalled();

        await runtime.stopControlServer();
    });

    it('wires connected-service runtime-auth and quota handlers into the control server', async () => {
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        fetchSessionByIdCompatMock.mockClear();
        fetchSessionByIdCompatMock.mockResolvedValueOnce({
            id: 'sess-runtime-inactive',
            encryptionMode: 'plain',
            metadata: JSON.stringify({
                flavor: 'codex',
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'codex-main',
                            profileId: 'primary',
                        },
                    },
                },
                connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
            }),
            metadataVersion: 3,
        });
        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getConnectedServiceAuthGroup: vi.fn(),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        expect(startDaemonControlServer).toHaveBeenLastCalledWith(expect.objectContaining({
            handleConnectedServiceRuntimeAuthFailure: expect.any(Function),
            runtimeAuthRecoveryScheduler: expect.objectContaining({
                enqueueHandlerFailure: expect.any(Function),
                enqueueApplyFailure: expect.any(Function),
                wake: expect.any(Function),
                cancel: expect.any(Function),
            }),
            handleConnectedServiceQuotaSnapshot: expect.any(Function),
        }));
        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        commitRuntimeAuthRecoverySessionEventMock.mockClear();
        const runtimeAuthRecoveryScheduler = controlServerInput?.runtimeAuthRecoveryScheduler as
            | {
                enqueueHandlerFailure: (input: {
                    sessionId: string;
                    switchesThisTurn: number;
                    classification: {
                        kind: 'usage_limit';
                        serviceId: string;
                        profileId: string | null;
                        groupId: string | null;
                        resetsAtMs: null;
                        retryAfterMs: null;
                        limitCategory: 'usage_limit';
                        quotaScope: 'account';
                        providerLimitId: string;
                        action: null;
                        planType: null;
                        rateLimits: null;
                        source: 'structured_provider_error';
                    };
                    error: unknown;
                }) => Promise<unknown>;
            }
            | undefined;
        await runtimeAuthRecoveryScheduler?.enqueueHandlerFailure({
            sessionId: 'sess-runtime-inactive',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                resetsAtMs: null,
                retryAfterMs: null,
                limitCategory: 'usage_limit',
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            error: new Error('timeout of 5000ms exceeded'),
        });
        await vi.waitFor(() => {
            expect(commitRuntimeAuthRecoverySessionEventMock).toHaveBeenCalledWith(expect.objectContaining({
                credentials: expect.objectContaining({ token: 'token-daemon' }),
                sessionId: 'sess-runtime-inactive',
                event: expect.objectContaining({
                    type: 'connected-service-runtime-auth-recovery',
                    status: 'retry_scheduled',
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'codex-main',
                    diagnostic: expect.objectContaining({
                        source: 'runtime_auth_recovery',
                        failurePhase: 'runtime_auth_recovery',
                    }),
                }),
            }));
        });
        await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-runtime-inactive',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: null,
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });
        const runtimeHandlerCall = handleConnectedServiceRuntimeAuthFailureForSessionMock.mock.calls.at(-1) as [unknown] | undefined;
        const runtimeHandlerInput = runtimeHandlerCall?.[0] as {
            resolveInactiveSession?: (input: { sessionId: string }) => Promise<unknown>;
        } | undefined;
        expect(runtimeHandlerInput?.resolveInactiveSession).toEqual(expect.any(Function));
        await expect(runtimeHandlerInput!.resolveInactiveSession!({
            sessionId: 'sess-runtime-inactive',
        })).resolves.toEqual({
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'codex-main',
                        profileId: 'primary',
                    },
                },
            },
            connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
        });
    });

    it('clears armed runtime-auth recovery intents when identity-matched provider activity arrives via turn lifecycle', async () => {
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        const boundaryAtMs = Date.now() - 1_000;
        const recoveryIdentity = {
            serviceId: 'openai-codex',
            selectionKind: 'group',
            groupId: 'codex-main',
            profileId: 'primary',
        } as const;
        fetchSessionByIdCompatMock.mockImplementation(async () => ({
            id: 'sess-activity-clear',
            encryptionMode: 'plain',
            metadata: JSON.stringify({
                sessionContinuationRecoveryV1: {
                    v: 1,
                    attemptsById: {
                        'attempt-1': {
                            v: 1,
                            attemptId: 'attempt-1',
                            status: 'awaiting_provider_activity',
                            failureAtMs: boundaryAtMs,
                            updatedAtMs: boundaryAtMs,
                            resumePromptMode: 'standard',
                            recoveryIdentity,
                            sentAtMs: boundaryAtMs,
                        },
                    },
                },
            }),
            metadataVersion: 3,
        }));
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-activity-clear',
            pid: 515_151,
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'codex-main',
                            profileId: 'primary',
                        },
                    },
                },
            },
        };

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getConnectedServiceAuthGroup: vi.fn(),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map([[tracked.pid, tracked]]),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        const runtimeAuthRecoveryScheduler = controlServerInput?.runtimeAuthRecoveryScheduler as
            | {
                enqueueHandlerFailure: (input: {
                    sessionId: string;
                    switchesThisTurn: number;
                    classification: {
                        kind: 'usage_limit';
                        serviceId: string;
                        profileId: string | null;
                        groupId: string | null;
                        resetsAtMs: null;
                        retryAfterMs: null;
                        limitCategory: 'usage_limit';
                        quotaScope: 'account';
                        providerLimitId: string;
                        action: null;
                        planType: null;
                        rateLimits: null;
                        source: 'structured_provider_error';
                    };
                    error: unknown;
                }) => Promise<unknown>;
                readForSession: (sessionId: string) => ReadonlyArray<{
                    status: string;
                    serviceId: string;
                    groupId: string | null;
                }>;
            }
            | undefined;
        await runtimeAuthRecoveryScheduler?.enqueueHandlerFailure({
            sessionId: 'sess-activity-clear',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                resetsAtMs: null,
                retryAfterMs: null,
                limitCategory: 'usage_limit',
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            error: new Error('timeout of 5000ms exceeded'),
        });
        expect(runtimeAuthRecoveryScheduler?.readForSession('sess-activity-clear')).toEqual([
            expect.objectContaining({
                status: 'waiting',
                serviceId: 'openai-codex',
                groupId: 'codex-main',
            }),
        ]);

        // Identity-matched provider activity after the recovery boundary is recovered
        // provider-outcome proof: the turn-lifecycle producer must clear the durable
        // runtime-auth intent without waiting for backoff exhaustion.
        await controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-activity-clear',
            event: 'assistant_message_end',
        });

        expect(runtimeAuthRecoveryScheduler?.readForSession('sess-activity-clear')).toEqual([]);
    });

    it('applies automatic auth-group generations through the shared session auth primitive', async () => {
        createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mockClear();
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        requestConnectedServiceSessionRestartSignalMock.mockClear();
        applyConnectedServiceAuthGenerationToTrackedSessionMock.mockClear();
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-runtime',
            pid: 4242,
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'codex-main',
                            profileId: 'primary',
                        },
                    },
                },
                connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
            },
        };

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getConnectedServiceAuthGroup: vi.fn(),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
                listConnectedServiceProfiles: vi.fn(),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map([[tracked.pid, tracked]]),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-runtime',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        const coordinatorInput = createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.at(-1)?.[0] as {
            restartSession?: (input: {
                serviceId: 'openai-codex';
                groupId: string;
                activeProfileId: string | null;
                generation: number;
            }) => Promise<void>;
        };
        await coordinatorInput.restartSession?.({
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'backup',
            generation: 4,
        });

        expect(applyConnectedServiceAuthGenerationToTrackedSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'automatic_runtime_failure',
            continueAfterRuntimeAuthSwitch: expect.any(Function),
            verifyProviderAccountAdoption: expect.any(Function),
            request: {
                sessionId: 'sess-runtime',
                agentId: 'codex',
                bindings: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'codex-main',
                            profileId: 'backup',
                        },
                    },
                },
                expectedGroupGenerationByServiceId: {
                    'openai-codex': 4,
                },
            },
        }));
        expect(requestConnectedServiceSessionRestartSignalMock).not.toHaveBeenCalled();
    });

    it('applies inactive auth-group generations through the shared session auth primitive', async () => {
        createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mockClear();
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        requestConnectedServiceSessionRestartSignalMock.mockClear();
        applyConnectedServiceAuthGenerationToTrackedSessionMock.mockClear();
        fetchSessionByIdCompatMock.mockReset();
        fetchSessionByIdCompatMock.mockResolvedValue({
            id: 'sess-runtime-inactive',
            encryptionMode: 'plain',
            metadata: JSON.stringify({
                flavor: 'codex',
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'codex-main',
                            profileId: 'primary',
                        },
                    },
                },
                connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
            }),
            metadataVersion: 3,
        });

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getConnectedServiceAuthGroup: vi.fn(),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
                listConnectedServiceProfiles: vi.fn(),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-runtime-inactive',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        const coordinatorInput = createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.at(-1)?.[0] as {
            restartSession?: (input: {
                serviceId: 'openai-codex';
                groupId: string;
                activeProfileId: string | null;
                generation: number;
            }) => Promise<unknown>;
        };
        await expect(coordinatorInput.restartSession?.({
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'backup',
            generation: 4,
        })).resolves.toMatchObject({ ok: true });

        expect(applyConnectedServiceAuthGenerationToTrackedSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'automatic_runtime_failure',
            request: {
                sessionId: 'sess-runtime-inactive',
                agentId: 'codex',
                bindings: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'codex-main',
                            profileId: 'backup',
                        },
                    },
                },
                expectedGroupGenerationByServiceId: {
                    'openai-codex': 4,
                },
            },
        }));
        expect(requestConnectedServiceSessionRestartSignalMock).not.toHaveBeenCalled();
    });

    it('passes active PI resume context from tracked spawn options into automatic switch continuity', async () => {
        createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mockClear();
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        applyConnectedServiceAuthGenerationToTrackedSessionMock.mockClear();
        resolveConnectedServiceSwitchContinuityMock.mockClear();
        const piSessionFile = '/tmp/connected-services/csm_stable_switch/pi/pi-agent-dir/sessions/--tmp-project--/2026-06-01T00-00-00-000Z_pi-session-1.jsonl';
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-pi-runtime',
            pid: 5151,
            spawnOptions: {
                directory: '/tmp/project',
                resume: piSessionFile,
                backendTarget: { kind: 'backend', backendId: 'pi', sourceKind: 'built_in' },
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'codex-main',
                            profileId: 'primary',
                        },
                    },
                },
                connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
            },
        };

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getConnectedServiceAuthGroup: vi.fn(),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
                listConnectedServiceProfiles: vi.fn(),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map([[tracked.pid, tracked]]),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-pi-runtime',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        const coordinatorInput = createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.at(-1)?.[0] as {
            restartSession?: (input: {
                serviceId: 'openai-codex';
                groupId: string;
                activeProfileId: string | null;
                generation: number;
            }) => Promise<void>;
        };
        await coordinatorInput.restartSession?.({
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'backup',
            generation: 4,
        });

        const applyCalls = applyConnectedServiceAuthGenerationToTrackedSessionMock.mock.calls as unknown as ReadonlyArray<readonly [{
            resolveContinuity: (input: unknown) => Promise<unknown>;
        }]>;
        const applyInput = applyCalls.at(-1)?.[0];
        expect(applyInput).toBeDefined();
        resolveConnectedServiceSwitchContinuityMock.mockResolvedValueOnce({ mode: 'restart_same_home' });
        await applyInput!.resolveContinuity({
            tracked,
            sessionId: 'sess-pi-runtime',
            agentId: 'pi',
            serviceId: 'openai-codex',
            previous: {
                source: 'connected',
                selection: 'group',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
            },
            next: {
                source: 'connected',
                selection: 'group',
                serviceId: 'openai-codex',
                profileId: 'backup',
                groupId: 'codex-main',
            },
            previousBindings: tracked.spawnOptions?.connectedServices,
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'codex-main',
                        profileId: 'backup',
                    },
                },
            },
            connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
            vendorResumeId: null,
        });

        expect(resolveConnectedServiceSwitchContinuityMock).toHaveBeenCalledWith('pi', expect.objectContaining({
            targetMaterializedRoot: resolveConnectedServiceMaterializedRootDir({
                baseDir: '/tmp/connected-services',
                agentId: 'pi',
                materializationKey: 'csm_stable_switch',
            }),
            vendorResumeId: piSessionFile,
            cwd: '/tmp/project',
            candidatePersistedSessionFile: piSessionFile,
        }));
    });

    it('returns typed automatic auth-group apply failures from the shared session auth primitive', async () => {
        createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mockClear();
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        requestConnectedServiceSessionRestartSignalMock.mockClear();
        const applyResult = {
            ok: false,
            errorCode: 'partial_applied_pending_reconciliation',
            diagnostics: {
                failurePhase: 'reconciliation',
                application: {
                    status: 'partial_applied_pending_reconciliation',
                    phase: 'hot_apply',
                    actor: 'runtime',
                    reason: 'automatic_runtime_failure',
                },
            },
        } as const;
        applyConnectedServiceAuthGenerationToTrackedSessionMock.mockClear();
        applyConnectedServiceAuthGenerationToTrackedSessionMock.mockResolvedValueOnce(applyResult);
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-runtime',
            pid: 4242,
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'codex-main',
                            profileId: 'primary',
                        },
                    },
                },
                connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
            },
        };

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getConnectedServiceAuthGroup: vi.fn(),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
                listConnectedServiceProfiles: vi.fn(),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map([[tracked.pid, tracked]]),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-runtime',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        const coordinatorInput = createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.at(-1)?.[0] as {
            restartSession?: (input: {
                serviceId: 'openai-codex';
                groupId: string;
                activeProfileId: string | null;
                generation: number;
            }) => Promise<unknown>;
        };
        await expect(coordinatorInput.restartSession?.({
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'backup',
            generation: 4,
        })).resolves.toEqual(applyResult);
        expect(requestConnectedServiceSessionRestartSignalMock).not.toHaveBeenCalled();
    });

    it('returns typed automatic auth-group apply failure when the tracked child is missing', async () => {
        createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mockClear();
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        requestConnectedServiceSessionRestartSignalMock.mockClear();
        applyConnectedServiceAuthGenerationToTrackedSessionMock.mockClear();
        fetchSessionByIdCompatMock.mockReset();
        fetchSessionByIdCompatMock.mockResolvedValue(null);

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getConnectedServiceAuthGroup: vi.fn(),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
                listConnectedServiceProfiles: vi.fn(),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-runtime',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        const coordinatorInput = createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.at(-1)?.[0] as {
            restartSession?: (input: {
                serviceId: 'openai-codex';
                groupId: string;
                activeProfileId: string | null;
                generation: number;
            }) => Promise<unknown>;
        };
        await expect(coordinatorInput.restartSession?.({
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'backup',
            generation: 4,
        })).resolves.toEqual({
            ok: false,
            errorCode: 'session_not_found',
            serviceId: 'openai-codex',
            diagnostics: { failurePhase: 'session_lookup' },
        });
        expect(applyConnectedServiceAuthGenerationToTrackedSessionMock).not.toHaveBeenCalled();
        expect(requestConnectedServiceSessionRestartSignalMock).not.toHaveBeenCalled();
    });

    it('returns typed automatic auth-group apply failure after deferred fallback restart signals at turn boundary', async () => {
        createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mockClear();
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        requestConnectedServiceSessionRestartSignalMock.mockClear();
        applyConnectedServiceAuthGenerationToTrackedSessionMock.mockClear();
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-runtime',
            pid: 4242,
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'primary',
                        },
                    },
                },
                connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
            },
        };

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getConnectedServiceAuthGroup: vi.fn(),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
                listConnectedServiceProfiles: vi.fn(),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map([[tracked.pid, tracked]]),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-runtime',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });
        await controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-runtime',
            event: 'prompt_or_steer',
        });

        const coordinatorInput = createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.at(-1)?.[0] as {
            restartSession?: (input: {
                serviceId: 'openai-codex';
                groupId: string;
                activeProfileId: string | null;
                generation: number;
            }) => Promise<unknown>;
        };
        const pendingRestart = coordinatorInput.restartSession?.({
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'backup',
            generation: 4,
        });
        expect(requestConnectedServiceSessionRestartSignalMock).not.toHaveBeenCalled();

        await controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-runtime',
            event: 'assistant_message_end',
        });
        await expect(pendingRestart).resolves.toEqual({
            ok: false,
            errorCode: 'generation_apply_not_confirmed',
            serviceId: 'openai-codex',
            diagnostics: { failurePhase: 'restart' },
        });
        expect(requestConnectedServiceSessionRestartSignalMock).toHaveBeenCalledOnce();
        expect(requestConnectedServiceSessionRestartSignalMock).toHaveBeenCalledWith(expect.objectContaining({
            restartDiagnostic: expect.objectContaining({
                trigger: 'automatic_group_switch',
                sessionId: 'sess-runtime',
                agentId: 'codex',
                serviceId: 'openai-codex',
                profileId: 'backup',
                groupId: 'codex-main',
                generation: 4,
                reason: 'usage_limit',
            }),
        }));
        expect(applyConnectedServiceAuthGenerationToTrackedSessionMock).not.toHaveBeenCalled();
    });

    it('arms live temporary-throttle retries through the startup scheduler recovery path', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(10_000));
        try {
            handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
            vi.mocked(executeSpawnSessionRequest).mockClear();
            vi.mocked(materializeNextPendingQueueV2MessageViaHttp).mockClear();
            fetchSessionByIdCompatMock.mockClear();
            const rawSession = {
                id: 'sess-temporary-throttle',
                encryptionMode: 'plain',
                metadata: JSON.stringify({
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-fresh',
                    path: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'codex-main',
                                profileId: 'primary',
                            },
                        },
                    },
                }),
                metadataVersion: 3,
            };
            fetchSessionByIdCompatMock
                .mockResolvedValueOnce(rawSession)
                .mockResolvedValueOnce(rawSession);
            let capturedTemporaryThrottleRecovery: null | {
                wake: (wakeInput: { sessionId: string; reason: 'timer' | 'manual' }) => Promise<{ status: string }>;
            } = null;
            handleConnectedServiceRuntimeAuthFailureForSessionMock.mockImplementationOnce(async (rawInput: unknown) => {
                const input = rawInput as {
                    temporaryThrottleRecovery?: {
                        enable: (armInput: {
                            sessionId: string;
                            serviceId: string;
                            profileId: string | null;
                            groupId: string | null;
                            issueFingerprint: string;
                            retryAfterMs?: number | null;
                            resetAtMs?: number | null;
                        }) => Promise<{
                            status: string;
                            nextRetryAtMs: number | null;
                            attemptCount: number;
                            maxAttempts?: number;
                        }>;
                        wake: (wakeInput: { sessionId: string; reason: 'timer' | 'manual' }) => Promise<{ status: string }>;
                    };
                };
                expect(input.temporaryThrottleRecovery).toBeDefined();
                capturedTemporaryThrottleRecovery = input.temporaryThrottleRecovery!;
                const recovery = await input.temporaryThrottleRecovery!.enable({
                    sessionId: 'sess-temporary-throttle',
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'codex-main',
                    issueFingerprint: 'temporary-throttle:openai-codex:codex-main:primary',
                    retryAfterMs: 1_000,
                    resetAtMs: null,
                });
                return {
                    status: 'temporary_retry_armed',
                    sessionId: 'sess-temporary-throttle',
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'codex-main',
                    attemptCount: recovery.attemptCount,
                    maxAttempts: recovery.maxAttempts ?? 0,
                    retryAfterMs: 1_000,
                    retryAtMs: recovery.nextRetryAtMs,
                    resetAtMs: null,
                    recovery,
                };
            });
            const pidToTrackedSession = new Map<number, TrackedSession>([
                [
                    999_999_123,
                    {
                        startedBy: 'daemon',
                        happySessionId: 'sess-temporary-throttle',
                        pid: 999_999_123,
                        vendorResumeId: 'codex-thread-stale',
                        spawnOptions: {
                            directory: '/tmp/project',
                            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                            existingSessionId: 'sess-temporary-throttle',
                            resume: 'codex-thread-stale',
                            connectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'group',
                                        groupId: 'codex-main',
                                        profileId: 'primary',
                                    },
                                },
                            },
                        },
                    },
                ],
            ]);

            const runtime = await startDaemonSessionControlRuntime({
                machineId: 'machine-1',
                credentials: {
                    token: 'token-daemon',
                    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
                },
                api: {
                    getConnectedServiceAuthGroup: vi.fn(),
                    updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
                } as never,
                loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
                connectedServicesMaterializationBaseDir: '/tmp/connected-services',
                getConnectedServiceRefreshCoordinator: () => null,
                getConnectedServiceQuotasCoordinator: () => null,
                pidToTrackedSession,
                pidToAwaiter: new Map(),
                pidToSpawnResultResolver: new Map(),
                pidToSpawnWebhookTimeout: new Map(),
                getApiMachineForSessions: () => null,
                spawnResourceCleanupByPid: new Map(),
                sessionAttachCleanupByPid: new Map(),
                connectedServicesRestartRequestedPids: new Set(),
                beforeShutdown: vi.fn(),
                onHappySessionWebhook: vi.fn(),
                requestShutdown: vi.fn(),
                processEnv: {},
            });

            const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
            await expect(controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
                sessionId: 'sess-temporary-throttle',
                switchesThisTurn: 0,
                classification: {
                    kind: 'temporary_throttle',
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'codex-main',
                    resetsAtMs: null,
                    retryAfterMs: null,
                    limitCategory: 'rate_limit',
                    quotaScope: 'provider',
                    providerLimitId: 'temporary_provider_throttle',
                    action: null,
                    planType: null,
                    rateLimits: null,
                    source: 'structured_provider_error',
                },
            })).resolves.toMatchObject({
                status: 'temporary_retry_armed',
                sessionId: 'sess-temporary-throttle',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                retryAtMs: 11_000,
            });

            expect(executeSpawnSessionRequest).not.toHaveBeenCalled();
            pidToTrackedSession.delete(999_999_123);
            expect(capturedTemporaryThrottleRecovery).not.toBeNull();
            await expect(capturedTemporaryThrottleRecovery!.wake({
                sessionId: 'sess-temporary-throttle',
                reason: 'manual',
            })).resolves.toEqual({ status: 'resumed' });
            expect(executeSpawnSessionRequest).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.objectContaining({
                    existingSessionId: 'sess-temporary-throttle',
                    resume: 'codex-thread-fresh',
                }),
            }));
            expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

            await runtime.stopControlServer();
        } finally {
            vi.useRealTimers();
            resetFetchSessionByIdCompatMock();
        }
    });

    it('hydrates durable temporary-throttle retries during startup', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(20_000));
        try {
            vi.mocked(executeSpawnSessionRequest).mockClear();
            vi.mocked(materializeNextPendingQueueV2MessageViaHttp).mockClear();
            fetchSessionByIdCompatMock.mockClear();
            const rawSession = {
                id: 'sess-temporary-throttle-hydrated',
                encryptionMode: 'plain',
                metadata: JSON.stringify({
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-hydrated-fresh',
                    path: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'codex-main',
                                profileId: 'primary',
                            },
                        },
                    },
                }),
                metadataVersion: 3,
            };
            fetchSessionByIdCompatMock.mockResolvedValue(rawSession);
            recoveryIntentFileStoresMock.storesByPath.set(
                '/tmp/happier-test-home/servers/default/connected-services/temporary-throttle-recovery.json',
                new Map([
                    ['sess-temporary-throttle-hydrated', {
                        v: 1,
                        sessionId: 'sess-temporary-throttle-hydrated',
                        serviceId: 'openai-codex',
                        profileId: 'primary',
                        groupId: 'codex-main',
                        status: 'waiting',
                        issueFingerprint: 'temporary-throttle:openai-codex:codex-main:primary',
                        armedAtMs: 19_000,
                        nextRetryAtMs: 21_000,
                        retryAfterMs: 2_000,
                        resetAtMs: null,
                        attemptCount: 0,
                        maxAttempts: 3,
                        lastError: null,
                    }],
                ]),
            );
            const pidToTrackedSession = new Map<number, TrackedSession>([
                [
                    999_999_124,
                    {
                        startedBy: 'daemon',
                        happySessionId: 'sess-temporary-throttle-hydrated',
                        pid: 999_999_124,
                        vendorResumeId: 'codex-thread-hydrated-stale',
                        spawnOptions: {
                            directory: '/tmp/project',
                            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                            existingSessionId: 'sess-temporary-throttle-hydrated',
                            resume: 'codex-thread-hydrated-stale',
                            connectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'group',
                                        groupId: 'codex-main',
                                        profileId: 'primary',
                                    },
                                },
                            },
                        },
                    },
                ],
            ]);

            const runtime = await startDaemonSessionControlRuntime({
                machineId: 'machine-1',
                credentials: {
                    token: 'token-daemon',
                    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
                },
                api: {
                    getConnectedServiceAuthGroup: vi.fn(),
                    updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
                } as never,
                loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
                connectedServicesMaterializationBaseDir: '/tmp/connected-services',
                getConnectedServiceRefreshCoordinator: () => null,
                getConnectedServiceQuotasCoordinator: () => null,
                pidToTrackedSession,
                pidToAwaiter: new Map(),
                pidToSpawnResultResolver: new Map(),
                pidToSpawnWebhookTimeout: new Map(),
                getApiMachineForSessions: () => null,
                spawnResourceCleanupByPid: new Map(),
                sessionAttachCleanupByPid: new Map(),
                connectedServicesRestartRequestedPids: new Set(),
                beforeShutdown: vi.fn(),
                onHappySessionWebhook: vi.fn(),
                requestShutdown: vi.fn(),
                processEnv: {},
            });

            await vi.advanceTimersByTimeAsync(999);
            expect(executeSpawnSessionRequest).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => {
                expect(executeSpawnSessionRequest).toHaveBeenCalledWith(expect.objectContaining({
                    options: expect.objectContaining({
                        existingSessionId: 'sess-temporary-throttle-hydrated',
                        resume: 'codex-thread-hydrated-fresh',
                    }),
                }));
            });
            expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

            await runtime.stopControlServer();
        } finally {
            vi.useRealTimers();
            resetFetchSessionByIdCompatMock();
        }
    });

    it('disposes hydrated temporary-throttle timers when the runtime control server stops', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(20_000));
        try {
            vi.mocked(executeSpawnSessionRequest).mockClear();
            fetchSessionByIdCompatMock.mockClear();
            fetchSessionByIdCompatMock.mockResolvedValue({
                id: 'sess-temporary-throttle-stop',
                encryptionMode: 'plain',
                metadata: JSON.stringify({
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-stop',
                    path: '/tmp/project',
                }),
                metadataVersion: 3,
            });
            recoveryIntentFileStoresMock.storesByPath.set(
                '/tmp/happier-test-home/servers/default/connected-services/temporary-throttle-recovery.json',
                new Map([
                    ['sess-temporary-throttle-stop', {
                        v: 1,
                        sessionId: 'sess-temporary-throttle-stop',
                        serviceId: 'openai-codex',
                        profileId: 'primary',
                        groupId: 'codex-main',
                        status: 'waiting',
                        issueFingerprint: 'temporary-throttle:openai-codex:codex-main:primary',
                        armedAtMs: 19_000,
                        nextRetryAtMs: 21_000,
                        retryAfterMs: 2_000,
                        resetAtMs: null,
                        attemptCount: 0,
                        maxAttempts: 3,
                        lastError: null,
                    }],
                ]),
            );

            const runtime = await startDaemonSessionControlRuntime({
                machineId: 'machine-1',
                credentials: {
                    token: 'token-daemon',
                    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
                },
                api: {} as never,
                loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
                connectedServicesMaterializationBaseDir: '/tmp/connected-services',
                getConnectedServiceRefreshCoordinator: () => null,
                getConnectedServiceQuotasCoordinator: () => null,
                pidToTrackedSession: new Map([
                    [
                        999_999_125,
                        {
                            startedBy: 'daemon',
                            happySessionId: 'sess-temporary-throttle-stop',
                            pid: 999_999_125,
                            vendorResumeId: 'codex-thread-stop-stale',
                            spawnOptions: {
                                directory: '/tmp/project',
                                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                                existingSessionId: 'sess-temporary-throttle-stop',
                                resume: 'codex-thread-stop-stale',
                            },
                        },
                    ],
                ]),
                pidToAwaiter: new Map(),
                pidToSpawnResultResolver: new Map(),
                pidToSpawnWebhookTimeout: new Map(),
                getApiMachineForSessions: () => null,
                spawnResourceCleanupByPid: new Map(),
                sessionAttachCleanupByPid: new Map(),
                connectedServicesRestartRequestedPids: new Set(),
                beforeShutdown: vi.fn(),
                onHappySessionWebhook: vi.fn(),
                requestShutdown: vi.fn(),
                processEnv: {},
            });

            await runtime.stopControlServer();
            await vi.advanceTimersByTimeAsync(5_000);

            expect(executeSpawnSessionRequest).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
            resetFetchSessionByIdCompatMock();
        }
    });

    it('resumes hydrated temporary-throttle retries from persisted metadata when the session is no longer tracked', async () => {
        // RD-REC-16 port: the throttle intent is durable but the in-memory resume snapshot is
        // not. After a daemon restart the hydrated intent must rebuild its resume source from
        // persisted session metadata instead of dead-lettering with
        // temporary_throttle_session_not_found.
        vi.useFakeTimers();
        vi.setSystemTime(new Date(20_000));
        try {
            vi.mocked(executeSpawnSessionRequest).mockClear();
            vi.mocked(materializeNextPendingQueueV2MessageViaHttp).mockClear();
            fetchSessionByIdCompatMock.mockClear();
            fetchSessionByIdCompatMock.mockResolvedValue({
                id: 'sess-temporary-throttle-inactive',
                encryptionMode: 'plain',
                metadata: JSON.stringify({
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-inactive-fresh',
                    path: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'codex-main',
                                profileId: 'primary',
                            },
                        },
                    },
                }),
                metadataVersion: 3,
            });
            recoveryIntentFileStoresMock.storesByPath.set(
                '/tmp/happier-test-home/servers/default/connected-services/temporary-throttle-recovery.json',
                new Map([
                    ['sess-temporary-throttle-inactive', {
                        v: 1,
                        sessionId: 'sess-temporary-throttle-inactive',
                        serviceId: 'openai-codex',
                        profileId: 'primary',
                        groupId: 'codex-main',
                        status: 'waiting',
                        issueFingerprint: 'temporary-throttle:openai-codex:codex-main:primary',
                        armedAtMs: 19_000,
                        nextRetryAtMs: 21_000,
                        retryAfterMs: 2_000,
                        resetAtMs: null,
                        attemptCount: 0,
                        maxAttempts: 3,
                        lastError: null,
                    }],
                ]),
            );

            const runtime = await startDaemonSessionControlRuntime({
                machineId: 'machine-1',
                credentials: {
                    token: 'token-daemon',
                    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
                },
                api: {
                    getConnectedServiceAuthGroup: vi.fn(),
                    updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
                } as never,
                loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
                connectedServicesMaterializationBaseDir: '/tmp/connected-services',
                getConnectedServiceRefreshCoordinator: () => null,
                getConnectedServiceQuotasCoordinator: () => null,
                pidToTrackedSession: new Map(),
                pidToAwaiter: new Map(),
                pidToSpawnResultResolver: new Map(),
                pidToSpawnWebhookTimeout: new Map(),
                getApiMachineForSessions: () => null,
                spawnResourceCleanupByPid: new Map(),
                sessionAttachCleanupByPid: new Map(),
                connectedServicesRestartRequestedPids: new Set(),
                beforeShutdown: vi.fn(),
                onHappySessionWebhook: vi.fn(),
                requestShutdown: vi.fn(),
                processEnv: {},
            });

            await vi.advanceTimersByTimeAsync(999);
            expect(executeSpawnSessionRequest).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => {
                expect(executeSpawnSessionRequest).toHaveBeenCalledWith(expect.objectContaining({
                    options: expect.objectContaining({
                        existingSessionId: 'sess-temporary-throttle-inactive',
                        directory: '/tmp/project',
                        resume: 'codex-thread-inactive-fresh',
                    }),
                }));
            });
            expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

            await runtime.stopControlServer();
        } finally {
            vi.useRealTimers();
            resetFetchSessionByIdCompatMock();
        }
    });

    it('uses decrypted inactive session metadata for runtime-auth recovery', async () => {
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        fetchSessionByIdCompatMock.mockClear();
        const secret = new Uint8Array(32).fill(1);
        const metadataCiphertext = encodeBase64(encrypt(secret, 'legacy', {
            flavor: 'gemini',
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    gemini: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'gemini-primary',
                    },
                },
            },
        }), 'base64');
        fetchSessionByIdCompatMock.mockResolvedValueOnce({
            id: 'sess-runtime-encrypted-inactive',
            encryptionMode: 'e2ee',
            metadata: metadataCiphertext,
            metadataVersion: 4,
        });

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret },
            },
            api: {
                getConnectedServiceAuthGroup: vi.fn(),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-runtime-encrypted-inactive',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired',
                serviceId: 'gemini',
                profileId: 'gemini-primary',
                groupId: null,
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });
        const runtimeHandlerCall = handleConnectedServiceRuntimeAuthFailureForSessionMock.mock.calls.at(-1) as [unknown] | undefined;
        const runtimeHandlerInput = runtimeHandlerCall?.[0] as {
            resolveInactiveSession?: (input: { sessionId: string }) => Promise<unknown>;
        } | undefined;
        expect(runtimeHandlerInput?.resolveInactiveSession).toEqual(expect.any(Function));
        await expect(runtimeHandlerInput!.resolveInactiveSession!({
            sessionId: 'sess-runtime-encrypted-inactive',
        })).resolves.toEqual({
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    gemini: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'gemini-primary',
                    },
                },
            },
        });
    });

    it('emits account-switch notifications and transcript events from runtime-auth switches', async () => {
        createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mockClear();
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        dispatchActivityNotificationAsyncMock.mockClear();
        fetchSessionByIdMock.mockClear();
        commitSessionStoredMessageMock.mockClear();

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getConnectedServiceAuthGroup: vi.fn(),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
                push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
                listConnectedServiceProfiles: vi.fn(async () => ({
                    serviceId: 'openai-codex',
                    profiles: [
                        { profileId: 'primary', status: 'connected', providerEmail: 'primary@example.test' },
                        { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.test' },
                    ],
                })),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {
                HAPPIER_CONNECTED_SERVICES_ACCOUNT_SWITCH_NOTIFICATION_DEDUPE_MS: '1234',
            },
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-runtime',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: null,
                groupId: null,
                resetsAtMs: null,
                retryAfterMs: 30_000,
                limitCategory: 'usage_limit',
                quotaScope: 'account',
                providerLimitId: 'weekly',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        const coordinatorInput = createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.at(-1)?.[0] as {
            emitEvent?: (event: unknown) => void;
        };
        coordinatorInput.emitEvent?.({
            type: 'connected_service_auth_group_switch',
            success: true,
            resultStatus: 'switched',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            fromProfileId: 'primary',
            toProfileId: 'backup',
            reason: 'usage_limit',
            fromGeneration: 6,
            toGeneration: 7,
            limitCategory: 'usage_limit',
            retryAfterMs: 30_000,
            quotaScope: 'account',
            providerLimitId: 'weekly',
        });

        await vi.waitFor(() => {
            expect(dispatchActivityNotificationAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
                event: expect.objectContaining({
                    topic: 'connected_service_account_switch',
                    sessionId: 'sess-runtime',
                    serviceId: 'openai-codex',
                    groupId: 'codex-main',
                }),
                dedupeWindowMs: 1234,
            }));
            expect(commitSessionStoredMessageMock).toHaveBeenCalledWith(expect.objectContaining({
                token: 'token-daemon',
                sessionId: 'sess-runtime',
                localId: 'connected-service-account-switch:openai-codex:codex-main:7',
            }));
        });
    });

    it('retries pending connected-service home cleanup after child exit', async () => {
        const cleanupPendingDeletedGroupHomes = vi.fn(async () => []);
        const cleanupPendingMaterializedHomes = vi.fn(async () => []);
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            // Test fixture boundary: child-exit cleanup does not need API methods.
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            connectedServiceGroupHomeCleanupScheduler: {
                cleanupPendingDeletedGroupHomes,
            },
            connectedServiceMaterializedHomeCleanupScheduler: {
                cleanupPendingMaterializedHomes,
            },
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        runtime.onChildExited(12345, { reason: 'process-exited', code: 0, signal: null });

        expect(cleanupPendingDeletedGroupHomes).toHaveBeenCalledOnce();
        expect(cleanupPendingMaterializedHomes).toHaveBeenCalledOnce();
    });

    it('allows native-to-connected Gemini switches through restart rematerialization', async () => {
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                7777,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-gemini',
                    pid: 7777,
                    spawnOptions: {
                        directory: '/tmp/project',
                        backendTarget: { kind: 'backend', backendId: 'gemini', sourceKind: 'built_in' },
                        connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
                        connectedServices: {
                            v: 1,
                            bindingsByServiceId: {
                                gemini: { source: 'native' },
                            },
                        },
                    },
                },
            ],
        ]);
        const listConnectedServiceProfiles = vi.fn(async () => ({
            serviceId: 'gemini' as const,
            profiles: [{ profileId: 'gemini-work', status: 'connected' as const }],
        }));

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                listConnectedServiceProfiles,
                getConnectedServiceAuthGroup: vi.fn(async () => null),
                push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession,
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await expect(controlServerInput?.handleSessionConnectedServiceAuthSwitch?.({
            sessionId: 'sess-gemini',
            agentId: 'gemini',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    gemini: { source: 'connected', selection: 'profile', profileId: 'gemini-work' },
                },
            },
        })).resolves.toMatchObject({
            ok: true,
            action: 'restart_requested',
            continuityByServiceId: {
                gemini: 'restart_rematerialize',
            },
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    gemini: { source: 'connected', selection: 'profile', profileId: 'gemini-work' },
                },
            },
        });

        expect(pidToTrackedSession.get(7777)?.spawnOptions?.connectedServices).toEqual({
            v: 1,
            bindingsByServiceId: {
                gemini: { source: 'connected', selection: 'profile', profileId: 'gemini-work' },
            },
        });
    });

    it('allows same-session connected-to-connected switches when the provider declares restart continuity', async () => {
        requestConnectedServiceSessionRestartSignalMock.mockClear();
        fetchSessionByIdCompatMock.mockClear();
        updateSessionMetadataWithRetryMock.mockClear();
        refreshAccountSettingsForMinimumVersionMock.mockClear();
        const calls: string[] = [];
        requestConnectedServiceSessionRestartSignalMock.mockImplementationOnce(async () => {
            calls.push('signal');
        });
        updateSessionMetadataWithRetryMock.mockImplementationOnce(async ({ updater }: {
            updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
        }) => {
            calls.push('persist');
            return {
                version: 2,
                metadata: updater({ flavor: 'gemini' }),
            };
        });
        const connectedServicesRestartRequestedPids = new Set<number>();
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                8888,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-gemini-connected',
                    pid: 8888,
                    spawnOptions: {
                        directory: '/tmp/project',
                        backendTarget: { kind: 'backend', backendId: 'gemini', sourceKind: 'built_in' },
                        connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
                        connectedServices: {
                            v: 1,
                            bindingsByServiceId: {
                                gemini: { source: 'connected', selection: 'profile', profileId: 'gemini-primary' },
                            },
                        },
                    },
                    vendorResumeId: 'gemini-thread-1',
                },
            ],
        ]);

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                listConnectedServiceProfiles: vi.fn(async () => ({
                    serviceId: 'gemini' as const,
                    profiles: [
                        { profileId: 'gemini-primary', status: 'connected' as const },
                        { profileId: 'gemini-backup', status: 'connected' as const },
                    ],
                })),
                getConnectedServiceAuthGroup: vi.fn(async () => null),
                push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession,
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids,
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await expect(controlServerInput?.handleSessionConnectedServiceAuthSwitch?.({
            sessionId: 'sess-gemini-connected',
            agentId: 'gemini',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    gemini: { source: 'connected', selection: 'profile', profileId: 'gemini-backup' },
                },
            },
            accountSettingsVersionHint: 42,
        } as Parameters<NonNullable<NonNullable<typeof controlServerInput>['handleSessionConnectedServiceAuthSwitch']>>[0] & {
            accountSettingsVersionHint: number;
        })).resolves.toMatchObject({
            ok: true,
            continuityByServiceId: {
                gemini: 'restart_rematerialize',
            },
            diagnostics: {
                accountSettingsFreshness: {
                    requestedVersion: 42,
                    status: 'succeeded',
                },
            },
        });

        expect(refreshAccountSettingsForMinimumVersionMock).toHaveBeenCalledWith({
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            minSettingsVersion: 42,
            mode: 'blocking',
        });
        expect(fetchSessionByIdCompatMock).toHaveBeenCalledWith({
            token: 'token-daemon',
            sessionId: 'sess-gemini-connected',
        });
        expect(updateSessionMetadataWithRetryMock).toHaveBeenCalled();
        expect(calls).toContain('persist');
        expect(connectedServicesRestartRequestedPids.has(8888)).toBe(true);
    });

    it('uses parsed session metadata for inactive connected-service auth switches', async () => {
        requestConnectedServiceSessionRestartSignalMock.mockClear();
        fetchSessionByIdCompatMock.mockClear();
        updateSessionMetadataWithRetryMock.mockClear();
        refreshAccountSettingsForMinimumVersionMock.mockClear();
        const rawSession = {
            id: 'sess-gemini-inactive',
            encryptionMode: 'plain' as const,
            metadata: JSON.stringify({
                flavor: 'gemini',
                geminiSessionId: 'gemini-inactive-thread-1',
                connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        gemini: {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'gemini-primary',
                        },
                    },
                },
            }),
            metadataVersion: 7,
        };
        fetchSessionByIdCompatMock
            .mockResolvedValueOnce(rawSession)
            .mockResolvedValueOnce(rawSession);

        await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                listConnectedServiceProfiles: vi.fn(async () => ({
                    serviceId: 'gemini' as const,
                    profiles: [
                        { profileId: 'gemini-primary', status: 'connected' as const },
                        { profileId: 'gemini-backup', status: 'connected' as const },
                    ],
                })),
                getConnectedServiceAuthGroup: vi.fn(async () => null),
                push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await expect(controlServerInput?.handleSessionConnectedServiceAuthSwitch?.({
            sessionId: 'sess-gemini-inactive',
            agentId: 'gemini',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    gemini: { source: 'connected', selection: 'profile', profileId: 'gemini-backup' },
                },
            },
        })).resolves.toMatchObject({
            ok: true,
            continuityByServiceId: {
                gemini: 'restart_rematerialize',
            },
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    gemini: { source: 'connected', selection: 'profile', profileId: 'gemini-backup' },
                },
            },
        });
        expect(fetchSessionByIdCompatMock).toHaveBeenCalledWith({
            token: 'token-daemon',
            sessionId: 'sess-gemini-inactive',
        });
        expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
        expect(requestConnectedServiceSessionRestartSignalMock).not.toHaveBeenCalled();
    });
});
