import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { AgentSessionRuntimeFactory } from '@happier-dev/plugin-sdk/agent-runtime';
import {
    CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
    resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';

import { encodeBase64, encrypt } from '@/api/encryption';
import { materializeNextPendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import {
    buildBackendTargetKeyV2,
    buildConnectedServiceCredentialRecord,
    buildProviderAccountUsageRecordId,
    FeaturesResponseSchema,
    sealSessionOwnerMetadataV1,
    SessionOwnerMetadataV1Schema,
    type BrowserCommandV1,
    type BrowserRecordingCapabilities,
    DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    type SimulatorDeviceResourceV1,
    type ConnectedServiceBindingsV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { ProviderAccountUsageAdoptionV1 } from '../connectedServices/accountUsage/adoption';
import type {
    ConnectedAccountRequestAuthServiceDependencies,
} from '../connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    type PluginHostedWebSecurityPolicyV1,
} from '@happier-dev/protocol/plugins/ui';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    createResolvedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import {
    readTerminalHostAttachmentInfo,
    removeTerminalHostAttachmentInfo,
    writeTerminalHostAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import type { TrackedSession } from '../types';
import type {
    ApplyConnectedServiceAuthGenerationToTrackedSessionInput,
    SessionConnectedServiceAuthSwitchResult,
} from '../connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import type { ConnectedServiceSessionRestartSignalResult } from '../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServices/connectedServiceChildEnvironment';
import {
    commitConnectedServiceHotApplyRuntimeTarget,
    resolveConnectedServiceContinuationInterruptionForSwitch,
    resolveConnectedServiceContinuationOriginId,
    resolveContinuationResumePromptMode,
    startDaemonSessionControlRuntime,
} from './startDaemonSessionControlRuntime';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';
import { startDaemonControlServer } from '../controlServer';
import * as sessionRunnerRespawnModule from '../processSupervision/sessionRunnerRespawn';
import { resolveConnectedServiceMaterializedRootDir } from '../connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { authorizeConnectedServiceRuntimeAuthFailureSource } from '../connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { computeConnectedServiceAccessTokenFingerprint } from '../connectedServices/refresh/credentialFreshness/tokenFingerprint';
import { resolveQuotaProbeFreshProof } from '../connectedServices/quotas/proof/quotaProbeFreshProof';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../connectedServices/sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import {
    createConnectedAccountRequestAuthSubjectRegistry,
} from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import {
    readConnectedAccountRequestAuthCapabilityFile,
} from '../connectedServices/requestAuth/capabilityFile';

const providerAccountUsageV4ServerFeatures = {
    status: 'ready',
    features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
            connectedServices: {
                qualifiedAccounts: { protocolVersion: 4 },
            },
        },
    }),
} satisfies CliServerFeaturesSnapshot;

describe('runtime-v2 continuation prompt policy composition', () => {
    it('uses group policy before account preference and explicit one-shot input before both', async () => {
        const loadGroupPolicy = vi.fn(async () => ({ resumePromptMode: 'off' }));
        const base = {
            serviceId: 'openai-codex' as const,
            groupId: 'group-1',
            readAccountSettings: () => ({ usageLimitRecoverySettingsV1: { resumePromptMode: 'custom' } }),
            loadGroupPolicy,
        };

        await expect(resolveContinuationResumePromptMode(base)).resolves.toBe('off');
        await expect(resolveContinuationResumePromptMode({ ...base, explicit: 'standard' })).resolves.toBe('standard');
        expect(loadGroupPolicy).toHaveBeenCalledTimes(1);
    });

    it('fails closed for deleted or malformed group/account settings', async () => {
        await expect(resolveContinuationResumePromptMode({
            serviceId: 'openai-codex',
            groupId: 'deleted',
            readAccountSettings: () => ({ usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } }),
            loadGroupPolicy: () => null,
        })).resolves.toBe('off');
        await expect(resolveContinuationResumePromptMode({
            serviceId: 'openai-codex',
            groupId: 'malformed',
            readAccountSettings: () => ({ usageLimitRecoverySettingsV1: { resumePromptMode: 'later' } }),
            loadGroupPolicy: () => ({ resumePromptMode: 'sometimes' }),
        })).resolves.toBe('standard');
    });

    it('uses a fresh report identity only when the in-band failed turn has already cleared', () => {
        expect(resolveConnectedServiceContinuationOriginId({
            source: 'daemon_report',
            activeTurnId: null,
            reportId: 'runtime-auth-report:origin-a',
        })).toBe('runtime-auth-report:origin-a');
        expect(resolveConnectedServiceContinuationOriginId({
            source: 'daemon_report',
            activeTurnId: 'turn-live',
            reportId: 'runtime-auth-report:origin-a',
        })).toBe('turn-live');
        expect(resolveConnectedServiceContinuationOriginId({
            source: 'scheduler_retry',
            activeTurnId: 'turn-stale',
            reportId: 'runtime-auth-report:origin-a',
        })).toBeNull();
    });
});

const connectedServiceMaterializationIdentity = {
    v: 1,
    id: 'csm_stable_switch',
    createdAt: 111,
} as const;

const runtimeAuthRefreshSelection = {
    kind: 'profile',
    serviceId: 'openai-codex',
    profileId: 'fixture-profile',
} as const;

function registerRuntimeAuthRefreshTarget(
    registry: ConnectedServiceRuntimeRegistry,
    sessionId: string,
): void {
    registry.registerTarget({
        pid: 777,
        agentId: 'codex',
        sessionId,
        connectedServiceSelectionsEnv: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                ...runtimeAuthRefreshSelection,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            }]),
        },
    });
}

const runtimeAuthRefreshRequest = {
    sessionId: 'sess_fixture',
    refreshAttemptId: 'refresh-attempt-1',
    selection: runtimeAuthRefreshSelection,
    expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
} as const;

it('commits the accepted hot-apply target before stale bootstrap state can supersede its exact report', async () => {
    const binding = {
        v: 1,
        bindingsByServiceId: {
            'openai-codex': {
                source: 'connected',
                selection: 'group',
                groupId: 'work',
                profileId: 'primary',
            },
        },
    } satisfies ConnectedServiceBindingsV1;
    const selectionA = {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'work',
        activeProfileId: 'primary',
        fallbackProfileId: 'primary',
        generation: 6,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
    } as const;
    const selectionB = {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'work',
        activeProfileId: 'backup',
        fallbackProfileId: 'primary',
        generation: 7,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    } as const;
    const staleBootstrapEnvironment = {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([selectionA]),
    };
    const acceptedHotApplyEnvironment = {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([selectionB]),
    };
    const sessionId = 'sess-hot-apply';
    const tracked: TrackedSession = {
        pid: 501,
        startedBy: 'daemon',
        happySessionId: sessionId,
        spawnOptions: {
            directory: '/tmp/worktree',
            connectedServices: binding,
            // Model the passive marker/webhook race restoring bootstrap A after
            // the hot-apply owner already accepted exact B.
            environmentVariables: staleBootstrapEnvironment,
        },
    };
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
        pid: tracked.pid,
        agentId: 'codex',
        sessionId: tracked.happySessionId,
        connectedServicesBindingsRaw: binding,
        connectedServiceSelectionsEnv: staleBootstrapEnvironment,
    });

    await commitConnectedServiceHotApplyRuntimeTarget({
        tracked,
        agentId: 'codex',
        materializationIdentity: connectedServiceMaterializationIdentity,
        registry,
        acceptedConnectedServicesBindingsRaw: binding,
        acceptedConnectedServiceSelectionsEnv: acceptedHotApplyEnvironment,
    });
    registry.registerTarget({
        pid: tracked.pid,
        agentId: 'codex',
        sessionId: tracked.happySessionId,
        connectedServicesBindingsRaw: binding,
        connectedServiceSelectionsEnv: staleBootstrapEnvironment,
    }, { source: 'bootstrap' });

    const registeredTarget = registry.getByPid(501);
    expect(registeredTarget).toMatchObject({
        activeBindings: [{
            serviceId: 'openai-codex',
            groupId: 'work',
            profileId: 'backup',
            groupGeneration: 7,
            credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        }],
    });

    const authorization = await authorizeConnectedServiceRuntimeAuthFailureSource({
        getChildren: () => [tracked],
        sessionId,
        runtimeAuthApplyCapability: {
            directLiveHotAuth: {
                supportsInTurnApply: true,
                requiresExactRuntimeIdentity: true,
                refreshSelectionResync: 'not_applicable',
                authMode: { kind: 'managed_provider_session' },
            },
        },
        classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'backup',
            groupId: 'work',
            groupGeneration: 7,
            expectedCredentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
            recoveryAction: { kind: 'quota_recovery_required' },
        },
        resolveRegisteredRuntimeAuthFailureSource: async () => {
            const current = registry.getBySessionId(sessionId);
            const currentBinding = current?.activeBindings.find(
                (candidate) => candidate.serviceId === 'openai-codex',
            );
            return currentBinding ? {
                serviceId: currentBinding.serviceId,
                groupId: currentBinding.groupId,
                profileId: currentBinding.profileId,
                generation: currentBinding.groupGeneration,
                credentialRevision: currentBinding.credentialRevision,
            } : null;
        },
    });
    expect(authorization).toMatchObject({ status: 'authorized' });
});

it('unregisters the canonical hot-apply target when a post-registration consumer fails', async () => {
    const environment = { HAPPIER_TEST_CONNECTED_SERVICE_SELECTION_IDENTITY: 'selection-2' };
    const tracked: TrackedSession = {
        pid: 502,
        startedBy: 'daemon',
        happySessionId: 'sess-hot-apply-rollback',
        spawnOptions: { directory: '/tmp/worktree', environmentVariables: environment },
    };
    const registry = new ConnectedServiceRuntimeRegistry();

    await expect(commitConnectedServiceHotApplyRuntimeTarget({
        tracked,
        agentId: 'codex',
        materializationIdentity: connectedServiceMaterializationIdentity,
        registry,
        acceptedConnectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} },
        acceptedConnectedServiceSelectionsEnv: environment,
        afterRegister: () => { throw new Error('consumer registration failed'); },
    })).rejects.toThrow('consumer registration failed');

    expect(registry.getByPid(502)).toBeNull();
});

const requestAuthSwitchAfterClassifiedFailureMock = vi.hoisted(() => vi.fn(async () => ({
    status: 'switched',
})));
const createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock = vi.hoisted(() => vi.fn((params: unknown) => ({
    __testParams: params,
    switchAfterClassifiedFailure: requestAuthSwitchAfterClassifiedFailureMock,
})));
const qualifiedRequestAuthSwitchAfterClassifiedFailureMock = vi.hoisted(
    () => vi.fn(async () => ({ status: 'switched' })),
);
const createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinatorMock =
    vi.hoisted(() => vi.fn((params: unknown) => ({
        __testParams: params,
        switchAfterClassifiedFailure:
            qualifiedRequestAuthSwitchAfterClassifiedFailureMock,
    })));
const connectedAccountRequestAuthServiceDependenciesCapture = vi.hoisted(() => ({
    current: null as ConnectedAccountRequestAuthServiceDependencies | null,
}));
const sendSessionMessageMock = vi.hoisted(() => vi.fn(async () => undefined));
type QuotaCoordinatorFactoryTestParams = Readonly<{
    emitEvent?: (event: unknown) => void;
    restartSession?: (input: Readonly<{
        sessionId?: string;
        serviceId: string;
        groupId: string;
        activeProfileId: string;
        generation: number;
        credentialRevision?: string | null;
        reason?: string;
    }>) => Promise<Readonly<Record<string, unknown>>>;
}>;

const createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock = vi.hoisted(() => vi.fn((params: QuotaCoordinatorFactoryTestParams) => ({
    switchBeforeTurn: vi.fn(async () => {
        params.emitEvent?.({
            type: 'connected_service_auth_group_switch',
            success: true,
            resultStatus: 'switched',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            fromProfileId: 'primary',
            toProfileId: 'backup',
            reason: 'soft_threshold',
            fromGeneration: 6,
            toGeneration: 7,
            limitCategory: 'soft_threshold',
            retryAfterMs: null,
            quotaScope: 'account',
            providerLimitId: 'weekly',
        });
        return { status: 'switched' };
    }),
    applyCommittedGeneration: vi.fn<(input: Readonly<{
        activeProfileId: string;
        generation: number;
        reason?: string;
    }>) => Promise<Readonly<Record<string, unknown>>>>(async (input) => ({
        status: 'observed_generation',
        activeProfileId: input.activeProfileId,
        generation: input.generation,
        mode: 'hot_apply',
    })),
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
    metadataLayoutVersion?: number;
    ownerMetadata?: string;
    dataEncryptionKey?: string;
} | null;
const fetchSessionByIdMock = vi.hoisted(() => vi.fn(async () => ({
    id: 'sess-runtime',
    encryptionMode: 'plain',
})));
const fetchSessionsPageMock = vi.hoisted(() => vi.fn(async () => ({
    sessions: [],
    nextCursor: null,
    hasNext: false,
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
const commitSessionStoredMessageMock = vi.hoisted(() => vi.fn<(input: { localId?: string }) => Promise<{
    didWrite: true;
    messageId: string;
    seq: number;
    createdAt: number;
}>>(async () => ({
    didWrite: true,
    messageId: 'msg-runtime-switch',
    seq: 1,
    createdAt: 1_000,
})));
const commitRuntimeAuthRecoveryVisibleEventDeliveryMock = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
const requestConnectedServiceSessionRestartSignalMock = vi.hoisted(() => vi.fn<() => Promise<ConnectedServiceSessionRestartSignalResult>>(async () => ({ status: 'requested' })));
const markSessionMarkerConnectedServiceRestartIntentMock = vi.hoisted(() => vi.fn(async () => true));
const clearSessionMarkerConnectedServiceRestartIntentMock = vi.hoisted(() => vi.fn(async () => {}));
const removeSessionMarkerMock = vi.hoisted(() => vi.fn(async () => {}));
const removeSessionMarkerIfOwnedMock = vi.hoisted(() => (
    vi.fn<(input: { pid: number }) => Promise<boolean>>(async () => true)
));
const updateSessionMarkerActiveTurnMock = vi.hoisted(() => vi.fn(async () => true));
const updateSessionMarkerAgentSessionStartupInstructionsMarkerMock = vi.hoisted(
    () => vi.fn(async () => true),
);
const drainRuntimeAuthFailureReportOutboxToDaemonMock = vi.hoisted(() => vi.fn(async () => ({
    delivered: 0,
    retried: 0,
    dropped: 0,
})));
const removeRuntimeAuthFailureReportOutboxItemsForSessionMock = vi.hoisted(
    () => vi.fn<(input: {
        outboxDir?: string;
        sessionId: string;
        updatedBeforeMs?: number;
    }) => Promise<void>>(async () => {}),
);
const getConnectedServiceRuntimeAuthAdapterMock = vi.hoisted(
    () => vi.fn(),
);
const recoveryIntentFileStoresMock = vi.hoisted(() => ({
    storesByPath: new Map<string, Map<string, unknown>>(),
    effectClaimsByPath: new Map<string, Map<string, string>>(),
}));
const applyConnectedServiceAuthGenerationToTrackedSessionMock = vi.hoisted(() => vi.fn<
    (input: ApplyConnectedServiceAuthGenerationToTrackedSessionInput) => Promise<SessionConnectedServiceAuthSwitchResult>
>(async () => ({
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
const acquireAuthoritativePluginRuntimeRegistryLeaseMock = vi.hoisted(() => vi.fn());
const listExecutionRunMarkersForRehydrationMock = vi.hoisted(
    () => vi.fn(async () => []),
);
const isRuntimeRegistryCurrentMock = vi.hoisted(
    () => vi.fn(() => true),
);
const resolveConnectedServiceSwitchContinuityMock = vi.hoisted(() => vi.fn());
const simulatorPreviewAdapterStopMock = vi.hoisted(() => vi.fn(async () => {}));
const createIosSimulatorPlatformAdapterMock = vi.hoisted(() => vi.fn(() => ({
    platform: 'ios' as const,
    usesPrivateFrameworks: true as const,
    health: async () => ({
        v: 1 as const,
        platform: 'ios' as const,
        status: 'unavailable' as const,
        reasonCode: 'ios_private_helper_unavailable' as const,
        diagnostics: [],
    }),
    listResources: async () => [],
    listDiagnostics: async () => [{
        platform: 'ios',
        status: 'unavailable',
        severity: 'error',
        reasonCode: 'ios_private_helper_unavailable',
        diagnostics: [],
    }],
    dispatchAction: async (actionInput: { event: { type: string } }) => ({
        v: 1 as const,
        eventType: actionInput.event.type,
        status: 'unavailable' as const,
        reasonCode: 'simulator_runtime_action_unavailable',
        diagnostics: [],
    }),
    stop: async () => {},
    capture: async () => ({
        ok: false as const,
        reasonCode: 'ios_private_helper_unavailable' as const,
    }),
})));
const createAndroidSimulatorPlatformAdapterMock = vi.hoisted(() => vi.fn(() => ({
    platform: 'android' as const,
    usesPrivateFrameworks: false as const,
    health: async () => ({
        v: 1 as const,
        platform: 'android' as const,
        status: 'unavailable' as const,
        reasonCode: 'android_emulator_bridge_unavailable' as const,
        diagnostics: [],
    }),
    listResources: async () => [],
    listDiagnostics: async () => [{
        platform: 'android',
        status: 'unavailable',
        severity: 'error',
        reasonCode: 'android_emulator_bridge_unavailable',
        diagnostics: [],
    }],
    dispatchAction: async (actionInput: { event: { type: string } }) => ({
        v: 1 as const,
        eventType: actionInput.event.type,
        status: 'unavailable' as const,
        reasonCode: 'simulator_runtime_action_unavailable',
        diagnostics: [],
    }),
    stop: async () => {},
    capture: async () => ({
        ok: false as const,
        reasonCode: 'android_emulator_bridge_unavailable' as const,
    }),
})));
const createComposedSimulatorPreviewAdapterMock = vi.hoisted(() => vi.fn((input: {
    platforms: readonly {
        listDiagnostics(): Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[];
    }[];
}) => ({
    listResources: async (): Promise<readonly SimulatorDeviceResourceV1[]> => [],
    listDiagnostics: async () => (
        await Promise.all(input.platforms.map(async (platform) => await platform.listDiagnostics()))
    ).flat(),
    dispatchAction: async (actionInput: { event: { type: string } }) => ({
        v: 1,
        eventType: actionInput.event.type,
        status: 'unavailable',
        reasonCode: 'simulator_runtime_action_unavailable',
        diagnostics: [],
    }),
    stop: simulatorPreviewAdapterStopMock,
})));

const startupAvailableSimulatorResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'sim_ios_startup',
    platform: 'ios',
    deviceId: 'sim_ios_startup',
    displayName: 'iPhone 16 Pro',
    capture: {
        status: 'available',
        sourceId: 'ios-simulator:sim_ios_startup:screen',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    },
};

const startupRecordingWebmBytes = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]),
    Buffer.from('startup browser recording bytes', 'utf8'),
]);

type BrowserStartupExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type BrowserStartupErrorListener = (error: Error) => void;
type BrowserStartupStderrListener = (chunk: string | Uint8Array) => void;

function createBrowserStartupFakeProcess() {
    const exitListeners: BrowserStartupExitListener[] = [];
    const errorListeners: BrowserStartupErrorListener[] = [];
    const stderrListeners: BrowserStartupStderrListener[] = [];
    const kill = vi.fn(() => true);

    return {
        process: {
            pid: 128,
            stderr: {
                on(event: 'data', listener: BrowserStartupStderrListener) {
                    if (event === 'data') stderrListeners.push(listener);
                    return this;
                },
                off(event: 'data', listener: BrowserStartupStderrListener) {
                    if (event !== 'data') return this;
                    const index = stderrListeners.indexOf(listener);
                    if (index >= 0) stderrListeners.splice(index, 1);
                    return this;
                },
            },
            once(event: 'exit' | 'error', listener: BrowserStartupExitListener | BrowserStartupErrorListener) {
                if (event === 'exit') exitListeners.push(listener as BrowserStartupExitListener);
                if (event === 'error') errorListeners.push(listener as BrowserStartupErrorListener);
                return this;
            },
            kill,
        },
        kill,
        emitExit(code: number | null, signal: NodeJS.Signals | null = null) {
            for (const listener of exitListeners) listener(code, signal);
        },
        emitError(error: Error) {
            for (const listener of errorListeners) listener(error);
        },
        emitStderr(chunk: string | Uint8Array) {
            for (const listener of [...stderrListeners]) listener(chunk);
        },
    };
}

async function waitForStartupCondition(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for startup test condition.');
}

async function waitForLocalServicesPreviewResource(
    controlServerInput: Parameters<typeof startDaemonControlServer>[0] | undefined,
    previewId: string,
) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const snapshot = await controlServerInput?.localServicesPreview?.getSnapshot();
        const resource = snapshot?.resources.find((candidate) => candidate.previewId === previewId);
        if (resource) return resource;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for local-service preview resource: ${previewId}`);
}

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
        daemonStateFile: '/tmp/happier-test-home/servers/default/daemon.state.json',
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

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
    callSessionRpc: vi.fn(async () => ({ type: 'no_pending' })),
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

vi.mock('../devices/simulator/adapter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../devices/simulator/adapter')>();
    return {
        ...actual,
        createComposedSimulatorPreviewAdapter: createComposedSimulatorPreviewAdapterMock,
    };
});

vi.mock('../devices/simulator/platform/ios', () => ({
    createIosSimulatorPlatformAdapter: createIosSimulatorPlatformAdapterMock,
}));

vi.mock('../devices/simulator/platform/android', () => ({
    createAndroidSimulatorPlatformAdapter: createAndroidSimulatorPlatformAdapterMock,
}));

vi.mock('@/daemon/connectedServices/catalogHooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/connectedServices/catalogHooks')>();
    resolveConnectedServiceSwitchContinuityMock.mockImplementation(actual.resolveConnectedServiceSwitchContinuity);
    getConnectedServiceRuntimeAuthAdapterMock.mockImplementation(actual.getConnectedServiceRuntimeAuthAdapter);
    return {
        ...actual,
        resolveConnectedServiceSwitchContinuity: resolveConnectedServiceSwitchContinuityMock,
        getConnectedServiceRuntimeAuthAdapter: getConnectedServiceRuntimeAuthAdapterMock,
    };
});

vi.mock('../connectedServices/runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator', () => ({
    createDaemonConnectedServiceAuthGroupSwitchCoordinator: createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock,
}));

vi.mock('../connectedServices/runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator', () => ({
    createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator:
        createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinatorMock,
}));

vi.mock(
    '../connectedServices/requestAuth/ConnectedAccountRequestAuthService',
    async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('../connectedServices/requestAuth/ConnectedAccountRequestAuthService')
        >();
        return {
            ...actual,
            createConnectedAccountRequestAuthService: (
                dependencies: ConnectedAccountRequestAuthServiceDependencies,
            ) => {
                connectedAccountRequestAuthServiceDependenciesCapture.current = dependencies;
                return actual.createConnectedAccountRequestAuthService(dependencies);
            },
        };
    },
);

vi.mock('@/session/services/sendSessionMessage', () => ({
    sendSessionMessage: sendSessionMessageMock,
}));

vi.mock('../connectedServices/quotas/createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator', () => ({
    createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator: createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock,
}));

vi.mock(
    '../connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession',
    async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('../connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession')
        >();
        return {
            ...actual,
            handleConnectedServiceRuntimeAuthFailureForSession:
                handleConnectedServiceRuntimeAuthFailureForSessionMock,
        };
    },
);

vi.mock('../connectedServices/runtimeAuth/commitConnectedServiceRuntimeAuthRecoverySessionEvent', () => ({
    commitRuntimeAuthRecoveryVisibleEventDelivery: commitRuntimeAuthRecoveryVisibleEventDeliveryMock,
}));

vi.mock('../connectedServices/recoveryScheduler/recoveryIntentFileStore', () => ({
    createRecoveryIntentFileStore: vi.fn((path: string) => {
        const store = recoveryIntentFileStoresMock.storesByPath.get(path) ?? new Map<string, unknown>();
        const effectClaims = recoveryIntentFileStoresMock.effectClaimsByPath.get(path)
            ?? new Map<string, string>();
        recoveryIntentFileStoresMock.storesByPath.set(path, store);
        recoveryIntentFileStoresMock.effectClaimsByPath.set(path, effectClaims);
        const applyMutation = (mutation: Readonly<{
            sessionId: string;
            intent: unknown | null;
            effectClaimToken: string | null;
        }>) => {
            if (mutation.intent === null) {
                store.delete(mutation.sessionId);
                effectClaims.delete(mutation.sessionId);
                return;
            }
            store.set(mutation.sessionId, mutation.intent);
            if (mutation.effectClaimToken === null) effectClaims.delete(mutation.sessionId);
            else effectClaims.set(mutation.sessionId, mutation.effectClaimToken);
        };
        return {
            read: (sessionId: string) => store.get(sessionId) ?? null,
            readAuthoritative: (sessionId: string) => store.get(sessionId) ?? null,
            readKeysAuthoritative: (sessionIds: readonly string[]) => new Map(
                sessionIds.map((sessionId) => [sessionId, store.get(sessionId) ?? null]),
            ),
            readAll: () => [...store.entries()],
            write: (sessionId: string, intent: unknown) => {
                store.set(sessionId, intent);
            },
            remove: (sessionId: string) => {
                store.delete(sessionId);
                effectClaims.delete(sessionId);
            },
            transact: async (
                sessionId: string,
                transaction: (current: Readonly<{
                    intent: unknown | null;
                    effectClaimToken: string | null;
                }>) => Readonly<{
                    intent: unknown | null;
                    effectClaimToken: string | null;
                    result: unknown;
                }>,
            ) => {
                const next = transaction({
                    intent: store.get(sessionId) ?? null,
                    effectClaimToken: effectClaims.get(sessionId) ?? null,
                });
                applyMutation({
                    sessionId,
                    intent: next.intent,
                    effectClaimToken: next.effectClaimToken,
                });
                return next.result;
            },
            transactKeys: async (
                sessionIds: readonly string[],
                transaction: (
                    currentBySessionId: ReadonlyMap<string, Readonly<{
                        intent: unknown | null;
                        effectClaimToken: string | null;
                    }>>,
                    allCurrentBySessionId: ReadonlyMap<string, Readonly<{
                        intent: unknown | null;
                        effectClaimToken: string | null;
                    }>>,
                ) => Readonly<{
                    mutations: ReadonlyArray<Readonly<{
                        sessionId: string;
                        intent: unknown | null;
                        effectClaimToken: string | null;
                    }>>;
                    result: unknown;
                }>,
            ) => {
                const readEntries = (sessionIdsToRead: Iterable<string>) => new Map(
                    [...sessionIdsToRead].map((sessionId) => [
                        sessionId,
                        {
                            intent: store.get(sessionId) ?? null,
                            effectClaimToken: effectClaims.get(sessionId) ?? null,
                        },
                    ]),
                );
                const next = transaction(
                    readEntries(sessionIds),
                    readEntries(new Set([...store.keys(), ...effectClaims.keys()])),
                );
                next.mutations.forEach(applyMutation);
                return next.result;
            },
        };
    }),
}));

vi.mock('../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal', () => ({
    isConnectedServiceRestartSignalStaleProcessError: (error: unknown) => {
        if (!(error instanceof Error)) return false;
        const code = (error as { code?: unknown }).code;
        return code === 'ESRCH' || /\bESRCH\b|\bno such process\b/i.test(error.message);
    },
    requestConnectedServiceSessionRestartSignal: requestConnectedServiceSessionRestartSignalMock,
}));

vi.mock('../sessionRegistry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../sessionRegistry')>();
    return {
        ...actual,
        markSessionMarkerConnectedServiceRestartIntent: markSessionMarkerConnectedServiceRestartIntentMock,
        clearSessionMarkerConnectedServiceRestartIntent: clearSessionMarkerConnectedServiceRestartIntentMock,
        removeSessionMarker: removeSessionMarkerMock,
        removeSessionMarkerIfOwned: removeSessionMarkerIfOwnedMock,
        updateSessionMarkerActiveTurn: updateSessionMarkerActiveTurnMock,
        updateSessionMarkerAgentSessionStartupInstructionsMarker:
            updateSessionMarkerAgentSessionStartupInstructionsMarkerMock,
    };
});

vi.mock('../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutboxDrain', () => ({
    drainRuntimeAuthFailureReportOutboxToDaemon: drainRuntimeAuthFailureReportOutboxToDaemonMock,
}));

vi.mock('../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutbox', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutbox')
    >();
    return {
        ...actual,
        removeRuntimeAuthFailureReportOutboxItemsForSession:
            removeRuntimeAuthFailureReportOutboxItemsForSessionMock,
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

vi.mock(
    '@/settings/accountSettings/activeAccountSettingsSnapshot',
    async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('@/settings/accountSettings/activeAccountSettingsSnapshot')
        >();
        return {
            ...actual,
            getActiveAccountSettingsSnapshot:
                getActiveAccountSettingsSnapshotMock,
        };
    },
);

vi.mock('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion', () => ({
    refreshAccountSettingsForMinimumVersion: refreshAccountSettingsForMinimumVersionMock,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
    fetchSessionById: fetchSessionByIdMock,
    fetchSessionByIdCompat: fetchSessionByIdCompatMock,
    fetchSessionsPage: fetchSessionsPageMock,
    commitSessionStoredMessage: commitSessionStoredMessageMock,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
    updateSessionMetadataWithRetry: updateSessionMetadataWithRetryMock,
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
    acquireAuthoritativePluginRuntimeRegistryLease: acquireAuthoritativePluginRuntimeRegistryLeaseMock,
}));

vi.mock('../executionRunRegistry', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('../executionRunRegistry')
    >();
    return {
        ...actual,
        listExecutionRunMarkersForRehydration:
            listExecutionRunMarkersForRehydrationMock,
    };
});

vi.mock('@/plugins/runtime/reload/singleton', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/plugins/runtime/reload/singleton')
    >();
    return {
        ...actual,
        pluginReloadController: {
            ...actual.pluginReloadController,
            isRuntimeRegistryCurrent:
                isRuntimeRegistryCurrentMock,
        },
    };
});

const hostedWebSecurity: PluginHostedWebSecurityPolicyV1 = {
    allowedNavigationOrigins: [],
    allowedCallbackOrigins: [],
    allowedConnectOrigins: [],
    csp: {
        scriptSrc: 'selfOnly',
        styleSrc: 'selfOnly',
        imgSrc: 'selfOnly',
        fontSrc: 'selfOnly',
        connectSrc: 'selfOnly',
        allowDataUrls: false,
        allowBlobUrls: false,
        allowInlineStyles: false,
        allowEval: false,
    },
    sourceMaps: 'disabled',
    mixedContent: 'deny',
};

function createHostedWebStaticAssetsRegistry(input: Readonly<{
    pluginRoot: string;
    digest: string;
    byteSize: number;
}>): ResolvedContributionRegistry {
    return createResolvedContributionRegistry({
        agents: [],
                hostedWeb: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.preview',
            pluginRootPath: input.pluginRoot,
            manifestPath: join(input.pluginRoot, '.happier-plugin/plugin.json'),
            manifestDigest: 'sha256:manifest',
            daemonEntryPath: null,
            sourceSpec: {
                kind: 'path',
                locator: input.pluginRoot,
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
            definition: {
                id: 'preview-web',
                service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                entry: { routeMode: 'pathFallback', path: '/' },
                bridge: { allowedMessages: ['ready'] },
                sandbox: {
                    scripts: true,
                    sameOrigin: false,
                    popups: false,
                    topNavigation: false,
                    mixedContent: false,
                },
                security: hostedWebSecurity,
                fallback: { kind: 'unavailable' },
                display: {
                    titleKey: 'plugin.preview.title',
                    developerFallback: 'Preview web',
                },
            },
        }],
        uiArtifacts: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.preview',
            pluginRootPath: input.pluginRoot,
            manifestPath: join(input.pluginRoot, '.happier-plugin/plugin.json'),
            manifestDigest: 'sha256:manifest',
            daemonEntryPath: null,
            sourceSpec: {
                kind: 'path',
                locator: input.pluginRoot,
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
            definition: {
                id: 'preview-web-static',
                contributionId: 'preview-web',
                contributionFamily: 'hostedWeb',
                artifactKind: 'hostedWebAsset',
                platform: 'web',
                channel: 'internal',
                integrity: { digest: input.digest },
                compatibility: {
                    hostAppVersion: '1.0.0',
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.0.0',
                    nativeCapabilities: [],
                },
                byteSize: input.byteSize,
                contentType: 'text/html',
            },
        }],
    });
}

async function writeHostedWebStaticAssetsFixture(input: Readonly<{
    pluginRoot: string;
    html: string;
    digest: string;
}>): Promise<void> {
    const installedRoot = join(input.pluginRoot, 'dist/happier-plugin-ui');
    await mkdir(join(installedRoot, 'hosted-web/preview-web'), { recursive: true });
    await writeFile(join(installedRoot, 'hosted-web/preview-web/index.html'), input.html, 'utf8');
    await writeFile(join(installedRoot, 'ui-artifacts.json'), JSON.stringify({
        version: 1,
        entries: [{
            contributionId: 'preview-web',
            tier: 'hostedWeb',
            platform: 'web',
            entry: 'hosted-web/preview-web/index.html',
            files: [{
                relativePath: 'hosted-web/preview-web/index.html',
                digest: `sha256:${createHash('sha256').update(input.html).digest('hex')}`,
                byteSize: Buffer.byteLength(input.html),
            }],
            digest: input.digest,
            builtWith: { bundler: 'vite', version: '6.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.0.0' },
        }],
    }), 'utf8');
}

describe('startDaemonSessionControlRuntime', () => {
    it('fails closed on missing or conflicting required startup identity and opens a matching raw carrier once', async () => {
        const startupInstructionsSentinel =
            'PRIV-R01 startup instructions must not survive Agent session open';
        const startupInstructions = {
            v: 1 as const,
            id: 'happier.global_voice_agent',
            revision: 7,
            instructions: startupInstructionsSentinel,
        };
        const startupInstructionsMarker = {
            v: 1 as const,
            id: startupInstructions.id,
            revision: startupInstructions.revision,
        };
        const descriptor = {
            v: 1 as const,
            pluginId: 'happier.agent.codex',
            pluginVersion: '1.2.3',
            agentId: 'codex',
            backendId: 'codex',
            generation: 'generation-startup-custody',
            runtimeAuthority: {
                permissions: [],
                runtimeCapabilities: [],
            },
            factoryControls: {
                continuation: false,
                goals: false,
                catalog: false,
                usageLimitRecovery: false,
            },
        };
        const context = {
            token: 'bridge-token',
            sessionId: 'session-startup-custody',
            pluginId: descriptor.pluginId,
            agentId: descriptor.agentId,
            generation: descriptor.generation,
        };
        const request = {
            kind: 'create' as const,
            sessionId: context.sessionId,
            cwd: '/workspace',
        };
        const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
            send: async () => ({ status: 'admitted' }),
            watch: () => ({ dispose() {} }),
            async dispose() {},
        }));
        const createRuntime = vi.fn(async () => ({
            sessions: { open },
        }));
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockImplementation(async () => ({
            registry: {
                contributes: createResolvedContributionRegistry({ agents: [] }),
                agentRuntimesByAgentId: new Map([['codex', {
                    hasPrimaryRuntime: true,
                    pluginId: descriptor.pluginId,
                    pluginVersion: descriptor.pluginVersion,
                    agentId: descriptor.agentId,
                    generation: descriptor.generation,
                    startupInstructionsVersions: [1],
                    isCurrent: () => true,
                    retirementSignal: new AbortController().signal,
                    createRuntime,
                }]]),
                permissionsByPluginId: new Map([[
                    descriptor.pluginId,
                    new Set(descriptor.runtimeAuthority.permissions),
                ]]),
                runtimeCapabilitiesByPluginId: new Map([[
                    descriptor.pluginId,
                    new Set(descriptor.runtimeAuthority.runtimeCapabilities),
                ]]),
                createAgentInvocationServices: () => Object.freeze({}),
            },
            source: 'active',
            release: vi.fn(async () => {}),
        }));
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            pid: 41,
            happySessionId: context.sessionId,
            agentSessionStartupInstructionsMarkerV1:
                startupInstructionsMarker,
            spawnOptions: {
                directory: request.cwd,
                agentSessionStartupInstructionsV1: startupInstructions,
            },
        };
        const markerOnlyContext = {
            ...context,
            sessionId: 'session-startup-marker-only',
        };
        const markerOnlyTracked: TrackedSession = {
            startedBy: 'daemon',
            pid: 42,
            happySessionId: markerOnlyContext.sessionId,
            agentSessionStartupInstructionsMarkerV1:
                startupInstructionsMarker,
            spawnOptions: {
                directory: request.cwd,
                existingSessionId: markerOnlyContext.sessionId,
            },
        };
        const mismatchedContext = {
            ...context,
            sessionId: 'session-startup-marker-mismatch',
        };
        const mismatchedTracked: TrackedSession = {
            startedBy: 'daemon',
            pid: 43,
            happySessionId: mismatchedContext.sessionId,
            agentSessionStartupInstructionsMarkerV1:
                startupInstructionsMarker,
            spawnOptions: {
                directory: request.cwd,
                agentSessionStartupInstructionsV1: {
                    ...startupInstructions,
                    revision: startupInstructions.revision + 1,
                },
            },
        };
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
                [tracked.pid, tracked],
                [markerOnlyTracked.pid, markerOnlyTracked],
                [mismatchedTracked.pid, mismatchedTracked],
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

        try {
            const bridge = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0]
                .agentRuntimeSessionBridge;
            expect(bridge).toBeDefined();
            if (!bridge) return;

            for (const [failureContext, requestId] of [
                [markerOnlyContext, 'prepare-startup-marker-only'],
                [mismatchedContext, 'prepare-startup-marker-mismatch'],
            ] as const) {
                await expect(bridge.dispatch({
                    v: 1,
                    context: failureContext,
                    operation: {
                        kind: 'factory.prepare',
                        requestId,
                        descriptor,
                        request: {
                            ...request,
                            sessionId: failureContext.sessionId,
                        },
                    },
                })).resolves.toMatchObject({
                    ok: false,
                    error: {
                        message:
                            'Agent startup instructions could not be resolved',
                    },
                });
            }
            expect(createRuntime).not.toHaveBeenCalled();
            expect(open).not.toHaveBeenCalled();

            await expect(bridge.dispatch({
                v: 1,
                context,
                operation: {
                    kind: 'factory.prepare',
                    requestId: 'prepare-startup-custody',
                    descriptor,
                    request,
                },
            })).resolves.toMatchObject({ ok: true });
            await expect(bridge.dispatch({
                v: 1,
                context,
                operation: {
                    kind: 'session.open',
                    requestId: 'open-startup-custody',
                    descriptor,
                    request,
                    featureDecisions: {},
                },
            })).resolves.toMatchObject({ ok: true });

            expect(open).toHaveBeenCalledTimes(1);
            expect(open).toHaveBeenCalledWith(
                { ...request, startupInstructions },
                expect.any(Object),
            );

            const attestation = await runtime.awaitAgentSessionOpen({
                sessionId: context.sessionId,
                timeoutMs: 0,
            });
            expect.soft(tracked.spawnOptions).not.toHaveProperty(
                'agentSessionStartupInstructionsV1',
            );
            expect.soft(tracked).toHaveProperty(
                'agentSessionStartupInstructionsMarkerV1',
                startupInstructionsMarker,
            );
            expect.soft(
                updateSessionMarkerAgentSessionStartupInstructionsMarkerMock,
            ).toHaveBeenCalledWith({
                pid: tracked.pid,
                sessionId: context.sessionId,
                marker: startupInstructionsMarker,
            });
            expect.soft(JSON.stringify(tracked.spawnOptions)).not.toContain(
                startupInstructionsSentinel,
            );
            expect.soft(attestation).toEqual({
                status: 'opened',
                request,
            });
            expect.soft(JSON.stringify(attestation)).not.toContain(
                startupInstructionsSentinel,
            );
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('reactivates a reattached Agent through the canonical session lease and rotates its exact request-auth capability', async () => {
        const materializationBaseDir = await mkdtemp(
            join(tmpdir(), 'happier-request-auth-reattach-'),
        );
        const materializationId = 'csm_request_auth_reattach';
        const materializedRootDir =
            resolveConnectedServiceMaterializedRootDir({
                baseDir: materializationBaseDir,
                agentId: 'opencode',
                materializationKey: materializationId,
            });
        await mkdir(materializedRootDir, {
            recursive: true,
            mode: 0o700,
        });
        const purpose = {
            consumer: {
                pluginId: 'happier.agent.opencode',
                localId: 'opencode',
            },
            purpose: 'openai-codex-model-request',
        } as const;
        const binding = {
            purpose,
            target: {
                kind: 'account',
                account: {
                    service: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    accountId: 'primary',
                },
            },
        } as const;
        const use = {
            purpose,
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://chatgpt.com',
                headerNames: ['authorization', 'chatgpt-account-id'],
            },
        } as const;
        const oldRegistry =
            createConnectedAccountRequestAuthSubjectRegistry();
        const oldDescriptor = await oldRegistry.activate({
            materializedRootDir,
            materializationId,
            httpPort: 43210,
            subject: {
                subjectId:
                    'agent-session:session-request-auth-reattach/agent:opencode',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: (candidate) => (
                    JSON.stringify(candidate) === JSON.stringify(purpose)
                        ? { binding, use }
                        : null
                ),
                listPurposeUses: () => [{ binding, use }],
            },
        });
        const oldCapability = (
            await readConnectedAccountRequestAuthCapabilityFile(
                oldDescriptor.path,
            )
        )?.capability;
        expect(oldRegistry.authenticate(oldCapability)).not.toBeNull();
        const unprovableMaterializationId =
            'csm_request_auth_unprovable';
        const unprovableMaterializedRootDir =
            resolveConnectedServiceMaterializedRootDir({
                baseDir: materializationBaseDir,
                agentId: 'opencode',
                materializationKey: unprovableMaterializationId,
            });
        await mkdir(unprovableMaterializedRootDir, {
            recursive: true,
            mode: 0o700,
        });
        const unprovableDescriptor = await oldRegistry.activate({
            materializedRootDir:
                unprovableMaterializedRootDir,
            materializationId:
                unprovableMaterializationId,
            httpPort: 43210,
            subject: {
                subjectId:
                    'agent-session:session-request-auth-unprovable/agent:opencode',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: () => ({ binding, use }),
                listPurposeUses: () => [{ binding, use }],
            },
        });
        const unprovableOldCapability = (
            await readConnectedAccountRequestAuthCapabilityFile(
                unprovableDescriptor.path,
            )
        )?.capability;
        const reusedMaterializationId =
            'csm_request_auth_reused_pid';
        const reusedMaterializedRootDir =
            resolveConnectedServiceMaterializedRootDir({
                baseDir: materializationBaseDir,
                agentId: 'opencode',
                materializationKey: reusedMaterializationId,
            });
        await mkdir(reusedMaterializedRootDir, {
            recursive: true,
            mode: 0o700,
        });
        const reusedDescriptor = await oldRegistry.activate({
            materializedRootDir: reusedMaterializedRootDir,
            materializationId: reusedMaterializationId,
            httpPort: 43210,
            subject: {
                subjectId:
                    'agent-session:session-request-auth-reused-pid/agent:opencode',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: () => ({ binding, use }),
                listPurposeUses: () => [{ binding, use }],
            },
        });
        const reusedOldCapability = (
            await readConnectedAccountRequestAuthCapabilityFile(
                reusedDescriptor.path,
            )
        )?.capability;
        const changedIdentityMaterializationId =
            'csm_request_auth_changed_identity';
        const changedIdentityMaterializedRootDir =
            resolveConnectedServiceMaterializedRootDir({
                baseDir: materializationBaseDir,
                agentId: 'opencode',
                materializationKey:
                    changedIdentityMaterializationId,
            });
        await mkdir(changedIdentityMaterializedRootDir, {
            recursive: true,
            mode: 0o700,
        });
        const changedIdentityDescriptor =
            await oldRegistry.activate({
                materializedRootDir:
                    changedIdentityMaterializedRootDir,
                materializationId:
                    changedIdentityMaterializationId,
                httpPort: 43210,
                subject: {
                    subjectId:
                        'agent-session:session-request-auth-changed-identity/agent:opencode',
                    isCurrent: () => true,
                    registerRedaction: () => undefined,
                    resolvePurposeUse: () => ({ binding, use }),
                    listPurposeUses: () => [{ binding, use }],
                },
            });
        const changedIdentityOldCapability = (
            await readConnectedAccountRequestAuthCapabilityFile(
                changedIdentityDescriptor.path,
            )
        )?.capability;

        const credentialRevision =
            'csr_0123456789ABCDEFGHJKMNPQRS';
        const credential = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'openai-codex',
            profileId: 'primary',
            kind: 'oauth',
            expiresAt: null,
            oauth: {
                accessToken: 'rotated-daemon-access-token',
                refreshToken: 'refresh-token',
                idToken: 'id-token',
                scope: null,
                tokenType: null,
                providerAccountId: 'account-primary',
                providerEmail: null,
            },
        });
        const fetchAccountProfile = vi
            .spyOn(axios, 'get')
            .mockResolvedValue({
                status: 200,
                data: {
                    id: 'account-request-auth-reattach',
                    connectedServicesV2: [{
                        serviceId: 'openai-codex',
                        profiles: [{
                            profileId: 'primary',
                            status: 'connected',
                            kind: 'oauth',
                        }],
                        groups: [],
                    }],
                    connectedServiceCredentialRevisionsV1: [{
                        serviceId: 'openai-codex',
                        profileId: 'primary',
                        credentialRevision,
                    }],
                },
            });
        acquireAuthoritativePluginRuntimeRegistryLeaseMock
            .mockImplementation(async () => ({
                registry: {
                    contributes: {
                        agentDefinitionsById: new Map([['opencode', {
                            identity: purpose.consumer,
                            richDefinition: {
                                definition: {
                                    connectedAccounts: [{
                                        purpose: purpose.purpose,
                                        service:
                                            binding.target.account.service,
                                    }],
                                },
                            },
                            catalogEntry: {
                                connectedAccountRequestAuthUses: [{
                                    purpose: use.purpose.purpose,
                                    materialization:
                                        use.materialization,
                                }],
                            },
                        }]]),
                    },
                },
                source: 'active',
                release: vi.fn(async () => {}),
            }));

        const purposeLeaseCurrentBySessionId =
            new Map<string, boolean>();
        const disposePurposeLease = vi.fn((sessionId: string) => {
            purposeLeaseCurrentBySessionId.set(sessionId, false);
        });
        const activateSessionPurposeBindings = vi.fn(
            (input: Readonly<{
                sessionId: string;
                purposes: readonly typeof purpose[];
                bindings: readonly typeof binding[];
            }>) => {
                purposeLeaseCurrentBySessionId.set(
                    input.sessionId,
                    true,
                );
                const isCurrent = () => (
                    purposeLeaseCurrentBySessionId.get(input.sessionId)
                        === true
                );
                return {
                    subjectId: `agent-session:${input.sessionId}`,
                    isCurrent,
                    resolvePurposeBinding:
                        (candidate: typeof purpose) => (
                            isCurrent()
                            && JSON.stringify(candidate)
                                === JSON.stringify(purpose)
                                ? binding
                                : null
                        ),
                    listPurposeBindings: () => (
                        isCurrent() ? [binding] : []
                    ),
                    dispose: () => {
                        disposePurposeLease(input.sessionId);
                    },
                };
            },
        );
        const beforeShutdown = vi.fn(async () => {});
        const previousAttachCleanup = vi.fn(async () => {});
        const reusedPreviousAttachCleanup =
            vi.fn(async () => {});
        const changedIdentityPreviousAttachCleanup =
            vi.fn(async () => {});
        const reattachedProcessCommand =
            'happier session --existing-session session-request-auth-reattach';
        const reattachedProcessCommandHash = createHash('sha256')
            .update(reattachedProcessCommand)
            .digest('hex');
        let resolveReusedPidIdentity!: (
            value: Readonly<{
                pid: number;
                processStartTimeMs: number;
                command: string;
            }>,
        ) => void;
        let markReusedPidSafetyEntered:
            (() => void)
            | null = null;
        const reusedPidSafetyEntered = new Promise<void>((resolve) => {
            markReusedPidSafetyEntered = resolve;
        });
        const reusedPidIdentityResult = new Promise<Readonly<{
            pid: number;
            processStartTimeMs: number;
            command: string;
        }>>((resolve) => {
            resolveReusedPidIdentity = resolve;
        });
        let resolveChangedIdentity!: (
            value: Readonly<{
                pid: number;
                processStartTimeMs: number;
                command: string;
            }>,
        ) => void;
        let markChangedIdentityEntered:
            (() => void)
            | null = null;
        const changedIdentityEntered = new Promise<void>((resolve) => {
            markChangedIdentityEntered = resolve;
        });
        const changedIdentityResult = new Promise<Readonly<{
            pid: number;
            processStartTimeMs: number;
            command: string;
        }>>((resolve) => {
            resolveChangedIdentity = resolve;
        });
        const findHappyProcessByPidFn = vi.fn(async (pid: number) => ({
            pid,
            command: reattachedProcessCommand,
            type: 'daemon-spawned-session',
        }));
        const readProcessIdentityByPidFn = vi.fn(
            async (pid: number) => {
                if (pid === 43) {
                    markReusedPidSafetyEntered?.();
                    return await reusedPidIdentityResult;
                }
                if (pid === 45) {
                    markChangedIdentityEntered?.();
                    return await changedIdentityResult;
                }
                return {
                    pid,
                    processStartTimeMs: 1_000,
                    command: reattachedProcessCommand,
                };
            },
        );
        const sessionAttachCleanupByPid = new Map<
            number,
            () => Promise<void>
        >([
            [41, previousAttachCleanup],
            [43, reusedPreviousAttachCleanup],
            [45, changedIdentityPreviousAttachCleanup],
        ]);
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'session-request-auth-reattach',
            pid: 41,
            reattachedFromDiskMarker: true,
            processCommand: reattachedProcessCommand,
            processCommandHash: reattachedProcessCommandHash,
            processStartTimeMs: 1_000,
            spawnOptions: {
                directory: '/tmp/project',
                existingSessionId: 'session-request-auth-reattach',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'opencode',
                    sourceKind: 'built_in',
                },
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
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: materializationId,
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
                environmentVariables: {
                    [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                        oldDescriptor.path,
                },
            },
        };
        const unprovableTracked: TrackedSession = {
            ...tracked,
            pid: 42,
            happySessionId:
                'session-request-auth-unprovable',
            spawnOptions: {
                ...tracked.spawnOptions!,
                existingSessionId:
                    'session-request-auth-unprovable',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: unprovableMaterializationId,
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
                // This legacy marker proves the deterministic capability path,
                // but lacks the exact persisted process-start fact required to
                // grant replacement-daemon request authority.
                environmentVariables: {
                    [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                        unprovableDescriptor.path,
                },
            },
            processCommand: reattachedProcessCommand,
            processCommandHash: reattachedProcessCommandHash,
            processStartTimeMs: undefined,
        };
        const reusedTracked: TrackedSession = {
            ...tracked,
            pid: 43,
            happySessionId:
                'session-request-auth-reused-pid',
            processStartTimeMs: 3_000,
            spawnOptions: {
                ...tracked.spawnOptions!,
                existingSessionId:
                    'session-request-auth-reused-pid',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: reusedMaterializationId,
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
                environmentVariables: {
                    [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                        reusedDescriptor.path,
                },
            },
        };
        const reusedInitialPid = reusedTracked.pid;
        const changedIdentityTracked: TrackedSession = {
            ...tracked,
            pid: 45,
            happySessionId:
                'session-request-auth-changed-identity',
            processStartTimeMs: 5_000,
            spawnOptions: {
                ...tracked.spawnOptions!,
                existingSessionId:
                    'session-request-auth-changed-identity',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: changedIdentityMaterializationId,
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
                environmentVariables: {
                    [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                        changedIdentityDescriptor.path,
                },
            },
        };

        const pidToTrackedSession =
            new Map<number, TrackedSession>([
                [tracked.pid, tracked],
                [unprovableTracked.pid, unprovableTracked],
                [reusedTracked.pid, reusedTracked],
                [
                    changedIdentityTracked.pid,
                    changedIdentityTracked,
                ],
            ]);
        const getConnectedServiceCredentialPlain =
            vi.fn(async () => ({
                revisionSemantics: 'revisioned' as const,
                credentialRevision,
                content: {
                    t: 'plain' as const,
                    v: credential,
                },
            }));
        try {
            const runtimePromise = startDaemonSessionControlRuntime({
                machineId: 'machine-1',
                credentials: {
                    token: 'token-daemon',
                    encryption: {
                        type: 'legacy',
                        secret: new Uint8Array(32).fill(1),
                    },
                },
                api: {
                    getAccountEncryptionMode:
                        vi.fn(async () => 'plain'),
                    getConnectedServiceCredentialPlain:
                        getConnectedServiceCredentialPlain,
                } as never,
                loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
                connectedServicesMaterializationBaseDir:
                    materializationBaseDir,
                getConnectedServiceRefreshCoordinator: () => null,
                getConnectedServiceQuotasCoordinator: () => null,
                resolveQualifiedConnectedAccountRequestAuthTransport:
                    () => ({
                        kind: 'legacy',
                        peerClass: 'revisioned_v2_v3',
                        serviceId: 'openai-codex',
                    }),
                pidToTrackedSession,
                pidToAwaiter: new Map(),
                pidToSpawnResultResolver: new Map(),
                pidToSpawnWebhookTimeout: new Map(),
                getApiMachineForSessions: () => null,
                spawnResourceCleanupByPid: new Map(),
                sessionAttachCleanupByPid,
                connectedServicesRestartRequestedPids: new Set(),
                beforeShutdown,
                onHappySessionWebhook: vi.fn(),
                requestShutdown: vi.fn(),
                activateSessionPurposeBindings:
                    activateSessionPurposeBindings as never,
                reattachedAgentRequestAuthPidSafetyDependencies: {
                    findHappyProcessByPidFn,
                    readProcessIdentityByPidFn,
                },
                processEnv: {},
            });
            await reusedPidSafetyEntered;
            const stagedReusedDocument =
                await readConnectedAccountRequestAuthCapabilityFile(
                    reusedDescriptor.path,
                );
            expect(stagedReusedDocument?.capability)
                .not.toBe(reusedOldCapability);
            expect(
                sessionAttachCleanupByPid.get(reusedTracked.pid),
            ).not.toBe(reusedPreviousAttachCleanup);
            const promotedReusedCleanup =
                sessionAttachCleanupByPid.get(reusedInitialPid)!;
            pidToTrackedSession.delete(reusedInitialPid);
            sessionAttachCleanupByPid.delete(reusedInitialPid);
            reusedTracked.pid = 44;
            pidToTrackedSession.set(reusedTracked.pid, reusedTracked);
            sessionAttachCleanupByPid.set(
                reusedTracked.pid,
                promotedReusedCleanup,
            );
            resolveReusedPidIdentity({
                pid: reusedInitialPid,
                processStartTimeMs: 3_000,
                command: reattachedProcessCommand,
            });
            await changedIdentityEntered;
            const stagedChangedIdentityDocument =
                await readConnectedAccountRequestAuthCapabilityFile(
                    changedIdentityDescriptor.path,
                );
            expect(stagedChangedIdentityDocument?.capability)
                .not.toBe(changedIdentityOldCapability);
            expect(
                sessionAttachCleanupByPid.get(
                    changedIdentityTracked.pid,
                ),
            ).not.toBe(changedIdentityPreviousAttachCleanup);
            resolveChangedIdentity({
                pid: changedIdentityTracked.pid,
                processStartTimeMs: 6_000,
                command: reattachedProcessCommand,
            });
            const runtime = await runtimePromise;

            expect(startDaemonControlServer).toHaveBeenCalledOnce();
            const controlInput = vi
                .mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0];
            const replacementDocument =
                await readConnectedAccountRequestAuthCapabilityFile(
                    oldDescriptor.path,
                );
            expect(oldDescriptor.path).toBe(
                resolveConnectedAccountRequestAuthCapabilityPath(
                    materializedRootDir,
                ),
            );
            expect(replacementDocument?.capability)
                .not.toBe(oldCapability);
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(oldCapability)).toBeNull();
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(
                    unprovableOldCapability,
                )).toBeNull();
            expect((
                await readConnectedAccountRequestAuthCapabilityFile(
                    unprovableDescriptor.path,
                )
            )?.capability).toBe(unprovableOldCapability);
            expect(
                await readConnectedAccountRequestAuthCapabilityFile(
                    reusedDescriptor.path,
                ),
            ).toBeNull();
            expect(
                await readConnectedAccountRequestAuthCapabilityFile(
                    changedIdentityDescriptor.path,
                ),
            ).toBeNull();
            const replacementPrincipal =
                controlInput?.connectedAccountRequestAuth
                    ?.authenticate(
                        replacementDocument?.capability,
                    );
            expect(replacementPrincipal).toMatchObject({
                subjectId:
                    'agent-session:session-request-auth-reattach/agent:opencode',
            });
            expect(getConnectedServiceCredentialPlain)
                .not.toHaveBeenCalled();
            const profileFetchesBeforeLookup =
                fetchAccountProfile.mock.calls.length;
            await expect(
                controlInput?.connectedAccountRequestAuth
                    ?.lookupRequestAuth({
                        subject: replacementPrincipal!,
                        purpose,
                    }),
            ).resolves.toMatchObject({
                accessToken: 'rotated-daemon-access-token',
                requiredHeaders: {
                    'chatgpt-account-id': 'account-primary',
                },
                credentialContext: {
                    account: {
                        accountId: 'primary',
                    },
                    credentialRevision,
                },
            });
            expect(fetchAccountProfile.mock.calls.length)
                .toBeGreaterThanOrEqual(
                    Math.max(1, profileFetchesBeforeLookup),
                );
            expect(getConnectedServiceCredentialPlain)
                .toHaveBeenCalledOnce();
            expect(
                fetchAccountProfile.mock.invocationCallOrder[0],
            ).toBeLessThan(
                getConnectedServiceCredentialPlain
                    .mock.invocationCallOrder[0]!,
            );
            expect(
                activateSessionPurposeBindings,
            ).toHaveBeenCalledWith({
                sessionId: 'session-request-auth-reattach',
                purposes: [purpose],
                bindings: [binding],
            });
            expect(
                activateSessionPurposeBindings,
            ).toHaveBeenCalledTimes(3);
            expect(findHappyProcessByPidFn)
                .toHaveBeenCalledTimes(3);
            expect(readProcessIdentityByPidFn)
                .toHaveBeenCalledTimes(3);
            expect(findHappyProcessByPidFn)
                .toHaveBeenCalledWith(tracked.pid);
            expect(findHappyProcessByPidFn)
                .toHaveBeenCalledWith(reusedInitialPid);
            expect(readProcessIdentityByPidFn)
                .toHaveBeenCalledWith(tracked.pid);
            expect(readProcessIdentityByPidFn)
                .toHaveBeenCalledWith(reusedInitialPid);
            expect(findHappyProcessByPidFn)
                .toHaveBeenCalledWith(
                    changedIdentityTracked.pid,
                );
            expect(readProcessIdentityByPidFn)
                .toHaveBeenCalledWith(
                    changedIdentityTracked.pid,
                );
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(
                    stagedReusedDocument?.capability,
                )).toBeNull();
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(reusedOldCapability)).toBeNull();
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(
                    stagedChangedIdentityDocument?.capability,
                )).toBeNull();
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(
                    changedIdentityOldCapability,
                )).toBeNull();
            expect(sessionAttachCleanupByPid.get(reusedTracked.pid))
                .toBe(reusedPreviousAttachCleanup);
            expect(
                sessionAttachCleanupByPid.has(reusedInitialPid),
            ).toBe(false);
            expect(pidToTrackedSession.get(reusedTracked.pid))
                .toBe(reusedTracked);
            expect(pidToTrackedSession.has(reusedInitialPid))
                .toBe(false);
            expect(reusedPreviousAttachCleanup)
                .not.toHaveBeenCalled();
            expect(
                sessionAttachCleanupByPid.get(
                    changedIdentityTracked.pid,
                ),
            ).toBe(changedIdentityPreviousAttachCleanup);
            expect(changedIdentityPreviousAttachCleanup)
                .not.toHaveBeenCalled();
            expect(disposePurposeLease)
                .toHaveBeenCalledWith(
                    'session-request-auth-reused-pid',
                );
            expect(disposePurposeLease)
                .toHaveBeenCalledWith(
                    'session-request-auth-changed-identity',
                );
            expect(pidToTrackedSession.get(tracked.pid))
                .toBe(tracked);
            expect(tracked.pid).toBe(41);
            expect(executeSpawnSessionRequest)
                .not.toHaveBeenCalled();

            const replacementCleanup =
                sessionAttachCleanupByPid.get(tracked.pid);
            expect(replacementCleanup)
                .not.toBe(previousAttachCleanup);
            expect(sessionAttachCleanupByPid.size).toBe(3);
            await replacementCleanup?.();
            await replacementCleanup?.();
            expect(previousAttachCleanup).toHaveBeenCalledOnce();
            expect(disposePurposeLease).toHaveBeenCalledTimes(3);
            expect(disposePurposeLease).toHaveBeenCalledWith(
                'session-request-auth-reattach',
            );
            expect(
                purposeLeaseCurrentBySessionId.get(
                    'session-request-auth-reattach',
                ),
            ).toBe(false);
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(
                    replacementDocument?.capability,
                )).toBeNull();
            expect(pidToTrackedSession.get(tracked.pid))
                .toBe(tracked);

            await controlInput?.beforeShutdown?.({
                managedLocalServicesDisposition: 'transfer',
            });
            expect(beforeShutdown).toHaveBeenCalledWith({
                managedLocalServicesDisposition: 'transfer',
            });
            await runtime.stopControlServer();
        } finally {
            fetchAccountProfile.mockRestore();
            await rm(materializationBaseDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('threads one request-auth registry through control routes and managed Provider launch', async () => {
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

        try {
            const controlInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
            expect(controlInput?.connectedAccountRequestAuth).toEqual(expect.objectContaining({
                authenticate: expect.any(Function),
                lookupRequestAuth: expect.any(Function),
                refreshAfterAuthFailure: expect.any(Function),
                reportQuotaFailure: expect.any(Function),
            }));

            await runtime.spawnSession({
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            });
            const spawnInput = vi.mocked(executeSpawnSessionRequest).mock.calls.at(-1)?.[0];
            const managedRuntime = spawnInput?.managedProviderEndpointRuntime;
            expect(managedRuntime).toEqual(expect.objectContaining({
                materializationBaseDir:
                    '/tmp/happier-test-home/providers/managed',
                requestAuthRegistry: expect.objectContaining({
                    activate: expect.any(Function),
                    retire: expect.any(Function),
                }),
            }));
            const registry = managedRuntime?.requestAuthRegistry as Readonly<{
                authenticate?: unknown;
            }> | undefined;
            expect(registry?.authenticate).toBe(
                controlInput?.connectedAccountRequestAuth?.authenticate,
            );
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('forwards the exact failed request-auth revision to the canonical refresh coordinator once', async () => {
        const refreshConnectedServiceCredentialForQuota = vi.fn(async () => ({
            kind: 'oauth',
        }));
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => ({
                refreshConnectedServiceCredentialForQuota,
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

        try {
            await connectedAccountRequestAuthServiceDependenciesCapture.current
                ?.refreshAfterAuthFailure({
                    resolved: {
                        account: {
                            service: {
                                pluginId: 'happier.agent.codex',
                                localId: 'openai-codex',
                            },
                            accountId: 'primary',
                        },
                        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                    },
                    failure: {
                        class: 'authentication',
                        evidence: {
                            httpStatus: 401,
                            limitCategory: 'auth_invalid',
                            quotaScope: 'unknown',
                            evidenceSource: { kind: 'structured' },
                        },
                    },
                });

            expect(refreshConnectedServiceCredentialForQuota).toHaveBeenCalledOnce();
            expect(refreshConnectedServiceCredentialForQuota).toHaveBeenCalledWith({
                serviceId: 'openai-codex',
                profileId: 'primary',
                force: true,
                expectedCredentialRevision:
                    'csr_0123456789ABCDEFGHJKMNPQRS',
            });
            expect(requestAuthSwitchAfterClassifiedFailureMock).not.toHaveBeenCalled();
            expect(handleConnectedServiceRuntimeAuthFailureForSessionMock).not.toHaveBeenCalled();
            expect(sendSessionMessageMock).not.toHaveBeenCalled();
        } finally {
            await runtime.stopControlServer();
        }
    });

    it.each([
        {
            label: 'advertised V4',
            support: 'advertised',
            qualifiedCalls: 1,
            legacyCalls: 0,
            rejectQualified: false,
        },
        {
            label: 'rejected advertised V4',
            support: 'advertised',
            qualifiedCalls: 1,
            legacyCalls: 0,
            rejectQualified: true,
        },
        {
            label: 'indeterminate capability',
            support: 'indeterminate',
            qualifiedCalls: 0,
            legacyCalls: 0,
            rejectQualified: false,
        },
        {
            label: 'absent V4 compatibility',
            support: 'absent',
            qualifiedCalls: 0,
            legacyCalls: 1,
            rejectQualified: false,
        },
    ] as const)(
        'routes request-auth group recovery through the canonical $label owner only',
        async ({
            support,
            qualifiedCalls,
            legacyCalls,
            rejectQualified,
        }) => {
        if (rejectQualified) {
            qualifiedRequestAuthSwitchAfterClassifiedFailureMock
                .mockRejectedValueOnce(
                    new Error(
                        'connect_group_source_revision_conflict',
                    ),
                );
        }
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: {
                    type: 'legacy',
                    secret: new Uint8Array(32).fill(1),
                },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir:
                '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            resolveQualifiedConnectedAccountV4Support: () =>
                support,
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

        try {
            await connectedAccountRequestAuthServiceDependenciesCapture
                .current?.reportQuotaFailure({
                    resolved: {
                        account: {
                            service: {
                                pluginId: 'happier.agent.codex',
                                localId: 'openai-codex',
                            },
                            accountId: 'primary',
                        },
                        group: {
                            groupId: 'fallbacks',
                            generation: 7,
                        },
                        credentialRevision:
                            'csr_0123456789ABCDEFGHJKMNPQRS',
                    },
                    failure: {
                        class: 'quota',
                        evidence: {
                            httpStatus: 429,
                            limitCategory: 'usage_limit',
                            quotaScope: 'account',
                            evidenceSource: {
                                kind: 'structured',
                            },
                        },
                    },
                });

            expect(
                qualifiedRequestAuthSwitchAfterClassifiedFailureMock,
            ).toHaveBeenCalledTimes(qualifiedCalls);
            if (qualifiedCalls === 1) {
                expect(
                    qualifiedRequestAuthSwitchAfterClassifiedFailureMock,
                ).toHaveBeenCalledWith(expect.objectContaining({
                    serviceId: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    groupId: 'fallbacks',
                    observedProfileId: 'primary',
                    expectedFailureSource: {
                        profileId: 'primary',
                        credentialRevision:
                            'csr_0123456789ABCDEFGHJKMNPQRS',
                        groupGeneration: 7,
                    },
                }));
            }
            expect(
                requestAuthSwitchAfterClassifiedFailureMock,
            ).toHaveBeenCalledTimes(legacyCalls);
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('fails request-auth backoff closed while quota automation is unavailable, then records after late startup initialization', async () => {
        const recordRequestAuthProviderBackoff = vi.fn(() => ({
            status: 'recorded' as const,
            consecutiveFailures: 1,
            nextAllowedAtMs: 10_500,
        }));
        const quotaCoordinator = {
            recordRequestAuthProviderBackoff,
        };
        let activeQuotaCoordinator: typeof quotaCoordinator | null = null;
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
            // This remains null during the startup window and permanently when quota automation
            // is feature-disabled or startup hydration fails.
            getConnectedServiceQuotasCoordinator: () => activeQuotaCoordinator as never,
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

        try {
            const dependencies = connectedAccountRequestAuthServiceDependenciesCapture.current;
            expect(dependencies).not.toBeNull();
            const quotaFailure = {
                resolved: {
                    account: {
                        service: {
                            pluginId: 'happier.agent.codex',
                            localId: 'openai-codex',
                        },
                        accountId: 'primary',
                    },
                    group: {
                        groupId: 'fallbacks',
                        generation: 7,
                    },
                    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                },
                failure: {
                    class: 'quota',
                    evidence: {
                        httpStatus: 429,
                        retryAfterMs: 500,
                        limitCategory: 'rate_limit',
                        quotaScope: 'provider',
                        evidenceSource: { kind: 'structured' },
                    },
                },
            } as const;

            await expect(
                dependencies?.reportQuotaFailure(quotaFailure),
            ).resolves.toEqual({ status: 'denied' });
            expect(recordRequestAuthProviderBackoff).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledWith(
                '[DAEMON RUN] Connected-account request-auth backoff unavailable',
                {
                    event: 'connected_account_request_auth_backoff_unavailable',
                    reason: 'backoff_owner_unavailable',
                    service: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    accountId: 'primary',
                    groupId: 'fallbacks',
                    groupGeneration: 7,
                    limitCategory: 'rate_limit',
                    quotaScope: 'provider',
                },
            );
            expect(requestAuthSwitchAfterClassifiedFailureMock).not.toHaveBeenCalled();
            expect(handleConnectedServiceRuntimeAuthFailureForSessionMock).not.toHaveBeenCalled();
            expect(sendSessionMessageMock).not.toHaveBeenCalled();
            expect(executeSpawnSessionRequest).not.toHaveBeenCalled();

            activeQuotaCoordinator = quotaCoordinator;
            recordRequestAuthProviderBackoff.mockImplementationOnce(() => {
                throw new Error('quota backoff owner failed');
            });
            await expect(
                dependencies?.reportQuotaFailure(quotaFailure),
            ).resolves.toEqual({ status: 'denied' });
            expect(logger.warn).toHaveBeenCalledWith(
                '[DAEMON RUN] Connected-account request-auth backoff unavailable',
                {
                    event: 'connected_account_request_auth_backoff_unavailable',
                    reason: 'backoff_record_failed',
                    service: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    accountId: 'primary',
                    groupId: 'fallbacks',
                    groupGeneration: 7,
                    limitCategory: 'rate_limit',
                    quotaScope: 'provider',
                },
            );

            await dependencies?.reportQuotaFailure(quotaFailure);
            expect(recordRequestAuthProviderBackoff).toHaveBeenCalledWith({
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'fallbacks',
                groupGeneration: 7,
                limitCategory: 'rate_limit',
                quotaScope: 'provider',
                retryAfterMs: 500,
                resetAtMs: null,
                providerCode: null,
            });
            expect(requestAuthSwitchAfterClassifiedFailureMock).not.toHaveBeenCalled();
            expect(handleConnectedServiceRuntimeAuthFailureForSessionMock).not.toHaveBeenCalled();
            expect(recordRequestAuthProviderBackoff).toHaveBeenCalledTimes(2);
            expect(sendSessionMessageMock).not.toHaveBeenCalled();
            expect(executeSpawnSessionRequest).not.toHaveBeenCalled();
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('derives continuation authority from explicit switch effects instead of live inFlight state', () => {
        const turnDeferralQueue = {
            getTurnLifecycleState: () => ({
                inFlight: true,
                hasProviderActivityThisTurn: true,
                forcedSwitchInterruptedLiveTurn: false,
            }),
        } as never;

        expect(resolveConnectedServiceContinuationInterruptionForSwitch({
            sessionId: 'session-hot',
            action: 'hot_applied',
            switchReason: 'manual',
            turnDeferralQueue,
        })).toBe('none');
        expect(resolveConnectedServiceContinuationInterruptionForSwitch({
            sessionId: 'session-hot-after-limit',
            action: 'hot_applied',
            switchReason: 'automatic_runtime_failure',
            groupSwitchTriggerReason: 'usage_limit',
            failureDriven: true,
            turnDeferralQueue,
        })).toBe('none');
        expect(resolveConnectedServiceContinuationInterruptionForSwitch({
            sessionId: 'session-clean',
            action: 'restart_requested',
            switchReason: 'manual',
            turnDeferralQueue,
        })).toBe('clean_boundary');
        expect(resolveConnectedServiceContinuationInterruptionForSwitch({
            sessionId: 'session-failure',
            interruptedSessionId: 'session-failure',
            action: 'restart_requested',
            switchReason: 'automatic_runtime_failure',
            failureDriven: true,
            turnDeferralQueue,
        })).toBe('provider_failed_turn');
    });

    function readStartDaemonSessionControlRuntimeSource(): string {
        return readFileSync(new URL('./startDaemonSessionControlRuntime.ts', import.meta.url), 'utf8');
    }

    // OWNER-GATE test seam: a deterministic browser daemon feature gate whose cached snapshot is
    // fixed. The startup runtime awaits refresh() once then reads isEnabled synchronously.
    type TestBrowserDaemonFeatureGateId =
        | 'browser.sidecar'
        | 'browser.context'
        | 'browser.automation'
        | 'browser.diagnostics'
        | 'browser.recording'
        | 'browser.recording.attachments'
        | 'attachments.uploads';

    const fakeBrowserGate = (enabled: Partial<Record<TestBrowserDaemonFeatureGateId, boolean>>) => ({
        isEnabled: (id: TestBrowserDaemonFeatureGateId) => enabled[id] === true,
        refresh: async () => {},
    });

    const createBrowserCapsSidecarAdapterFactory = (dispatchCommand: ReturnType<typeof vi.fn>) => vi.fn(() => ({
        ok: true as const,
        adapter: {
            adapterKind: 'chromiumSidecar' as const,
            ownsView: ({ browserSessionId, viewId }: { browserSessionId: string; viewId: string }) =>
                browserSessionId === 'browser_session_caps' && viewId === 'view_caps',
            supportsOpenView: () => false,
            dispatchCommand,
        },
    }));

    const browserCapsContextSourceFactory = () => vi.fn(() => ({
        capturePage: vi.fn(async () => ({
            ok: true as const,
            url: 'https://browser.example.test/caps',
            title: 'Caps',
        })),
        captureScreenshot: vi.fn(async () => ({ ok: false as const, reason: 'adapter_unavailable' as const })),
        captureSummary: vi.fn(async () => ({ ok: false as const, reason: 'adapter_unavailable' as const })),
        captureSelectedElement: vi.fn(async () => ({ ok: false as const, reason: 'adapter_unavailable' as const })),
        captureSnapshot: vi.fn(async () => ({
            ok: true as const,
            url: 'https://browser.example.test/caps',
            title: 'Caps',
            visibleText: 'Caps ready',
            axNodes: [{ role: 'button', name: 'Run' }],
            interactiveElements: [
                { role: 'button', name: 'Run', selector: '#run', rect: { x: 4, y: 8, width: 80, height: 24 } },
            ],
            consoleSummary: '[log] ready',
        })),
    }));

    beforeEach(() => {
        recoveryIntentFileStoresMock.storesByPath.clear();
        recoveryIntentFileStoresMock.effectClaimsByPath.clear();
        drainRuntimeAuthFailureReportOutboxToDaemonMock.mockClear();
        removeRuntimeAuthFailureReportOutboxItemsForSessionMock.mockClear();
        getConnectedServiceRuntimeAuthAdapterMock.mockClear();
        updateSessionMarkerActiveTurnMock.mockClear();
        vi.mocked(startDaemonControlServer).mockClear();
        vi.mocked(executeSpawnSessionRequest).mockClear();
        createIosSimulatorPlatformAdapterMock.mockClear();
        createAndroidSimulatorPlatformAdapterMock.mockClear();
        createComposedSimulatorPreviewAdapterMock.mockClear();
        simulatorPreviewAdapterStopMock.mockClear();
        simulatorPreviewAdapterStopMock.mockImplementation(async () => {});
        vi.mocked(materializeNextPendingQueueV2MessageViaHttp).mockReset();
        vi.mocked(materializeNextPendingQueueV2MessageViaHttp).mockImplementation(async () => ({
            didMaterialize: false,
            localId: null,
            didWrite: false,
            pendingQueueState: null,
            message: null,
        }));
        vi.mocked(callSessionRpc).mockReset();
        vi.mocked(callSessionRpc).mockImplementation(async () => ({ type: 'no_pending' }));
        createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock.mockClear();
        requestAuthSwitchAfterClassifiedFailureMock.mockClear();
        createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinatorMock
            .mockClear();
        qualifiedRequestAuthSwitchAfterClassifiedFailureMock.mockClear();
        connectedAccountRequestAuthServiceDependenciesCapture.current = null;
        sendSessionMessageMock.mockClear();
        createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock.mockClear();
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
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockReset();
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockImplementation(async () => ({
            registry: {
                contributes: createResolvedContributionRegistry({
                    agents: [],
                                    }),
            },
            source: 'active',
            release: vi.fn(async () => {}),
        }));
        listExecutionRunMarkersForRehydrationMock.mockReset();
        listExecutionRunMarkersForRehydrationMock.mockResolvedValue([]);
        isRuntimeRegistryCurrentMock.mockReset();
        isRuntimeRegistryCurrentMock.mockReturnValue(true);
        commitSessionStoredMessageMock.mockClear();
        commitRuntimeAuthRecoveryVisibleEventDeliveryMock.mockClear();
        requestConnectedServiceSessionRestartSignalMock.mockReset();
        requestConnectedServiceSessionRestartSignalMock.mockImplementation(async () => ({ status: 'requested' as const }));
        markSessionMarkerConnectedServiceRestartIntentMock.mockReset();
        markSessionMarkerConnectedServiceRestartIntentMock.mockImplementation(async () => true);
        clearSessionMarkerConnectedServiceRestartIntentMock.mockReset();
        clearSessionMarkerConnectedServiceRestartIntentMock.mockImplementation(async () => {});
        updateSessionMarkerAgentSessionStartupInstructionsMarkerMock.mockReset();
        updateSessionMarkerAgentSessionStartupInstructionsMarkerMock.mockImplementation(async () => true);
        removeSessionMarkerMock.mockReset();
        removeSessionMarkerMock.mockImplementation(async () => {});
        removeSessionMarkerIfOwnedMock.mockReset();
        removeSessionMarkerIfOwnedMock.mockImplementation(async () => true);
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
        vi.mocked(logger.debug).mockClear();
        vi.mocked(logger.info).mockClear();
        vi.mocked(logger.warn).mockClear();
    });

    it('rotates live execution-run request authority with the exact current control port after startup', async () => {
        const materializationBaseDir = await mkdtemp(
            join(tmpdir(), 'happier-run-startup-port-'),
        );
        const runId = 'run_startup_request_auth_port';
        const activationId = '11111111-1111-4111-8111-111111111111';
        const sessionId = 'session-startup-request-auth-port';
        const runnerPid = process.pid;
        const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
        const targetRegistrations: unknown[] = [];
        const unsubscribeTargetRegistrations =
            runtimeRegistry.subscribeTargetRegistrations((target) => {
                targetRegistrations.push(target);
            });
        const materializedRoot =
            resolveConnectedServiceMaterializedRootDir({
                baseDir: materializationBaseDir,
                materializationKey: runId,
                agentId: 'codex',
            });
        await mkdir(materializedRoot, {
            recursive: true,
            mode: 0o700,
        });
        const purpose = {
            consumer: {
                pluginId: 'happier.agent.codex',
                localId: 'codex',
            },
            purpose: 'primary',
        };
        const binding = {
            purpose,
            target: {
                kind: 'account' as const,
                account: {
                    service: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    accountId: 'profile_1',
                },
            },
        };
        const use = {
            purpose,
            materialization: {
                kind: 'httpHeaders' as const,
                origin: 'https://api.openai.com',
                headerNames: ['authorization'],
            },
        };
        const oldRegistry =
            createConnectedAccountRequestAuthSubjectRegistry();
        const oldDescriptor = await oldRegistry.activate({
            subject: {
                subjectId: 'old-daemon/run-startup-port',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: () => ({ binding, use }),
                listPurposeUses: () => [{ binding, use }],
            },
            materializedRootDir: materializedRoot,
            materializationId: runId,
            httpPort: 41111,
        });
        const oldDocument =
            await readConnectedAccountRequestAuthCapabilityFile(
                oldDescriptor.path,
            );
        if (!oldDocument) {
            throw new Error('expected predecessor execution-run capability');
        }

        const registration = {
            v: 1 as const,
            activationId,
            runKey: runId,
            agentId: 'codex' as const,
            materializationKey: runId,
            connectedServicesBindings: {
                v: 1 as const,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected' as const,
                        selection: 'profile' as const,
                        profileId: 'profile_1',
                    },
                },
            },
            connectedServiceSelectionsEnv: {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[]',
            },
            sessionDirectory: '/tmp/project',
            materializedRoot,
        };
        listExecutionRunMarkersForRehydrationMock.mockResolvedValueOnce([{
            runId,
            happySessionId: sessionId,
            happyHomeDir: configuration.happyHomeDir,
            pid: runnerPid,
            status: 'running',
            startedAtMs: 1,
            updatedAtMs: 1,
            executionRunConnectedServicesLaunchV1: registration,
        }] as never);
        acquireAuthoritativePluginRuntimeRegistryLeaseMock
            .mockImplementation(async () => ({
                registry: {
                    contributes: {
                        agentDefinitionsById: new Map([['codex', {
                            identity: purpose.consumer,
                            richDefinition: {
                                definition: {
                                    connectedAccounts: [{
                                        purpose: purpose.purpose,
                                        service: 'openai-codex',
                                    }],
                                },
                            },
                            catalogEntry: {
                                connectedAccountRequestAuthUses: [{
                                    purpose: purpose.purpose,
                                    materialization:
                                        use.materialization,
                                }],
                            },
                        }]]),
                    },
                },
                source: 'active',
                release: vi.fn(async () => {}),
            }));
        const activatePurposeBindings = vi.fn(
            (input: Readonly<{
                subject: Readonly<{
                    isCurrent(): boolean;
                }>;
            }>) => ({
                subjectId:
                    `execution-run:${runId}/runner:${runnerPid}/agent:codex`,
                isCurrent: input.subject.isCurrent,
                resolvePurposeBinding:
                    (candidate: typeof purpose) => (
                        JSON.stringify(candidate)
                            === JSON.stringify(purpose)
                            ? binding
                            : null
                    ),
                listPurposeBindings: () => [binding],
                dispose: vi.fn(),
            }),
        );
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            pid: runnerPid,
            happySessionId: sessionId,
        };
        let runtime:
            Awaited<ReturnType<typeof startDaemonSessionControlRuntime>>
            | null = null;
        try {
            runtime = await startDaemonSessionControlRuntime({
                machineId: 'machine-1',
                credentials: {
                    token: 'token-daemon',
                    encryption: {
                        type: 'legacy',
                        secret: new Uint8Array(32).fill(1),
                    },
                },
                api: {
                    getConnectedServiceAuthGroup: vi.fn(),
                    updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
                } as never,
                loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
                connectedServicesMaterializationBaseDir:
                    materializationBaseDir,
                getConnectedServiceRefreshCoordinator: () => null,
                getConnectedServiceQuotasCoordinator: () => null,
                connectedServiceRuntimeRegistry: runtimeRegistry,
                pidToTrackedSession:
                    new Map([[runnerPid, tracked]]),
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
                activatePurposeBindings:
                    activatePurposeBindings as never,
                processEnv: {},
            });

            const replacementDocument =
                await readConnectedAccountRequestAuthCapabilityFile(
                    oldDescriptor.path,
                );
            expect(replacementDocument).toMatchObject({
                httpPort: 43210,
            });
            expect(replacementDocument?.capability)
                .not.toBe(oldDocument.capability);
            const controlInput = vi
                .mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0];
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(oldDocument.capability)).toBeNull();
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(
                    replacementDocument?.capability,
                )).toMatchObject({
                    subjectId:
                        `execution-run:${runId}/runner:${runnerPid}/agent:codex/agent:codex`,
                });
            expect(activatePurposeBindings).toHaveBeenCalledWith(
                expect.objectContaining({
                    subject: expect.objectContaining({
                        kind: 'execution_run',
                        runId,
                        runnerPid,
                        agentId: 'codex',
                    }),
                }),
            );
            expect(runtimeRegistry.getRunTargetByRunKey(runId)).toMatchObject({
                pid: runnerPid,
                agentId: 'codex',
                materializationKey: runId,
                sessionId,
            });
            expect(targetRegistrations).toHaveLength(1);
            await controlInput
                ?.releaseConnectedServicesForExecutionRun?.({
                    runId,
                    runnerPid,
                    activationId,
                });
        } finally {
            unsubscribeTargetRegistrations();
            await runtime?.stopControlServer();
            await oldRegistry.retire(oldDescriptor)
                .catch(() => undefined);
            await rm(materializationBaseDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it.each(['replacement', 'exit'] as const)(
        'fails an execution-run generation check when the exact registry target has a deferred %s',
        async (transition) => {
            const runId = `run-generation-${transition}`;
            const runnerPid = transition === 'replacement' ? 6311 : 6312;
            const credentialRevision =
                'csr_0123456789ABCDEFGHJKMNPQRS';
            const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
            const registerTarget = () => runtimeRegistry.registerRunTarget({
                runKey: runId,
                pid: runnerPid,
                agentId: 'codex',
                materializationKey: runId,
                connectedServicesBindingsRaw: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'profile_1',
                        },
                    },
                },
                connectedServiceSelectionsEnv: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]:
                        JSON.stringify([{
                            kind: 'profile',
                            serviceId: 'openai-codex',
                            profileId: 'profile_1',
                            credentialRevision,
                        }]),
                },
            });
            registerTarget();
            let fetchEntered!: () => void;
            const entered = new Promise<void>((resolve) => {
                fetchEntered = resolve;
            });
            let releaseFetch!: () => void;
            const fetchGate = new Promise<void>((resolve) => {
                releaseFetch = resolve;
            });
            const accountProfileGet = vi.spyOn(axios, 'get')
                .mockImplementation(async () => {
                    fetchEntered();
                    await fetchGate;
                    return {
                        status: 200,
                        data: {
                            id: 'account-generation-currentness',
                            connectedServicesV2: [{
                                serviceId: 'openai-codex',
                                profiles: [{
                                    profileId: 'profile_1',
                                    status: 'connected',
                                    kind: 'oauth',
                                }],
                                groups: [],
                            }],
                            connectedServiceCredentialRevisionsV1: [{
                                serviceId: 'openai-codex',
                                profileId: 'profile_1',
                                credentialRevision,
                            }],
                        },
                    };
                });
            let runtime:
                Awaited<ReturnType<typeof startDaemonSessionControlRuntime>>
                | null = null;
            try {
                runtime = await startDaemonSessionControlRuntime({
                    machineId: `machine-generation-${transition}`,
                    credentials: {
                        token: 'token-daemon',
                        encryption: {
                            type: 'legacy',
                            secret: new Uint8Array(32).fill(1),
                        },
                    },
                    api: {} as never,
                    loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
                    connectedServicesMaterializationBaseDir:
                        '/tmp/connected-services',
                    getConnectedServiceRefreshCoordinator: () => null,
                    getConnectedServiceQuotasCoordinator: () => null,
                    connectedServiceRuntimeRegistry: runtimeRegistry,
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
                const controlInput = vi
                    .mocked(startDaemonControlServer)
                    .mock.calls.at(-1)?.[0];
                const check =
                    controlInput
                        ?.checkConnectedServicesGenerationForExecutionRun?.({
                            runId,
                            runnerPid,
                        });
                await entered;
                if (transition === 'replacement') {
                    registerTarget();
                } else {
                    runtimeRegistry.unregisterRunKey(runId);
                }
                releaseFetch();
                await expect(check).resolves.toEqual({
                    ok: true,
                    current: false,
                });
            } finally {
                accountProfileGet.mockRestore();
                releaseFetch();
                await runtime?.stopControlServer();
            }
        },
    );

    it('starts the request-auth control server before non-blocking retained managed Provider recovery', async () => {
        const sessionId = 'session-managed-provider-startup-nonblocking';
        const fetchAccountProfile = vi.spyOn(axios, 'get').mockResolvedValue({
            status: 200,
            data: {
                id: 'account-managed-provider-startup',
                connectedServicesV2: [],
                connectedServiceCredentialRevisionsV1: [],
            },
        });
        let resolveServerFeaturesSnapshot!: (
            snapshot: CliServerFeaturesSnapshot | undefined,
        ) => void;
        const serverFeaturesSnapshotPromise =
            new Promise<CliServerFeaturesSnapshot | undefined>((resolve) => {
                resolveServerFeaturesSnapshot = resolve;
            });
        const readServerFeaturesSnapshot = vi.fn(async () =>
            await serverFeaturesSnapshotPromise,
        );
        const tracked: TrackedSession = {
            pid: 5101,
            startedBy: 'daemon',
            happySessionId: sessionId,
        };

        const runtimePromise = startDaemonSessionControlRuntime({
            machineId: 'machine-managed-provider-startup-nonblocking',
            credentials: {
                token: 'token-daemon',
                encryption: {
                    type: 'legacy',
                    secret: new Uint8Array(32).fill(1),
                },
            },
            api: {} as never,
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
            startupManagedProviderRecoveryCandidates: [{
                pid: tracked.pid,
                sessionId,
                attachment: {
                    v: 1,
                    process: {
                        pid: 5102,
                        processStartTimeMs: 1_717_171_717_654,
                        processCommandHash: 'c'.repeat(64),
                    },
                    endpoint: {
                        host: '127.0.0.1',
                        port: 45_321,
                    },
                    materialization: {
                        rootDir:
                            '/tmp/managed-provider-startup-nonblocking',
                        materializationId:
                            'managed-provider-startup-nonblocking',
                    },
                },
                markerOwnership: {
                    happySessionId: sessionId,
                    processCommandHash: 'b'.repeat(64),
                    processStartTimeMs: 1_717_171_717_321,
                },
            }],
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
            resolveServerFeaturesSnapshot: readServerFeaturesSnapshot,
            browserDaemonFeatureGate: fakeBrowserGate({}),
        });

        let controlServerStartedBeforeRecoveryReadiness = false;
        let connectedServiceProjectionLoadedBeforeRecoveryReadiness = false;
        let fetchAccountProfileCall:
            | Parameters<typeof axios.get>
            | undefined;
        let fetchAccountProfileInvocationOrder: number | undefined;
        try {
            await waitForStartupCondition(
                () => vi.mocked(startDaemonControlServer).mock.calls.length > 0,
            );
            controlServerStartedBeforeRecoveryReadiness = true;
            try {
                await waitForStartupCondition(
                    () => fetchAccountProfile.mock.calls.length > 0,
                );
                connectedServiceProjectionLoadedBeforeRecoveryReadiness = true;
            } catch {
                // The assertions below record the missing startup projection boundary.
            }
        } catch {
            // The assertion below records the daemon-startup barrier directly.
        } finally {
            if (controlServerStartedBeforeRecoveryReadiness) {
                const runtime = await runtimePromise;
                await runtime.stopControlServer();
                resolveServerFeaturesSnapshot(undefined);
                await Promise.resolve();
                await Promise.resolve();
            } else {
                resolveServerFeaturesSnapshot(undefined);
                const runtime = await runtimePromise;
                await runtime.stopControlServer();
            }
            fetchAccountProfileCall = fetchAccountProfile.mock.calls[0];
            fetchAccountProfileInvocationOrder =
                fetchAccountProfile.mock.invocationCallOrder[0];
            fetchAccountProfile.mockRestore();
        }

        expect(controlServerStartedBeforeRecoveryReadiness).toBe(true);
        expect(
            connectedServiceProjectionLoadedBeforeRecoveryReadiness,
        ).toBe(true);
        expect(
            refreshAccountSettingsForMinimumVersionMock,
        ).toHaveBeenCalledTimes(1);
        expect(fetchAccountProfileCall).toEqual([
            expect.stringContaining('/v1/account/profile'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-daemon',
                }),
            }),
        ]);
        expect(readServerFeaturesSnapshot).toHaveBeenCalledTimes(1);
        expect(
            vi.mocked(startDaemonControlServer)
                .mock.invocationCallOrder.at(-1),
        ).toBeLessThan(
            refreshAccountSettingsForMinimumVersionMock
                .mock.invocationCallOrder[0]!,
        );
        expect(
            refreshAccountSettingsForMinimumVersionMock
                .mock.invocationCallOrder[0],
        ).toBeLessThan(
            fetchAccountProfileInvocationOrder!,
        );
        expect(
            fetchAccountProfileInvocationOrder,
        ).toBeLessThan(
            readServerFeaturesSnapshot.mock.invocationCallOrder[0]!,
        );
        expect(logger.debug).not.toHaveBeenCalledWith(
            '[DAEMON RUN] Managed Provider startup recovery left request-auth unavailable',
            expect.objectContaining({
                sessionId: tracked.happySessionId,
            }),
        );
    });

    it('rejects internal spawn requests once daemon shutdown is quiescing new work', async () => {
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
            isShuttingDown: () => true,
            processEnv: {},
        });

        const result = await runtime.spawnSession({
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        });

        expect(result).toEqual({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
            errorMessage: 'Daemon is shutting down',
        });
        expect(executeSpawnSessionRequest).not.toHaveBeenCalled();

        await runtime.stopControlServer();
    });

    it('completes fresh resume admission only for the external control-server spawn boundary', async () => {
        const originalCreateSessionRunnerRespawnManager =
            sessionRunnerRespawnModule.createSessionRunnerRespawnManager;
        const completedAdmissions: Array<ReturnType<typeof vi.fn>> = [];
        const prepareFreshExplicitResumeAdmission = vi.fn();
        const createManagerSpy = vi.spyOn(
            sessionRunnerRespawnModule,
            'createSessionRunnerRespawnManager',
        ).mockImplementation((params) => {
            const manager = originalCreateSessionRunnerRespawnManager(params);
            prepareFreshExplicitResumeAdmission.mockImplementation((sessionId: string) => {
                const complete = manager.prepareFreshExplicitResumeAdmission(sessionId);
                const observedComplete = vi.fn(complete);
                completedAdmissions.push(observedComplete);
                return observedComplete;
            });
            return {
                ...manager,
                prepareFreshExplicitResumeAdmission,
            };
        });
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

        try {
            const resumeOptions = {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                existingSessionId: 'session-stopped',
            } satisfies SpawnSessionOptions;

            await expect(runtime.spawnSession(resumeOptions)).resolves.toEqual(
                expect.objectContaining({ type: 'success' }),
            );
            expect(prepareFreshExplicitResumeAdmission).not.toHaveBeenCalled();

            const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
            if (!controlServerInput) throw new Error('Expected control server input');
            await expect(controlServerInput.spawnSession(resumeOptions)).resolves.toEqual(
                expect.objectContaining({ type: 'success' }),
            );
            expect(prepareFreshExplicitResumeAdmission).toHaveBeenCalledTimes(1);
            expect(completedAdmissions).toHaveLength(1);
            expect(completedAdmissions[0]).toHaveBeenCalledTimes(1);

            vi.mocked(executeSpawnSessionRequest).mockResolvedValueOnce({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'spawn rejected',
            });
            await expect(controlServerInput.spawnSession({
                ...resumeOptions,
                existingSessionId: 'session-failed',
            })).resolves.toEqual(expect.objectContaining({ type: 'error' }));
            expect(completedAdmissions).toHaveLength(2);
            expect(completedAdmissions[1]).not.toHaveBeenCalled();
        } finally {
            await runtime.stopControlServer();
            createManagerSpy.mockRestore();
        }
    });

    it('keeps internal resumes stop-fenced while real child-exit cleanup still respawns an unstopped crash', async () => {
        const stoppedSessionId = 'session-internal-resume-stop-fence';
        const crashedSessionId = 'session-unstopped-crash';
        const pidToTrackedSession = new Map<number, TrackedSession>();
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
            processEnv: {
                HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS: '50',
                HAPPIER_DAEMON_SESSION_RESPAWN_MAX_DELAY_MS: '50',
                HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS: '0',
            },
        });

        const stoppedResumeOptions = {
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            existingSessionId: stoppedSessionId,
        } satisfies SpawnSessionOptions;
        const crashedResumeOptions = {
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            existingSessionId: crashedSessionId,
        } satisfies SpawnSessionOptions;

        try {
            await runtime.stopSession(stoppedSessionId);
            await expect(runtime.spawnSession(stoppedResumeOptions)).resolves.toEqual(
                expect.objectContaining({ type: 'success' }),
            );
            expect(executeSpawnSessionRequest).toHaveBeenCalledTimes(1);

            pidToTrackedSession.set(8801, {
                pid: 8801,
                startedBy: 'daemon',
                happySessionId: stoppedSessionId,
                spawnOptions: stoppedResumeOptions,
            });
            await runtime.onChildExited(8801, {
                reason: 'process-exited',
                code: 1,
                signal: null,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(executeSpawnSessionRequest).toHaveBeenCalledTimes(1);
            expect(pidToTrackedSession.has(8801)).toBe(false);

            pidToTrackedSession.set(8802, {
                pid: 8802,
                startedBy: 'daemon',
                happySessionId: crashedSessionId,
                spawnOptions: crashedResumeOptions,
            });
            await runtime.onChildExited(8802, {
                reason: 'process-exited',
                code: 1,
                signal: null,
            });
            await vi.waitFor(() => {
                expect(executeSpawnSessionRequest).toHaveBeenCalledTimes(2);
            }, { timeout: 1_000 });
            expect(vi.mocked(executeSpawnSessionRequest).mock.calls[1]?.[0]).toEqual(
                expect.objectContaining({
                    options: expect.objectContaining({
                        existingSessionId: crashedSessionId,
                    }),
                }),
            );
            expect(pidToTrackedSession.has(8802)).toBe(false);
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('preserves scheduled crash markers and never closes a recovered already-running Session', async () => {
        type RespawnManagerOptions =
            Parameters<typeof sessionRunnerRespawnModule.createSessionRunnerRespawnManager>[0];
        const managerOptionsRef: { current: RespawnManagerOptions | null } = { current: null };
        const getManagerOptions = (): RespawnManagerOptions => {
            if (!managerOptionsRef.current) throw new Error('Expected respawn manager options');
            return managerOptionsRef.current;
        };
        let disposition: 'scheduled' | 'already_running' = 'scheduled';
        const managerSpy = vi.spyOn(sessionRunnerRespawnModule, 'createSessionRunnerRespawnManager')
            .mockImplementation((options) => {
                managerOptionsRef.current = options;
                return {
                    markStopRequested: vi.fn(),
                    prepareFreshExplicitResumeAdmission: vi.fn(() => vi.fn()),
                    handleUnexpectedExit: vi.fn((tracked) => {
                        if (disposition === 'already_running') {
                            options.onRespawnTerminal?.({
                                sessionId: tracked.happySessionId!,
                                previousPid: tracked.pid,
                                reason: 'already_running',
                            });
                            return 'terminal';
                        }
                        return 'scheduled';
                    }),
                };
            });
        const captureMachineSessionTerminal = vi.fn(async (sessionId: string) => ({
            v: 1 as const,
            status: 'captured' as const,
            sessionId,
            committedFenceMs: 12,
        }));
        const finalizeMachineSessionTerminal = vi.fn(async (target: { sessionId: string }) => ({
            v: 1 as const,
            status: 'closed' as const,
            sessionId: target.sessionId,
        }));
        const enqueueDaemonTerminalExactTurnEnd = vi.fn(async () => undefined);
        const apiMachine = {
            captureMachineSessionTerminal,
            finalizeMachineSessionTerminal,
            enqueueDaemonTerminalExactTurnEnd,
        };
        let activeApiMachine: typeof apiMachine | null = null;
        const pidToTrackedSession = new Map<number, TrackedSession>();
        const connectedServicesRestartRequestedPids = new Set<number>();
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
            getApiMachineForSessions: () => activeApiMachine as never,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids,
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        }).catch((error) => {
            managerSpy.mockRestore();
            throw error;
        });
        activeApiMachine = apiMachine;

        try {
            const spawnOptions = {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
                existingSessionId: 'session-crash-marker',
            } satisfies SpawnSessionOptions;
            pidToTrackedSession.set(8911, {
                pid: 8911,
                startedBy: 'daemon',
                happySessionId: 'session-crash-marker',
                spawnOptions,
            });
            await runtime.onChildExited(8911, { reason: 'process-exited', code: 1, signal: null });
            expect(captureMachineSessionTerminal).toHaveBeenCalledWith('session-crash-marker');
            expect(removeSessionMarkerIfOwnedMock).not.toHaveBeenCalled();

            getManagerOptions().onRespawnSuccess?.({
                sessionId: 'session-crash-marker',
                previousPid: 8911,
                result: { type: 'success' },
            });
            await vi.waitFor(() => expect(removeSessionMarkerIfOwnedMock).toHaveBeenCalledWith(
                expect.objectContaining({ pid: 8911, happySessionId: 'session-crash-marker' }),
            ));
            expect(finalizeMachineSessionTerminal).not.toHaveBeenCalled();

            disposition = 'already_running';
            removeSessionMarkerIfOwnedMock.mockClear();
            pidToTrackedSession.set(8912, {
                pid: 8912,
                startedBy: 'daemon',
                happySessionId: 'session-recovered-live',
                spawnOptions: { ...spawnOptions, existingSessionId: 'session-recovered-live' },
            });
            await runtime.onChildExited(8912, { reason: 'process-exited', code: 1, signal: null });
            await vi.waitFor(() => expect(removeSessionMarkerIfOwnedMock).toHaveBeenCalledWith(
                expect.objectContaining({ pid: 8912, happySessionId: 'session-recovered-live' }),
            ));
            expect(finalizeMachineSessionTerminal).not.toHaveBeenCalled();

            disposition = 'scheduled';
            const immutableTracked: TrackedSession = {
                pid: 8915,
                startedBy: 'daemon',
                happySessionId: 'session-immutable-fence',
                activeTurnId: 'turn-immutable',
                spawnOptions: {
                    ...spawnOptions,
                    existingSessionId: 'session-immutable-fence',
                },
            };
            pidToTrackedSession.set(8915, immutableTracked);
            captureMachineSessionTerminal.mockResolvedValueOnce({
                v: 1,
                status: 'captured',
                sessionId: 'session-immutable-fence',
                committedFenceMs: 31,
            });
            enqueueDaemonTerminalExactTurnEnd.mockRejectedValueOnce(new Error('stage unavailable'));
            await runtime.onChildExited(8915, { reason: 'process-exited', code: 1, signal: null });
            expect(pidToTrackedSession.get(8915)).toBe(immutableTracked);
            await runtime.onChildExited(8915, { reason: 'process-exited', code: 1, signal: null });
            expect(captureMachineSessionTerminal).toHaveBeenCalledTimes(3);
            getManagerOptions().onRespawnTerminal?.({
                sessionId: 'session-immutable-fence',
                previousPid: 8915,
                reason: 'no_restart',
            });
            await vi.waitFor(() => expect(finalizeMachineSessionTerminal).toHaveBeenCalledWith({
                sessionId: 'session-immutable-fence',
                committedFenceMs: 31,
            }));

            removeSessionMarkerIfOwnedMock.mockClear();
            captureMachineSessionTerminal
                .mockResolvedValueOnce({
                    v: 1,
                    status: 'captured',
                    sessionId: 'session-pre-webhook-cycle',
                    committedFenceMs: 21,
                })
                .mockResolvedValueOnce({
                    v: 1,
                    status: 'captured',
                    sessionId: 'session-pre-webhook-cycle',
                    committedFenceMs: 22,
                });
            for (const pid of [8913, 8914]) {
                pidToTrackedSession.set(pid, {
                    pid,
                    startedBy: 'daemon',
                    happySessionId: 'session-pre-webhook-cycle',
                    spawnOptions: {
                        ...spawnOptions,
                        existingSessionId: 'session-pre-webhook-cycle',
                    },
                });
                await runtime.onChildExited(pid, {
                    reason: 'process-exited-before-webhook',
                    code: 1,
                    signal: null,
                });
            }
            getManagerOptions().onRespawnTerminal?.({
                sessionId: 'session-pre-webhook-cycle',
                previousPid: 8914,
                reason: 'no_restart',
            });
            await vi.waitFor(() => expect(finalizeMachineSessionTerminal).toHaveBeenCalledWith({
                sessionId: 'session-pre-webhook-cycle',
                committedFenceMs: 22,
            }));
            await vi.waitFor(() => {
                expect(removeSessionMarkerIfOwnedMock).toHaveBeenCalledWith(
                    expect.objectContaining({ pid: 8913 }),
                );
                expect(removeSessionMarkerIfOwnedMock).toHaveBeenCalledWith(
                    expect.objectContaining({ pid: 8914 }),
                );
            });

            removeSessionMarkerIfOwnedMock.mockClear();
            captureMachineSessionTerminal
                .mockResolvedValueOnce({
                    v: 1,
                    status: 'captured',
                    sessionId: 'session-pre-webhook-success',
                    committedFenceMs: 61,
                })
                .mockResolvedValueOnce({
                    v: 1,
                    status: 'captured',
                    sessionId: 'session-pre-webhook-success',
                    committedFenceMs: 62,
                });
            for (const pid of [8922, 8923]) {
                pidToTrackedSession.set(pid, {
                    pid,
                    startedBy: 'daemon',
                    happySessionId: 'session-pre-webhook-success',
                    spawnOptions: {
                        ...spawnOptions,
                        existingSessionId: 'session-pre-webhook-success',
                    },
                });
                await runtime.onChildExited(pid, {
                    reason: 'process-exited-before-webhook',
                    code: 1,
                    signal: null,
                });
            }
            const finalizeCountBeforePreWebhookSuccess =
                finalizeMachineSessionTerminal.mock.calls.length;
            getManagerOptions().onRespawnSuccess?.({
                sessionId: 'session-pre-webhook-success',
                previousPid: 8923,
                result: { type: 'success' },
            });
            await vi.waitFor(() => {
                expect(removeSessionMarkerIfOwnedMock).toHaveBeenCalledWith(
                    expect.objectContaining({ pid: 8922 }),
                );
                expect(removeSessionMarkerIfOwnedMock).toHaveBeenCalledWith(
                    expect.objectContaining({ pid: 8923 }),
                );
            });
            expect(finalizeMachineSessionTerminal).toHaveBeenCalledTimes(
                finalizeCountBeforePreWebhookSuccess,
            );

            let releaseLateSuccessMarker!: () => void;
            const lateSuccessMarker = new Promise<void>((resolve) => {
                releaseLateSuccessMarker = resolve;
            });
            removeSessionMarkerIfOwnedMock.mockImplementation(async ({ pid }: { pid: number }) => {
                if (pid === 8916) await lateSuccessMarker;
                return true;
            });
            captureMachineSessionTerminal
                .mockResolvedValueOnce({
                    v: 1,
                    status: 'captured',
                    sessionId: 'session-late-success',
                    committedFenceMs: 41,
                })
                .mockResolvedValueOnce({
                    v: 1,
                    status: 'captured',
                    sessionId: 'session-late-success',
                    committedFenceMs: 42,
                });
            pidToTrackedSession.set(8916, {
                pid: 8916,
                startedBy: 'daemon',
                happySessionId: 'session-late-success',
                spawnOptions: {
                    ...spawnOptions,
                    existingSessionId: 'session-late-success',
                },
            });
            await runtime.onChildExited(8916, { reason: 'process-exited', code: 1, signal: null });
            getManagerOptions().onRespawnSuccess?.({
                sessionId: 'session-late-success',
                previousPid: 8916,
                result: { type: 'success' },
            });
            await vi.waitFor(() => expect(removeSessionMarkerIfOwnedMock).toHaveBeenCalledWith(
                expect.objectContaining({ pid: 8916 }),
            ));
            pidToTrackedSession.set(8917, {
                pid: 8917,
                startedBy: 'daemon',
                happySessionId: 'session-late-success',
                spawnOptions: {
                    ...spawnOptions,
                    existingSessionId: 'session-late-success',
                },
            });
            await runtime.onChildExited(8917, { reason: 'process-exited', code: 1, signal: null });
            getManagerOptions().onRespawnTerminal?.({
                sessionId: 'session-late-success',
                previousPid: 8917,
                reason: 'no_restart',
            });
            await vi.waitFor(() => expect(finalizeMachineSessionTerminal).toHaveBeenCalledWith({
                sessionId: 'session-late-success',
                committedFenceMs: 42,
            }));
            await vi.waitFor(() => expect(removeSessionMarkerIfOwnedMock).toHaveBeenCalledWith(
                expect.objectContaining({ pid: 8917 }),
            ));
            releaseLateSuccessMarker();

            removeSessionMarkerIfOwnedMock.mockReset();
            removeSessionMarkerIfOwnedMock.mockResolvedValue(true);
            const captureCountBeforeLiveReplacement = captureMachineSessionTerminal.mock.calls.length;
            const finalizeCountBeforeLiveReplacement = finalizeMachineSessionTerminal.mock.calls.length;
            const oldPid = 8920;
            const livePid = 8921;
            connectedServicesRestartRequestedPids.add(oldPid);
            pidToTrackedSession.set(oldPid, {
                pid: oldPid,
                startedBy: 'daemon',
                happySessionId: 'session-live-replacement',
                activeTurnId: 'turn-obsolete',
                spawnOptions: {
                    ...spawnOptions,
                    existingSessionId: 'session-live-replacement',
                },
            });
            pidToTrackedSession.set(livePid, {
                pid: livePid,
                startedBy: 'daemon',
                happySessionId: 'session-live-replacement',
                spawnOptions: {
                    ...spawnOptions,
                    existingSessionId: 'session-live-replacement',
                },
            });
            const originalKill = process.kill.bind(process);
            const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: any) => {
                if (pid === livePid && signal === 0) return true;
                return originalKill(pid, signal);
            }) as any);
            await runtime.onChildExited(oldPid, { reason: 'process-exited', code: 1, signal: null });
            expect(captureMachineSessionTerminal).toHaveBeenCalledTimes(captureCountBeforeLiveReplacement);
            expect(finalizeMachineSessionTerminal).toHaveBeenCalledTimes(finalizeCountBeforeLiveReplacement);
            expect(removeSessionMarkerIfOwnedMock).toHaveBeenCalledWith(
                expect.objectContaining({ pid: oldPid, happySessionId: 'session-live-replacement' }),
            );
            killSpy.mockRestore();
        } finally {
            await runtime.stopControlServer();
            managerSpy.mockRestore();
        }
    });

    it.each([
        ['omits a machine id', undefined],
        ['supplies a different machine id', 'untrusted-machine'],
    ])('uses the authoritative daemon machine identity when a spawn request %s', async (_label, requestMachineId) => {
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-authoritative',
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
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            ...(requestMachineId ? { machineId: requestMachineId } : {}),
        });

        expect(executeSpawnSessionRequest).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                machineId: 'machine-authoritative',
            }),
        }));

        await runtime.stopControlServer();
    });

    it('repairs dead unresolved terminal topology through the canonical Stop owner before Resume', async () => {
        const originalCreateSessionRunnerRespawnManager =
            sessionRunnerRespawnModule.createSessionRunnerRespawnManager;
        const markStopRequested = vi.fn();
        const managerSpy = vi.spyOn(
            sessionRunnerRespawnModule,
            'createSessionRunnerRespawnManager',
        ).mockImplementation((params) => {
            const manager = originalCreateSessionRunnerRespawnManager(params);
            return {
                ...manager,
                markStopRequested: (...args) => {
                    markStopRequested(...args);
                    return manager.markStopRequested(...args);
                },
            };
        });
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-terminal-recovery',
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
            startupTerminalRecovery: {
                disconnectedTerminalHostCandidates: [],
                unresolvedTerminalHostSessionIds: ['session-unresolved-terminal'],
            },
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        try {
            await expect(runtime.spawnSession({
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                existingSessionId: 'session-unresolved-terminal',
            })).resolves.toEqual({ type: 'success', sessionId: 'spawned-session' });
            expect(markStopRequested).toHaveBeenCalledWith(
                'session-unresolved-terminal',
                expect.objectContaining({ reason: 'daemon_stop_session' }),
            );
            expect(executeSpawnSessionRequest).toHaveBeenCalledTimes(1);
        } finally {
            await runtime.stopControlServer();
            managerSpy.mockRestore();
        }
    });

    it('retires an exact positively dead startup attachment before launching a fresh Resume', async () => {
        const sessionId = 'session-exact-dead-terminal';
        const attachment = await writeTerminalHostAttachmentInfo({
            happyHomeDir: configuration.happyHomeDir,
            sessionId,
            handle: {
                kind: 'tmux',
                sessionName: 'happier-exact-dead-terminal',
                paneId: 'pane-dead',
                attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
            },
        });
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-exact-dead-terminal-recovery',
            credentials: { token: 'token-daemon', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(), pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(), connectedServicesRestartRequestedPids: new Set(),
            loadTerminalHostAdapters: async () => ({
                tmux: {
                    kind: 'tmux', createOrAttachHost: vi.fn(), injectUserPrompt: vi.fn(), interruptTurn: vi.fn(),
                    evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 1 })),
                    dispose: vi.fn(async () => undefined),
                },
            }),
            startupTerminalRecovery: {
                disconnectedTerminalHostCandidates: [{
                    sessionId,
                    pid: 2_147_482_999,
                    happyHomeDir: configuration.happyHomeDir,
                    attachmentId: attachment.attachmentId,
                    handle: attachment.handle,
                    controlDescriptorAvailable: false,
                }],
                unresolvedTerminalHostSessionIds: [],
            },
            beforeShutdown: vi.fn(), onHappySessionWebhook: vi.fn(), requestShutdown: vi.fn(), processEnv: {},
        });
        try {
            await expect(runtime.spawnSession({
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                existingSessionId: sessionId,
            })).resolves.toEqual({ type: 'success', sessionId: 'spawned-session' });
            expect(executeSpawnSessionRequest).toHaveBeenCalledTimes(1);
            await expect(readTerminalHostAttachmentInfo({
                happyHomeDir: configuration.happyHomeDir,
                sessionId,
            })).resolves.toBeNull();
        } finally {
            await runtime.stopControlServer();
            await removeTerminalHostAttachmentInfo({
                happyHomeDir: configuration.happyHomeDir,
                sessionId,
                expectedAttachmentId: attachment.attachmentId,
            });
        }
    });

    it('fences Resume before runner launch for an exact live host without a control descriptor', async () => {
        const sessionId = 'session-exact-live-terminal';
        const attachment = await writeTerminalHostAttachmentInfo({
            happyHomeDir: configuration.happyHomeDir,
            sessionId,
            handle: {
                kind: 'tmux',
                sessionName: 'happier-exact-live-terminal',
                paneId: 'pane-1',
                attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
            },
        });
        const dispose = vi.fn(async () => undefined);
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-exact-terminal-recovery',
            credentials: { token: 'token-daemon', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(), pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(), connectedServicesRestartRequestedPids: new Set(),
            loadTerminalHostAdapters: async () => ({
                tmux: {
                    kind: 'tmux', createOrAttachHost: vi.fn(), injectUserPrompt: vi.fn(), interruptTurn: vi.fn(),
                    evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })), dispose,
                },
            }),
            startupTerminalRecovery: {
                disconnectedTerminalHostCandidates: [{
                    sessionId,
                    pid: 2_147_483_000,
                    happyHomeDir: configuration.happyHomeDir,
                    attachmentId: attachment.attachmentId,
                    handle: attachment.handle,
                    controlDescriptorAvailable: false,
                }],
                unresolvedTerminalHostSessionIds: [],
            },
            beforeShutdown: vi.fn(), onHappySessionWebhook: vi.fn(), requestShutdown: vi.fn(), processEnv: {},
        });
        try {
            await expect(runtime.spawnSession({
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                existingSessionId: sessionId,
            })).resolves.toMatchObject({ type: 'error' });
            expect(executeSpawnSessionRequest).not.toHaveBeenCalled();
            expect(dispose).not.toHaveBeenCalled();

            await expect(runtime.stopSession(sessionId)).resolves.toEqual({ status: 'stopped' });
            expect(dispose).toHaveBeenCalledWith(attachment.handle);

            await expect(runtime.spawnSession({
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                existingSessionId: sessionId,
            })).resolves.toEqual({ type: 'success', sessionId: 'spawned-session' });
            expect(executeSpawnSessionRequest).toHaveBeenCalledTimes(1);
        } finally {
            await runtime.stopControlServer();
            await removeTerminalHostAttachmentInfo({
                happyHomeDir: configuration.happyHomeDir,
                sessionId,
                expectedAttachmentId: attachment.attachmentId,
            });
        }
    });

    it('allows Resume after the tracked-runner stop path retires the cached exact host candidate', async () => {
        const sessionId = 'session-exact-live-terminal-tracked-stop';
        const trackedPid = 2_147_483_001;
        const attachment = await writeTerminalHostAttachmentInfo({
            happyHomeDir: configuration.happyHomeDir,
            sessionId,
            handle: {
                kind: 'tmux',
                sessionName: 'happier-exact-live-terminal-tracked-stop',
                paneId: 'pane-2',
                attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
            },
        });
        const dispose = vi.fn(async () => undefined);
        const trackedSessions = new Map<number, TrackedSession>([
            [trackedPid, {
                startedBy: 'terminal',
                happySessionId: sessionId,
                pid: trackedPid,
                processCommandHash: 'hash-session-exact-live-terminal-tracked-stop',
                spawnOptions: {
                    directory: '/tmp/project',
                    existingSessionId: sessionId,
                    terminal: { mode: 'tmux' as const },
                },
            }],
        ]);
        const pidSafetyModule = await import('../pidSafety');
        const pidSafetySpy = vi.spyOn(pidSafetyModule, 'isPidSafeHappySessionProcess').mockResolvedValue(true);
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
            if (signal === 0) return true;
            if (targetPid === trackedPid && signal === 'SIGTERM') {
                trackedSessions.delete(trackedPid);
                return true;
            }
            return true;
        }) as typeof process.kill);
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-exact-terminal-recovery-tracked-stop',
            credentials: { token: 'token-daemon', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: trackedSessions,
            pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(), connectedServicesRestartRequestedPids: new Set(),
            loadTerminalHostAdapters: async () => ({
                tmux: {
                    kind: 'tmux', createOrAttachHost: vi.fn(), injectUserPrompt: vi.fn(), interruptTurn: vi.fn(),
                    evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })), dispose,
                },
            }),
            startupTerminalRecovery: {
                disconnectedTerminalHostCandidates: [{
                    sessionId,
                    pid: 2_147_483_001,
                    happyHomeDir: configuration.happyHomeDir,
                    attachmentId: attachment.attachmentId,
                    handle: attachment.handle,
                    controlDescriptorAvailable: false,
                }],
                unresolvedTerminalHostSessionIds: [],
            },
            beforeShutdown: vi.fn(), onHappySessionWebhook: vi.fn(), requestShutdown: vi.fn(), processEnv: {},
        });
        try {
            await expect(runtime.stopSession(sessionId)).resolves.toEqual({ status: 'stopped' });
            expect(dispose).toHaveBeenCalledWith(attachment.handle);
            expect(killSpy).toHaveBeenCalledWith(trackedPid, 'SIGTERM');

            await expect(runtime.spawnSession({
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                existingSessionId: sessionId,
            })).resolves.toEqual({ type: 'success', sessionId: 'spawned-session' });
            expect(executeSpawnSessionRequest).toHaveBeenCalledTimes(1);
        } finally {
            pidSafetySpy.mockRestore();
            killSpy.mockRestore();
            await runtime.stopControlServer();
            await removeTerminalHostAttachmentInfo({
                happyHomeDir: configuration.happyHomeDir,
                sessionId,
                expectedAttachmentId: attachment.attachmentId,
            });
        }
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

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-usage',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getAccountEncryptionMode: vi.fn(async () => 'plain'),
                getServerFeaturesSnapshot: vi.fn(
                    async () => providerAccountUsageV4ServerFeatures,
                ),
                getProviderAccountUsageWriteRouteAvailability: vi.fn(
                    async () => 'available' as const,
                ),
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
            status: 'snapshot_advanced',
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
                    accountSubject: { kind: 'providerSubject', id: 'acct_123' },
                }),
            },
        }));
    });

    it('normalizes qualified account usage to the current registered generation before persistence and quota policy', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const recordKey = {
            providerId: 'codex',
            accountSubjectId: 'acct_group_usage',
            subjectKind: 'account',
            quotaScope: 'account',
        } as const;
        const snapshot: ProviderAccountUsageSnapshotV1 = {
            v: 1,
            recordId: buildProviderAccountUsageRecordId(recordKey),
            recordKey,
            providerId: 'codex',
            accountSubject: { kind: 'providerSubject', id: 'acct_group_usage' },
            observedAtMs: 900,
            fetchedAtMs: 1_000,
            staleAfterMs: 60_000,
            source: 'runtimeSignal',
            confidence: 'confirmed',
            state: 'loaded_data',
            meters: [{
                meterId: 'primary',
                label: 'Primary',
                used: 10,
                limit: 100,
                unit: 'requests',
                utilizationPct: 10,
                remainingPct: 90,
                resetsAt: 10_000,
                status: 'ok',
                details: {},
            }],
        };
        let releasePolicy!: () => void;
        const policyBarrier = new Promise<void>((resolve) => {
            releasePolicy = resolve;
        });
        const handleAccountUsageChanged = vi.fn(async () => await policyBarrier);
        const connectedCredential = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'openai-codex',
            profileId: 'primary',
            kind: 'oauth',
            expiresAt: 10_000,
            oauth: {
                accessToken: 'current-access-token',
                refreshToken: 'current-refresh-token',
                idToken: 'current-id-token',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_group_usage',
                providerEmail: null,
            },
        });
        const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
        const registerProviderAccountUsageSnapshotPlain = vi.fn(async () => {});
        let credentialRevisionSemantics:
            'revisioned' | 'legacy_unfenced' = 'revisioned';
        const getConnectedServiceCredentialPlain = vi.fn(async () => ({
            content: { t: 'plain' as const, v: connectedCredential },
            ...(credentialRevisionSemantics === 'revisioned'
                ? {
                    revisionSemantics: 'revisioned' as const,
                    credentialRevision:
                        'csr_0123456789ABCDEFGHJKMNPQRS',
                }
                : {
                    revisionSemantics: 'legacy_unfenced' as const,
                    credentialRevision: null,
                }),
        }));

        await startDaemonSessionControlRuntime({
            machineId: 'machine-usage-policy',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getAccountEncryptionMode: vi.fn(async () => 'plain'),
                getServerFeaturesSnapshot: vi.fn(
                    async () => providerAccountUsageV4ServerFeatures,
                ),
                getProviderAccountUsageWriteRouteAvailability: vi.fn(
                    async () => 'available' as const,
                ),
                getConnectedServiceCredentialPlain,
                registerProviderAccountUsageSnapshotPlain,
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => ({
                handleAccountUsageChanged,
                resolveQuotaProbeFreshProof: (proofInput: Parameters<typeof resolveQuotaProbeFreshProof>[0]) =>
                    resolveQuotaProbeFreshProof({ ...proofInput, nowMs: 2_000, maxAgeMs: 30_000 }),
            }) as never,
            pidToTrackedSession: new Map<number, TrackedSession>([
                [1234, {
                    startedBy: 'daemon',
                    pid: 1234,
                    happySessionId: 'sess_usage_group',
                    spawnOptions: {
                        directory: '/tmp/project',
                        connectedServices: {
                            v: 1,
                            bindingsByServiceId: {
                                'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
                            },
                        },
                        environmentVariables: {
                            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                                kind: 'group',
                                serviceId: 'openai-codex',
                                groupId: 'team',
                                activeProfileId: 'primary',
                                fallbackProfileId: 'primary',
                                generation: 6,
                            }]),
                        },
                    },
                }],
            ]),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            connectedServiceRuntimeRegistry: runtimeRegistry,
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });
        runtimeRegistry.registerTarget({
            pid: 1234,
            agentId: 'codex',
            sessionId: 'sess_usage_group',
            connectedServicesBindingsRaw: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
                },
            },
            connectedServiceSelectionsEnv: {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                    kind: 'group',
                    serviceId: 'openai-codex',
                    groupId: 'team',
                    activeProfileId: 'primary',
                    fallbackProfileId: 'primary',
                    generation: 7,
                }]),
            },
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        const proofScheduler = controlServerInput!.runtimeAuthRecoveryScheduler as unknown as {
            markProviderOutcomeProofByIdentity: (input: unknown) => Promise<unknown>;
        };
        const markQuotaProof = vi.spyOn(
            proofScheduler,
            'markProviderOutcomeProofByIdentity',
        );
        const intake = controlServerInput?.handleProviderAccountUsageSnapshot?.({
            sessionId: 'sess_usage_group',
            snapshot,
            source: {
                serviceId: 'openai-codex',
                profileId: 'primary',
                bindingKind: 'group_member',
                groupId: 'team',
                groupGeneration: 7,
            },
            credentialFingerprint: computeConnectedServiceAccessTokenFingerprint('current-access-token'),
        });
        await expect(Promise.race([
            intake,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
        ])).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
        });
        releasePolicy();
        await vi.waitFor(() => expect(handleAccountUsageChanged).toHaveBeenCalledWith({
            sessionId: 'sess_usage_group',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'team',
            groupGeneration: 7,
            recordId: snapshot.recordId,
            source: 'in_band',
            snapshot: expect.objectContaining({
                recordId: snapshot.recordId,
                accountSubject: { kind: 'providerSubject', id: 'acct_group_usage' },
            }),
        }));
        await vi.waitFor(() => expect(markQuotaProof).toHaveBeenCalledWith({
            sessionId: 'sess_usage_group',
            proofKind: 'quota_probe_fresh',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'team',
            groupGeneration: 7,
            credentialRevision: expect.any(String),
            observedAtMs: 900,
        }));

        markQuotaProof.mockRejectedValueOnce(new Error('proof settlement unavailable'));
        await expect(controlServerInput?.handleProviderAccountUsageSnapshot?.({
            sessionId: 'sess_usage_group',
            snapshot: { ...snapshot, observedAtMs: 1_001, fetchedAtMs: 1_001 },
            source: {
                serviceId: 'openai-codex',
                profileId: 'primary',
                bindingKind: 'group_member',
                groupId: 'team',
                groupGeneration: 7,
            },
            credentialFingerprint: computeConnectedServiceAccessTokenFingerprint('current-access-token'),
        })).resolves.toMatchObject({ status: 'snapshot_advanced' });
        await vi.waitFor(() => expect(handleAccountUsageChanged).toHaveBeenCalledTimes(2));

        markQuotaProof.mockClear();
        await controlServerInput?.handleProviderAccountUsageSnapshot?.({
            sessionId: 'sess_usage_group',
            snapshot: { ...snapshot, observedAtMs: 1_002, fetchedAtMs: 1_002 },
            source: {
                serviceId: 'openai-codex',
                profileId: 'primary',
                bindingKind: 'group_member',
                groupId: 'team',
                groupGeneration: 6,
            },
            credentialFingerprint: computeConnectedServiceAccessTokenFingerprint('current-access-token'),
        });
        await vi.waitFor(() => expect(handleAccountUsageChanged).toHaveBeenCalledTimes(3));
        await vi.waitFor(() => expect(markQuotaProof).toHaveBeenCalledWith(expect.objectContaining({
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'team',
            groupGeneration: 7,
        })));
        await vi.waitFor(() => expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenLastCalledWith(
            expect.objectContaining({
                source: {
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    bindingKind: 'group_member',
                    groupId: 'team',
                    groupGeneration: 7,
                },
            }),
        ));

        markQuotaProof.mockClear();
        await controlServerInput?.handleProviderAccountUsageSnapshot?.({
            sessionId: 'sess_usage_group',
            snapshot: { ...snapshot, observedAtMs: 1_003, fetchedAtMs: 1_003 },
            source: {
                serviceId: 'openai-codex',
                profileId: 'primary',
                bindingKind: 'profile',
            },
            credentialFingerprint: computeConnectedServiceAccessTokenFingerprint('current-access-token'),
        });
        await vi.waitFor(() => expect(handleAccountUsageChanged).toHaveBeenCalledTimes(4));
        await vi.waitFor(() => expect(markQuotaProof).toHaveBeenCalledWith(expect.objectContaining({
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'team',
            groupGeneration: 7,
        })));
        await vi.waitFor(() => expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenLastCalledWith(
            expect.objectContaining({
                source: {
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    bindingKind: 'group_member',
                    groupId: 'team',
                    groupGeneration: 7,
                },
            }),
        ));

        await expect(controlServerInput?.handleProviderAccountUsageSnapshot?.({
            sessionId: 'sess_usage_group',
            snapshot,
            source: {
                serviceId: 'openai-codex',
                profileId: 'primary',
                bindingKind: 'group_member',
                groupId: 'team',
                groupGeneration: 7,
            },
            credentialFingerprint: 'sha256:deadbeef',
        })).resolves.toEqual({
            status: 'credential_fingerprint_mismatch',
            recordId: snapshot.recordId,
            persisted: false,
        });
        expect(handleAccountUsageChanged).toHaveBeenCalledTimes(4);

        handleAccountUsageChanged.mockClear();
        markQuotaProof.mockClear();
        credentialRevisionSemantics = 'legacy_unfenced';
        const credentialReadCount =
            getConnectedServiceCredentialPlain.mock.calls.length;
        await expect(controlServerInput?.handleProviderAccountUsageSnapshot?.({
            sessionId: 'sess_usage_group',
            snapshot: {
                ...snapshot,
                observedAtMs: 1_004,
                fetchedAtMs: 1_004,
            },
            source: {
                serviceId: 'openai-codex',
                profileId: 'primary',
                bindingKind: 'group_member',
                groupId: 'team',
                groupGeneration: 7,
            },
            credentialFingerprint:
                computeConnectedServiceAccessTokenFingerprint(
                    'current-access-token',
                ),
        })).resolves.toMatchObject({
            status: 'credential_fingerprint_mismatch',
            persisted: false,
        });
        await vi.waitFor(() => {
            expect(getConnectedServiceCredentialPlain.mock.calls.length)
                .toBeGreaterThan(credentialReadCount);
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(handleAccountUsageChanged).not.toHaveBeenCalled();
        expect(markQuotaProof).not.toHaveBeenCalled();
    });

    it('keeps unproved claimed sources out of quota policy', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const recordKey = {
            providerId: 'codex',
            accountSubjectId: 'acct_source_link',
            subjectKind: 'account',
            quotaScope: 'account',
        } as const;
        const snapshot: ProviderAccountUsageSnapshotV1 = {
            v: 1,
            recordId: buildProviderAccountUsageRecordId(recordKey),
            recordKey,
            providerId: 'codex',
            accountSubject: { kind: 'providerSubject', id: 'acct_source_link' },
            observedAtMs: 2_000,
            fetchedAtMs: 2_000,
            staleAfterMs: 60_000,
            source: 'runtimeSignal',
            confidence: 'confirmed',
            state: 'loaded_data',
            meters: [],
        };
        const handleAccountUsageChanged = vi.fn(async () => {});

        await startDaemonSessionControlRuntime({
            machineId: 'machine-usage-source-link',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getAccountEncryptionMode: vi.fn(async () => 'plain'),
                getServerFeaturesSnapshot: vi.fn(async () => undefined),
                getProviderAccountUsageWriteRouteAvailability: vi.fn(
                    async () => 'available' as const,
                ),
                registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => ({ handleAccountUsageChanged }) as never,
            pidToTrackedSession: new Map<number, TrackedSession>([
                [1234, { startedBy: 'daemon', pid: 1234, happySessionId: 'sess_usage_source_link' }],
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
        await expect(controlServerInput?.handleProviderAccountUsageSnapshot?.({
            sessionId: 'sess_usage_source_link',
            snapshot,
        })).resolves.toMatchObject({ status: 'snapshot_advanced' });
        expect(handleAccountUsageChanged).not.toHaveBeenCalled();

        const groupSource = {
            serviceId: 'openai-codex' as const,
            profileId: 'primary',
            bindingKind: 'group_member' as const,
            groupId: 'team',
            groupGeneration: 7,
        };
        await expect(controlServerInput?.handleProviderAccountUsageSnapshot?.({
            sessionId: 'sess_usage_source_link',
            snapshot,
            source: groupSource,
        })).resolves.toMatchObject({ status: 'duplicate' });
        expect(handleAccountUsageChanged).not.toHaveBeenCalled();

        await expect(controlServerInput?.handleProviderAccountUsageSnapshot?.({
            sessionId: 'sess_usage_source_link',
            snapshot: { ...snapshot, observedAtMs: 1_000, fetchedAtMs: 1_000 },
            source: groupSource,
        })).resolves.toMatchObject({ status: 'older' });
        expect(handleAccountUsageChanged).not.toHaveBeenCalled();
    });

    it('rejects provider account usage adoption after shutdown disposal suppresses persistence custody', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        updateSessionMetadataWithRetryMock.mockClear();
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-usage-adoption-shutdown',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                getAccountEncryptionMode: vi.fn(async () => 'plain'),
                registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map<number, TrackedSession>([
                [1234, { startedBy: 'daemon', pid: 1234, happySessionId: 'sess_usage_adoption' }],
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
        const adoption = {
            providerId: 'codex',
            fromRecordId: buildProviderAccountUsageRecordId({
                providerId: 'codex',
                accountSubjectId: 'provisional:native',
                subjectKind: 'unknown',
                quotaScope: 'account',
            }),
            toRecordId: buildProviderAccountUsageRecordId({
                providerId: 'codex',
                accountSubjectId: 'acct_shutdown_adopted',
                subjectKind: 'account',
                quotaScope: 'account',
            }),
            stableRecordKey: {
                providerId: 'codex',
                accountSubjectId: 'acct_shutdown_adopted',
                subjectKind: 'account',
                quotaScope: 'account',
            },
            proof: { kind: 'provider_account_id_match' as const },
            observedAtMs: 2_000,
        } satisfies ProviderAccountUsageAdoptionV1;
        const snapshot: ProviderAccountUsageSnapshotV1 = {
            v: 1,
            recordId: adoption.fromRecordId,
            recordKey: {
                providerId: 'codex',
                accountSubjectId: 'provisional:native',
                subjectKind: 'unknown',
                quotaScope: 'account',
            },
            providerId: 'codex',
            accountSubject: { kind: 'provisionalLocalSubject', id: 'provisional:native' },
            observedAtMs: 1_000,
            fetchedAtMs: 1_000,
            staleAfterMs: 60_000,
            source: 'runtimeSignal',
            confidence: 'confirmed',
            state: 'loaded_data',
            meters: [],
        };

        await controlServerInput?.handleProviderAccountUsageSnapshot?.({
            sessionId: 'sess_usage_adoption',
            snapshot,
        });
        updateSessionMetadataWithRetryMock.mockClear();
        await runtime.stopControlServer();

        await expect(controlServerInput?.handleProviderAccountUsageAdoption?.({
            sessionId: 'sess_usage_adoption',
            adoption,
        })).rejects.toThrow('provider_account_usage_persistence_disposed');
        expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    });

    it('wires daemon local-service, browser diagnostics, browser recording, and simulator preview routes into machine RPC', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const registerLocalServicesPreviewRoutes = vi.fn();
        const registerLocalServicesRoutes = vi.fn();
        const registerBrowserDiagnosticsRoutes = vi.fn();
        const registerBrowserRecordingRoutes = vi.fn();
        const registerSimulatorPreviewRoutes = vi.fn();
        const setLocalServicesRuntimeActionRoutesProvider = vi.fn();
        const setSimulatorPreviewRoutesProvider = vi.fn();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-local-services',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                setLocalServicesRuntimeActionRoutesProvider,
                setSimulatorPreviewRoutesProvider,
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => ({
                registerLocalServicesPreviewRoutes,
                registerLocalServicesRoutes,
                registerBrowserDiagnosticsRoutes,
                registerBrowserRecordingRoutes,
                registerSimulatorPreviewRoutes,
            }) as never,
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
            ...({
                browserDaemonFeatureGate: fakeBrowserGate({
                    'browser.diagnostics': true,
                    'browser.recording': true,
                }),
            } satisfies Record<string, unknown>),
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        expect(controlServerInput?.localServicesInventory).toEqual(expect.objectContaining({
            getSnapshot: expect.any(Function),
            refreshSnapshot: expect.any(Function),
            patchLabel: expect.any(Function),
        }));
        expect(controlServerInput?.localServicesPreview).toEqual(expect.objectContaining({
            getSnapshot: expect.any(Function),
        }));
        expect(controlServerInput?.localServicesPublicPreview).toEqual(expect.objectContaining({
            getStatus: expect.any(Function),
            createExposure: expect.any(Function),
            revokeExposure: expect.any(Function),
            copyUrl: expect.any(Function),
        }));
        expect(controlServerInput?.localServicesLauncher).toEqual(expect.objectContaining({
            getSnapshot: expect.any(Function),
        }));
        expect(registerBrowserDiagnosticsRoutes).toHaveBeenCalledWith(expect.objectContaining({
            getSnapshot: expect.any(Function),
        }));
        expect(registerBrowserRecordingRoutes).toHaveBeenCalledWith(expect.objectContaining({
            startRecording: expect.any(Function),
            stopRecording: expect.any(Function),
            cancelRecording: expect.any(Function),
            getRecordingStatus: expect.any(Function),
            listRecordingsForView: expect.any(Function),
            cleanupExpiredRecordings: expect.any(Function),
        }));
        expect(controlServerInput?.simulatorPreview).toEqual(expect.objectContaining({
            getSnapshot: expect.any(Function),
            dispatchAction: expect.any(Function),
        }));
        expect(controlServerInput?.localServicesLauncher).toEqual(expect.objectContaining({
            getSnapshot: expect.any(Function),
            startTarget: expect.any(Function),
        }));
        expect(registerLocalServicesPreviewRoutes).not.toHaveBeenCalled();
        expect(registerLocalServicesRoutes).toHaveBeenCalledWith({
            localServicesInventory: controlServerInput?.localServicesInventory,
            localServicesLauncher: controlServerInput?.localServicesLauncher,
            localServicesManaged: controlServerInput?.localServicesManaged,
            localServicesPreview: controlServerInput?.localServicesPreview,
            localServicesActions: controlServerInput?.localServicesActions,
            localServicesPublicPreview: controlServerInput?.localServicesPublicPreview,
        });
        expect(registerSimulatorPreviewRoutes).toHaveBeenCalledWith(expect.objectContaining({
            getSnapshot: expect.any(Function),
            dispatchAction: expect.any(Function),
        }));
        expect(setLocalServicesRuntimeActionRoutesProvider).toHaveBeenCalledWith(expect.any(Function));
        const apiLocalServicesRoutesProvider = setLocalServicesRuntimeActionRoutesProvider.mock.calls[0]?.[0] as
            | (() => unknown)
            | undefined;
        expect(apiLocalServicesRoutesProvider?.()).toEqual({
            inventoryRoutes: controlServerInput?.localServicesInventory,
            launcherRoutes: controlServerInput?.localServicesLauncher,
            previewRoutes: controlServerInput?.localServicesPreview,
            actionRoutes: controlServerInput?.localServicesActions,
            publicPreviewRoutes: controlServerInput?.localServicesPublicPreview,
        });
        expect(setSimulatorPreviewRoutesProvider).toHaveBeenCalledWith(expect.any(Function));
        const apiSimulatorRoutesProvider = setSimulatorPreviewRoutesProvider.mock.calls[0]?.[0] as
            | (() => unknown)
            | undefined;
        expect(apiSimulatorRoutesProvider?.()).toBe(controlServerInput?.simulatorPreview);
        await expect(controlServerInput?.simulatorPreview?.getSnapshot()).resolves.toMatchObject({
            diagnostics: expect.arrayContaining([
                expect.objectContaining({
                    platform: 'ios',
                    reasonCode: 'ios_private_helper_unavailable',
                    severity: 'error',
                }),
                expect.objectContaining({
                    platform: 'android',
                    reasonCode: 'android_emulator_bridge_unavailable',
                    severity: 'error',
                }),
            ]),
        });
        const browserRecordingRoutes = registerBrowserRecordingRoutes.mock.calls.at(-1)?.[0];
        await expect(browserRecordingRoutes?.startRecording({
            browserSessionId: 'browser_session_startup',
            viewId: 'view_startup',
            profileId: 'profile_startup',
            targetKind: 'localServicePreview',
            adapterKind: 'localPreview',
            renderEngineKind: 'webIframe',
            captureKind: 'streamFrameCapture',
            fidelity: 'streamFrame',
            navigationGeneration: 1,
            mimeType: 'video/webm',
            retentionClass: 'preSend',
        })).resolves.toMatchObject({
            status: 'unavailable',
            reason: {
                code: 'browser_recording_disabled',
            },
        });

        await runtime.stopControlServer();
        expect(setLocalServicesRuntimeActionRoutesProvider).toHaveBeenLastCalledWith(null);
        expect(setSimulatorPreviewRoutesProvider).toHaveBeenLastCalledWith(null);
    });

    it('registers Browser control routes only when a sidecar control adapter factory returns an executable adapter', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const setBrowserDaemonControlRoutesProvider = vi.fn();
        const adapterDispose = vi.fn();
        const dispatchCommand = vi.fn(async (command: { commandId: string }) => ({
            v: 1 as const,
            commandId: command.commandId,
            status: 'dispatched' as const,
            adapterKind: 'chromiumSidecar' as const,
            events: [],
        }));
        const browserSidecarControlAdapterFactory = vi.fn(() => ({
            ok: true as const,
            adapter: {
                adapterKind: 'chromiumSidecar' as const,
                ownsView: ({ browserSessionId, viewId }: { browserSessionId: string; viewId: string }) =>
                    browserSessionId === 'browser_session_startup' && viewId === 'view_startup',
                supportsOpenView: () => false,
                dispatchCommand,
            },
            dispose: adapterDispose,
        }));

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-control-startup',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                setBrowserDaemonControlRoutesProvider,
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
            ...({
                browserSidecarControlAdapterFactory,
                resolveBrowserUseAllowed: () => true,
                browserDaemonFeatureGate: fakeBrowserGate({ 'browser.sidecar': true }),
            } satisfies Record<string, unknown>),
        });

        expect(browserSidecarControlAdapterFactory).toHaveBeenCalledOnce();
        expect(setBrowserDaemonControlRoutesProvider).toHaveBeenCalledWith(expect.any(Function));
        const provider = setBrowserDaemonControlRoutesProvider.mock.calls[0]?.[0] as
            | (() => { dispatchCommand(command: unknown): Promise<unknown> })
            | undefined;
        const routes = provider?.();
        await expect(routes?.dispatchCommand({
            kind: 'navigate',
            commandId: 'command_browser_startup',
            browserSessionId: 'browser_session_startup',
            viewId: 'view_startup',
            url: 'https://browser.example.test/startup',
        })).resolves.toEqual({
            v: 1,
            commandId: 'command_browser_startup',
            status: 'dispatched',
            adapterKind: 'chromiumSidecar',
            events: [],
        });

        await runtime.stopControlServer();
        expect(setBrowserDaemonControlRoutesProvider).toHaveBeenLastCalledWith(null);
        expect(adapterDispose).toHaveBeenCalledOnce();
    });

    it('registers privileged browser route owners only when the server feature gate is enabled', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const setBrowserDaemonContextRoutesProvider = vi.fn();
        const setBrowserDaemonAutomationRoutesProvider = vi.fn();
        const onBrowserContextRoutesReady = vi.fn();
        const onBrowserAutomationRoutesReady = vi.fn();
        const dispatchCommand = vi.fn(async (command: { commandId: string }) => ({
            v: 1 as const,
            commandId: command.commandId,
            status: 'dispatched' as const,
            adapterKind: 'chromiumSidecar' as const,
            events: [],
        }));
        const browserSidecarControlAdapterFactory = createBrowserCapsSidecarAdapterFactory(dispatchCommand);
        const browserContextSourceFactory = browserCapsContextSourceFactory();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-caps-startup',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                setBrowserDaemonContextRoutesProvider,
                setBrowserDaemonAutomationRoutesProvider,
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
            onBrowserContextRoutesReady,
            onBrowserAutomationRoutesReady,
            ...({
                browserSidecarControlAdapterFactory,
                browserContextSourceFactory,
                resolveBrowserUseAllowed: () => true,
                browserDaemonFeatureGate: fakeBrowserGate({
                    'browser.sidecar': true,
                    'browser.context': true,
                    'browser.automation': true,
                }),
            } satisfies Record<string, unknown>),
        });

        expect(setBrowserDaemonContextRoutesProvider).toHaveBeenCalledWith(expect.any(Function));
        expect(setBrowserDaemonAutomationRoutesProvider).toHaveBeenCalledWith(expect.any(Function));
        expect(onBrowserContextRoutesReady).toHaveBeenCalledOnce();
        expect(onBrowserAutomationRoutesReady).toHaveBeenCalledOnce();

        const contextProvider = setBrowserDaemonContextRoutesProvider.mock.calls[0]?.[0] as
            | (() => { dispatch(actionId: string, input: unknown): Promise<unknown> })
            | undefined;
        const contextResult = await contextProvider?.().dispatch('browser.context.capturePage', {
            browserSessionId: 'browser_session_caps',
            viewId: 'view_caps',
            navigationGeneration: 1,
        });
        expect((contextResult as { kind?: string })?.kind).toBe('browserPageReference');

        const automationProvider = setBrowserDaemonAutomationRoutesProvider.mock.calls[0]?.[0] as
            | (() => { dispatch(actionId: string, input: unknown): Promise<unknown> })
            | undefined;
        const automationService = automationProvider?.();
        const lease = await automationService?.dispatch('browser.automation.status', {
            browserSessionId: 'browser_session_caps',
            viewId: 'view_caps',
        });
        expect((lease as { status?: string })?.status).toBe('succeeded');
        const richSnapshot = await automationService?.dispatch('browser.automation.snapshot', {
            v: 1,
            automationRequestId: 'req_snapshot_caps',
            browserSessionId: 'browser_session_caps',
            viewId: 'view_caps',
            navigationGeneration: 1,
            requestedBy: 'agent',
            requesterRef: { kind: 'agent', id: 'agent_caps' },
            actionKind: 'snapshot',
            payload: {},
            timeoutMs: 5_000,
        });
        expect(richSnapshot).toMatchObject({
            status: 'succeeded',
            resultSummary: {
                visibleText: 'Caps ready',
                axNodes: [{ role: 'button', name: 'Run' }],
                interactiveElements: [
                    { role: 'button', name: 'Run', selector: '#run' },
                ],
                consoleSummary: '[log] ready',
            },
        });

        await runtime.stopControlServer();
        expect(setBrowserDaemonContextRoutesProvider).toHaveBeenLastCalledWith(null);
        expect(setBrowserDaemonAutomationRoutesProvider).toHaveBeenLastCalledWith(null);
    });

    it('does NOT register privileged browser route owners when the server disables the capture gate', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const setBrowserDaemonContextRoutesProvider = vi.fn();
        const setBrowserDaemonAutomationRoutesProvider = vi.fn();
        const onBrowserContextRoutesReady = vi.fn();
        const onBrowserAutomationRoutesReady = vi.fn();
        const dispatchCommand = vi.fn(async (command: { commandId: string }) => ({
            v: 1 as const,
            commandId: command.commandId,
            status: 'dispatched' as const,
            adapterKind: 'chromiumSidecar' as const,
            events: [],
        }));
        const browserSidecarControlAdapterFactory = createBrowserCapsSidecarAdapterFactory(dispatchCommand);
        const browserContextSourceFactory = browserCapsContextSourceFactory();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-caps-disabled',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                setBrowserDaemonContextRoutesProvider,
                setBrowserDaemonAutomationRoutesProvider,
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
            onBrowserContextRoutesReady,
            onBrowserAutomationRoutesReady,
            ...({
                browserSidecarControlAdapterFactory,
                browserContextSourceFactory,
                // Sidecar host on, but the server disables context + automation: no owner registers.
                resolveBrowserUseAllowed: () => true,
                browserDaemonFeatureGate: fakeBrowserGate({
                    'browser.sidecar': true,
                    'browser.context': false,
                    'browser.automation': false,
                }),
            } satisfies Record<string, unknown>),
        });

        expect(setBrowserDaemonContextRoutesProvider).not.toHaveBeenCalledWith(expect.any(Function));
        expect(setBrowserDaemonAutomationRoutesProvider).not.toHaveBeenCalledWith(expect.any(Function));
        expect(onBrowserContextRoutesReady).not.toHaveBeenCalled();
        expect(onBrowserAutomationRoutesReady).not.toHaveBeenCalled();

        await runtime.stopControlServer();
    });

    it('can register browser route owners after the server feature snapshot recovers', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const setBrowserDaemonControlRoutesProvider = vi.fn();
        const setBrowserDaemonContextRoutesProvider = vi.fn();
        const setBrowserDaemonAutomationRoutesProvider = vi.fn();
        const onBrowserControlRoutesReady = vi.fn();
        const onBrowserContextRoutesReady = vi.fn();
        const onBrowserAutomationRoutesReady = vi.fn();
        const registerBrowserControlRoutes = vi.fn();
        const registerBrowserContextRoutes = vi.fn();
        const dispatchCommand = vi.fn(async (command: { commandId: string }) => ({
            v: 1 as const,
            commandId: command.commandId,
            status: 'dispatched' as const,
            adapterKind: 'chromiumSidecar' as const,
            events: [],
        }));
        const gateState: Partial<Record<TestBrowserDaemonFeatureGateId, boolean>> = {
            'browser.sidecar': false,
            'browser.context': false,
            'browser.automation': false,
        };
        const browserDaemonFeatureGate = {
            isEnabled: (id: keyof typeof gateState) => gateState[id] === true,
            refresh: vi.fn(async () => {}),
        };
        const browserSidecarControlAdapterFactory = createBrowserCapsSidecarAdapterFactory(dispatchCommand);
        const browserContextSourceFactory = browserCapsContextSourceFactory();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-caps-recovery',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                setBrowserDaemonControlRoutesProvider,
                setBrowserDaemonContextRoutesProvider,
                setBrowserDaemonAutomationRoutesProvider,
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => ({
                registerLocalServicesRoutes: vi.fn(),
                registerBrowserControlRoutes,
                registerBrowserContextRoutes,
                registerSimulatorPreviewRoutes: vi.fn(),
            }) as never,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
            onBrowserControlRoutesReady,
            onBrowserContextRoutesReady,
            onBrowserAutomationRoutesReady,
            ...({
                browserSidecarControlAdapterFactory,
                browserContextSourceFactory,
                resolveBrowserUseAllowed: () => true,
                browserDaemonFeatureGate,
            } satisfies Record<string, unknown>),
        });

        expect(setBrowserDaemonControlRoutesProvider).not.toHaveBeenCalledWith(expect.any(Function));
        expect(setBrowserDaemonContextRoutesProvider).not.toHaveBeenCalledWith(expect.any(Function));
        expect(setBrowserDaemonAutomationRoutesProvider).not.toHaveBeenCalledWith(expect.any(Function));

        gateState['browser.sidecar'] = true;
        gateState['browser.context'] = true;
        gateState['browser.automation'] = true;
        await runtime.refreshBrowserRouteOwners();

        expect(browserDaemonFeatureGate.refresh).toHaveBeenCalledTimes(2);
        expect(setBrowserDaemonControlRoutesProvider).toHaveBeenCalledWith(expect.any(Function));
        expect(setBrowserDaemonContextRoutesProvider).toHaveBeenCalledWith(expect.any(Function));
        expect(setBrowserDaemonAutomationRoutesProvider).toHaveBeenCalledWith(expect.any(Function));
        expect(onBrowserControlRoutesReady).toHaveBeenCalledOnce();
        expect(onBrowserContextRoutesReady).toHaveBeenCalledOnce();
        expect(onBrowserAutomationRoutesReady).toHaveBeenCalledOnce();
        expect(registerBrowserControlRoutes).toHaveBeenCalledOnce();
        expect(registerBrowserContextRoutes).toHaveBeenCalledOnce();

        await runtime.refreshBrowserRouteOwners();
        expect(onBrowserControlRoutesReady).toHaveBeenCalledOnce();
        expect(onBrowserContextRoutesReady).toHaveBeenCalledOnce();
        expect(onBrowserAutomationRoutesReady).toHaveBeenCalledOnce();
        expect(registerBrowserControlRoutes).toHaveBeenCalledOnce();
        expect(registerBrowserContextRoutes).toHaveBeenCalledOnce();

        await runtime.stopControlServer();
        expect(setBrowserDaemonControlRoutesProvider).toHaveBeenLastCalledWith(null);
        expect(setBrowserDaemonContextRoutesProvider).toHaveBeenLastCalledWith(null);
        expect(setBrowserDaemonAutomationRoutesProvider).toHaveBeenLastCalledWith(null);
    });

    it('does not construct browser diagnostics/recording owners when those gates are server-disabled', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const onBrowserDiagnosticsRoutesReady = vi.fn();
        const onBrowserRecordingRoutesReady = vi.fn();
        const registerBrowserDiagnosticsRoutes = vi.fn();
        const registerBrowserRecordingRoutes = vi.fn();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-diag-recording-disabled',
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
            getApiMachineForSessions: () => ({
                registerLocalServicesRoutes: vi.fn(),
                registerBrowserDiagnosticsRoutes,
                registerBrowserRecordingRoutes,
                registerSimulatorPreviewRoutes: vi.fn(),
            } as never),
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
            onBrowserDiagnosticsRoutesReady,
            onBrowserRecordingRoutesReady,
            ...({
                browserDaemonFeatureGate: fakeBrowserGate({
                    'browser.diagnostics': false,
                    'browser.recording': false,
                }),
            } satisfies Record<string, unknown>),
        });

        expect(onBrowserDiagnosticsRoutesReady).not.toHaveBeenCalled();
        expect(onBrowserRecordingRoutesReady).not.toHaveBeenCalled();
        expect(registerBrowserDiagnosticsRoutes).not.toHaveBeenCalled();
        expect(registerBrowserRecordingRoutes).not.toHaveBeenCalled();

        await runtime.stopControlServer();
    });

    it('feeds the diagnostics store from the live CDP event surface when browser.diagnostics is enabled', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const registerBrowserDiagnosticsRoutes = vi.fn();
        type CdpListener = (notification: { method: string; sessionId?: string; params?: Record<string, unknown> }) => void;
        type LifecycleListener = (event: { type: 'bound' | 'unbound'; browserSessionId: string; viewId: string }) => void;
        // DIAG-INTERACTION: the live CDP surface now has TWO daemon subscribers — the diagnostics
        // event-ingestion runtime AND the interaction transport — so the mock must fan out to a LIST of
        // listeners (a single-slot variable silently dropped the first subscriber). Tests fire to all.
        const cdpListeners: CdpListener[] = [];
        const lifecycleListeners: LifecycleListener[] = [];
        const fireLifecycle = (event: Parameters<LifecycleListener>[0]): void => {
            for (const listener of [...lifecycleListeners]) listener(event);
        };
        const fireCdp = (notification: Parameters<CdpListener>[0]): void => {
            for (const listener of [...cdpListeners]) listener(notification);
        };

        const browserSidecarControlAdapterFactory = vi.fn(() => ({
            ok: true as const,
            adapter: {
                adapterKind: 'chromiumSidecar' as const,
                ownsView: () => true,
                supportsOpenView: () => false,
                dispatchCommand: vi.fn(async (command: { commandId: string }) => ({
                    v: 1 as const,
                    commandId: command.commandId,
                    status: 'dispatched' as const,
                    adapterKind: 'chromiumSidecar' as const,
                    events: [],
                })),
            },
            contextCapture: {
                transport: { dispatchPageCommand: vi.fn(async () => ({})) },
                resolvePageHandle: () => ({ targetId: 'target_1', sessionId: 'cdp_session_1' }),
                subscribeCdpEvents: (listener: CdpListener) => {
                    cdpListeners.push(listener);
                    return () => {
                        const index = cdpListeners.indexOf(listener);
                        if (index >= 0) cdpListeners.splice(index, 1);
                    };
                },
                subscribeViewLifecycle: (listener: LifecycleListener) => {
                    lifecycleListeners.push(listener);
                    return () => {
                        const index = lifecycleListeners.indexOf(listener);
                        if (index >= 0) lifecycleListeners.splice(index, 1);
                    };
                },
            },
        }));

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-diag-live',
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
            getApiMachineForSessions: () => ({
                registerLocalServicesRoutes: vi.fn(),
                registerBrowserDiagnosticsRoutes,
                registerBrowserRecordingRoutes: vi.fn(),
                registerSimulatorPreviewRoutes: vi.fn(),
                // SEAM-FINISH-2: an executable sidecar control adapter reaches the browser-control RPC
                // wiring (`apiMachineForSessions.registerBrowserControlRoutes`). The mock must expose it
                // or the optional-chained call throws `is not a function`.
                registerBrowserControlRoutes: vi.fn(),
            }) as never,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
            ...({
                browserSidecarControlAdapterFactory,
                resolveBrowserUseAllowed: () => true,
                browserDaemonFeatureGate: fakeBrowserGate({
                    'browser.sidecar': true,
                    'browser.diagnostics': true,
                }),
            } satisfies Record<string, unknown>),
        });

        const diagnosticsRoutes = registerBrowserDiagnosticsRoutes.mock.calls[0]?.[0] as
            | { getSnapshot(): Promise<{ events: ReadonlyArray<{ kind: string; fidelity: string }> }> }
            | undefined;
        expect(diagnosticsRoutes).toBeDefined();
        expect(lifecycleListeners.length).toBeGreaterThan(0);

        // The control adapter binds a view (openView) → diagnostics attaches a per-view source over
        // the live CDP stream; a synthetic CDP request then flows into the diagnostics store, redacted.
        fireLifecycle({
            type: 'bound',
            browserSessionId: 'browser_product_machine-browser-diag-live',
            viewId: 'view_diag',
        });
        expect(cdpListeners.length).toBeGreaterThan(0);
        fireCdp({
            method: 'Network.requestWillBeSent',
            sessionId: 'cdp_session_1',
            params: {
                requestId: 'raw_cdp_request_secret',
                request: {
                    url: 'https://example.test/api?token=secret',
                    method: 'GET',
                    headers: { Authorization: 'Bearer secret' },
                },
                type: 'XHR',
            },
        });

        const snapshot = await diagnosticsRoutes?.getSnapshot();
        expect(snapshot?.events.map((event) => [event.kind, event.fidelity])).toEqual([
            ['network.requestStarted', 'cdp'],
        ]);
        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toContain('raw_cdp_request_secret');
        expect(serialized).not.toContain('Bearer secret');
        expect(serialized).not.toContain('token=secret');

        await runtime.stopControlServer();
        expect(lifecycleListeners).toHaveLength(0);
        expect(cdpListeners).toHaveLength(0);
    });

    it('does not feed diagnostics when the sidecar control adapter exposes no live CDP event surface', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const registerBrowserDiagnosticsRoutes = vi.fn();
        type LifecycleListener = (event: { type: 'bound' | 'unbound'; browserSessionId: string; viewId: string }) => void;
        let lifecycleListener: LifecycleListener | null = null;

        // A sidecar adapter WITHOUT subscribeCdpEvents (e.g. a non-event-capable transport): the live
        // diagnostics runtime must not be constructed (fail-closed); the ring/store stays empty.
        const browserSidecarControlAdapterFactory = vi.fn(() => ({
            ok: true as const,
            adapter: {
                adapterKind: 'chromiumSidecar' as const,
                ownsView: () => true,
                supportsOpenView: () => false,
                dispatchCommand: vi.fn(async (command: { commandId: string }) => ({
                    v: 1 as const,
                    commandId: command.commandId,
                    status: 'dispatched' as const,
                    adapterKind: 'chromiumSidecar' as const,
                    events: [],
                })),
            },
            contextCapture: {
                transport: { dispatchPageCommand: vi.fn(async () => ({})) },
                resolvePageHandle: () => ({ targetId: 'target_1', sessionId: 'cdp_session_1' }),
                subscribeViewLifecycle: (listener: LifecycleListener) => {
                    lifecycleListener = listener;
                    return () => {
                        lifecycleListener = null;
                    };
                },
            },
        }));

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-diag-nosurface',
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
            getApiMachineForSessions: () => ({
                registerLocalServicesRoutes: vi.fn(),
                registerBrowserDiagnosticsRoutes,
                registerBrowserRecordingRoutes: vi.fn(),
                registerSimulatorPreviewRoutes: vi.fn(),
                // SEAM-FINISH-2: an executable sidecar control adapter reaches the browser-control RPC
                // wiring (`apiMachineForSessions.registerBrowserControlRoutes`). The mock must expose it
                // or the optional-chained call throws `is not a function`.
                registerBrowserControlRoutes: vi.fn(),
            }) as never,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
            ...({
                browserSidecarControlAdapterFactory,
                resolveBrowserUseAllowed: () => true,
                browserDaemonFeatureGate: fakeBrowserGate({
                    'browser.sidecar': true,
                    'browser.diagnostics': true,
                }),
            } satisfies Record<string, unknown>),
        });

        // Without a CDP EVENT surface no diagnostics event-ingestion runtime is constructed, so the
        // store is never fed. The DIAG-INTERACTION interaction transport may still subscribe the view
        // lifecycle for the interaction verbs (it only needs the page transport), so a lifecycle
        // subscriber can exist — the fail-closed invariant is that binding a view never populates the
        // diagnostics snapshot when there is no event stream to ingest.
        if (lifecycleListener) {
            (lifecycleListener as LifecycleListener)({
                type: 'bound',
                browserSessionId: 'browser_product_machine-browser-diag-nosurface',
                viewId: 'view_diag',
            });
        }
        const diagnosticsRoutes = registerBrowserDiagnosticsRoutes.mock.calls[0]?.[0] as
            | { getSnapshot(): Promise<{ events: ReadonlyArray<unknown> }> }
            | undefined;
        const snapshot = await diagnosticsRoutes?.getSnapshot();
        expect(snapshot?.events).toEqual([]);

        await runtime.stopControlServer();
    });

    it('does not register Browser context or automation providers when the sidecar control adapter is unavailable', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const setBrowserDaemonContextRoutesProvider = vi.fn();
        const setBrowserDaemonAutomationRoutesProvider = vi.fn();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-caps-fail-closed',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                setBrowserDaemonContextRoutesProvider,
                setBrowserDaemonAutomationRoutesProvider,
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

        expect(setBrowserDaemonContextRoutesProvider).not.toHaveBeenCalled();
        expect(setBrowserDaemonAutomationRoutesProvider).not.toHaveBeenCalled();

        await runtime.stopControlServer();
        expect(setBrowserDaemonContextRoutesProvider).not.toHaveBeenCalled();
        expect(setBrowserDaemonAutomationRoutesProvider).not.toHaveBeenCalled();
    });

    it('does not register an empty Browser control provider when the sidecar control adapter factory is unavailable', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const setBrowserDaemonControlRoutesProvider = vi.fn();
        const browserSidecarControlAdapterFactory = vi.fn(() => ({
            ok: false as const,
            errorCode: 'cdp_unavailable' as const,
            disabledReason: 'Browser sidecar CDP endpoint is not proven.',
        }));

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-control-unavailable',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                setBrowserDaemonControlRoutesProvider,
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
            ...({
                browserDaemonFeatureGate: fakeBrowserGate({ 'browser.sidecar': true }),
                browserSidecarControlAdapterFactory,
                resolveBrowserUseAllowed: () => true,
            } satisfies Record<string, unknown>),
        });

        expect(browserSidecarControlAdapterFactory).toHaveBeenCalledOnce();
        expect(setBrowserDaemonControlRoutesProvider).not.toHaveBeenCalled();

        await runtime.stopControlServer();
        expect(setBrowserDaemonControlRoutesProvider).not.toHaveBeenCalled();
    });

    it('keeps the default Browser sidecar product source dormant while the server gate is disabled', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const setBrowserDaemonControlRoutesProvider = vi.fn();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-control-product-source-unavailable',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                setBrowserDaemonControlRoutesProvider,
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

        expect(setBrowserDaemonControlRoutesProvider).not.toHaveBeenCalled();

        await runtime.stopControlServer();
        expect(setBrowserDaemonControlRoutesProvider).not.toHaveBeenCalled();
    });

    it('keeps Browser sidecar startup fail-closed when browser-use policy is absent', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const setBrowserDaemonControlRoutesProvider = vi.fn();
        const browserSidecarControlAdapterFactory = vi.fn(() => ({
            ok: true as const,
            adapter: {
                adapterKind: 'chromiumSidecar' as const,
                ownsView: () => true,
                supportsOpenView: () => false,
                dispatchCommand: vi.fn(),
            },
        }));

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-policy-absent',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                setBrowserDaemonControlRoutesProvider,
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
            ...({
                browserSidecarControlAdapterFactory,
                browserDaemonFeatureGate: fakeBrowserGate({ 'browser.sidecar': true }),
            } satisfies Record<string, unknown>),
        });

        expect(browserSidecarControlAdapterFactory).not.toHaveBeenCalled();
        expect(setBrowserDaemonControlRoutesProvider).not.toHaveBeenCalled();

        await runtime.stopControlServer();
        expect(setBrowserDaemonControlRoutesProvider).not.toHaveBeenCalled();
    });

    it('registers Browser control routes only after the launch owner starts a sidecar and connects CDP', async () => {
        const mod = await import('../browser/sidecar/launchOwner').catch(() => null);

        expect(mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory) return;

        vi.mocked(startDaemonControlServer).mockClear();
        const setBrowserDaemonControlRoutesProvider = vi.fn();
        const fake = createBrowserStartupFakeProcess();
        const spawnProcess = vi.fn(() => fake.process);
        const cleanupProfileDirectory = vi.fn(async () => {});
        const transport = {
            openPage: vi.fn(async () => ({
                targetId: 'target_startup_private',
                sessionId: 'session_startup_private',
            })),
            dispatchPageCommand: vi.fn(async () => ({})),
            dispatchBrowserCommand: vi.fn(async () => ({})),
        };
        const browserSidecarControlAdapterFactory = mod.createBrowserSidecarLaunchOwnerControlAdapterFactory({
            browserSessionId: 'browser_session_default',
            sidecarId: 'sidecar_startup_owner',
            featureEnabled: true,
            browserUseAllowed: true,
            allowPersistentProfiles: false,
            profile: {
                profileId: 'profile_startup_owner',
                storageMode: 'ephemeral',
                owner: { kind: 'session', id: 'browser_session_default' },
                cleanupOnSessionClose: true,
            },
            profileDirectory: '/tmp/happier/browser/profile_startup_owner',
            binaryResolution: {
                ok: true,
                source: 'managedBrowserPackage',
                executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime',
                diagnostics: [],
            },
            spawnProcess,
            connectTransport: vi.fn(async () => ({ transport })),
            cleanupProfileDirectory,
            endpointTimeoutMs: 100,
            nowMs: () => 9_000,
        });

        const runtimePromise = startDaemonSessionControlRuntime({
            machineId: 'machine-browser-launch-owner-startup',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                setBrowserDaemonControlRoutesProvider,
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
            browserSidecarControlAdapterFactory,
            ...({
                browserDaemonFeatureGate: fakeBrowserGate({ 'browser.sidecar': true }),
                resolveBrowserUseAllowed: () => true,
            } satisfies Record<string, unknown>),
        });

        await waitForStartupCondition(() => spawnProcess.mock.calls.length === 1);
        expect(setBrowserDaemonControlRoutesProvider).not.toHaveBeenCalled();

        fake.emitStderr('DevTools listening on ws://127.0.0.1:9555/devtools/browser/startup-private-token\n');
        const runtime = await runtimePromise;

        expect(setBrowserDaemonControlRoutesProvider).toHaveBeenCalledWith(expect.any(Function));
        const provider = setBrowserDaemonControlRoutesProvider.mock.calls[0]?.[0] as
            | (() => { dispatchCommand(command: unknown): Promise<unknown> })
            | undefined;
        await expect(provider?.().dispatchCommand({
            kind: 'openView',
            commandId: 'command_browser_startup_owner',
            browserSessionId: 'browser_session_default',
            viewId: 'view_startup_owner',
            platform: 'web',
            focus: true,
            target: {
                kind: 'externalUrl',
                targetId: 'target_startup_owner',
                url: 'https://browser.example.test/startup-owner',
            },
        })).resolves.toMatchObject({
            v: 1,
            commandId: 'command_browser_startup_owner',
            status: 'dispatched',
            adapterKind: 'chromiumSidecar',
        });
        expect(transport.openPage).toHaveBeenCalledWith({
            url: 'https://browser.example.test/startup-owner',
            focus: true,
        });

        await runtime.stopControlServer();
        expect(setBrowserDaemonControlRoutesProvider).toHaveBeenLastCalledWith(null);
        expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
        expect(cleanupProfileDirectory).toHaveBeenCalledWith('/tmp/happier/browser/profile_startup_owner');
    });

    it('enters the executable-adapter branch when the managed product factory resolves a provenance-verified source', async () => {
        const mod = await import('../browser/sidecar/productSource').catch(() => null);

        expect(mod?.createProductBrowserSidecarControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createProductBrowserSidecarControlAdapterFactory) return;

        vi.mocked(startDaemonControlServer).mockClear();
        const setBrowserDaemonControlRoutesProvider = vi.fn();
        const dispatchCommand = vi.fn(async (command: { commandId: string }) => ({
            v: 1 as const,
            commandId: command.commandId,
            status: 'dispatched' as const,
            adapterKind: 'chromiumSidecar' as const,
            events: [],
        }));
        // The product gate consumes the launch owner; inject one that returns a live executable
        // adapter so the test exercises the real gate (whitelist narrow + provenance check +
        // delegation) rather than the launch -> CDP plumbing (covered by the launch-owner test).
        const createLaunchOwnerFactory = vi.fn((_input: unknown) => async () => ({
            ok: true as const,
            adapter: {
                adapterKind: 'chromiumSidecar' as const,
                ownsView: ({ browserSessionId, viewId }: { browserSessionId: string; viewId: string }) =>
                    browserSessionId === 'browser_managed_startup' && viewId === 'view_managed',
                supportsOpenView: () => false,
                dispatchCommand,
            },
            dispose: vi.fn(),
        }));
        const resolveManagedCandidate = vi.fn(async () => ({
            source: 'managedBrowserPackage' as const,
            executablePath: '/home/u/.happier/tools/browser-chromium/current/chrome',
            discoveryKind: 'managedRuntime' as const,
            available: true,
            provenance: {
                origin: 'managed_package' as const,
                pinnedVersion: '127.0.6533.88',
                channel: 'stable' as const,
                integrityDigest: `sha256:${'a'.repeat(64)}`,
                license: 'BSD-3-Clause',
            },
        }));

        const browserSidecarControlAdapterFactory = mod.createProductBrowserSidecarControlAdapterFactory({
            platform: 'linux',
            arch: 'x64',
            featureEnabled: true,
            browserUseAllowed: true,
            resolveManagedCandidate,
            createLaunchOwnerFactory,
        });

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-managed-startup',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                setBrowserDaemonControlRoutesProvider,
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
            ...({
                browserSidecarControlAdapterFactory,
                resolveBrowserUseAllowed: () => true,
                browserDaemonFeatureGate: fakeBrowserGate({ 'browser.sidecar': true }),
            } satisfies Record<string, unknown>),
        });

        // The managed source resolved with provenance -> launch owner delegated -> executable
        // adapter registered -> browserControlRoutes constructed and published.
        expect(resolveManagedCandidate).toHaveBeenCalledOnce();
        expect(createLaunchOwnerFactory).toHaveBeenCalledOnce();
        const launchInput = createLaunchOwnerFactory.mock.calls[0]?.[0] as {
            binaryResolution: { ok: boolean; source: string; provenance?: { origin: string } };
        };
        expect(launchInput.binaryResolution.ok).toBe(true);
        expect(launchInput.binaryResolution.source).toBe('managedBrowserPackage');
        expect(launchInput.binaryResolution.provenance?.origin).toBe('managed_package');
        expect(setBrowserDaemonControlRoutesProvider).toHaveBeenCalledWith(expect.any(Function));

        await runtime.stopControlServer();
        expect(setBrowserDaemonControlRoutesProvider).toHaveBeenLastCalledWith(null);
    });

    it('stops simulator preview adapter resources from control-runtime shutdown once', async () => {
        vi.mocked(startDaemonControlServer).mockClear();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-simulator-cleanup',
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

        expect(createComposedSimulatorPreviewAdapterMock).toHaveBeenCalledWith({
            platforms: expect.arrayContaining([
                expect.objectContaining({ platform: 'ios' }),
                expect.objectContaining({ platform: 'android' }),
            ]),
        });
        // Capability-truth: the iOS adapter is constructed with captureAdapterAvailable derived
        // from the verified-artifact resolution. With no signed/notarized helper vendored (the
        // pinned placeholder digest), it resolves false and iOS capture stays fail-closed.
        expect(createIosSimulatorPlatformAdapterMock).toHaveBeenCalledWith({
            captureAdapterAvailable: false,
            discoverResources: expect.any(Function),
        });
        expect(createAndroidSimulatorPlatformAdapterMock).toHaveBeenCalledWith(expect.objectContaining({
            discoverResources: expect.any(Function),
            resolveScrcpyControl: expect.any(Function),
            stopScrcpyControl: expect.any(Function),
        }));

        await runtime.stopControlServer();
        await runtime.stopControlServer();
        expect(simulatorPreviewAdapterStopMock).toHaveBeenCalledOnce();
    });

    it('reconciles startup simulator resources into the shared PMS live-stream capture registry', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        createComposedSimulatorPreviewAdapterMock.mockImplementationOnce(() => ({
            listResources: async () => [startupAvailableSimulatorResource],
            listDiagnostics: async () => [],
            dispatchAction: async (actionInput: { event: { type: string } }) => ({
                v: 1,
                eventType: actionInput.event.type,
                status: 'unavailable',
                reasonCode: 'simulator_runtime_action_unavailable',
                diagnostics: [],
            }),
            stop: simulatorPreviewAdapterStopMock,
        }));
        const liveStreamCaptureRegistry = createMachineLiveStreamCaptureRegistry();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-simulator-capture-registry',
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
            liveStreamCaptureRegistry,
            processEnv: {
                HAPPIER_FEATURE_LOCAL_SERVICES__ENABLED: '1',
                HAPPIER_FEATURE_LOCAL_SERVICES_INVENTORY__ENABLED: '1',
            },
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await controlServerInput?.simulatorPreview?.getSnapshot();
        expect(liveStreamCaptureRegistry.resolve({
            streamFamily: 'ios-simulator:sim_ios_startup:screen',
        })).toMatchObject({
            ok: true,
            source: {
                sourceId: 'ios-simulator:sim_ios_startup:screen',
                capabilities: {
                    sourceKind: 'simulator',
                    supportedCodecs: ['image.mjpeg'],
                    health: { status: 'available' },
                },
            },
        });

        await runtime.stopControlServer();
        expect(liveStreamCaptureRegistry.resolve({
            sourceId: 'ios-simulator:sim_ios_startup:screen',
        })).toMatchObject({
            ok: false,
            diagnostic: { reasonCode: 'capture_source_unavailable' },
        });
    });

    it('wires browser recording startup through the shared PMS capture registry when explicit policy and targets are supplied', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const registerBrowserRecordingRoutes = vi.fn();
        const liveStreamCaptureRegistry = createMachineLiveStreamCaptureRegistry();
        const recordingOutputPath = join('/tmp/happier-test-home', 'startup-browser-recording.webm');
        let offerFailure: string | null = null;
        const sourceStop = vi.fn(async () => {});
        const sourceStart = vi.fn(async (input: {
            streamId: string;
            offerFrame: (frame: {
                v: 1;
                streamId: string;
                sequence: number;
                timestampMs: number;
                payloadKind: 'image_keyframe';
                payloadEncoding: 'binary_base64';
                payloadBase64: string;
                payloadSizeBytes: number;
            }) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
        }) => {
            const payload = Buffer.from('startup-pms-frame');
            const offered = input.offerFrame({
                v: 1,
                streamId: input.streamId,
                sequence: 1,
                timestampMs: 10_000,
                payloadKind: 'image_keyframe',
                payloadEncoding: 'binary_base64',
                payloadBase64: payload.toString('base64'),
                payloadSizeBytes: payload.byteLength,
            });
            if (!offered.ok) {
                offerFailure = offered.reasonCode;
                throw new Error(`Expected startup PMS frame to be accepted, got ${offered.reasonCode}.`);
            }
            return { ok: true as const, session: { stop: sourceStop } };
        });
        liveStreamCaptureRegistry.register({
            sourceId: 'startup-source-1',
            streamFamily: 'startup-source-1',
            capabilities: {
                v: 1,
                sourceId: 'startup-source-1',
                sourceKind: 'simulator',
                supportedCodecs: ['image.mjpeg'],
                maxFramesPerSecond: 30,
                inputMode: 'none',
                sidebands: [],
                health: { status: 'available' },
            },
            adapter: { start: sourceStart },
        });
        const recordingCapabilities = {
            enabled: true,
            attachmentsEnabled: true,
            available: true,
            supportedCaptureKinds: ['streamFrameCapture'],
            supportedMimeTypes: ['video/webm'],
            supportedAdapterKinds: ['simulatorPreview'],
            maxDurationMs: 30_000,
            maxBytes: 16_000_000,
            maxFps: 1_000_000,
            audioSupported: false,
            cursorOverlaySupported: true,
            actionTimelineChaptersSupported: true,
            supportedRetentionClasses: ['preSend'],
            disabledReasons: [],
            policyDeniedReasons: [],
        } satisfies BrowserRecordingCapabilities;

        await mkdir(join('/tmp/happier-test-home', '.git', 'info'), { recursive: true });
        await rm(join('/tmp/happier-test-home', '.happier', 'uploads', 'artifacts', 'session_startup_recording'), {
            recursive: true,
            force: true,
        });

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-recording-startup',
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
            getApiMachineForSessions: () => ({
                registerLocalServicesPreviewRoutes: vi.fn(),
                registerLocalServicesRoutes: vi.fn(),
                registerBrowserDiagnosticsRoutes: vi.fn(),
                registerBrowserRecordingRoutes,
                registerSimulatorPreviewRoutes: vi.fn(),
            }) as never,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            liveStreamCaptureRegistry,
            resolveBrowserRecordingStartContext: vi.fn(async () => ({
                browserRecordingEnabled: true,
                recordingCapabilities,
            })),
            browserRecordingStreamFrameEncoderFactory: async () => ({
                appendFrame: vi.fn(),
                finish: async () => {
                    await writeFile(recordingOutputPath, startupRecordingWebmBytes);
                    return {
                        source: {
                            kind: 'local-file' as const,
                            path: recordingOutputPath,
                            mimeType: 'video/webm',
                            fileNameHint: 'startup-recording.webm',
                        },
                        byteSize: startupRecordingWebmBytes.byteLength,
                        cleanup: async () => {
                            await rm(recordingOutputPath, { force: true });
                        },
                    };
                },
                discard: vi.fn(async () => {}),
            }),
            processEnv: {
                HAPPIER_FEATURE_LOCAL_SERVICES__ENABLED: '1',
                HAPPIER_FEATURE_LOCAL_SERVICES_INVENTORY__ENABLED: '1',
            },
            ...({
                browserDaemonFeatureGate: fakeBrowserGate({
                    'browser.sidecar': true,
                    'browser.recording': true,
                    'browser.context': true,
                    'browser.automation': true,
                    'browser.diagnostics': true,
                }),
            } satisfies Record<string, unknown>),
        });

        try {
            const browserRecordingRoutes = registerBrowserRecordingRoutes.mock.calls.at(-1)?.[0];
            const started = await browserRecordingRoutes?.startRecording({
                browserSessionId: 'browser_session_startup_recording',
                viewId: 'view_startup_recording',
                profileId: 'profile_startup_recording',
                targetKind: 'simulatorPreview',
                adapterKind: 'simulatorPreview',
                renderEngineKind: 'streamedSurface',
                captureKind: 'streamFrameCapture',
                fidelity: 'streamFrame',
                navigationGeneration: 1,
                mimeType: 'video/webm',
                retentionClass: 'preSend',
                mediaTarget: {
                    sessionId: 'session_startup_recording',
                    messageLocalId: 'message_startup_recording',
                },
                captureSource: {
                    kind: 'machineLiveStream',
                    streamFamily: 'startup-source-1',
                    sourceId: 'startup-source-1',
                },
            });

            expect(offerFailure).toBe(null);
            expect(started).toMatchObject({ status: 'started' });
            if (!started || started.status !== 'started') return;

            const stopped = await browserRecordingRoutes?.stopRecording({
                recordingId: started.recording.recordingId,
                stoppedAtMs: started.recording.startedAtMs + 1_000,
                navigationGenerationEnd: 2,
            });

            expect(sourceStart).toHaveBeenCalledTimes(1);
            expect(sourceStop).toHaveBeenCalledTimes(1);
            expect(stopped).toMatchObject({
                status: 'finalized',
                recording: {
                    mediaRef: {
                        refKind: 'sessionMedia',
                        mediaKind: 'video',
                        mimeType: 'video/webm',
                        sizeBytes: startupRecordingWebmBytes.byteLength,
                    },
                },
            });
            if (!stopped || stopped.status !== 'finalized' || !stopped.recording.mediaRef) return;
            const persistedFile = join(
                '/tmp/happier-test-home',
                '.happier',
                'uploads',
                'artifacts',
                'session_startup_recording',
                'message_startup_recording',
                `${stopped.recording.mediaRef.mediaId.slice(0, 12)}-startup-recording.webm`,
            );
            await expect(readFile(persistedFile)).resolves.toEqual(startupRecordingWebmBytes);
            await expect(readFile(recordingOutputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await runtime.stopControlServer();
            await rm(join('/tmp/happier-test-home', '.happier', 'uploads', 'artifacts', 'session_startup_recording'), {
                recursive: true,
                force: true,
            });
        }
    });

    it('wires managed-Chromium cdpScreencast recording through the production sidecar context-capture transport', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const registerBrowserRecordingRoutes = vi.fn();
        const registerBrowserControlRoutes = vi.fn();
        const machineId = 'machine-browser-cdp-recording-startup';
        const browserSessionId = `browser_product_${machineId}`;
        const viewId = 'view_cdp_recording_startup';
        const outputPath = join('/tmp/happier-test-home', 'startup-browser-recording-cdp.webm');
        const outputBytes = Buffer.from('startup-cdp-webm');
        const cdpCommands: Array<Record<string, unknown>> = [];
        const cdpListeners: Array<(notification: { method: string; sessionId?: string; params?: Record<string, unknown> }) => void> = [];
        const lifecycleListeners: Array<(event: { type: 'bound' | 'unbound'; browserSessionId: string; viewId: string }) => void> = [];
        let viewBound = false;

        await mkdir(join('/tmp/happier-test-home', '.git', 'info'), { recursive: true });
        await rm(join('/tmp/happier-test-home', '.happier', 'uploads', 'artifacts', 'session_startup_cdp_recording'), {
            recursive: true,
            force: true,
        });

        const browserSidecarControlAdapterFactory = vi.fn(() => ({
            ok: true as const,
            adapter: {
                adapterKind: 'chromiumSidecar' as const,
                ownsView: ({ browserSessionId: candidateSessionId, viewId: candidateViewId }: { browserSessionId: string; viewId: string }) =>
                    viewBound && candidateSessionId === browserSessionId && candidateViewId === viewId,
                supportsOpenView: () => true,
                dispatchCommand: vi.fn(async (command: BrowserCommandV1) => {
                    if (command.kind === 'openView' && command.browserSessionId === browserSessionId && command.viewId === viewId) {
                        viewBound = true;
                        for (const listener of [...lifecycleListeners]) {
                            listener({ type: 'bound', browserSessionId, viewId });
                        }
                    }
                    return {
                        v: 1 as const,
                        commandId: command.commandId,
                        status: 'dispatched' as const,
                        adapterKind: 'chromiumSidecar' as const,
                        events: [],
                    };
                }),
            },
            contextCapture: {
                transport: {
                    dispatchPageCommand: vi.fn(async (command: Record<string, unknown>) => {
                        cdpCommands.push(command);
                        return {};
                    }),
                },
                resolvePageHandle: (view: { browserSessionId: string; viewId: string }) =>
                    viewBound && view.browserSessionId === browserSessionId && view.viewId === viewId
                        ? { targetId: 'target_cdp_recording', sessionId: 'session_cdp_recording' }
                        : null,
                subscribeCdpEvents: (listener: (notification: { method: string; sessionId?: string; params?: Record<string, unknown> }) => void) => {
                    cdpListeners.push(listener);
                    return () => {
                        const index = cdpListeners.indexOf(listener);
                        if (index >= 0) cdpListeners.splice(index, 1);
                    };
                },
                subscribeViewLifecycle: (listener: (event: { type: 'bound' | 'unbound'; browserSessionId: string; viewId: string }) => void) => {
                    lifecycleListeners.push(listener);
                    return () => {
                        const index = lifecycleListeners.indexOf(listener);
                        if (index >= 0) lifecycleListeners.splice(index, 1);
                    };
                },
            },
        }));

        const runtime = await startDaemonSessionControlRuntime({
            machineId,
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
            getApiMachineForSessions: () => ({
                registerLocalServicesPreviewRoutes: vi.fn(),
                registerLocalServicesRoutes: vi.fn(),
                registerBrowserControlRoutes,
                registerBrowserDiagnosticsRoutes: vi.fn(),
                registerBrowserRecordingRoutes,
                registerSimulatorPreviewRoutes: vi.fn(),
                hasConnectedClientRpcHandler: vi.fn(() => false),
            }) as never,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            browserRecordingStreamFrameEncoderFactory: async () => ({
                appendFrame: vi.fn(),
                finish: async () => {
                    await writeFile(outputPath, outputBytes);
                    return {
                        source: {
                            kind: 'local-file' as const,
                            path: outputPath,
                            mimeType: 'video/webm',
                            fileNameHint: 'startup-cdp-recording.webm',
                        },
                        byteSize: outputBytes.byteLength,
                        cleanup: async () => {
                            await rm(outputPath, { force: true });
                        },
                    };
                },
                discard: vi.fn(async () => {}),
            }),
            processEnv: {},
            ...({
                browserSidecarControlAdapterFactory,
                resolveBrowserUseAllowed: () => true,
                browserDaemonFeatureGate: fakeBrowserGate({
                    'browser.sidecar': true,
                    'browser.recording': true,
                    'browser.context': true,
                    'browser.automation': true,
                    'browser.diagnostics': true,
                }),
            } satisfies Record<string, unknown>),
        });

        try {
            const browserControlRoutes = registerBrowserControlRoutes.mock.calls.at(-1)?.[0];
            await expect(browserControlRoutes?.dispatchCommand({
                kind: 'openView',
                commandId: 'command_open_cdp_recording',
                browserSessionId,
                viewId,
                platform: 'web',
                focus: true,
                target: {
                    kind: 'externalUrl',
                    targetId: 'target_cdp_recording',
                    url: 'https://browser.example.test/recording',
                },
            })).resolves.toMatchObject({ status: 'dispatched' });

            const browserRecordingRoutes = registerBrowserRecordingRoutes.mock.calls.at(-1)?.[0];
            const recordingStartedAtMs = Date.now() - 1_000;
            const started = await browserRecordingRoutes?.startRecording({
                browserSessionId,
                viewId,
                profileId: 'profile_cdp_recording',
                targetKind: 'externalUrl',
                adapterKind: 'chromiumSidecar',
                renderEngineKind: 'unavailable',
                captureKind: 'cdpScreencast',
                fidelity: 'cdp',
                navigationGeneration: 1,
                startedAtMs: recordingStartedAtMs,
                mimeType: 'video/webm',
                retentionClass: 'preSend',
                mediaTarget: {
                    sessionId: 'session_startup_cdp_recording',
                    messageLocalId: 'message_startup_cdp_recording',
                },
            });

            expect(started).toMatchObject({ status: 'started' });
            expect(cdpCommands).toContainEqual(expect.objectContaining({
                targetId: 'target_cdp_recording',
                sessionId: 'session_cdp_recording',
                method: 'Page.startScreencast',
                params: expect.objectContaining({ format: 'jpeg' }),
            }));
            expect(cdpListeners.length).toBeGreaterThan(0);
            for (const listener of [...cdpListeners]) {
                listener({
                    method: 'Page.screencastFrame',
                    sessionId: 'session_cdp_recording',
                    params: {
                        sessionId: 9,
                        data: Buffer.from('startup-cdp-frame').toString('base64'),
                    },
                });
            }
            expect(cdpCommands).toContainEqual(expect.objectContaining({
                targetId: 'target_cdp_recording',
                sessionId: 'session_cdp_recording',
                method: 'Page.screencastFrameAck',
                params: { sessionId: 9 },
            }));
            if (!started || started.status !== 'started') return;

            const stopped = await browserRecordingRoutes?.stopRecording({
                recordingId: started.recording.recordingId,
                stoppedAtMs: recordingStartedAtMs + 1_000,
                navigationGenerationEnd: 1,
            });

            expect(cdpCommands).toContainEqual(expect.objectContaining({
                targetId: 'target_cdp_recording',
                sessionId: 'session_cdp_recording',
                method: 'Page.stopScreencast',
            }));
            expect(stopped).toMatchObject({
                status: 'finalized',
                recording: {
                    frameCount: 1,
                    mediaRef: {
                        refKind: 'sessionMedia',
                        mediaKind: 'video',
                        mimeType: 'video/webm',
                        sizeBytes: outputBytes.byteLength,
                    },
                },
            });
        } finally {
            await runtime.stopControlServer();
            await rm(join('/tmp/happier-test-home', '.happier', 'uploads', 'artifacts', 'session_startup_cdp_recording'), {
                recursive: true,
                force: true,
            });
        }
    });

    it('preserves default desktop nativeViewCapture when the connected UI reverse-capture RPC handler is available', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const registerBrowserRecordingRoutes = vi.fn();
        const hasConnectedClientRpcHandler = vi.fn((method: string) =>
            method === RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME);
        const callConnectedClientRpc = vi.fn(async (_method: string, params: unknown) => ({
            ok: true as const,
            result: {
                protocolVersion: 1,
                result: {
                    ok: true,
                    frame: {
                        mimeType: 'image/png',
                        width: 12,
                        height: 8,
                        sizeBytes: 128,
                        path: (params as { outputPath: string }).outputPath,
                    },
                },
            },
        }));

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-native-recording-startup',
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
            getApiMachineForSessions: () => ({
                hasConnectedClientRpcHandler,
                callConnectedClientRpc,
                registerLocalServicesPreviewRoutes: vi.fn(),
                registerLocalServicesRoutes: vi.fn(),
                registerBrowserControlRoutes: vi.fn(),
                registerBrowserDiagnosticsRoutes: vi.fn(),
                registerBrowserRecordingRoutes,
                registerSimulatorPreviewRoutes: vi.fn(),
            }) as never,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
            ...({
                browserDaemonFeatureGate: fakeBrowserGate({
                    'browser.recording': true,
                }),
            } satisfies Record<string, unknown>),
        });

        try {
            const browserRecordingRoutes = registerBrowserRecordingRoutes.mock.calls.at(-1)?.[0];
            const started = await browserRecordingRoutes?.startRecording({
                browserSessionId: 'browser_session_native_recording',
                viewId: 'view_native_recording',
                profileId: 'profile_native_recording',
                targetKind: 'externalUrl',
                adapterKind: 'externalUrl',
                renderEngineKind: 'desktopWebView',
                captureKind: 'nativeViewCapture',
                fidelity: 'nativeCallback',
                navigationGeneration: 4,
                mimeType: 'image/png',
                retentionClass: 'preSend',
                mediaTarget: {
                    sessionId: 'session_startup_native_recording',
                    messageLocalId: 'message_startup_native_recording',
                },
            });

            expect(hasConnectedClientRpcHandler).toHaveBeenCalledWith(RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME);
            expect(started).toMatchObject({
                status: 'started',
                recording: {
                    captureKind: 'nativeViewCapture',
                    fidelity: 'nativeCallback',
                },
            });
            expect(callConnectedClientRpc).toHaveBeenCalledWith(
                RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME,
                expect.objectContaining({
                    browserSessionId: 'browser_session_native_recording',
                    viewId: 'view_native_recording',
                    navigationGeneration: 4,
                    outputPath: expect.stringContaining('.native-view.png'),
                }),
                undefined,
            );
        } finally {
            await runtime.stopControlServer();
            await rm(join('/tmp/happier-test-home', '.happier', 'tmp', 'browser-recordings'), {
                recursive: true,
                force: true,
            });
        }
    });

    it('keeps default desktop nativeViewCapture fail-closed before reverse invocation when no UI handler is available', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const registerBrowserRecordingRoutes = vi.fn();
        const hasConnectedClientRpcHandler = vi.fn(() => false);
        const callConnectedClientRpc = vi.fn();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-browser-native-recording-no-handler',
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
            getApiMachineForSessions: () => ({
                hasConnectedClientRpcHandler,
                callConnectedClientRpc,
                registerLocalServicesPreviewRoutes: vi.fn(),
                registerLocalServicesRoutes: vi.fn(),
                registerBrowserControlRoutes: vi.fn(),
                registerBrowserDiagnosticsRoutes: vi.fn(),
                registerBrowserRecordingRoutes,
                registerSimulatorPreviewRoutes: vi.fn(),
            }) as never,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
            ...({ browserDaemonFeatureGate: fakeBrowserGate({ 'browser.recording': true }) } satisfies Record<string, unknown>),
        });

        try {
            const browserRecordingRoutes = registerBrowserRecordingRoutes.mock.calls.at(-1)?.[0];
            const started = await browserRecordingRoutes?.startRecording({
                browserSessionId: 'browser_session_native_recording_no_handler',
                viewId: 'view_native_recording_no_handler',
                profileId: 'profile_native_recording_no_handler',
                targetKind: 'externalUrl',
                adapterKind: 'externalUrl',
                renderEngineKind: 'desktopWebView',
                captureKind: 'nativeViewCapture',
                fidelity: 'nativeCallback',
                navigationGeneration: 4,
                mimeType: 'image/png',
                retentionClass: 'preSend',
                mediaTarget: {
                    sessionId: 'session_startup_native_recording_no_handler',
                    messageLocalId: 'message_startup_native_recording_no_handler',
                },
            });

            expect(hasConnectedClientRpcHandler).toHaveBeenCalledWith(RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME);
            expect(started).toMatchObject({
                status: 'unavailable',
                reason: { code: 'browser_recording_disabled' },
            });
            expect(callConnectedClientRpc).not.toHaveBeenCalled();
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('syncs installed hosted-web static assets into daemon local-service previews for tracked sessions', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-hosted-web-startup-'));
        const html = '<html><body>Hosted web preview</body></html>';
        const bytes = new TextEncoder().encode(html);
        const digest = computePluginUiArtifactFileSetSha256DigestV1([{
            relativePath: 'hosted-web/preview-web/index.html',
            bytes,
        }]);
        await writeHostedWebStaticAssetsFixture({ pluginRoot, html, digest });
        const resolveHostedWebStaticAssetContributionRegistry = vi.fn(async () => createHostedWebStaticAssetsRegistry({
            pluginRoot,
            digest,
            byteSize: bytes.byteLength,
        }));

        const tracked: TrackedSession = {
            startedBy: 'daemon',
            pid: 9100,
            happySessionId: 'sess-hosted-web',
        };

        try {
            const runtime = await startDaemonSessionControlRuntime({
                machineId: 'machine-hosted-web',
                credentials: {
                    token: 'token-daemon',
                    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
                },
                api: {} as never,
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
                resolveHostedWebStaticAssetContributionRegistry,
                processEnv: {},
            });

            const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
            const resource = await waitForLocalServicesPreviewResource(
                controlServerInput,
                'plugin-static:acme.preview:preview-web:sess-hosted-web:machine-hosted-web',
            );

            expect(resolveHostedWebStaticAssetContributionRegistry).toHaveBeenCalledOnce();
            expect(resource).toMatchObject({
                sessionId: 'sess-hosted-web',
                owner: { kind: 'plugin', id: 'acme.preview' },
                originMode: 'path',
            });
            expect(resource?.display.diagnostics).toMatchObject({
                pluginId: 'acme.preview',
                contributionId: 'preview-web',
                assetServer: 'hostedWebStaticAssets',
            });

            const response = await fetch(`${resource?.target.scheme}://${resource?.target.host}:${resource?.target.port}/`);
            await expect(response.text()).resolves.toBe(html);

            await runtime.stopControlServer();
        } finally {
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });

    it('syncs hosted-web static assets from the authoritative plugin runtime registry lease', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-hosted-web-runtime-lease-'));
        const html = '<html><body>Hosted web runtime lease</body></html>';
        const bytes = new TextEncoder().encode(html);
        const digest = computePluginUiArtifactFileSetSha256DigestV1([{
            relativePath: 'hosted-web/preview-web/index.html',
            bytes,
        }]);
        await writeHostedWebStaticAssetsFixture({ pluginRoot, html, digest });
        const releaseRuntimeRegistryLease = vi.fn(async () => {});
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValueOnce({
            registry: {
                contributes: createHostedWebStaticAssetsRegistry({
                    pluginRoot,
                    digest,
                    byteSize: bytes.byteLength,
                }),
            },
            source: 'active',
            release: releaseRuntimeRegistryLease,
        });

        const tracked: TrackedSession = {
            startedBy: 'daemon',
            pid: 9101,
            happySessionId: 'sess-hosted-web-runtime-lease',
        };

        try {
            const runtime = await startDaemonSessionControlRuntime({
                machineId: 'machine-hosted-web-runtime-lease',
                credentials: {
                    token: 'token-daemon',
                    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
                },
                api: {} as never,
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
            const resource = await waitForLocalServicesPreviewResource(
                controlServerInput,
                'plugin-static:acme.preview:preview-web:sess-hosted-web-runtime-lease:machine-hosted-web-runtime-lease',
            );

            expect(acquireAuthoritativePluginRuntimeRegistryLeaseMock).toHaveBeenCalledWith({
                happyHomeDir: '/tmp/happier-test-home',
            });
            expect(releaseRuntimeRegistryLease).toHaveBeenCalledTimes(1);
            expect(resource).toMatchObject({
                sessionId: 'sess-hosted-web-runtime-lease',
                owner: { kind: 'plugin', id: 'acme.preview' },
                originMode: 'path',
            });

            const response = await fetch(`${resource?.target.scheme}://${resource?.target.host}:${resource?.target.port}/`);
            await expect(response.text()).resolves.toBe(html);

            await runtime.stopControlServer();
        } finally {
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });

    it('starts the daemon control server before hosted-web startup registry sync settles', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        type RuntimeRegistryLeaseTestValue = {
            registry: { contributes: ResolvedContributionRegistry };
            source: 'active';
            release: () => Promise<void>;
        };
        let resolveRuntimeRegistryLease!: (value: RuntimeRegistryLeaseTestValue) => void;
        const runtimeRegistryLeasePromise = new Promise<RuntimeRegistryLeaseTestValue>((resolve) => {
            resolveRuntimeRegistryLease = resolve;
        });
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockImplementationOnce(async () => await runtimeRegistryLeasePromise);
        const releaseRuntimeRegistryLease = vi.fn(async () => {});
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            pid: 9102,
            happySessionId: 'sess-hosted-web-startup-nonblocking',
        };

        const runtimePromise = startDaemonSessionControlRuntime({
            machineId: 'machine-hosted-web-startup-nonblocking',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
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

        let didStartBeforeLeaseSettled = false;
        try {
            await waitForStartupCondition(() => vi.mocked(startDaemonControlServer).mock.calls.length > 0);
            didStartBeforeLeaseSettled = true;
        } finally {
            resolveRuntimeRegistryLease({
                registry: {
                    contributes: createResolvedContributionRegistry({
                        agents: [],
                                            }),
                },
                source: 'active',
                release: releaseRuntimeRegistryLease,
            });
            const runtime = await runtimePromise;
            await runtime.stopControlServer();
        }

        expect(didStartBeforeLeaseSettled).toBe(true);
    });

    it('notifies when daemon local-service preview routes are ready before machine RPC exists', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const onLocalServicesPreviewRoutesReady = vi.fn();
        const onBrowserRecordingRoutesReady = vi.fn();
        const onSimulatorPreviewRoutesReady = vi.fn();

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-local-services-delayed-rpc',
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
            onLocalServicesPreviewRoutesReady,
            onBrowserRecordingRoutesReady,
            onSimulatorPreviewRoutesReady,
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
            browserDaemonFeatureGate: fakeBrowserGate({ 'browser.recording': true }),
        } as Parameters<typeof startDaemonSessionControlRuntime>[0]);

        expect(onLocalServicesPreviewRoutesReady).toHaveBeenCalledWith(expect.objectContaining({
            getSnapshot: expect.any(Function),
        }));
        expect(onBrowserRecordingRoutesReady).toHaveBeenCalledWith(expect.objectContaining({
            startRecording: expect.any(Function),
            stopRecording: expect.any(Function),
            cancelRecording: expect.any(Function),
            getRecordingStatus: expect.any(Function),
            listRecordingsForView: expect.any(Function),
            cleanupExpiredRecordings: expect.any(Function),
        }));
        expect(onSimulatorPreviewRoutesReady).toHaveBeenCalledWith(expect.objectContaining({
            getSnapshot: expect.any(Function),
            dispatchAction: expect.any(Function),
        }));

        await runtime.stopControlServer();
    });

    it('builds a predictive soft-switch guard that requires Claude shared group auth surface while keeping Codex eligible', async () => {
        const activeServerDir = '/tmp/happier-test-home/servers/default';
        const claudeSharedConfigDir = [
            activeServerDir,
            'daemon',
            'connected-services',
            'homes',
            'claude-subscription',
            '__groups',
            'claude-team',
            'claude',
            'claude-config',
        ].join('/');
        const claudeTracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'session-claude-shared',
            pid: 5533,
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                environmentVariables: {
                    CLAUDE_CONFIG_DIR: claudeSharedConfigDir,
                    HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
                        kind: 'group',
                        serviceId: 'claude-subscription',
                        groupId: 'claude-team',
                        activeProfileId: 'batiplus',
                        fallbackProfileId: 'batiplus',
                        generation: 4,
                    }]),
                },
            },
        };
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
            pidToTrackedSession: new Map([[claudeTracked.pid, claudeTracked]]),
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

        await expect(runtime.connectedServicePredictiveSwitchGuard({
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

        await expect(runtime.connectedServicePredictiveSwitchGuard({
            sessionId: 'session-claude-shared',
            serviceId: 'claude-subscription',
            groupId: 'claude-team',
            activeProfileId: 'batiplus',
            agentId: 'claude',
            reason: 'soft_threshold',
        })).resolves.toEqual({ status: 'allow' });

        await expect(runtime.connectedServicePredictiveSwitchGuard({
            sessionId: 'session-codex',
            serviceId: 'openai-codex',
            groupId: 'codex-team',
            activeProfileId: 'codex4',
            agentId: 'codex',
            reason: 'soft_threshold',
        })).resolves.toEqual({ status: 'allow' });

        await runtime.stopControlServer();
    });

    it('keeps quota coordinator proof applies deduplicated while awaiting passive replay acknowledgement', async () => {
        applyConnectedServiceAuthGenerationToTrackedSessionMock.mockClear();
        const currentGroup = {
            v: 1,
            serviceId: 'openai-codex' as const,
            groupId: 'codex-main',
            displayName: 'Codex main',
            activeProfileId: 'backup',
            generation: 8,
            policy: { strategy: 'priority' as const, autoSwitch: true, recoveryMode: 'auto' as const },
            state: { status: 'ready' as const },
            createdAt: 1,
            updatedAt: 1,
            members: [],
        } as const;
        const listConnectedServiceAuthGroups = vi.fn(async () => ([currentGroup]));
        const getConnectedServiceAuthGroup = vi.fn(async () => currentGroup);
        const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-quota-switch',
            pid: 7788,
            spawnOptions: {
                directory: '/tmp/workspace-quota-switch',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                approvedNewDirectoryCreation: true,
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
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-quota-switch',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                listConnectedServiceProfiles: vi.fn(async () => ({ serviceId: 'openai-codex', profiles: [] })),
                getConnectedServiceAuthGroup,
                listConnectedServiceAuthGroups,
                push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            connectedServiceRuntimeRegistry,
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

        await runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator.switchBeforeTurn({
            sessionId: 'sess-quota-switch',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            reason: 'soft_threshold',
        });
        await Promise.resolve();

        await expect(runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator.applyCommittedGeneration({
            sessionId: 'sess-quota-switch',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'backup',
            generation: 7,
            reason: 'usage_limit',
        })).resolves.toMatchObject({
            status: 'observed_generation',
            activeProfileId: 'backup',
            generation: 7,
        });
        const generation7Coordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock.mock.results.at(-1)?.value as {
            switchBeforeTurn: ReturnType<typeof vi.fn>;
            applyCommittedGeneration: ReturnType<typeof vi.fn>;
        } | undefined;
        expect(generation7Coordinator?.applyCommittedGeneration).toHaveBeenCalledWith({
            sessionId: 'sess-quota-switch',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'backup',
            generation: 7,
            reason: 'usage_limit',
        });
        expect(generation7Coordinator?.switchBeforeTurn).not.toHaveBeenCalled();
        generation7Coordinator?.applyCommittedGeneration.mockClear();
        await expect(runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator.applyCommittedGeneration({
            sessionId: 'sess-quota-switch',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'backup',
            generation: 8,
            reason: 'account_changed',
            allowRestart: false,
        })).resolves.toMatchObject({
            status: 'observed_generation',
            generation: 8,
        });
        const generation8Coordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock.mock.results.at(-1)?.value as {
            applyCommittedGeneration: ReturnType<typeof vi.fn>;
        } | undefined;
        expect(generation7Coordinator?.applyCommittedGeneration).not.toHaveBeenCalled();
        expect(generation8Coordinator?.applyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-quota-switch',
            activeProfileId: 'backup',
            generation: 8,
            allowRestart: false,
        }));

        connectedServiceRuntimeRegistry.unregisterPid(tracked.pid);
        updateSessionMetadataWithRetryMock.mockClear();
        vi.mocked(callSessionRpc).mockClear();
        const reconcileCurrentProjection = () => runtime.reconcileConnectedServicesProjection({
            source: 'changes',
            executionAuthority: 'passive_projection',
            signal: new AbortController().signal,
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'backup', status: 'connected', kind: 'oauth' }],
                groups: [{
                    groupId: 'codex-main',
                    displayName: 'Codex main',
                    activeProfileId: 'backup',
                    generation: 8,
                    memberProfileIds: ['backup'],
                }],
            }],
            connectedServiceCredentialRevisionsV1: [{
                serviceId: 'openai-codex',
                profileId: 'backup',
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            }],
        });
        await expect(reconcileCurrentProjection()).resolves.toBeUndefined();
        expect(generation8Coordinator?.applyCommittedGeneration).toHaveBeenCalledOnce();
        expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
        expect(vi.mocked(callSessionRpc).mock.calls.some(([request]) => (
            request.method.endsWith(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION)
        ))).toBe(false);

        const controlServerInputForReplay = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        const replayApplyCommittedGeneration = vi.spyOn(
            runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator,
            'applyCommittedGeneration',
        );
        const registerReplacementRuntimeTarget = () => connectedServiceRuntimeRegistry.registerTarget({
            pid: tracked.pid,
            agentId: 'codex',
            sessionId: 'sess-quota-switch',
            materializationKey: 'csm_quota_switch_replacement',
            connectedServicesBindingsRaw: {
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
            connectedServiceSelectionsEnvRaw: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'codex-main',
                activeProfileId: 'backup',
                fallbackProfileId: 'primary',
                generation: 8,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            }]),
        });
        registerReplacementRuntimeTarget();
        await new Promise((resolve) => setImmediate(resolve));
        expect(replayApplyCommittedGeneration).not.toHaveBeenCalled();
        await expect(reconcileCurrentProjection()).rejects.toThrow(
            'connected_service_generation_reconciliation_not_acknowledgeable',
        );
        expect(replayApplyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-quota-switch',
            activeProfileId: 'backup',
            generation: 8,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            allowRestart: false,
        }));

        const baseSessionMetadata = {
            path: '/tmp/project',
            host: 'test-host',
            homeDir: '/tmp/home',
            happyHomeDir: '/tmp/home/.happier',
            happyLibDir: '/tmp/home/.happier/lib',
            happyToolsDir: '/tmp/home/.happier/tools',
        } as const;
        const accountProfileGet = vi.spyOn(axios, 'get').mockResolvedValue({
            status: 200,
            data: {
                id: 'account-1',
                connectedServicesV2: [{
                    serviceId: 'openai-codex',
                    profiles: [{ profileId: 'backup', status: 'connected', kind: 'oauth' }],
                    groups: [{
                        groupId: 'codex-main',
                        displayName: 'Codex main',
                        activeProfileId: 'backup',
                        generation: 8,
                        memberProfileIds: ['backup'],
                    }],
                }],
                connectedServiceCredentialRevisionsV1: [{
                    serviceId: 'openai-codex',
                    profileId: 'backup',
                    credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                }],
            },
        });
        replayApplyCommittedGeneration.mockClear();
        let releaseWebhookGenerationReconciliation!: () => void;
        const webhookGenerationReconciliationGate = new Promise<void>((resolve) => {
            releaseWebhookGenerationReconciliation = resolve;
        });
        replayApplyCommittedGeneration.mockImplementationOnce(async (input) => {
            await webhookGenerationReconciliationGate;
            return {
                status: 'observed_generation',
                activeProfileId: input.activeProfileId,
                generation: input.generation,
                mode: 'hot_apply',
            };
        });
        let webhookGenerationReconciliationSettled = false;
        const webhookGenerationReconciliation = Promise.resolve(
            controlServerInputForReplay?.onHappySessionWebhook?.('sess-quota-switch', {
                ...baseSessionMetadata,
            }),
        ).finally(() => {
            webhookGenerationReconciliationSettled = true;
        });
        const webhookGenerationReconciliationOutcome = webhookGenerationReconciliation.then(
            () => ({ status: 'resolved' as const }),
            (error: unknown) => ({ status: 'rejected' as const, error }),
        );
        await vi.waitFor(() => {
            expect(replayApplyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                allowRestart: false,
            }));
        });
        expect(webhookGenerationReconciliationSettled).toBe(false);
        releaseWebhookGenerationReconciliation();
        const webhookOutcome = await webhookGenerationReconciliationOutcome;
        expect(webhookOutcome.status).toBe('rejected');
        if (webhookOutcome.status !== 'rejected') {
            throw new Error('Expected webhook generation reconciliation to reject');
        }
        expect(webhookOutcome.error).toEqual(expect.objectContaining({
            message: 'connected_service_generation_reconciliation_not_acknowledgeable',
        }));
        expect(replayApplyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            allowRestart: false,
        }));

        replayApplyCommittedGeneration.mockClear();
        let generationCoordinatorCallsBeforeReplay = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.length;
        await expect(Promise.resolve(
            controlServerInputForReplay?.onHappySessionWebhook?.('sess-quota-switch', {
                ...baseSessionMetadata,
            }),
        )).rejects.toThrow('connected_service_generation_reconciliation_not_acknowledgeable');
        expect(replayApplyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            allowRestart: false,
        }));
        expect(createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock).toHaveBeenCalledTimes(
            generationCoordinatorCallsBeforeReplay + 1,
        );

        replayApplyCommittedGeneration.mockClear();
        generationCoordinatorCallsBeforeReplay = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.length;
        await expect(Promise.resolve(
            controlServerInputForReplay?.onHappySessionWebhook?.('sess-quota-switch', {
                ...baseSessionMetadata,
                connectedServicePendingAuthGroupGenerationsV1: {
                    v: 1,
                    entries: [{
                        kind: 'provider_adopted_generation',
                        providerAdoptedTarget: {
                            serviceId: 'openai-codex',
                            groupId: 'codex-main',
                            profileId: 'backup',
                            generation: 8,
                            credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                            proof: {
                                status: 'verified',
                                source: 'codex_app_server',
                                providerAccountId: 'acct',
                                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                            },
                        },
                        proofStrength: 'exact',
                        updatedAtMs: 1,
                    }],
                },
            }),
        )).rejects.toThrow('connected_service_generation_reconciliation_not_acknowledgeable');
        expect(replayApplyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            allowRestart: false,
        }));
        expect(createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock).toHaveBeenCalledTimes(
            generationCoordinatorCallsBeforeReplay + 1,
        );

        // Prove the mismatched envelope did not populate the projection cache before the exact-proof check.
        replayApplyCommittedGeneration.mockClear();
        generationCoordinatorCallsBeforeReplay = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.length;
        await expect(Promise.resolve(
            controlServerInputForReplay?.onHappySessionWebhook?.('sess-quota-switch', {
                ...baseSessionMetadata,
            }),
        )).rejects.toThrow('connected_service_generation_reconciliation_not_acknowledgeable');
        expect(replayApplyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            allowRestart: false,
        }));
        expect(createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock).toHaveBeenCalledTimes(
            generationCoordinatorCallsBeforeReplay + 1,
        );

        replayApplyCommittedGeneration.mockClear();
        generationCoordinatorCallsBeforeReplay = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.length;
        listConnectedServiceAuthGroups.mockClear();
        getConnectedServiceAuthGroup.mockClear();
        updateSessionMetadataWithRetryMock.mockClear();
        vi.mocked(callSessionRpc).mockClear();
        connectedServiceRuntimeRegistry.registerTarget({
            pid: tracked.pid,
            agentId: 'codex',
            sessionId: 'sess-quota-switch',
            materializationKey: 'csm_quota_switch_stale_runtime',
            connectedServicesBindingsRaw: {
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
            connectedServiceSelectionsEnvRaw: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'codex-main',
                activeProfileId: 'primary',
                fallbackProfileId: 'primary',
                generation: 7,
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            }]),
        });
        expect(connectedServiceRuntimeRegistry.getBySessionId('sess-quota-switch')?.activeBindings).toEqual([
            expect.objectContaining({
                profileId: 'primary',
                groupGeneration: 7,
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            }),
        ]);
        await expect(Promise.resolve(
            controlServerInputForReplay?.onHappySessionWebhook?.('sess-quota-switch', {
                ...baseSessionMetadata,
                connectedServicePendingAuthGroupGenerationsV1: {
                    v: 1,
                    entries: [{
                        kind: 'provider_adopted_generation',
                        providerAdoptedTarget: {
                            serviceId: 'openai-codex',
                            groupId: 'codex-main',
                            profileId: 'backup',
                            generation: 8,
                            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                            proof: {
                                status: 'verified',
                                source: 'codex_app_server',
                                providerAccountId: 'acct',
                                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                            },
                        },
                        proofStrength: 'exact',
                        updatedAtMs: 1,
                    }],
                },
            }),
        )).resolves.toBeUndefined();
        const accountProfileGetCalls = accountProfileGet.mock.calls.length;
        expect(replayApplyCommittedGeneration).not.toHaveBeenCalled();
        expect(listConnectedServiceAuthGroups).not.toHaveBeenCalled();
        expect(getConnectedServiceAuthGroup).not.toHaveBeenCalled();
        expect(accountProfileGetCalls).toBeGreaterThan(0);
        expect(createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock).toHaveBeenCalledTimes(
            generationCoordinatorCallsBeforeReplay,
        );
        expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
        expect(vi.mocked(callSessionRpc).mock.calls.some(([request]) => (
            request.method.endsWith(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION)
        ))).toBe(false);
        expect(connectedServiceRuntimeRegistry.getBySessionId('sess-quota-switch')?.activeBindings).toEqual([
            expect.objectContaining({
                profileId: 'backup',
                groupGeneration: 8,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            }),
        ]);

        expect(commitSessionStoredMessageMock).not.toHaveBeenCalled();
        expect(dispatchActivityNotificationAsyncMock).not.toHaveBeenCalled();

        const quotaCoordinatorInput = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock.mock.calls.at(-1)?.[0] as {
            restartSession?: (input: {
                serviceId: 'openai-codex';
                groupId: string;
                activeProfileId: string | null;
                generation: number;
            }) => Promise<void>;
        };
        await quotaCoordinatorInput.restartSession?.({
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'backup',
            generation: 7,
        });

        const applyInput = applyConnectedServiceAuthGenerationToTrackedSessionMock.mock.calls.at(-1)?.[0] as {
            emitSessionEvent?: (sessionId: string, event: unknown) => void;
        } | undefined;
        applyInput?.emitSessionEvent?.('sess-quota-switch', {
            type: 'connected_service_account_switch',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            fromProfileId: 'primary',
            toProfileId: 'backup',
            reason: 'soft_threshold',
            mode: 'hot_apply',
            generation: 7,
        });
        applyInput?.emitSessionEvent?.('sess-quota-switch', {
            type: 'connected_service_account_switch_attempt',
            ok: true,
            action: 'hot_applied',
            outcome: 'succeeded',
            outcomeAction: 'hot_applied',
            errorCode: null,
            groupGeneration: 7,
            sessionAdoption: 'applied',
            sessionAdoptedGeneration: 7,
            partialState: 'runtime_auth_applied',
            reason: 'soft_threshold',
        });

        await Promise.resolve();
        // This callback belongs to passive projection replay. Runtime-owned quota
        // attempts remain visible, but replay must not manufacture a new switch or
        // failure row merely because the daemon reconstructed current truth.
        expect(commitSessionStoredMessageMock).not.toHaveBeenCalled();
        expect(dispatchActivityNotificationAsyncMock).not.toHaveBeenCalled();

        accountProfileGet.mockRestore();
        await runtime.stopControlServer();
    });

    it('reconciles a daemon-replacement runtime from layout-v1 provider adoption without admission or restart', async () => {
        const sessionId = 'sess-late-current-truth';
        const pid = 7799;
        const secret = new Uint8Array(32).fill(1);
        const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: sessionId,
            pid,
            happySessionMetadataFromLocalWebhook: {
                path: '/tmp/workspace-late-current-truth',
                host: 'test-host',
                homeDir: '/tmp/home',
                happyHomeDir: '/tmp/home/.happier',
                happyLibDir: '/tmp/home/.happier/lib',
                happyToolsDir: '/tmp/home/.happier/tools',
            },
            spawnOptions: {
                directory: '/tmp/workspace-late-current-truth',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            },
        };
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
            v: 1,
            connectedServices: {
                connectedServicePendingAuthGroupGenerationsV1: {
                    v: 1,
                    entries: [{
                        kind: 'provider_adopted_generation',
                        providerAdoptedTarget: {
                            serviceId: 'openai-codex',
                            groupId: 'codex-main',
                            profileId: 'primary',
                            generation: 7,
                            credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                            proof: {
                                status: 'verified',
                                source: 'codex_app_server',
                                providerAccountId: 'acct',
                                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                            },
                        },
                        proofStrength: 'exact',
                        updatedAtMs: 1,
                    }],
                },
            },
        });
        fetchSessionByIdCompatMock.mockResolvedValue({
            id: sessionId,
            encryptionMode: 'plain',
            metadataLayoutVersion: 1,
            metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: sealSessionOwnerMetadataV1({
                material: { type: 'legacy', secret },
                ownerMetadata,
                randomBytes: (length) => new Uint8Array(length).fill(7),
            }),
            metadataVersion: 7,
        });
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-late-current-truth',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret },
            },
            api: {
                listConnectedServiceProfiles: vi.fn(async () => ({ serviceId: 'openai-codex', profiles: [] })),
                getConnectedServiceAuthGroup: vi.fn(async () => null),
                push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            connectedServiceRuntimeRegistry,
            pidToTrackedSession: new Map([[pid, tracked]]),
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

        await runtime.reconcileConnectedServicesProjection({
            source: 'changes',
            executionAuthority: 'passive_projection',
            signal: new AbortController().signal,
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'primary', status: 'connected', kind: 'oauth' }],
                groups: [{
                    groupId: 'codex-main',
                    displayName: 'Codex main',
                    activeProfileId: 'primary',
                    generation: 7,
                    memberProfileIds: ['primary'],
                }],
            }],
            connectedServiceCredentialRevisionsV1: [{
                serviceId: 'openai-codex',
                profileId: 'primary',
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            }],
        });
        const applyCommittedGeneration = vi.spyOn(
            runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator,
            'applyCommittedGeneration',
        );
        vi.mocked(callSessionRpc).mockClear();

        const registerLateRuntime = () => connectedServiceRuntimeRegistry.registerTarget({
            pid,
            agentId: 'codex',
            sessionId,
            materializationKey: 'csm_late_current_truth',
            connectedServicesBindingsRaw: {
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
            connectedServiceSelectionsEnvRaw: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'codex-main',
                activeProfileId: 'primary',
                fallbackProfileId: 'primary',
                generation: 7,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            }]),
        });
        registerLateRuntime();
        await new Promise((resolve) => setImmediate(resolve));

        expect(applyCommittedGeneration).not.toHaveBeenCalled();
        expect(connectedServiceRuntimeRegistry.getBySessionId(sessionId)?.activeBindings).toEqual([
            expect.objectContaining({
                profileId: 'primary',
                groupGeneration: 7,
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            }),
        ]);
        applyCommittedGeneration.mockClear();
        registerLateRuntime();
        await new Promise((resolve) => setImmediate(resolve));
        expect(applyCommittedGeneration).not.toHaveBeenCalled();

        expect(vi.mocked(callSessionRpc).mock.calls.some(([request]) => (
            request.method.endsWith(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION)
        ))).toBe(false);

        applyCommittedGeneration.mockClear();
        const parentSessionMetadataRead = vi.spyOn(axios, 'get').mockResolvedValueOnce({ data: null });
        connectedServiceRuntimeRegistry.registerRunTarget({
            runKey: 'run-late-current-truth',
            pid,
            agentId: 'codex',
            sessionId,
            materializationKey: 'run-late-current-truth',
            connectedServicesBindingsRaw: {
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
            connectedServiceSelectionsEnvRaw: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'codex-main',
                activeProfileId: 'primary',
                fallbackProfileId: 'primary',
                generation: 7,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            }]),
        });
        await new Promise((resolve) => setImmediate(resolve));

        // A run may retain its parent sessionId for lifecycle display, but that does not grant the
        // run permission to read or consume the parent's provider-adoption metadata. Its only live
        // current-generation authority is the exact run-key pre-effect admission fence.
        expect(parentSessionMetadataRead).not.toHaveBeenCalled();
        expect(applyCommittedGeneration).not.toHaveBeenCalled();
        parentSessionMetadataRead.mockRestore();

        await runtime.stopControlServer();
    });

    it('uses fresh authoritative truth for startup readiness without applying a stale projection', async () => {
        const sessionId = 'sess-claude-legacy-startup-fresh-truth';
        const pid = 7800;
        const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
        const happySessionMetadata: NonNullable<TrackedSession['happySessionMetadataFromLocalWebhook']> = {
            path: '/tmp/workspace-claude-legacy-startup',
            host: 'test-host',
            homeDir: '/tmp/home',
            happyHomeDir: '/tmp/home/.happier',
            happyLibDir: '/tmp/home/.happier/lib',
            happyToolsDir: '/tmp/home/.happier/tools',
        };
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: sessionId,
            pid,
            happySessionMetadataFromLocalWebhook: happySessionMetadata,
            spawnOptions: {
                directory: '/tmp/workspace-claude-legacy-startup',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            },
        };
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-claude-legacy-startup',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {
                listConnectedServiceProfiles: vi.fn(async () => ({ serviceId: 'claude-subscription', profiles: [] })),
                getConnectedServiceAuthGroup: vi.fn(async () => null),
                push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            connectedServiceRuntimeRegistry,
            pidToTrackedSession: new Map([[pid, tracked]]),
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
        const accountProfileGet = vi.spyOn(axios, 'get').mockResolvedValue({
            status: 200,
            data: {
                id: 'account-1',
                connectedServicesV2: [{
                    serviceId: 'claude-subscription',
                    profiles: [{ profileId: 'lb_bat', status: 'connected', kind: 'oauth' }],
                    groups: [{
                        groupId: 'team',
                        displayName: 'Claude team',
                        activeProfileId: 'lb_bat',
                        generation: 274,
                        memberProfileIds: ['lb_bat'],
                    }],
                }],
                connectedServiceCredentialRevisionsV1: [],
            },
        });

        try {
            await runtime.reconcileConnectedServicesProjection({
                source: 'changes',
                executionAuthority: 'passive_projection',
                signal: new AbortController().signal,
                connectedServicesV2: [{
                    serviceId: 'claude-subscription',
                    profiles: [{ profileId: 'claude-primary', status: 'connected', kind: 'oauth' }],
                    groups: [{
                        groupId: 'team',
                        displayName: 'Claude team',
                        activeProfileId: 'claude-primary',
                        generation: 1,
                        memberProfileIds: ['claude-primary'],
                    }],
                }],
                connectedServiceCredentialRevisionsV1: [{
                    serviceId: 'claude-subscription',
                    profileId: 'claude-primary',
                    credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                }],
            });
            applyConnectedServiceAuthGenerationToTrackedSessionMock.mockRejectedValue(
                new Error('stale passive application is not acknowledgeable'),
            );
            connectedServiceRuntimeRegistry.registerTarget({
                pid,
                agentId: 'claude',
                sessionId,
                materializationKey: 'csm_claude_legacy_startup',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: 'csm_claude_legacy_startup',
                    createdAt: 1,
                },
                connectedServicesBindingsRaw: {
                    v: 1,
                    bindingsByServiceId: {
                        'claude-subscription': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'team',
                            profileId: 'lb_bat',
                        },
                    },
                },
                connectedServiceSelectionsEnvRaw: JSON.stringify([{
                    kind: 'group',
                    serviceId: 'claude-subscription',
                    groupId: 'team',
                    activeProfileId: 'lb_bat',
                    fallbackProfileId: 'lb_bat',
                    generation: 274,
                }]),
            });

            const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
            await expect(Promise.resolve(
                controlServerInput?.onHappySessionWebhook?.(
                    sessionId,
                    happySessionMetadata,
                ),
            )).resolves.toBeUndefined();

            expect(accountProfileGet).toHaveBeenCalled();
            expect(applyConnectedServiceAuthGenerationToTrackedSessionMock).not.toHaveBeenCalled();
        } finally {
            accountProfileGet.mockRestore();
            await runtime.stopControlServer();
        }
    });

    it('keeps a refresh-disabled direct-profile run fenced while credential deletion stops its parent lifecycle', async () => {
        const sessionId = 'sess-direct-run-deletion';
        const runId = 'run-direct-deletion';
        const pid = 7801;
        const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const materializationBaseDir = await mkdtemp(join(tmpdir(), 'happier-direct-run-deletion-'));
        const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
        let refreshCoordinator: Readonly<{
            handleExternalCredentialUpdate: (input: unknown) => Promise<void>;
        }> | null = null;
        const childProcess = {
            pid,
            exitCode: null as number | null,
            signalCode: null as NodeJS.Signals | null,
            kill: vi.fn(() => true),
        };
        const pidToTrackedSession = new Map<number, TrackedSession>([[
            pid,
            {
                startedBy: 'daemon',
                happySessionId: sessionId,
                pid,
                childProcess: childProcess as never,
                spawnOptions: {
                    directory: '/tmp/workspace-direct-run-deletion',
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
                },
            },
        ]]);
        const quotasCoordinator = {};
        const credential = buildConnectedServiceCredentialRecord({
            now: 1,
            serviceId: 'openai-codex',
            profileId: 'primary',
            kind: 'oauth',
            expiresAt: null,
            oauth: {
                accessToken: 'direct-run-access',
                refreshToken: 'direct-run-refresh',
                idToken: 'direct-run-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct-direct-run',
                providerEmail: null,
            },
        });
        const processKill = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
            if (targetPid === -pid && signal === 'SIGTERM') {
                throw Object.assign(new Error('missing process group'), { code: 'ESRCH' });
            }
            if (targetPid === pid && signal === 0) {
                if (childProcess.exitCode === null) return true;
                throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
            }
            return true;
        }) as typeof process.kill);

        const presentProjection = {
            source: 'changes' as const,
            executionAuthority: 'passive_projection' as const,
            signal: new AbortController().signal,
            connectedServicesV2: [{
                serviceId: 'openai-codex' as const,
                profiles: [{ profileId: 'primary', status: 'connected' as const, kind: 'oauth' as const }],
                groups: [],
            }],
            connectedServiceCredentialRevisionsV1: [{
                serviceId: 'openai-codex' as const,
                profileId: 'primary',
                credentialRevision,
            }],
        };
        const absentProjection = {
            ...presentProjection,
            signal: new AbortController().signal,
            connectedServicesV2: [{
                serviceId: 'openai-codex' as const,
                profiles: [],
                groups: [],
            }],
            connectedServiceCredentialRevisionsV1: [],
        };

        try {
            const runtime = await startDaemonSessionControlRuntime({
                machineId: 'machine-direct-run-deletion',
                credentials: {
                    token: 'token-daemon',
                    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
                },
                api: {
                    listConnectedServiceProfiles: vi.fn(async () => ({
                        serviceId: 'openai-codex',
                        profiles: [{ profileId: 'primary', status: 'connected' }],
                    })),
                    getAccountEncryptionMode: vi.fn(async () => 'plain'),
                    getConnectedServiceCredentialPlain: vi.fn(async () => ({
                        revisionSemantics: 'revisioned',
                        credentialRevision,
                        content: { t: 'plain', v: credential },
                    })),
                    push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
                } as never,
                loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
                connectedServicesMaterializationBaseDir: materializationBaseDir,
                getConnectedServiceRefreshCoordinator: () => refreshCoordinator as never,
                getConnectedServiceQuotasCoordinator: () => quotasCoordinator as never,
                connectedServiceRuntimeRegistry,
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
            const materialized = await controlServerInput?.materializeConnectedServicesForExecutionRun?.({
                runId,
                runnerPid: pid,
                agentId: 'codex',
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
                cwd: '/tmp/workspace-direct-run-deletion',
            });
            expect(materialized).toMatchObject({ ok: true });
            if (!materialized?.ok) {
                throw new Error('expected run materialization to succeed');
            }
            expect(connectedServiceRuntimeRegistry.getRunTargetByRunKey(runId)).toMatchObject({
                pid,
                sessionId,
                materializationKey: runId,
                activeBindings: [{
                    serviceId: 'openai-codex',
                    groupId: null,
                    profileId: 'primary',
                    groupGeneration: null,
                    credentialRevision,
                }],
            });

            refreshCoordinator = {
                handleExternalCredentialUpdate: vi.fn(async () => {}),
            };
            await expect(runtime.reconcileConnectedServicesProjection(presentProjection)).resolves.toBeUndefined();
            await expect(controlServerInput?.checkConnectedServicesGenerationForExecutionRun?.({
                runId,
                runnerPid: pid,
            })).resolves.toEqual({ ok: true, current: true });

            refreshCoordinator = null;
            await expect(runtime.reconcileConnectedServicesProjection(absentProjection)).rejects.toThrow(
                'connected_service_credential_deletion_not_settled:incomplete',
            );
            expect(childProcess.kill).toHaveBeenCalledTimes(1);
            await expect(controlServerInput?.checkConnectedServicesGenerationForExecutionRun?.({
                runId,
                runnerPid: pid,
            })).resolves.toEqual({ ok: true, current: false });

            await runtime.onChildExited(pid, {
                reason: 'process-exited',
                code: 0,
                signal: null,
            });
            expect(pidToTrackedSession.has(pid)).toBe(false);
            expect(connectedServiceRuntimeRegistry.getRunTargetByRunKey(runId)).toBeNull();

            const retriedDeletion = runtime.reconcileConnectedServicesProjection({
                ...absentProjection,
                signal: new AbortController().signal,
            });
            await expect(controlServerInput?.checkConnectedServicesGenerationForExecutionRun?.({
                runId,
                runnerPid: pid,
            })).resolves.toEqual({ ok: true, current: false });
            await expect(retriedDeletion).resolves.toBeUndefined();
            expect(childProcess.kill).toHaveBeenCalledTimes(1);

            await controlServerInput?.releaseConnectedServicesForExecutionRun?.({
                runId,
                runnerPid: pid,
                activationId: materialized.activationId,
            });
            await runtime.stopControlServer();
        } finally {
            processKill.mockRestore();
            await rm(materializationBaseDir, { recursive: true, force: true });
        }
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

        await runtime.onChildExited(9999, { reason: 'process-exited', code: null, signal: 'SIGTERM' });
        expect(connectedServicesRestartRequestedPids.has(9999)).toBe(false);

        await vi.waitFor(() => {
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
        });

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
        const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
        const transferRuntimeTarget = vi.spyOn(connectedServiceRuntimeRegistry, 'transferPid');
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
            connectedServiceRuntimeRegistry,
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

        await runtime.onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

        expect(transferRuntimeTarget).toHaveBeenCalledWith(wrapperPid, runnerPid);
        expect(refreshCoordinator.transferPid).not.toHaveBeenCalled();
        expect(quotasCoordinator.transferPid).not.toHaveBeenCalled();
        expect(refreshCoordinator.unregisterPid).not.toHaveBeenCalled();
        expect(quotasCoordinator.unregisterPid).not.toHaveBeenCalled();
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

    it('routes session runtime-auth refresh through the plugin runtime registry bridge', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
        registerRuntimeAuthRefreshTarget(runtimeRegistry, runtimeAuthRefreshRequest.sessionId);
        const bridge = Object.freeze({
            pluginId: 'acme.oauth',
            registration: {
                serviceId: 'openai-codex',
                refresh: vi.fn(async () => ({
                    status: 'refreshed' as const,
                    result: { accessToken: 'plugin-access' },
                })),
            },
        });
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockImplementationOnce(async () => ({
            registry: {
                contributes: createResolvedContributionRegistry({
                    agents: [],
                                    }),
                daemonAuthBridgesByServiceId: new Map([
                    ['openai-codex', bridge],
                ]),
            },
            source: 'active',
            release: vi.fn(async () => {}),
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
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            connectedServiceRuntimeRegistry: runtimeRegistry,
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
        await expect(controlServerInput?.handleSessionConnectedServiceRuntimeAuthRefresh?.(
            runtimeAuthRefreshRequest,
        )).resolves.toEqual({
            ok: true,
            result: {
                status: 'refreshed',
                result: { accessToken: 'plugin-access' },
            },
        });
        expect(bridge.registration.refresh).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: runtimeAuthRefreshRequest.sessionId,
            selection: runtimeAuthRefreshSelection,
            expectedCredentialRevision: runtimeAuthRefreshRequest.expectedCredentialRevision,
            forceRefresh: true,
        }));
    });

    it('binds daemon auth bridge refresh through the registering agent catalog hook', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
        registerRuntimeAuthRefreshTarget(runtimeRegistry, runtimeAuthRefreshRequest.sessionId);
        const placeholderRefresh = vi.fn(async () => ({
            status: 'refreshed' as const,
            result: { source: 'placeholder' },
        }));
        const catalogRefresh = vi.fn(async (input: Readonly<{
            serviceId: string;
            request: Readonly<Record<string, unknown>>;
        }>) => ({
            status: 'refreshed' as const,
            result: {
                source: 'catalog',
                serviceId: input.serviceId,
                selection: input.request.selection,
            },
        }));
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockImplementation(async () => ({
            registry: {
                contributes: createResolvedContributionRegistry({
                    agents: [],
                                        catalogEntries: [{
                        id: 'fixture-agent',
                        cliSubcommand: 'fixture-agent',
                        vendorResumeSupport: 'unsupported',
                        getConnectedServiceDaemonAuthBridgeRefresh: async () => catalogRefresh,
                    }],
                }),
                daemonAuthBridgesByServiceId: new Map([
                    ['openai-codex', Object.freeze({
                        pluginId: 'fixture-agent',
                        registration: {
                            serviceId: 'openai-codex',
                            refresh: placeholderRefresh,
                        },
                    })],
                ]),
            },
            source: 'active',
            release: vi.fn(async () => {}),
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
            getConnectedServiceRefreshCoordinator: () => ({ marker: 'refresh-coordinator' }) as never,
            getConnectedServiceQuotasCoordinator: () => null,
            connectedServiceRuntimeRegistry: runtimeRegistry,
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
        await expect(controlServerInput?.handleSessionConnectedServiceRuntimeAuthRefresh?.(
            runtimeAuthRefreshRequest,
        )).resolves.toEqual({
            ok: true,
            result: {
                status: 'refreshed',
                result: {
                    source: 'catalog',
                    serviceId: 'openai-codex',
                    selection: runtimeAuthRefreshSelection,
                },
            },
        });
        expect(catalogRefresh).toHaveBeenCalledTimes(1);
        expect(placeholderRefresh).not.toHaveBeenCalled();
    });

    it('resolves daemon auth bridges from the current plugin runtime registry on each lookup', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
        registerRuntimeAuthRefreshTarget(runtimeRegistry, runtimeAuthRefreshRequest.sessionId);
        const firstBridge = Object.freeze({
            pluginId: 'codex.first',
            registration: {
                serviceId: 'openai-codex',
                refresh: vi.fn(async () => ({ status: 'refreshed' as const, result: { accessToken: 'first-access' } })),
            },
        });
        const secondBridge = Object.freeze({
            pluginId: 'codex.second',
            registration: {
                serviceId: 'openai-codex',
                refresh: vi.fn(async () => ({ status: 'refreshed' as const, result: { accessToken: 'second-access' } })),
            },
        });
        const releaseFirst = vi.fn(async () => {});
        const releaseSecond = vi.fn(async () => {});
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
            connectedServiceRuntimeRegistry: runtimeRegistry,
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

        acquireAuthoritativePluginRuntimeRegistryLeaseMock
            .mockImplementationOnce(async () => ({
                registry: {
                    contributes: createResolvedContributionRegistry({
                        agents: [],
                                            }),
                    daemonAuthBridgesByServiceId: new Map([
                        ['openai-codex', firstBridge],
                    ]),
                },
                source: 'active',
                release: releaseFirst,
            }))
            .mockImplementationOnce(async () => ({
                registry: {
                    contributes: createResolvedContributionRegistry({
                        agents: [],
                                            }),
                    daemonAuthBridgesByServiceId: new Map([
                        ['openai-codex', secondBridge],
                    ]),
                },
                source: 'active',
                release: releaseSecond,
            }));

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        await expect(controlServerInput?.handleSessionConnectedServiceRuntimeAuthRefresh?.({
            ...runtimeAuthRefreshRequest,
            refreshAttemptId: 'refresh-attempt-first',
        })).resolves.toEqual({
            ok: true,
            result: { status: 'refreshed', result: { accessToken: 'first-access' } },
        });
        await expect(controlServerInput?.handleSessionConnectedServiceRuntimeAuthRefresh?.({
            ...runtimeAuthRefreshRequest,
            refreshAttemptId: 'refresh-attempt-second',
        })).resolves.toEqual({
            ok: true,
            result: { status: 'refreshed', result: { accessToken: 'second-access' } },
        });
        expect(releaseFirst).toHaveBeenCalledTimes(1);
        expect(releaseSecond).toHaveBeenCalledTimes(1);
    });

     it('does not replay runtime-auth failure reports during passive startup reconstruction', async () => {
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

        expect(drainRuntimeAuthFailureReportOutboxToDaemonMock).not.toHaveBeenCalled();
    });

    it('retains predecessor no-turn lifecycle as downstream-only compatibility', async () => {
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-cancelled',
            pid: 75,
            sessionRunnerPid: 76,
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'gemini', sourceKind: 'built_in' },
            },
        };
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

        await expect(controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-cancelled',
            event: 'turn_cancelled',
        })).resolves.toEqual({
            status: 'ignored_missing_exact_turn',
            turnCustody: {
                status: 'ignored_missing_exact_turn',
                activeTurnId: null,
            },
        });

        expect(updateSessionMarkerActiveTurnMock).not.toHaveBeenCalled();
        expect(removeRuntimeAuthFailureReportOutboxItemsForSessionMock).toHaveBeenCalledWith({
            sessionId: 'sess-cancelled',
            updatedBeforeMs: expect.any(Number),
        });
    });

    it('rejects stale exact terminal custody without downstream outbox or marker effects', async () => {
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-stale-terminal',
            pid: 75,
            sessionRunnerPid: 76,
            activeTurnId: 'session-turn:current',
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            },
        };
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

        await expect(controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-stale-terminal',
            turnId: 'session-turn:current',
            event: 'prompt_or_steer',
        })).resolves.toMatchObject({
            status: 'recorded',
            turnCustody: { status: 'recorded' },
        });
        await vi.waitFor(() => {
            expect(removeRuntimeAuthFailureReportOutboxItemsForSessionMock).toHaveBeenCalledOnce();
        });
        // The accepted prompt cleanup is deliberately detached from custody. Let its
        // promise chain finish before clearing the mock so the stale-event assertion
        // cannot be contaminated by the accepted event's remaining microtasks.
        await new Promise<void>((resolve) => setImmediate(resolve));
        removeRuntimeAuthFailureReportOutboxItemsForSessionMock.mockClear();
        await expect(controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-stale-terminal',
            turnId: 'session-turn:stale',
            event: 'turn_cancelled',
        })).resolves.toEqual({
            status: 'ignored_turn_mismatch',
            turnCustody: {
                status: 'ignored_turn_mismatch',
                activeTurnId: 'session-turn:current',
            },
        });

        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(removeRuntimeAuthFailureReportOutboxItemsForSessionMock).not.toHaveBeenCalled();
        expect(updateSessionMarkerActiveTurnMock).toHaveBeenCalledTimes(1);
        expect(tracked.activeTurnId).toBe('session-turn:current');
    });

    it('rejects exact custody when the authoritative marker write fails', async () => {
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-marker-failed',
            pid: 77,
            sessionRunnerPid: 78,
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            },
        };
        updateSessionMarkerActiveTurnMock.mockResolvedValueOnce(false);
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

        await expect(controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-marker-failed',
            turnId: 'session-turn:exact-1',
            event: 'prompt_or_steer',
        })).resolves.toEqual({
            status: 'ignored_marker_not_updated',
            turnCustody: {
                status: 'ignored_marker_not_updated',
                activeTurnId: null,
            },
        });

        expect(removeRuntimeAuthFailureReportOutboxItemsForSessionMock).not.toHaveBeenCalled();
        await expect(runtime.connectedServicePredictiveSwitchGuard({
            sessionId: 'sess-marker-failed',
            serviceId: 'openai-codex',
            groupId: 'codex-team',
            activeProfileId: 'primary',
            agentId: 'codex',
            reason: 'soft_threshold',
        })).resolves.toEqual({ status: 'allow' });
    });

    it('acknowledges exact custody before provider proof and a later supersession settle on disposal', async () => {
        const credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
        const runtimeSelectionRaw = JSON.stringify([{
            kind: 'group',
            serviceId: 'gemini',
            groupId: 'gemini-pool',
            activeProfileId: 'backup',
            fallbackProfileId: 'primary',
            generation: 2,
            credentialRevision,
        }]);
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-begin-custody',
            pid: 77,
            sessionRunnerPid: 78,
            activeTurnId: 'session-turn:exact-1',
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'gemini', sourceKind: 'built_in' },
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: runtimeSelectionRaw,
                },
            },
        };
        const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
        getConnectedServiceRuntimeAuthAdapterMock.mockImplementationOnce(async () => ({
            verifyProviderOutcome: async () => ({
                status: 'verified' as const,
                targets: [{
                    serviceId: 'gemini',
                    profileId: 'backup',
                    groupId: 'gemini-pool',
                    groupGeneration: 2,
                    credentialRevision,
                }],
            }),
        }));
        const downstreamSettlementStarted = vi.fn();
        let releaseDownstreamSettlement!: () => void;
        const downstreamSettlementRelease = new Promise<void>((resolve) => {
            releaseDownstreamSettlement = resolve;
        });
        let observeDownstreamSettlementStarted!: () => void;
        const downstreamSettlementStartedPromise = new Promise<void>((resolve) => {
            observeDownstreamSettlementStarted = resolve;
        });
        let markProviderOutcomeProof:
            | ReturnType<typeof vi.spyOn>
            | undefined;
        removeRuntimeAuthFailureReportOutboxItemsForSessionMock.mockImplementationOnce(async (input) => {
            expect(input).toEqual({
                sessionId: 'sess-begin-custody',
                updatedBeforeMs: expect.any(Number),
            });
            downstreamSettlementStarted();
            observeDownstreamSettlementStarted();
            await downstreamSettlementRelease;
        });

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
            connectedServiceRuntimeRegistry,
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
        connectedServiceRuntimeRegistry.registerTarget({
            pid: tracked.pid,
            agentId: 'gemini',
            sessionId: tracked.happySessionId,
            connectedServiceSelectionsEnv: {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: runtimeSelectionRaw,
            },
        });
        markProviderOutcomeProof = vi.spyOn(
            controlServerInput!.runtimeAuthRecoveryScheduler!,
            'markProviderOutcomeProofByIdentity',
        );

        const terminalResult = controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-begin-custody',
            turnId: 'session-turn:exact-1',
            event: 'assistant_message_end',
            terminalStatus: 'completed',
            connectedServiceSelectionsEnvRaw: runtimeSelectionRaw,
        });
        const observedTerminal = await Promise.race([
            Promise.resolve(terminalResult).then((value) => ({ status: 'resolved' as const, value })),
            new Promise<{ status: 'pending' }>((resolve) => setImmediate(() => resolve({ status: 'pending' }))),
        ]);

        expect(observedTerminal).toEqual({
            status: 'resolved',
            value: {
                status: 'recorded',
                turnCustody: {
                    status: 'recorded',
                    activeTurnId: null,
                },
            },
        });
        expect(updateSessionMarkerActiveTurnMock).toHaveBeenCalledWith({
            pid: 78,
            sessionId: 'sess-begin-custody',
            activeTurnId: null,
        });
        expect(tracked.activeTurnId).toBeUndefined();
        await vi.waitFor(() => {
            expect(markProviderOutcomeProof).toHaveBeenCalled();
        });

        const promptResult = controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-begin-custody',
            turnId: 'session-turn:exact-2',
            event: 'prompt_or_steer',
        });
        const observedPrompt = await Promise.race([
            Promise.resolve(promptResult).then((value) => ({ status: 'resolved' as const, value })),
            new Promise<{ status: 'pending' }>((resolve) => setImmediate(() => resolve({ status: 'pending' }))),
        ]);
        expect(observedPrompt).toEqual({
            status: 'resolved',
            value: {
                status: 'recorded',
                turnCustody: {
                    status: 'recorded',
                    activeTurnId: 'session-turn:exact-2',
                },
            },
        });
        await downstreamSettlementStartedPromise;
        expect(downstreamSettlementStarted).toHaveBeenCalledOnce();

        const shutdown = controlServerInput!.beforeShutdown!({
            managedLocalServicesDisposition: 'permanent',
        });
        await expect(Promise.race([
            shutdown.then(() => 'settled' as const),
            new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
        ])).resolves.toBe('settled');

        releaseDownstreamSettlement();
    });

    it('does not let a never-settling provider verification strand daemon shutdown', async () => {
        const runtimeSelectionRaw = JSON.stringify([{
            kind: 'group',
            serviceId: 'gemini',
            groupId: 'gemini-pool',
            activeProfileId: 'backup',
            fallbackProfileId: 'primary',
            generation: 2,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }]);
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-provider-proof-hang',
            pid: 79,
            activeTurnId: 'session-turn:exact-hang',
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'gemini', sourceKind: 'built_in' },
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: runtimeSelectionRaw,
                },
            },
        };
        const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
        let observeProviderVerificationStarted!: () => void;
        const providerVerificationStarted = new Promise<void>((resolve) => {
            observeProviderVerificationStarted = resolve;
        });
        getConnectedServiceRuntimeAuthAdapterMock.mockImplementationOnce(async () => ({
            verifyProviderOutcome: async () => {
                observeProviderVerificationStarted();
                await new Promise<void>(() => {});
                throw new Error('unreachable');
            },
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
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            connectedServiceRuntimeRegistry,
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
        connectedServiceRuntimeRegistry.registerTarget({
            pid: tracked.pid,
            agentId: 'gemini',
            sessionId: tracked.happySessionId,
            connectedServiceSelectionsEnv: {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: runtimeSelectionRaw,
            },
        });

        await expect(controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-provider-proof-hang',
            turnId: 'session-turn:exact-hang',
            event: 'assistant_message_end',
            terminalStatus: 'completed',
            connectedServiceSelectionsEnvRaw: runtimeSelectionRaw,
        })).resolves.toMatchObject({ status: 'recorded' });
        await providerVerificationStarted;

        await expect(Promise.race([
            controlServerInput!.beforeShutdown!({
                managedLocalServicesDisposition: 'permanent',
            }).then(() => 'settled' as const),
            new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
        ])).resolves.toBe('settled');
        expect(removeRuntimeAuthFailureReportOutboxItemsForSessionMock).not.toHaveBeenCalled();
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

    it('rehydrates exact connected-service runtime identity after a reported session reconnects', async () => {
        vi.mocked(callSessionRpc).mockResolvedValueOnce({
            ok: true,
            serviceId: 'openai-codex',
            identity: {
                strategy: 'provider_account_id',
                proofStrength: 'exact',
                providerAccountId: 'acct-live',
                accountLabel: 'live@example.com',
            },
            runtime: {
                profileId: 'runtime-primary',
                groupId: 'codex-main',
                generation: 12,
                inProviderTurn: false,
                safeToProbe: true,
            },
        });
        fetchSessionByIdMock.mockResolvedValue({
            id: 'sess-runtime-reconnect',
            metadata: '{}',
            metadataVersion: 1,
            encryptionMode: 'plain',
        } as never);
        const quotaCoordinator = {
            recordRuntimeAccountIdentityFromSnapshot: vi.fn(),
            invalidateRuntimeAccountIdentityForSession: vi.fn(),
            flushInBandQuotaPersistence: vi.fn(async () => {}),
        };
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                9191,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-runtime-reconnect',
                    pid: 9191,
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
                                    profileId: 'fallback',
                                },
                            },
                        } satisfies ConnectedServiceBindingsV1,
                        environmentVariables: {
                            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
                                kind: 'group',
                                serviceId: 'openai-codex',
                                groupId: 'codex-main',
                                activeProfileId: 'stale-primary',
                                fallbackProfileId: 'fallback',
                                generation: 7,
                            }]),
                        },
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
            getConnectedServiceQuotasCoordinator: () => quotaCoordinator as never,
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
        controlServerInput?.onHappySessionWebhook('sess-runtime-reconnect', {
            path: '/tmp/project',
            host: 'host-1',
            homeDir: '/tmp/home',
            happyHomeDir: '/tmp/happier-test-home',
            happyLibDir: '/tmp/happier-lib',
            happyToolsDir: '/tmp/happier-tools',
            hostPid: 9191,
            startedBy: 'daemon',
        });

        await vi.waitFor(() => {
            expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
                sessionId: 'sess-runtime-reconnect',
                method: `${'sess-runtime-reconnect'}:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY}`,
                request: {
                    serviceId: 'openai-codex',
                    reason: 'diagnostic',
                    requireExactProof: true,
                    expected: {
                        groupId: 'codex-main',
                        profileId: 'stale-primary',
                        generation: 7,
                    },
                },
            }));
        });
        expect(quotaCoordinator.recordRuntimeAccountIdentityFromSnapshot).toHaveBeenCalledWith({
            sessionId: 'sess-runtime-reconnect',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            profileId: 'runtime-primary',
            providerAccountId: 'acct-live',
            accountLabel: 'live@example.com',
            observedAtMs: expect.any(Number),
            source: 'runtime_identity_probe',
            proofStrength: 'exact',
            groupGeneration: 12,
        });
        expect(quotaCoordinator.flushInBandQuotaPersistence).toHaveBeenCalledWith(0);
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
        await vi.waitFor(() => {
            expect(executeSpawnSessionRequest).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.objectContaining({
                    existingSessionId: 'sess-connected-service-runtime-refresh',
                    permissionMode: 'yolo',
                    permissionModeUpdatedAt: 500,
                    agentModeId: 'plan',
                    agentModeUpdatedAt: 501,
                    modelSelection: {
                        v: 1,
                        updatedAt: 502,
                        ref: {
                            agentTargetKey: 'backend:claude',
                            providerConnectionId: null,
                            modelId: 'claude-opus-4-7',
                        },
                    },
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
        });
        expect(vi.mocked(executeSpawnSessionRequest).mock.calls[0]?.[0].options).not.toHaveProperty('resume');

        vi.mocked(executeSpawnSessionRequest).mockClear();
        await runtime.stopControlServer();
    });

    it('discovers and publishes the fixed pending wake when an existing session is already active', async () => {
        vi.mocked(callSessionRpc)
            .mockResolvedValueOnce({ ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' })
            .mockResolvedValueOnce({ ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' })
            .mockResolvedValueOnce({ ok: true, result: 'wake_published' });
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

        expect(callSessionRpc).toHaveBeenNthCalledWith(1, {
            token: 'token-daemon',
            sessionId: 'sess-live',
            mode: 'plain',
            method: `sess-live:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1}`,
            request: {},
            ctx: {
                encryptionKey: new Uint8Array(32).fill(1),
                encryptionVariant: 'legacy',
            },
        });
        expect(callSessionRpc).toHaveBeenNthCalledWith(3, expect.objectContaining({
            method: `sess-live:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1}`,
            request: { protocolVersion: 1 },
        }));
        expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
        expect(executeSpawnSessionRequest).not.toHaveBeenCalled();

        await runtime.stopControlServer();
    });

    it('fences an active existing session when exact-session controls are unavailable', async () => {
        const runnerPid = 999_999_321;
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
            if (signal === 0) return true;
            return true;
        }) as typeof process.kill);
        const childKill = vi.fn(() => true);
        vi.mocked(callSessionRpc).mockRejectedValueOnce({
            rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
            message: 'RPC method not available: sess-live-adopt:session.pendingQueue.wake.capability.get.v1',
        });
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                runnerPid,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-live-adopt',
                    pid: runnerPid,
                    childProcess: {
                        pid: runnerPid,
                        exitCode: null,
                        signalCode: null,
                        kill: childKill,
                    } as never,
                    spawnOptions: {
                        directory: '/tmp/project',
                        existingSessionId: 'sess-live-adopt',
                    },
                },
            ],
        ]);

        try {
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

            await expect(runtime.spawnSession({
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                existingSessionId: 'sess-live-adopt',
            })).resolves.toMatchObject({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            });

            expect(executeSpawnSessionRequest).not.toHaveBeenCalled();
            expect(childKill).not.toHaveBeenCalled();
            expect(killSpy).not.toHaveBeenCalledWith(-runnerPid, 'SIGTERM');
            expect(killSpy).not.toHaveBeenCalledWith(runnerPid, 'SIGTERM');

            await runtime.stopControlServer();
        } finally {
            killSpy.mockRestore();
        }
    });

    it('applies persisted runtime state when an existing session is already active', async () => {
        vi.mocked(callSessionRpc).mockImplementation(async (raw) => {
            const method = raw.method;
            if (method.endsWith(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1)) {
                return { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' };
            }
            return { ok: true, result: 'provider_accepted', localId: 'local-exact' };
        });
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
            executionAuthorization: {
                provenance: 'user_request',
                requestId: 'local-exact',
            },
        })).resolves.toEqual({
            type: 'success',
            sessionId: 'sess-live-runtime',
        });

        expect(pidToTrackedSession.get(process.pid)?.vendorResumeId).toBe('codex-thread-fresh');
        expect(pidToTrackedSession.get(process.pid)?.spawnOptions).toEqual(expect.objectContaining({
            existingSessionId: 'sess-live-runtime',
            permissionMode: 'yolo',
            permissionModeUpdatedAt: 200,
            agentModeId: 'plan',
            agentModeUpdatedAt: 201,
            modelSelection: {
                v: 1,
                updatedAt: 202,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5.1',
                },
            },
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
        expect(pidToTrackedSession.get(process.pid)?.spawnOptions?.resume).toBeUndefined();
        expect(executeSpawnSessionRequest).not.toHaveBeenCalled();
        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: 'sess-live-runtime:session.pendingQueue.wake.v1',
        }));

        await runtime.stopControlServer();
    });

    it('wakes Pending after starting an inactive existing session', async () => {
        vi.mocked(executeSpawnSessionRequest).mockResolvedValueOnce({
            type: 'success',
            sessionId: 'sess-inactive-exact',
        });
        fetchSessionByIdCompatMock.mockResolvedValue({
            id: 'sess-inactive-exact',
            encryptionMode: 'plain',
            metadata: '{}',
            metadataVersion: 1,
        });
        vi.mocked(callSessionRpc).mockImplementation(async (raw) => {
            if (raw.method.endsWith(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1)) {
                return { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' };
            }
            return { ok: true, result: 'wake_published' };
        });
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

        await expect(runtime.spawnSession({
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            existingSessionId: 'sess-inactive-exact',
            executionAuthorization: {
                provenance: 'user_request',
                requestId: 'local-inactive-exact',
            },
        })).resolves.toEqual({ type: 'success', sessionId: 'sess-inactive-exact' });
        expect(executeSpawnSessionRequest).toHaveBeenCalledTimes(1);
        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: 'sess-inactive-exact:session.pendingQueue.wake.v1',
        }));

        await runtime.stopControlServer();
    });

    it('refreshes persisted runtime state after a session metadata webhook', async () => {
        vi.mocked(callSessionRpc).mockImplementation(async (raw) => {
            if (raw.method.endsWith(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1)) {
                return { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' };
            }
            return { ok: true, result: 'provider_accepted', localId: 'local-exact' };
        });
        let rawSession = {
            id: 'sess-live-runtime-webhook',
            encryptionMode: 'plain',
            metadata: JSON.stringify({
                flavor: 'codex',
                codexSessionId: 'codex-thread-before-webhook',
                path: '/tmp/project',
                permissionMode: 'default',
                permissionModeUpdatedAt: 100,
            }),
            metadataVersion: 1,
        };
        fetchSessionByIdCompatMock.mockImplementation(async () => rawSession);
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                process.pid,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-live-runtime-webhook',
                    pid: process.pid,
                    vendorResumeId: 'codex-thread-stale',
                    spawnOptions: {
                        directory: '/tmp/project',
                        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                        existingSessionId: 'sess-live-runtime-webhook',
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
            processEnv: {
                HAPPIER_DAEMON_SPAWN_RECENT_SUCCESS_TTL_MS: '0',
            },
        });

        await expect(runtime.spawnSession({
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            existingSessionId: 'sess-live-runtime-webhook',
        })).resolves.toEqual({
            type: 'success',
            sessionId: 'sess-live-runtime-webhook',
        });
        expect(pidToTrackedSession.get(process.pid)?.vendorResumeId).toBe('codex-thread-before-webhook');

        rawSession = {
            ...rawSession,
            metadata: JSON.stringify({
                flavor: 'codex',
                codexSessionId: 'codex-thread-after-webhook',
                path: '/tmp/project',
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 300,
            }),
            metadataVersion: 2,
        };
        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        controlServerInput?.onHappySessionWebhook('sess-live-runtime-webhook', JSON.parse(rawSession.metadata));

        await expect(runtime.spawnSession({
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            existingSessionId: 'sess-live-runtime-webhook',
            modelSelection: {
                v: 1,
                updatedAt: 101,
                ref: {
                    agentTargetKey: buildBackendTargetKeyV2({
                        kind: 'backend',
                        backendId: 'codex',
                        sourceKind: 'built_in',
                    }),
                    providerConnectionId: null,
                    modelId: 'incoming-model',
                },
            },
        })).resolves.toEqual({
            type: 'success',
            sessionId: 'sess-live-runtime-webhook',
        });

        expect(pidToTrackedSession.get(process.pid)?.vendorResumeId).toBe('codex-thread-after-webhook');
        expect(pidToTrackedSession.get(process.pid)?.spawnOptions).toEqual(expect.objectContaining({
            permissionMode: 'yolo',
            permissionModeUpdatedAt: 300,
        }));
        expect(pidToTrackedSession.get(process.pid)?.spawnOptions?.resume).toBeUndefined();

        await runtime.stopControlServer();
    });

    it('wires connected-service runtime-auth and quota handlers into the control server', async () => {
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        commitRuntimeAuthRecoveryVisibleEventDeliveryMock.mockClear();
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockResolvedValue({
            status: 'switch_attempted',
            result: {
                status: 'superseded_after_apply',
                activeProfileId: 'authoritative-profile',
                generation: 43,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
        });
        fetchSessionByIdCompatMock.mockClear();
        const quotaCoordinator = {
            recordRuntimeUsageLimitExhaustionAndFanout: vi.fn(async () => ({
                status: 'recorded' as const,
                fanoutCandidates: 0,
                fanoutRequests: 0,
            })),
        };
        fetchSessionByIdCompatMock.mockResolvedValue({
            id: 'sess-runtime-inactive',
            encryptionMode: 'plain',
            metadata: JSON.stringify({
                flavor: 'codex',
                path: '/tmp/runtime-inactive-project',
                codexSessionId: 'codex-thread-runtime-inactive',
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
        // Exact V2/four-part-key persistence vector produced by remote-dev at
        // 6e6ecb42e7f9ab8607b5710547563bbc9c232728. Startup may redeliver its
        // pending presentation custody, but must not run provider recovery.
        recoveryIntentFileStoresMock.storesByPath.set(
            '/tmp/happier-test-home/servers/default/connected-services/runtime-auth-recovery.json',
            new Map([
                [
                    'runtime-auth:v1:WyJzZXNzLXJ1bnRpbWUtcHJlZGVjZXNzb3IiLCJvcGVuYWktY29kZXgiLG51bGwsImNvZGV4LW1haW4iXQ',
                    {
                        v: 2,
                        attemptId: 'runtime-auth-attempt:predecessor-startup',
                        lastSettledTransition: 'scheduled',
                        pendingVisibleEvents: [{
                            attemptId: 'runtime-auth-attempt:predecessor-startup',
                            transition: 'scheduled',
                            transcriptEvent: {
                                type: 'connected-service-runtime-auth-recovery',
                                status: 'retry_scheduled',
                                serviceId: 'openai-codex',
                                profileId: 'primary',
                                groupId: 'codex-main',
                                nextRetryAtMs: 2_000,
                                terminal: false,
                                diagnostic: {
                                    code: 'recovery_retry_scheduled',
                                    failurePhase: 'runtime_auth_recovery',
                                    source: 'runtime_auth_recovery',
                                    serviceId: 'openai-codex',
                                    profileId: 'primary',
                                    groupId: 'codex-main',
                                    retryable: true,
                                    suggestedActions: ['retry', 'open_connected_accounts'],
                                },
                            },
                        }],
                        sessionId: 'sess-runtime-predecessor',
                        serviceId: 'openai-codex',
                        profileId: 'primary',
                        groupId: 'codex-main',
                        resumePromptMode: 'standard',
                        status: 'waiting',
                        armedAtMs: 1_000,
                        nextRetryAtMs: 2_000,
                        attemptCount: 0,
                        maxAttempts: 5,
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
                            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                        },
                        failurePhase: 'handler',
                        failureReason: 'handler_transient_failure',
                        lastError: 'network',
                        lastErrorClassification: { kind: 'network', retryable: true },
                        pendingTargetProfileId: null,
                        pendingTargetGeneration: null,
                        terminalAtMs: null,
                        terminalReason: null,
                    },
                ],
            ]),
        );
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
            getConnectedServiceQuotasCoordinator: () => quotaCoordinator as never,
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
            handleConnectedServiceUsageLimitWaitResumeCancel: expect.any(Function),
            runtimeAuthRecoveryScheduler: expect.objectContaining({
                enqueueHandlerFailure: expect.any(Function),
                enqueueApplyFailure: expect.any(Function),
                wake: expect.any(Function),
                cancel: expect.any(Function),
            }),
        }));
        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        const runtimeAuthRecoveryScheduler = controlServerInput?.runtimeAuthRecoveryScheduler as
            | {
                enqueueHandlerFailure: (input: {
                    reportId?: string;
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
            reportId: 'runtime-auth-report:control-runtime-visible-delivery',
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
        // The production delivery drain is deliberately unref'ed and batches for 2s.
        // Keep this test alive through that real scheduling boundary before observing it.
        await new Promise<void>((resolve) => setTimeout(resolve, 2_100));
        await vi.waitFor(() => {
            expect(commitRuntimeAuthRecoveryVisibleEventDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
                credentials: expect.objectContaining({ token: 'token-daemon' }),
                delivery: expect.objectContaining({
                    sessionId: 'sess-runtime-inactive',
                    attemptId: 'runtime-auth-attempt:control-runtime-visible-delivery',
                    transition: 'scheduled',
                    transcriptEvent: expect.objectContaining({
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
                }),
            }));
            expect(commitRuntimeAuthRecoveryVisibleEventDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
                delivery: expect.objectContaining({
                    sessionId: 'sess-runtime-predecessor',
                    attemptId: 'runtime-auth-attempt:predecessor-startup',
                    transition: 'scheduled',
                }),
            }));
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        expect(handleConnectedServiceRuntimeAuthFailureForSessionMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: 'sess-runtime-predecessor' }),
        );
        await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-runtime-inactive',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                resetsAtMs: null,
                sourceProviderAccountId: 'acct-source',
                sourceAccountLabel: 'source@example.test',
                groupGeneration: 42,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });
        expect(quotaCoordinator.recordRuntimeUsageLimitExhaustionAndFanout).toHaveBeenCalledWith(expect.objectContaining({
            sourceSessionId: 'sess-runtime-inactive',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            exhaustedProfileId: 'primary',
            sourceProviderAccountId: 'acct-source',
            sourceAccountLabel: 'source@example.test',
            sourceGroupGeneration: 42,
            resetAtMs: null,
            sourceRequiresConvergence: true,
            committedGeneration: expect.objectContaining({
                provenance: 'hard_limit',
                decisionCommittedTarget: {
                    serviceId: 'openai-codex',
                    groupId: 'codex-main',
                    profileId: 'authoritative-profile',
                    generation: 43,
                    credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                },
            }),
        }));
        quotaCoordinator.recordRuntimeUsageLimitExhaustionAndFanout.mockRejectedValueOnce(new Error('fanout unavailable'));
        await expect(controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-runtime-inactive',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                resetsAtMs: null,
                sourceProviderAccountId: 'acct-source',
                sourceAccountLabel: 'source@example.test',
                groupGeneration: 42,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'superseded_after_apply',
                activeProfileId: 'authoritative-profile',
                generation: 43,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
        });
        const runtimeHandlerCall = handleConnectedServiceRuntimeAuthFailureForSessionMock.mock.calls.at(-1) as [unknown] | undefined;
        const runtimeHandlerInput = runtimeHandlerCall?.[0] as {
            resolveInactiveSession?: (input: { sessionId: string }) => Promise<unknown>;
            sourceAuthorization?: unknown;
            runtimeAuthApplyCapability?: {
                directLiveHotAuth?: {
                    requiresExactRuntimeIdentity?: boolean;
                } | 'unsupported';
            };
        } | undefined;
        expect(runtimeHandlerInput?.sourceAuthorization).toBeUndefined();
        expect(runtimeHandlerInput?.resolveInactiveSession).toEqual(expect.any(Function));
        await expect(runtimeHandlerInput!.resolveInactiveSession!({
            sessionId: 'sess-runtime-inactive',
        })).resolves.toEqual({
            agentId: 'codex',
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
            vendorResumeId: 'codex-thread-runtime-inactive',
            cwd: '/tmp/runtime-inactive-project',
        });

        const sourceAuthorization = {
            status: 'authorized' as const,
            tracked: null,
            inactive: {
                agentId: 'codex',
                connectedServices: {
                    v: 1 as const,
                    bindingsByServiceId: {},
                },
            },
        };
        await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
            sessionId: 'sess-runtime-inactive',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                resetsAtMs: null,
                groupGeneration: 42,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            sourceAuthorization,
        });
        expect(handleConnectedServiceRuntimeAuthFailureForSessionMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sourceAuthorization,
                runtimeAuthApplyCapability: expect.objectContaining({
                    directLiveHotAuth: expect.objectContaining({
                        requiresExactRuntimeIdentity: true,
                    }),
                }),
            }),
        );
        expect(
            (handleConnectedServiceRuntimeAuthFailureForSessionMock.mock.calls.at(-1)?.[0] as {
                sourceAuthorization?: unknown;
            } | undefined)?.sourceAuthorization,
        ).toBe(sourceAuthorization);
    });

    it('keeps provider limit recovery work out of the local server storm gate', async () => {
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockImplementation(async () => ({
            handled: false,
            reason: 'unhandled',
        }));
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
            processEnv: {
                HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_THRESHOLD: '2',
                HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_DELAY_MS: '1000',
                HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_JITTER_MS: '1',
            },
        });

        const controlServerInput = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        const runtimeAuthRecoveryScheduler = controlServerInput?.runtimeAuthRecoveryScheduler as
            | {
                beginClassifiedFailure: (input: {
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
                        planType: null;
                        rateLimits: null;
                        source: 'structured_provider_error';
                    };
                }) => Promise<unknown>;
                wake: (input: { sessionId: string; reason: 'manual' }) => Promise<Readonly<{ status: string }>>;
            }
            | undefined;
        expect(runtimeAuthRecoveryScheduler).toBeDefined();

        const providerLimitClassification = {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'codex-main',
            resetsAtMs: null,
            retryAfterMs: null,
            limitCategory: 'usage_limit',
            quotaScope: 'account',
            providerLimitId: 'weekly',
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
        } as const;

        await runtimeAuthRecoveryScheduler!.beginClassifiedFailure({
            sessionId: 'sess-provider-limit-a',
            switchesThisTurn: 0,
            classification: providerLimitClassification,
        });
        await runtimeAuthRecoveryScheduler!.beginClassifiedFailure({
            sessionId: 'sess-provider-limit-b',
            switchesThisTurn: 0,
            classification: providerLimitClassification,
        });
        await runtimeAuthRecoveryScheduler!.beginClassifiedFailure({
            sessionId: 'sess-provider-limit-target',
            switchesThisTurn: 0,
            classification: providerLimitClassification,
        });

        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        const wakeResult = await runtimeAuthRecoveryScheduler!.wake({
            sessionId: 'sess-provider-limit-target',
            reason: 'manual',
        });

        expect(wakeResult.status).not.toBe('waiting');
        expect(handleConnectedServiceRuntimeAuthFailureForSessionMock).toHaveBeenCalledTimes(1);
        expect(commitRuntimeAuthRecoveryVisibleEventDeliveryMock).not.toHaveBeenCalledWith(expect.objectContaining({
            delivery: expect.objectContaining({
                sessionId: 'sess-provider-limit-target',
                transcriptEvent: expect.objectContaining({
                    status: 'retry_scheduled',
                    diagnostic: expect.objectContaining({
                        reason: 'local_server_storm',
                    }),
                }),
            }),
        }));
    });

    it('keeps exact provider-outcome proof waits pending when tracked activity cannot be provider-verified', async () => {
        const sourceRevision = 'csr_abcdefghijklmnopqrstuv';
        const targetRevision = 'csr_bcdefghijklmnopqrstuvw';
        const runtimeSelectionRaw = JSON.stringify([{
            kind: 'group',
            serviceId: 'gemini',
            groupId: 'gemini-pool',
            activeProfileId: 'backup',
            generation: 2,
            credentialRevision: targetRevision,
        }]);
        fetchSessionByIdCompatMock.mockImplementation(async () => ({
            id: 'sess-activity-proof-only',
            encryptionMode: 'plain',
            metadata: '{}',
            metadataVersion: 1,
        }));
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-activity-proof-only',
            pid: 616_161,
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'gemini', sourceKind: 'built_in' },
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: runtimeSelectionRaw,
                },
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        gemini: {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'gemini-pool',
                            profileId: 'backup',
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
                        groupGeneration?: number;
                        expectedCredentialRevision?: string;
                    };
                    error: unknown;
                }) => Promise<unknown>;
                markAwaitingProviderOutcomeProofByKey: (input: {
                    sessionId: string;
                    serviceId: string;
                    profileId: string | null;
                    groupId: string | null;
                    result?: unknown;
                }) => Promise<unknown>;
                readForSession: (sessionId: string) => ReadonlyArray<{
                    status: string;
                    serviceId: string;
                    groupId: string | null;
                }>;
            }
            | undefined;
        await runtimeAuthRecoveryScheduler?.enqueueHandlerFailure({
            sessionId: 'sess-activity-proof-only',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'gemini',
                profileId: 'primary',
                groupId: 'gemini-pool',
                resetsAtMs: null,
                retryAfterMs: null,
                limitCategory: 'usage_limit',
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                groupGeneration: 1,
                expectedCredentialRevision: sourceRevision,
            },
            error: new Error('timeout of 5000ms exceeded'),
        });
        await runtimeAuthRecoveryScheduler?.markAwaitingProviderOutcomeProofByKey({
            sessionId: 'sess-activity-proof-only',
            serviceId: 'gemini',
            profileId: 'backup',
            groupId: 'gemini-pool',
            result: {
                status: 'switch_attempted',
                result: {
                    status: 'observed_generation',
                    activeProfileId: 'backup',
                    generation: 2,
                    credentialRevision: targetRevision,
                },
            },
        });
        expect(runtimeAuthRecoveryScheduler?.readForSession('sess-activity-proof-only')).toEqual([
            expect.objectContaining({
                status: 'resumed_awaiting_proof',
                serviceId: 'gemini',
                groupId: 'gemini-pool',
            }),
        ]);

        await controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-activity-proof-only',
            event: 'assistant_message_end',
            connectedServiceSelectionsEnvRaw: runtimeSelectionRaw,
        });

        expect(runtimeAuthRecoveryScheduler?.readForSession('sess-activity-proof-only')).toEqual([
            expect.objectContaining({
                status: 'resumed_awaiting_proof',
                serviceId: 'gemini',
                groupId: 'gemini-pool',
                pendingTargetProfileId: 'backup',
                pendingTargetGeneration: 2,
                pendingTargetCredentialRevision: targetRevision,
            }),
        ]);
    });

    it('keeps a revision-less durable runtime-auth proof wait pending when tracked bindings are unavailable', async () => {
        fetchSessionByIdCompatMock.mockImplementation(async () => ({
            id: 'sess-claude-durable-proof-only',
            encryptionMode: 'plain',
            metadata: '{}',
            metadataVersion: 1,
        }));
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: 'sess-claude-durable-proof-only',
            pid: 717_171,
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
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
                beginClassifiedFailure: (input: {
                    sessionId: string;
                    switchesThisTurn: number;
                    classification: {
                        kind: 'auth_expired';
                        serviceId: string;
                        profileId: string | null;
                        groupId: string | null;
                        resetsAtMs: null;
                        retryAfterMs: null;
                        limitCategory: 'auth_invalid';
                        quotaScope: 'account';
                        providerLimitId: null;
                        action: null;
                        planType: null;
                        rateLimits: null;
                        source: 'stable_provider_message';
                    };
                }) => Promise<unknown>;
                markAwaitingProviderOutcomeProofByKey: (input: {
                    sessionId: string;
                    serviceId: string;
                    profileId: string | null;
                    groupId: string | null;
                }) => Promise<unknown>;
                readForSession: (sessionId: string) => ReadonlyArray<{
                    status: string;
                    serviceId: string;
                    profileId: string | null;
                    groupId: string | null;
                }>;
            }
            | undefined;
        await runtimeAuthRecoveryScheduler?.beginClassifiedFailure({
            sessionId: 'sess-claude-durable-proof-only',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired',
                serviceId: 'claude-subscription',
                profileId: 'leeroy_bat',
                groupId: 'claude',
                resetsAtMs: null,
                retryAfterMs: null,
                limitCategory: 'auth_invalid',
                quotaScope: 'account',
                providerLimitId: null,
                action: null,
                planType: null,
                rateLimits: null,
                source: 'stable_provider_message',
            },
        });
        await runtimeAuthRecoveryScheduler?.markAwaitingProviderOutcomeProofByKey({
            sessionId: 'sess-claude-durable-proof-only',
            serviceId: 'claude-subscription',
            profileId: 'leeroy_bat',
            groupId: 'claude',
        });
        expect(runtimeAuthRecoveryScheduler?.readForSession('sess-claude-durable-proof-only')).toEqual([
            expect.objectContaining({
                status: 'resumed_awaiting_proof',
                serviceId: 'claude-subscription',
                profileId: 'leeroy_bat',
                groupId: 'claude',
            }),
        ]);

        await controlServerInput?.handleConnectedServiceTurnLifecycle?.({
            sessionId: 'sess-claude-durable-proof-only',
            event: 'task_started',
        });

        expect(runtimeAuthRecoveryScheduler?.readForSession('sess-claude-durable-proof-only')).toEqual([
            expect.objectContaining({
                status: 'resumed_awaiting_proof',
                serviceId: 'claude-subscription',
                profileId: 'leeroy_bat',
                groupId: 'claude',
                pendingTargetCredentialRevision: null,
            }),
        ]);
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
                push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
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

        const applyInput = applyConnectedServiceAuthGenerationToTrackedSessionMock.mock.calls.at(-1)?.[0] as {
            emitSessionEvent?: (sessionId: string, event: unknown) => void;
            continueAfterRuntimeAuthSwitch?: (input: {
                sessionId: string;
                attemptId: string;
                normalizedBindings: {
                    v: 1;
                    bindingsByServiceId: Record<string, unknown>;
                };
                serviceIds: ReadonlySet<'openai-codex'>;
                action: 'hot_applied' | 'restart_requested';
                switchReason?: 'automatic_runtime_failure';
            }) => Promise<void>;
        } | undefined;
        const continuationInput = {
            sessionId: 'sess-runtime',
            normalizedBindings: {
                v: 1 as const,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'codex-main',
                        profileId: 'backup',
                    },
                },
            },
            serviceIds: new Set(['openai-codex' as const]),
            switchReason: 'automatic_runtime_failure' as const,
        };
        updateSessionMetadataWithRetryMock.mockClear();
        await applyInput?.continueAfterRuntimeAuthSwitch?.({
            ...continuationInput,
            attemptId: 'automatic-hot-apply',
            action: 'hot_applied',
        });
        expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();

        await applyInput?.continueAfterRuntimeAuthSwitch?.({
            ...continuationInput,
            attemptId: 'automatic-provider-failed-restart',
            action: 'restart_requested',
        });
        // This fixture has no exact interrupted activeTurnId. Transcript silence is
        // not proof that the provider had no effect and must not manufacture a
        // continuation/replay authority.
        expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
        commitSessionStoredMessageMock.mockClear();
        dispatchActivityNotificationAsyncMock.mockClear();
        applyInput?.emitSessionEvent?.('sess-runtime', {
            type: 'connected_service_account_switch',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            fromProfileId: 'primary',
            toProfileId: 'backup',
            reason: 'usage_limit',
            mode: 'hot_apply',
            generation: 4,
        });
        applyInput?.emitSessionEvent?.('sess-runtime', {
            type: 'connected_service_account_switch_attempt',
            ok: true,
            action: 'hot_applied',
            outcome: 'succeeded',
            outcomeAction: 'hot_applied',
            errorCode: null,
            groupGeneration: 4,
            sessionAdoption: 'applied',
            sessionAdoptedGeneration: 4,
            partialState: 'runtime_auth_applied',
        });

        await vi.waitFor(() => {
            expect(commitSessionStoredMessageMock).toHaveBeenCalledTimes(2);
        });
        expect(commitSessionStoredMessageMock.mock.calls.map((call) => call[0]?.localId)).toEqual(expect.arrayContaining([
            'connected-service-account-switch:openai-codex:codex-main:4',
            expect.stringMatching(/^connected-service-account-switch-attempt:ok:/),
        ]));
        expect(dispatchActivityNotificationAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
            event: expect.objectContaining({
                topic: 'connected_service_account_switch',
                sessionId: 'sess-runtime',
                serviceId: 'openai-codex',
                groupId: 'codex-main',
            }),
        }));
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
                    resume: 'codex-thread-stale',
                }),
            }));
            expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

            await runtime.stopControlServer();
        } finally {
            vi.useRealTimers();
            resetFetchSessionByIdCompatMock();
        }
    });

    it('hydrates tracked temporary-throttle retries passively until a fresh manual action', async () => {
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

            await vi.advanceTimersByTimeAsync(5_000);
            expect(executeSpawnSessionRequest).not.toHaveBeenCalled();
            await expect(runtime.retryTemporaryThrottleNow({
                sessionId: 'sess-temporary-throttle-hydrated',
            })).resolves.toEqual({ status: 'resumed' });
            expect(executeSpawnSessionRequest).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.objectContaining({
                    existingSessionId: 'sess-temporary-throttle-hydrated',
                    resume: 'codex-thread-hydrated-stale',
                }),
            }));
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

    it('hydrates inactive temporary-throttle retries passively and resumes only after a fresh manual action', async () => {
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

            await vi.advanceTimersByTimeAsync(5_000);
            expect(executeSpawnSessionRequest).not.toHaveBeenCalled();
            await expect(runtime.retryTemporaryThrottleNow({
                sessionId: 'sess-temporary-throttle-inactive',
            })).resolves.toEqual({ status: 'resumed' });
            expect(executeSpawnSessionRequest).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.objectContaining({
                    existingSessionId: 'sess-temporary-throttle-inactive',
                    directory: '/tmp/project',
                }),
            }));
            expect(vi.mocked(executeSpawnSessionRequest).mock.calls.at(-1)?.[0].options.resume).toBeUndefined();
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
            agentId: 'gemini',
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

    it('emits account-switch notifications and transcript events from the canonical runtime-auth session switch event', async () => {
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
        const runtimeHandlerInput = handleConnectedServiceRuntimeAuthFailureForSessionMock.mock.calls.at(-1)?.[0] as {
            emitSessionEvent?: (sessionId: string, event: unknown) => void;
        } | undefined;
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

        await Promise.resolve();
        expect(commitSessionStoredMessageMock).not.toHaveBeenCalled();
        expect(dispatchActivityNotificationAsyncMock).not.toHaveBeenCalled();

        runtimeHandlerInput?.emitSessionEvent?.('sess-runtime', {
            type: 'connected_service_account_switch',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            fromProfileId: 'primary',
            toProfileId: 'backup',
            reason: 'usage_limit',
            mode: 'hot_apply',
            generation: 7,
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
        expect(commitSessionStoredMessageMock).toHaveBeenCalledTimes(1);
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

        await runtime.onChildExited(12345, { reason: 'process-exited', code: 0, signal: null });

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
            return { status: 'requested' as const };
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

    it('uses layout-v1 owner metadata for inactive connected-service auth switches', async () => {
        requestConnectedServiceSessionRestartSignalMock.mockClear();
        fetchSessionByIdCompatMock.mockClear();
        updateSessionMetadataWithRetryMock.mockClear();
        refreshAccountSettingsForMinimumVersionMock.mockClear();
        const secret = new Uint8Array(32).fill(1);
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: {
                flavor: 'gemini',
            },
            nativeSession: {
                geminiSessionId: 'gemini-inactive-thread-1',
            },
            connectedServices: {
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
            },
        });
        const rawSession = {
            id: 'sess-gemini-inactive',
            encryptionMode: 'plain' as const,
            metadataLayoutVersion: 1,
            metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: sealSessionOwnerMetadataV1({
                material: { type: 'legacy', secret },
                ownerMetadata,
                randomBytes: (length) => new Uint8Array(length).fill(7),
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
                encryption: { type: 'legacy', secret },
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
