import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import type { AgentSessionRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    ManagedDependenciesService,
    ManagedServiceSpec,
    ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';
import { PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST } from '@happier-dev/plugins-opencode/manifest';
import {
    CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
    resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/agents/request-auth';

import { encodeBase64, encrypt } from '@/api/encryption';
import { materializeNextPendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import {
    RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD,
    RunnerManagedServicesCustodyRequestV1Schema,
} from '@/agent/runtime/session/process/runnerManagedServicesCustody';
import type {
    ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createTargetComposerAttachmentRegistry } from '@/plugins/runtime/lifecycle/contributions/targetComposerAttachments';
import type { ResolvedPluginHookHandler } from '@/plugins/runtime/types';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import {
    buildBackendTargetKeyV2,
    buildConnectedServiceCredentialRecord,
    buildProviderAccountUsageRecordId,
    ConnectedServiceBindingsV1Schema,
    createProviderBindingSecurityFingerprintV1,
    createProviderMachineGrantFingerprintV1,
    AccountSettingsSchema,
    DEFAULT_PROVIDER_SETTINGS_V1,
    FeaturesResponseSchema,
    createPlainSessionOwnerMetadataEnvelopeV1,
    ProviderConnectionIdSchema,
    ProviderRuntimeBindingBasisV1Schema,
    ProviderSettingsV1Schema,
    SessionProviderBindingMetadataV1Schema,
    SessionOwnerMetadataV1Schema,
    type SessionOwnerMetadataEnvelopeV1,
    type BrowserCommandV1,
    type BrowserRecordingCapabilities,
    DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    type SimulatorDeviceResourceV1,
    type ConnectedServiceBindingsV1,
    type ProviderAccountUsageSnapshotV1,
    type AccountSettings,
    type SessionPendingEnqueueByMachineRequestV1,
    type HookEventEnvelopeV1,
} from '@happier-dev/protocol';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { ProviderAccountUsageAdoptionV1 } from '../connectedServices/accountUsage/adoption';
import type {
    ConnectedAccountRequestAuthServiceDependencies,
    ConnectedAccountRequestAuthSubject,
} from '../connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import type { ConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    createResolvedContributionRegistry,
    getResolvedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
    ResolvedComposerAttachmentContribution,
    ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import {
    readTerminalHostAttachmentInfo,
    removeTerminalHostAttachmentInfo,
    writeTerminalHostAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import type { TrackedSession } from '../types';
import type { StopSessionOptions } from '../sessions/stopSession';
import type {
    ApplyConnectedServiceAuthGenerationToTrackedSessionInput,
    SessionConnectedServiceAuthSwitchResult,
} from '../connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServices/connectedServiceChildEnvironment';
import {
    commitConnectedServiceHotApplyRuntimeTarget,
    resolveConnectedServiceContinuationInterruptionForSwitch,
    resolveConnectedServiceContinuationOriginId,
    resolveContinuationResumePromptMode,
    isManagedProviderSessionInvocationCurrent,
    isRetainedManagedProviderInvocationCurrent,
    startDaemonSessionControlRuntime as startDaemonSessionControlRuntimeRaw,
} from './startDaemonSessionControlRuntime';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';
import { startDaemonControlServer } from '../controlServer';
import type { ExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import * as sessionRunnerRespawnModule from '../processSupervision/sessionRunnerRespawn';
import { resolveSessionRunnerRestartEligibility } from '../sessionRunnerRuntime/resolveRestartEligibility';
import { resolveConnectedServiceMaterializedRootDir } from '../connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { materializeConnectedServicesForSpawn } from '../connectedServices/materialize/materializeConnectedServicesForSpawn';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { authorizeConnectedServiceRuntimeAuthFailureSource } from '../connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { RuntimeAuthRecoveryScheduler } from '../connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { ConnectedServiceTemporaryThrottleRetryScheduler } from '../connectedServices/runtimeAuth/temporaryThrottleRetryScheduler';
import { computeConnectedServiceAccessTokenFingerprint } from '../connectedServices/refresh/credentialFreshness/tokenFingerprint';
import { resolveQuotaProbeFreshProof } from '../connectedServices/quotas/proof/quotaProbeFreshProof';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../connectedServices/sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import {
    createConnectedAccountRequestAuthSubjectRegistry,
} from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import {
    readConnectedAccountRequestAuthCapabilityFile,
} from '../connectedServices/requestAuth/capabilityFile';
import {
    createAgentRuntimeDaemonServiceAuthorityPath,
    publishAgentRuntimeDaemonServiceAuthority,
} from '../agentRuntime/sessionBridgeAuthorization';
import {
    resolveQualifiedPurposeBindingSnapshotForAgentSpawn,
} from '../connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
    AgentRuntimeDaemonServiceRequestV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import {
    createUnavailablePluginServices,
} from '@/plugins/runtime/invocation/services/unavailable';
import {
    createPluginInvocationActionsService,
} from '@/plugins/runtime/invocation/services/actions';
import {
    createPluginActionCallerMaterializationFixture,
} from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    createImmutablePluginGenerationRecordFromSource,
    persistValidatedAgentSessionRunnerFactories,
    persistInstallationStateRevision,
    prepareImmutablePluginGeneration,
    readCurrentPluginImmutableGenerationIntegrityCurrentness,
    readInstallationStateRevision,
} from '@/plugins/store/registry/generationStore';
import {
    isRetainedManagedProviderSettingsGrantCurrent,
} from '@/providers/sessions/retainedManagedProviderPolicy';
import {
    readPluginRegistryCommitRecord,
    replacePluginRegistryCommitRecord,
} from '@/plugins/store/registry/commitRecord';

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
const createCliActionExecutorFromCredentialsMock = vi.hoisted(() => vi.fn());
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
const getActiveAccountSettingsSnapshotMock = vi.hoisted(() => vi.fn<
    () => Readonly<{
        settings: AccountSettings | null;
        settingsSecretsReadKeys: readonly Uint8Array[];
    }>
>(() => ({
    settings: null,
    settingsSecretsReadKeys: [],
})));
type FetchSessionByIdCompatMockResult = {
    id: string;
    metadata: string;
    metadataVersion: number;
    encryptionMode: string;
    metadataLayoutVersion?: number;
    ownerMetadata?: SessionOwnerMetadataEnvelopeV1;
    dataEncryptionKey?: string;
} | null;
const fetchSessionByIdMock = vi.hoisted(() => vi.fn(async () => ({
    id: 'sess-runtime',
    encryptionMode: 'plain',
})));
const fetchAccountEncryptionCurrentnessMock = vi.hoisted(() => vi.fn(
    async () => ({
        mode: 'plain' as const,
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: 1,
    }),
));
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
const commitSessionStoredMessageMock = vi.hoisted(() => vi.fn<(input: {
    token?: string;
    sessionId?: string;
    localId?: string;
}) => Promise<{
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
type StartDaemonSessionControlRuntimeTestParams = Omit<
    Parameters<typeof startDaemonSessionControlRuntimeRaw>[0],
    'daemonSessionMutationCustody' | 'cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop'
> & Readonly<{
    daemonSessionMutationCustody?: Pick<Parameters<
        typeof startDaemonSessionControlRuntimeRaw
    >[0]['daemonSessionMutationCustody'], 'stageTranscriptEvent'> & Partial<Pick<Parameters<
        typeof startDaemonSessionControlRuntimeRaw
    >[0]['daemonSessionMutationCustody'], 'stage'>>;
    cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop?: Parameters<
        typeof startDaemonSessionControlRuntimeRaw
    >[0]['cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop'];
}>;
const startDaemonSessionControlRuntime = async (
    params: StartDaemonSessionControlRuntimeTestParams,
): ReturnType<typeof startDaemonSessionControlRuntimeRaw> => (
    await startDaemonSessionControlRuntimeRaw({
        ...params,
        cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop:
            params.cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop ?? (async () => null),
        daemonSessionMutationCustody: {
            async stage() {},
            ...params.daemonSessionMutationCustody,
            async stageTranscriptEvent(input) {
                if (params.daemonSessionMutationCustody) {
                    return await params.daemonSessionMutationCustody.stageTranscriptEvent(input);
                }
                await commitSessionStoredMessageMock({
                    token: params.credentials.token,
                    sessionId: input.sessionId,
                    localId: input.eventId,
                });
                return { persisted: true, delivered: true };
            },
        },
    })
);
type RequestConnectedServiceSessionRestartSignal =
    typeof import('../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal')['requestConnectedServiceSessionRestartSignal'];
const requestConnectedServiceSessionRestartSignalMock = vi.hoisted(() => vi.fn<RequestConnectedServiceSessionRestartSignal>(async () => ({ status: 'requested' })));
const markSessionMarkerConnectedServiceRestartIntentMock = vi.hoisted(() => vi.fn(async () => true));
const clearSessionMarkerConnectedServiceRestartIntentMock = vi.hoisted(() => vi.fn(async () => {}));
const removeSessionMarkerMock = vi.hoisted(() => vi.fn(async () => {}));
const removeSessionMarkerIfOwnedMock = vi.hoisted(() => (
    vi.fn<(input: { pid: number }) => Promise<boolean>>(async () => true)
));
type ReadSessionMarkerForPid =
    typeof import('../sessionRegistry')['readSessionMarkerForPid'];
const readSessionMarkerForPidMock = vi.hoisted(() => (
    vi.fn<ReadSessionMarkerForPid>(async () => null)
));
const updateSessionMarkerActiveTurnMock = vi.hoisted(() => vi.fn(async () => true));
const updateSessionMarkerAgentSessionStartupInstructionsMarkerMock = vi.hoisted(
    () => vi.fn(async () => true),
);
const updateSessionMarkerAgentRuntimeSessionOpenAttestationMock = vi.hoisted(
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
const authorizeSessionModelTransitionProviderTargetWithLeaseMock =
    vi.hoisted(() => vi.fn());
const listExecutionRunMarkersForRehydrationMock = vi.hoisted(
    () => vi.fn(async () => []),
);
const isRuntimeRegistryCurrentMock = vi.hoisted(
    () => vi.fn(() => true),
);
const pluginReloadListenersMock = vi.hoisted(
    () => new Set<(result: unknown) => void>(),
);
const pluginRunningSessionDispositionListenersMock = vi.hoisted(
    () => new Set<(result: unknown) => void>(),
);
const pluginReloadStateMock = vi.hoisted(() => ({
    activeRegistry: null as null | Readonly<{
        agentRuntimesByAgentId: ReadonlyMap<string, unknown>;
    }>,
}));
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
        apiServerUrl: 'http://127.0.0.1:41001',
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

vi.mock(
    '@/session/actions/createCliActionExecutorFromCredentials',
    async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('@/session/actions/createCliActionExecutorFromCredentials')
        >();
        createCliActionExecutorFromCredentialsMock.mockImplementation(
            actual.createCliActionExecutorFromCredentials,
        );
        return {
            ...actual,
            createCliActionExecutorFromCredentials:
                createCliActionExecutorFromCredentialsMock,
        };
    },
);

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
        readSessionMarkerForPid: readSessionMarkerForPidMock,
        markSessionMarkerConnectedServiceRestartIntent: markSessionMarkerConnectedServiceRestartIntentMock,
        clearSessionMarkerConnectedServiceRestartIntent: clearSessionMarkerConnectedServiceRestartIntentMock,
        removeSessionMarker: removeSessionMarkerMock,
        removeSessionMarkerIfOwned: removeSessionMarkerIfOwnedMock,
        updateSessionMarkerActiveTurn: updateSessionMarkerActiveTurnMock,
        updateSessionMarkerAgentSessionStartupInstructionsMarker:
            updateSessionMarkerAgentSessionStartupInstructionsMarkerMock,
        updateSessionMarkerAgentRuntimeSessionOpenAttestation:
            updateSessionMarkerAgentRuntimeSessionOpenAttestationMock,
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

vi.mock(
    '@/api/client/connectedServiceCredentialApi',
    async (importOriginal) => ({
        ...await importOriginal<
            typeof import('@/api/client/connectedServiceCredentialApi')
        >(),
        fetchAccountEncryptionCurrentness:
            fetchAccountEncryptionCurrentnessMock,
    }),
);

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
    updateSessionMetadataWithRetry: updateSessionMetadataWithRetryMock,
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
    acquireAuthoritativePluginRuntimeRegistryLease: acquireAuthoritativePluginRuntimeRegistryLeaseMock,
}));

vi.mock(
    '@/providers/sessions/authorizeSessionModelTransitionTarget',
    async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('@/providers/sessions/authorizeSessionModelTransitionTarget')
        >();
        authorizeSessionModelTransitionProviderTargetWithLeaseMock
            .mockImplementation(
                actual.authorizeSessionModelTransitionProviderTargetWithLease,
            );
        return {
            ...actual,
            authorizeSessionModelTransitionProviderTargetWithLease:
                authorizeSessionModelTransitionProviderTargetWithLeaseMock,
        };
    },
);

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
            subscribe: (listener: (result: unknown) => void) => {
                pluginReloadListenersMock.add(listener);
                return () => {
                    pluginReloadListenersMock.delete(listener);
                };
            },
            subscribeRunningSessionDisposition: (
                listener: (result: unknown) => void,
            ) => {
                pluginRunningSessionDispositionListenersMock.add(listener);
                return () => {
                    pluginRunningSessionDispositionListenersMock.delete(listener);
                };
            },
            getState: () => pluginReloadStateMock,
        },
    };
});

function createHostedWebStaticAssetsRegistry(input: Readonly<{
    pluginRoot: string;
    digest: PluginUiArtifactDigestV1;
    byteSize: number;
}>): ResolvedContributionRegistry {
    const base = {
        provenance: 'external' as const,
        source: { kind: 'path' as const },
        pluginId: 'acme.preview',
        pluginRootPath: input.pluginRoot,
        manifestPath: join(input.pluginRoot, '.happier-plugin/plugin.json'),
        daemonEntryPath: null,
        sourceSpec: {
            kind: 'path' as const,
            locator: input.pluginRoot,
            trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const,
        },
    };
    return createResolvedContributionRegistry({
        agents: [],
        uiViewsV2: [{
            ...base,
            identity: { pluginId: base.pluginId, localId: 'preview-web-view' },
            definition: {
                id: 'preview-web-view',
                container: 'rightPane',
                target: { kind: 'session' },
                renderer: 'preview-web',
                title: 'Preview web',
                instancePolicy: 'singleton',
                headerActions: [],
            },
        }],
        uiRenderersV2: [{
            ...base,
            identity: { pluginId: base.pluginId, localId: 'preview-web' },
            generatedUiArtifactsManifest: {
                version: 1,
                entries: [{
                    contributionId: 'preview-web',
                    tier: 'hostedWeb',
                    platform: 'web',
                    entry: 'hosted-web/preview-web/index.html',
                    files: [{
                        relativePath: 'hosted-web/preview-web/index.html',
                        digest: input.digest,
                        byteSize: input.byteSize,
                    }],
                    digest: input.digest,
                    builtWith: { bundler: 'vite', version: '6.0.0' },
                    hostUiApiVersion: '1.0.0',
                    compat: {},
                }],
            },
            definition: {
                id: 'preview-web',
                kind: 'hostedWeb',
                source: { kind: 'artifact', artifact: 'preview-web' },
            },
        }],
    });
}

async function writeHostedWebStaticAssetsFixture(input: Readonly<{
    pluginRoot: string;
    html: string;
    digest: PluginUiArtifactDigestV1;
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
            compat: {},
        }],
    }), 'utf8');
}

describe('startDaemonSessionControlRuntime', () => {
    it('composes runner custody from a direct retained binding instead of an execution grant', () => {
        const source = readFileSync(
            new URL('./startDaemonSessionControlRuntime.ts', import.meta.url),
            'utf8',
        );

        expect(source).toContain('verifyRunnerAgentBindingAgainstGeneration');
        expect(source).toContain('retainedAgent');
        expect(source).not.toContain('RunnerAgentExecutionGrant');
        expect(source).not.toContain('grantDigest');
        expect(source).not.toContain('runtimeBindingDigest');
    });

    it('mounts the Account-bound public Action ingress through the control-server boundary', async () => {
        const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
        const externalSessionHostAction = vi.fn(async () => ({
            ok: true as const,
            result: { items: [], nextCursor: null },
        }));
        const startParams = {
            machineId: 'machine-external-action-ingress',
            credentials: {
                token: 'token-daemon',
                encryption: {
                    type: 'legacy' as const,
                    secret: new Uint8Array(32).fill(1),
                },
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
            // These are daemon-owned lifecycle facts. The HTTP request never
            // provides either Account or machine-placement authority.
            externalActionAccountId: 'account-external-action-ingress',
            runtimeActionExecute,
            currentMachineHost: 'daemon-host',
            currentMachineHomeDir: '/home/daemon',
            resolveExternalSessionHostAction: () => externalSessionHostAction,
            resolveSessionSpawnDirectTargetTransport: () => undefined,
        };
        const runtime = await startDaemonSessionControlRuntime(
            startParams as StartDaemonSessionControlRuntimeTestParams,
        );

        try {
            const controlInput = vi.mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0];
            const externalActionApi = controlInput?.externalActionApi;
            expect(externalActionApi).toEqual(expect.objectContaining({
                currentServerId: configuration.activeServerId,
                verifyPat: expect.any(Function),
                resolveTarget: expect.any(Function),
                executor: expect.objectContaining({ execute: expect.any(Function) }),
            }));
            await expect(externalActionApi?.resolveTarget({
                actionId: 'session.status.get',
                target: { kind: 'machine', machineId: 'machine-external-action-ingress' },
                currentMachineId: 'machine-external-action-ingress',
            })).resolves.toEqual({
                kind: 'machine',
                machineId: 'machine-external-action-ingress',
            });

            const accountApiTokensPost = vi.spyOn(axios, 'post').mockResolvedValueOnce({
                status: 200,
                data: {
                    tokens: [{
                        tokenId: 'token-listed-through-daemon',
                        label: 'Daemon external Action',
                        displayPrefix: 'hap_v1_token…',
                        createdAt: '2026-08-23T10:00:00.000Z',
                        lastUsedAt: null,
                        expiresAt: null,
                    }],
                },
            });
            onTestFinished(() => accountApiTokensPost.mockRestore());
            await expect(externalActionApi?.executor.execute(
                'account.apiTokens.list',
                {},
                {
                    surface: 'api',
                    authority: 'account_automation',
                    actionCaller: { kind: 'host' },
                },
            )).resolves.toEqual({
                ok: true,
                result: {
                    tokens: [{
                        tokenId: 'token-listed-through-daemon',
                        label: 'Daemon external Action',
                        displayPrefix: 'hap_v1_token…',
                        createdAt: '2026-08-23T10:00:00.000Z',
                        lastUsedAt: null,
                        expiresAt: null,
                    }],
                },
            });
            expect(accountApiTokensPost).toHaveBeenCalledWith(
                expect.stringMatching(/\/v1\/account\/api-tokens\/list$/),
                {},
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer token-daemon',
                    }),
                }),
            );
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('routes E2EE external Action spawn input through the current authenticated machine admission transport', async () => {
        type ApiMachineForTest = Readonly<{
            enqueueSessionPendingByMachine: (
                request: unknown,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) => Promise<unknown>;
            registerLocalServicesRoutes: (routes: unknown) => void;
            registerSimulatorPreviewRoutes: (routes: unknown) => void;
        }>;
        const staleEnqueueSessionPendingByMachine = vi.fn<
            (request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => Promise<{
                status: 'rejected';
                code: 'session_input_target_unavailable';
            }>
        >(async () => ({
            status: 'rejected' as const,
            code: 'session_input_target_unavailable' as const,
        }));
        const enqueueSessionPendingByMachine = vi.fn<
            (request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => Promise<{
                status: 'accepted';
                localId: string;
            }>
        >(async () => ({
            status: 'accepted' as const,
            localId: 'plugin-input-v1:external-spawn',
        }));
        const apiMachineAtStartup: ApiMachineForTest = {
            enqueueSessionPendingByMachine: async (request, options) =>
                await staleEnqueueSessionPendingByMachine(request, options),
            registerLocalServicesRoutes: () => {},
            registerSimulatorPreviewRoutes: () => {},
        };
        const apiMachineAtRequest: ApiMachineForTest = {
            enqueueSessionPendingByMachine: async (request, options) =>
                await enqueueSessionPendingByMachine(request, options),
            registerLocalServicesRoutes: () => {},
            registerSimulatorPreviewRoutes: () => {},
        };
        let currentApiMachineForSessions: ApiMachineForTest | null =
            apiMachineAtStartup;
        const getApiMachineForSessions = vi.fn(() => (
            currentApiMachineForSessions as unknown as ReturnType<
                StartDaemonSessionControlRuntimeTestParams['getApiMachineForSessions']
            >
        ));
        const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
        createCliActionExecutorFromCredentialsMock.mockImplementationOnce(() => ({
            execute,
            prepare: vi.fn(),
            bindInvocation: vi.fn(),
        }));
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-external-action-admission',
            credentials: {
                token: 'token-daemon',
                encryption: {
                    type: 'legacy' as const,
                    secret: new Uint8Array(32).fill(1),
                },
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
            getApiMachineForSessions,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
            externalActionAccountId: 'account-external-action-admission',
            resolveSessionSpawnDirectTargetTransport: () => undefined,
        } as StartDaemonSessionControlRuntimeTestParams);

        try {
            const externalActionApi = vi.mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0]?.externalActionApi;
            if (!externalActionApi) {
                throw new Error('Expected the daemon to mount the external Action API');
            }
            currentApiMachineForSessions = apiMachineAtRequest;

            await externalActionApi.executor.execute(
                'session.spawn_new',
                { initialMessage: 'Durable E2EE initial input' },
                { surface: 'api' },
            );

            type ExecutorOptions = Readonly<{
                machineAdmissionTransport?: (
                    request: unknown,
                    options?: Readonly<{ signal?: AbortSignal }>,
                ) => Promise<unknown>;
            }>;
            const executorOptions = createCliActionExecutorFromCredentialsMock
                .mock.calls.at(-1)?.[0] as ExecutorOptions | undefined;
            const machineAdmissionTransport = executorOptions?.machineAdmissionTransport;
            if (!machineAdmissionTransport) {
                throw new Error('Expected external Action execution to receive machine admission');
            }

            const controller = new AbortController();
            const request = {
                v: 1,
                sessionId: 'session-external-spawn',
                targetMachineId: 'machine-external-action-admission',
                localId: 'plugin-input-v1:external-spawn',
                content: { t: 'encrypted', c: 'ciphertext' },
                requestedAction: { v: 1, kind: 'send_now' },
            } as const;
            await expect(machineAdmissionTransport(request, { signal: controller.signal }))
                .resolves.toEqual({
                    status: 'accepted',
                    localId: 'plugin-input-v1:external-spawn',
                });
            expect(getApiMachineForSessions).toHaveBeenCalledTimes(2);
            expect(enqueueSessionPendingByMachine).toHaveBeenCalledWith(request, {
                signal: controller.signal,
            });
            expect(staleEnqueueSessionPendingByMachine).not.toHaveBeenCalled();
            expect(execute).toHaveBeenCalledWith(
                'session.spawn_new',
                { initialMessage: 'Durable E2EE initial input' },
                { surface: 'api' },
            );
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('does not restore legacy-unfenced one-shot materialization as an ongoing runtime target', async () => {
        const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const createTracked = (
            pid: number,
            profileId: string,
            credentialRevision?: string,
        ): TrackedSession => ({
            pid,
            startedBy: 'daemon',
            happySessionId: `session-${profileId}`,
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'codex',
                    sourceKind: 'built_in',
                },
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'profile',
                            profileId,
                        },
                    },
                },
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: `csm-${profileId}`,
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]:
                        JSON.stringify([{
                            kind: 'profile',
                            serviceId: 'openai-codex',
                            profileId,
                            ...(credentialRevision
                                ? { credentialRevision }
                                : {}),
                        }]),
                },
            },
        });
        const legacyTracked = createTracked(101, 'legacy');
        const fabricatedRevisionTracked = createTracked(
            103,
            'legacy-with-fabricated-revision',
            revision,
        );
        const revisionedTracked = createTracked(
            102,
            'revisioned',
            revision,
        );
        const credentialRecord = (profileId: string) =>
            buildConnectedServiceCredentialRecord({
                now: 1_000,
                serviceId: 'openai-codex',
                profileId,
                kind: 'oauth',
                expiresAt: null,
                oauth: {
                    accessToken: `${profileId}-access`,
                    refreshToken: `${profileId}-refresh`,
                    idToken: null,
                    scope: null,
                    tokenType: null,
                    providerAccountId: null,
                    providerEmail: null,
                },
            });
        const getConnectedServiceCredentialPlain = vi.fn(
            async ({ profileId }: { profileId: string }) => ({
                content: {
                    t: 'plain' as const,
                    v: credentialRecord(profileId),
                },
                ...(profileId !== 'revisioned'
                    ? {
                        revisionSemantics: 'legacy_unfenced' as const,
                        credentialRevision: null,
                    }
                    : {
                        revisionSemantics: 'revisioned' as const,
                        credentialRevision: revision,
                    }),
            }),
        );
        const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
        // Server-observed credential revisions are the bootstrap fencing authority: only the
        // revisioned profile carries one, so the legacy profiles read back as legacy-unfenced
        // even though one of them fabricates a revision in its own spawn environment.
        const fetchAccountProfile = vi.spyOn(axios, 'get').mockResolvedValue({
            status: 200,
            data: {
                id: 'account-bootstrap-unfenced',
                connectedServicesV2: [{
                    serviceId: 'openai-codex',
                    profiles: [
                        { profileId: 'legacy', status: 'connected', kind: 'oauth' },
                        {
                            profileId: 'legacy-with-fabricated-revision',
                            status: 'connected',
                            kind: 'oauth',
                        },
                        { profileId: 'revisioned', status: 'connected', kind: 'oauth' },
                    ],
                    groups: [],
                }],
                connectedServiceCredentialRevisionsV1: [{
                    serviceId: 'openai-codex',
                    profileId: 'revisioned',
                    credentialRevision: revision,
                }],
            },
        });
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-bootstrap-unfenced',
            credentials: {
                token: 'token-daemon',
                encryption: {
                    type: 'legacy',
                    secret: new Uint8Array(32).fill(1),
                },
            },
            api: {
                getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
                getConnectedServiceCredentialPlain,
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir:
                '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            connectedServiceRuntimeRegistry: runtimeRegistry,
            pidToTrackedSession: new Map([
                [legacyTracked.pid, legacyTracked],
                [fabricatedRevisionTracked.pid,
                    fabricatedRevisionTracked],
                [revisionedTracked.pid, revisionedTracked],
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
            expect(runtimeRegistry.getByPid(legacyTracked.pid)).toBeNull();
            expect(runtimeRegistry.getByPid(fabricatedRevisionTracked.pid))
                .toBeNull();
            expect(runtimeRegistry.getByPid(revisionedTracked.pid))
                .not.toBeNull();
            // Bootstrap fencing reads server-observed revisions, never credential material.
            expect(getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
        } finally {
            fetchAccountProfile.mockRestore();
            await runtime.stopControlServer();
        }
    });

    it('switches a fresh managed Provider from current-Q admission to Q-free exact-P policy after adoption', async () => {
        let adopted = false;
        let exactPPolicyCurrent = true;
        const revalidateCurrentQ = vi.fn(async () => true);
        const revalidateExactPPolicy = vi.fn(
            async () => exactPPolicyCurrent,
        );
        const fenceRetainedPolicy = vi.fn(async () => undefined);

        const readCurrent = async () =>
            await isManagedProviderSessionInvocationCurrent({
                adoptionCommitted: () => adopted,
                revalidateInitialPolicy: revalidateCurrentQ,
                readsRetainedAuthorityCurrent: () => true,
                revalidateRetainedPolicy: revalidateExactPPolicy,
                fenceRetainedPolicy,
                readHardRevocationRevision: async () => 7,
                readGenerationIntegrityCurrentness: async () => true,
                hardRevocationRevisionAtAdmission: 7,
            });

        await expect(readCurrent()).resolves.toBe(true);
        expect(revalidateCurrentQ).toHaveBeenCalledOnce();
        expect(revalidateExactPPolicy).not.toHaveBeenCalled();

        adopted = true;
        await expect(readCurrent()).resolves.toBe(true);
        expect(revalidateCurrentQ).toHaveBeenCalledOnce();
        expect(revalidateExactPPolicy).toHaveBeenCalledOnce();

        exactPPolicyCurrent = false;
        await expect(readCurrent()).resolves.toBe(false);
        expect(revalidateCurrentQ).toHaveBeenCalledOnce();
        expect(revalidateExactPPolicy).toHaveBeenCalledTimes(2);
        expect(fenceRetainedPolicy).toHaveBeenCalledOnce();
    });

    it('rejects exact P after hard revocation advances during retained integrity currentness', async () => {
        let hardRevocationRevision = 7;
        const readHardRevocationRevision = vi.fn(
            async () => hardRevocationRevision,
        );
        const readGenerationIntegrityCurrentness = vi.fn(async () => {
            await Promise.resolve();
            hardRevocationRevision = 8;
            return true;
        });
        const revalidateInitialPolicy = vi.fn(async () => true);
        const revalidateRetainedPolicy = vi.fn(async () => true);
        const fenceRetainedPolicy = vi.fn(async () => undefined);

        await expect(isManagedProviderSessionInvocationCurrent({
            adoptionCommitted: () => true,
            revalidateInitialPolicy,
            readsRetainedAuthorityCurrent: () => true,
            revalidateRetainedPolicy,
            fenceRetainedPolicy,
            readHardRevocationRevision,
            readGenerationIntegrityCurrentness,
            hardRevocationRevisionAtAdmission: 7,
        })).resolves.toBe(false);

        expect(revalidateInitialPolicy).not.toHaveBeenCalled();
        expect(revalidateRetainedPolicy).toHaveBeenCalledOnce();
        expect(readGenerationIntegrityCurrentness).toHaveBeenCalledOnce();
        expect(readHardRevocationRevision).toHaveBeenCalledTimes(2);
        expect(fenceRetainedPolicy).not.toHaveBeenCalled();
    });

    it('fences retained Provider policy failures but not stale daemon authority', async () => {
        const fenceRetainedPolicy = vi.fn(async () => undefined);
        const revalidatePolicy = vi.fn(async () => {
            throw new Error('policy owner unavailable');
        });

        await expect(isRetainedManagedProviderInvocationCurrent({
            readsRetainedAuthorityCurrent: () => true,
            revalidatePolicy,
            fenceRetainedPolicy,
            readHardRevocationRevision: async () => 7,
            hardRevocationRevisionAtAdmission: 7,
            readGenerationIntegrityCurrentness: async () => true,
        })).resolves.toBe(false);
        expect(fenceRetainedPolicy).toHaveBeenCalledOnce();

        revalidatePolicy.mockClear();
        fenceRetainedPolicy.mockClear();
        await expect(isRetainedManagedProviderInvocationCurrent({
            readsRetainedAuthorityCurrent: () => false,
            revalidatePolicy,
            fenceRetainedPolicy,
            readHardRevocationRevision: async () => 7,
            hardRevocationRevisionAtAdmission: 7,
            readGenerationIntegrityCurrentness: async () => true,
        })).resolves.toBe(false);
        expect(revalidatePolicy).not.toHaveBeenCalled();
        expect(fenceRetainedPolicy).not.toHaveBeenCalled();

        let authorityReadCount = 0;
        await expect(isRetainedManagedProviderInvocationCurrent({
            readsRetainedAuthorityCurrent: () =>
                ++authorityReadCount === 1,
            revalidatePolicy: async () => true,
            fenceRetainedPolicy,
            readHardRevocationRevision: async () => 7,
            hardRevocationRevisionAtAdmission: 7,
            readGenerationIntegrityCurrentness: async () => true,
        })).resolves.toBe(false);
        expect(fenceRetainedPolicy).not.toHaveBeenCalled();

        authorityReadCount = 0;
        await expect(isRetainedManagedProviderInvocationCurrent({
            readsRetainedAuthorityCurrent: () =>
                ++authorityReadCount === 1,
            revalidatePolicy: async () => false,
            fenceRetainedPolicy,
            readHardRevocationRevision: async () => 7,
            hardRevocationRevisionAtAdmission: 7,
            readGenerationIntegrityCurrentness: async () => true,
        })).resolves.toBe(false);
        expect(fenceRetainedPolicy).not.toHaveBeenCalled();
    });

    it('revalidates retained Provider policy on every post-prepare currentness read', async () => {
        let policyCurrent = true;
        let generationIntegrityCurrent = true;
        const revalidatePolicy = vi.fn(async () => policyCurrent);
        const readHardRevocationRevision = vi.fn(async () => 7);
        const readGenerationIntegrityCurrentness = vi.fn(
            async () => generationIntegrityCurrent,
        );
        const fenceRetainedPolicy = vi.fn(async () => undefined);

        await expect(isRetainedManagedProviderInvocationCurrent({
            readsRetainedAuthorityCurrent: () => true,
            revalidatePolicy,
            fenceRetainedPolicy,
            readHardRevocationRevision,
            hardRevocationRevisionAtAdmission: 7,
            readGenerationIntegrityCurrentness,
        })).resolves.toBe(true);

        // Connection/grant removal after daemon-B prepare must revoke P on
        // the next managed operation without consulting desired Q.
        policyCurrent = false;
        await expect(isRetainedManagedProviderInvocationCurrent({
            readsRetainedAuthorityCurrent: () => true,
            revalidatePolicy,
            fenceRetainedPolicy,
            readHardRevocationRevision,
            hardRevocationRevisionAtAdmission: 7,
            readGenerationIntegrityCurrentness,
        })).resolves.toBe(false);
        expect(revalidatePolicy).toHaveBeenCalledTimes(2);
        expect(readHardRevocationRevision).toHaveBeenCalledTimes(2);
        expect(fenceRetainedPolicy).toHaveBeenCalledOnce();

        policyCurrent = true;
        generationIntegrityCurrent = false;
        await expect(isRetainedManagedProviderInvocationCurrent({
            readsRetainedAuthorityCurrent: () => true,
            revalidatePolicy,
            fenceRetainedPolicy,
            readHardRevocationRevision,
            hardRevocationRevisionAtAdmission: 7,
            readGenerationIntegrityCurrentness,
        })).resolves.toBe(false);
        expect(readHardRevocationRevision).toHaveBeenCalledTimes(3);
        expect(readGenerationIntegrityCurrentness).toHaveBeenCalledTimes(2);
    });

    it('does not treat tracked startup metadata as Runner Agent session-open attestation', async () => {
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
                runtimeCapabilities: [],
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
            expect(createRuntime).not.toHaveBeenCalled();
            expect(open).not.toHaveBeenCalled();

            const attestation = await runtime.awaitAgentSessionOpen({
                sessionId: context.sessionId,
                timeoutMs: 0,
            });
            expect.soft(tracked.spawnOptions).toHaveProperty(
                'agentSessionStartupInstructionsV1',
                startupInstructions,
            );
            expect.soft(tracked).toHaveProperty(
                'agentSessionStartupInstructionsMarkerV1',
                startupInstructionsMarker,
            );
            expect.soft(
                updateSessionMarkerAgentSessionStartupInstructionsMarkerMock,
            ).not.toHaveBeenCalled();
            expect.soft(JSON.stringify(tracked.spawnOptions)).toContain(
                startupInstructionsSentinel,
            );
            expect.soft(attestation).toEqual({ status: 'timeout' });
            expect.soft(JSON.stringify(attestation)).not.toContain(
                startupInstructionsSentinel,
            );
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('keeps session-open prepare out of tracked currentness until commit', async () => {
        const sessionId = 'session-open-phase-custody';
        const binding = createAgentSessionRunnerFactoryBinding({
            v: 1,
            pluginId: 'acme.plugin',
            pluginVersion: '1.2.3',
            agentId: 'acme-agent',
            localAgentId: 'acme-agent',
            immutableGenerationId: `sha256:${'1'.repeat(64)}`,
            locator: {
                module: './runtime.mjs',
                export: 'createRuntime',
                runtimeApiVersion: 1,
            },
            normalizedModulePath: '/immutable/acme/runtime.mjs',
            loadMode: 'immutable-js',
        });
        const runner = Object.freeze({
            pid: 4321,
            processStartTimeMs: 1_717_171_717_000,
            processCommandHash: 'a'.repeat(64),
            snapshotIdentity: 'snapshot:runner-open',
        });
        const tracked: TrackedSession = {
            startedBy: 'daemon',
            pid: runner.pid,
            happySessionId: sessionId,
            runnerAgentImmutableGenerationId: binding.immutableGenerationId,
            processStartTimeMs: runner.processStartTimeMs,
            processCommandHash: runner.processCommandHash,
            agentRuntimeDaemonServiceAuthorityFilePath:
                '/private/current-authority.json',
        };
        const openRequest = {
            kind: 'create' as const,
            sessionId,
            cwd: '/workspace',
            stateSharing: {
                configMode: 'linked' as const,
                stateMode: 'shared' as const,
            },
        };
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-session-open-phase-custody',
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
            pidToTrackedSession: new Map([[runner.pid, tracked]]),
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
            const dispatch = vi.mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0].agentRuntimeDaemonServices?.dispatch;
            if (!dispatch) {
                throw new Error('Expected runner Agent daemon-service dispatcher');
            }
            const context = {
                sessionId,
                runner,
                retainedAgent: binding,
                trackedSession: tracked,
                invocationContext: {
                    cwd: '/workspace',
                    environment: {},
                    providerBindingActive: false,
                },
                signal: new AbortController().signal,
            };
            const attest = async (phase: 'prepare' | 'commit') => await dispatch(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: { token: 'a'.repeat(43), sessionId },
                    operation: {
                        kind: 'session.open.attest',
                        requestId: `attest-open-${phase}`,
                        phase,
                        request: openRequest,
                        providerSessionId: null,
                    },
                }),
                context,
            );

            await expect(attest('prepare')).resolves.toEqual({
                ok: true,
                result: {
                    kind: 'session.open.attestation',
                    status: 'accepted',
                },
            });
            expect(
                updateSessionMarkerAgentRuntimeSessionOpenAttestationMock,
            ).not.toHaveBeenCalled();
            await expect(runtime.awaitAgentSessionOpen({
                sessionId,
                timeoutMs: 0,
            })).resolves.toEqual({ status: 'timeout' });

            await expect(attest('commit')).resolves.toEqual({
                ok: true,
                result: {
                    kind: 'session.open.attestation',
                    status: 'recorded',
                },
            });
            expect(
                updateSessionMarkerAgentRuntimeSessionOpenAttestationMock,
            ).toHaveBeenCalledWith({
                pid: runner.pid,
                sessionId,
                authorityFilePath: '/private/current-authority.json',
                attestation: {
                    request: openRequest,
                    providerSessionId: null,
                },
            });
            await expect(runtime.awaitAgentSessionOpen({
                sessionId,
                timeoutMs: 0,
            })).resolves.toEqual({
                status: 'opened',
                request: openRequest,
            });
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('attempts every independent control-runtime shutdown phase when an earlier one rejects', async () => {
        // Daemon shutdown runs these phases in one chain. A single `await` sequence
        // meant one rejecting runner/External-Sessions cleanup silently skipped the
        // remaining phases — control-runtime resources were never disposed and the
        // control server was never stopped, for a shutdown that reports itself done.
        const retireExternalSessionHostOperations = vi.fn(async (): Promise<void> => {
            throw new Error('external-session-retirement-failed');
        });
        const externalSessionHostOperationOwner: ExternalSessionHostOperationOwner = {
            bind: () => {
                throw new Error('not bound in this test');
            },
            install: async () => Object.freeze({ dispose: async () => {} }),
            canFollowNow: () => false,
            retire: retireExternalSessionHostOperations,
        };
        const beforeShutdown = vi.fn(async () => {});
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-shutdown-phases',
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
            externalSessionHostOperationOwner,
            beforeShutdown,
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });
        const controlServerStarted = await vi.mocked(startDaemonControlServer)
            .mock.results.at(-1)?.value as
            Awaited<ReturnType<typeof startDaemonControlServer>>;
        const controlInput = vi.mocked(startDaemonControlServer)
            .mock.calls.at(-1)?.[0];

        // The control-server drain path: a rejecting phase still reaches the
        // daemon-owned drain that runs after it.
        await expect(controlInput?.beforeShutdown?.())
            .rejects.toThrow('external-session-retirement-failed');
        expect(retireExternalSessionHostOperations).toHaveBeenCalledTimes(1);
        expect(beforeShutdown).toHaveBeenCalledTimes(1);

        // The daemon cleanup path: the control socket is stopped even though an
        // earlier phase rejected, and the failure is still reported to the caller.
        await expect(runtime.stopControlServer())
            .rejects.toThrow('external-session-retirement-failed');
        expect(controlServerStarted.stop).toHaveBeenCalledTimes(1);
    });

    it('reactivates a reattached Agent through the canonical session lease and rotates its exact request-auth capability', async () => {
        const materializationBaseDir = await mkdtemp(
            join(tmpdir(), 'happier-request-auth-reattach-'),
        );
        let plannedRestartPidSafetySpy: Readonly<{
            mockRestore: () => void;
        }> | null = null;
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
        const piPurpose = {
            consumer: {
                pluginId: 'happier.agent.pi',
                localId: 'pi',
            },
            purpose: 'openai-codex-model-request',
        } as const;
        const piBinding = {
            purpose: piPurpose,
            target: binding.target,
        } as const;
        const piUse = {
            purpose: piPurpose,
            materialization: use.materialization,
        } as const;
        const piMaterializationId =
            'csm_pi_request_auth_reattach';
        const piCredential =
            buildConnectedServiceCredentialRecord({
                now: 1_000,
                serviceId: 'openai-codex',
                profileId: 'primary',
                kind: 'oauth',
                expiresAt: null,
                oauth: {
                    accessToken: 'pi-old-daemon-access-token',
                    refreshToken: 'pi-refresh-token',
                    idToken: 'pi-id-token',
                    scope: null,
                    tokenType: null,
                    providerAccountId: 'account-primary',
                    providerEmail: null,
                },
            });
        const piMaterialization =
            await materializeConnectedServicesForSpawn({
                agentId: 'pi',
                materializationKey: piMaterializationId,
                activeServerDir: materializationBaseDir,
                baseDir: materializationBaseDir,
                recordsByServiceId: new Map([
                    ['openai-codex', piCredential],
                ]),
                connectedAccountMaterializationAuthority: {
                    kind: 'qualified',
                    purposeBindings: [piBinding],
                    requestAuthPurposeBindings: [piBinding],
                },
            });
        expect(piMaterialization).not.toBeNull();
        const piCapabilityPath =
            piMaterialization!.env[
                CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV
            ]!;
        const piMaterializedRootDir =
            resolve(piCapabilityPath, '..', '..');
        const oldRegistry =
            createConnectedAccountRequestAuthSubjectRegistry();
        const oldDescriptor = await oldRegistry.activate({
            materializedRootDir,
            materializationId,
            httpPort: 43210,
            subject: {
                subjectId:
                    'agent-session:session-request-auth-reattach',
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
        const oldPiDescriptor = await oldRegistry.activate({
            materializedRootDir: piMaterializedRootDir,
            materializationId: piMaterializationId,
            httpPort: 43210,
            subject: {
                subjectId:
                    'agent-session:session-pi-request-auth-reattach',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: (candidate) => (
                    JSON.stringify(candidate)
                        === JSON.stringify(piPurpose)
                        ? { binding: piBinding, use: piUse }
                        : null
                ),
                listPurposeUses: () => [{
                    binding: piBinding,
                    use: piUse,
                }],
            },
        });
        const oldPiCapability = (
            await readConnectedAccountRequestAuthCapabilityFile(
                oldPiDescriptor.path,
            )
        )?.capability;
        expect(oldRegistry.authenticate(oldPiCapability))
            .not.toBeNull();
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
                    'agent-session:session-request-auth-unprovable',
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
                    'agent-session:session-request-auth-reused-pid',
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
                        'agent-session:session-request-auth-changed-identity',
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
        const scopeChangedMaterializationId =
            'csm_request_auth_scope_changed';
        const scopeChangedMaterializedRootDir =
            resolveConnectedServiceMaterializedRootDir({
                baseDir: materializationBaseDir,
                agentId: 'opencode',
                materializationKey: scopeChangedMaterializationId,
            });
        await mkdir(scopeChangedMaterializedRootDir, {
            recursive: true,
            mode: 0o700,
        });
        // The predecessor daemon launched this exact running child under a
        // narrower request-auth use than the Agent contributes today, so the
        // replacement's subject scope no longer equals the recovered one.
        const scopeChangedUse = {
            purpose,
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://chatgpt.com',
                headerNames: ['authorization'],
            },
        } as const;
        const scopeChangedDescriptor = await oldRegistry.activate({
            materializedRootDir: scopeChangedMaterializedRootDir,
            materializationId: scopeChangedMaterializationId,
            httpPort: 43210,
            subject: {
                subjectId:
                    'agent-session:session-request-auth-scope-changed',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: () => ({
                    binding,
                    use: scopeChangedUse,
                }),
                listPurposeUses: () => [{
                    binding,
                    use: scopeChangedUse,
                }],
            },
        });
        const scopeChangedOldCapability = (
            await readConnectedAccountRequestAuthCapabilityFile(
                scopeChangedDescriptor.path,
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
                        agentDefinitionsById: new Map([
                            ['opencode', {
                                identity: purpose.consumer,
                                richDefinition: {
                                    definition: {
                                        connectedAccounts: [{
                                            purpose: purpose.purpose,
                                            service:
                                                binding.target.account.service,
                                            materializationKinds:
                                                ['httpHeaders'],
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
                            }],
                            ['pi', {
                                identity: piPurpose.consumer,
                                richDefinition: {
                                    definition: {
                                        connectedAccounts: [{
                                            purpose:
                                                piPurpose.purpose,
                                            service:
                                                piBinding.target.account.service,
                                            materializationKinds:
                                                ['httpHeaders'],
                                        }],
                                    },
                                },
                                catalogEntry: {
                                    connectedAccountRequestAuthUses: [{
                                        purpose:
                                            piUse.purpose.purpose,
                                        materialization:
                                            piUse.materialization,
                                    }],
                                },
                            }],
                        ]),
                        // Both shipped Agents declare legacy service-keyed Connected Services,
                        // which is what grants the recovered subject legacy compatibility.
                        catalogEntriesById: {
                            opencode: {
                                connectedServiceIds: [
                                    'openai-codex',
                                    'openai',
                                    'claude-subscription',
                                    'anthropic',
                                ],
                            },
                            pi: {
                                connectedServiceIds: [
                                    'openai-codex',
                                    'openai',
                                    'claude-subscription',
                                    'anthropic',
                                ],
                            },
                        },
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
                purposes: readonly (typeof purpose | typeof piPurpose)[];
                bindings: readonly (typeof binding | typeof piBinding)[];
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
                        (candidate: typeof purpose | typeof piPurpose) => {
                            if (!isCurrent()) return null;
                            const candidateKey =
                                JSON.stringify(candidate);
                            const index = input.purposes.findIndex(
                                (item) =>
                                    JSON.stringify(item)
                                    === candidateKey,
                            );
                            return index < 0
                                ? null
                                : input.bindings[index] ?? null;
                        },
                    listPurposeBindings: () => (
                        isCurrent() ? input.bindings : []
                    ),
                    dispose: () => {
                        disposePurposeLease(input.sessionId);
                    },
                };
            },
        );
        const beforeShutdown = vi.fn(async () => {});
        const previousAttachCleanup = vi.fn(async () => {});
        const piPreviousAttachCleanup = vi.fn(async () => {});
        const reusedPreviousAttachCleanup =
            vi.fn(async () => {});
        const changedIdentityPreviousAttachCleanup =
            vi.fn(async () => {});
        const scopeChangedPreviousAttachCleanup =
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
                    processStartTimeMs:
                        pid === piTracked.pid ? 15_000 : 1_000,
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
            [54, piPreviousAttachCleanup],
            [57, scopeChangedPreviousAttachCleanup],
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
        const piTracked: TrackedSession = {
            ...tracked,
            pid: 54,
            happySessionId:
                'session-pi-request-auth-reattach',
            processStartTimeMs: 15_000,
            spawnOptions: {
                ...tracked.spawnOptions!,
                existingSessionId:
                    'session-pi-request-auth-reattach',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'pi',
                    sourceKind: 'built_in',
                },
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: piMaterializationId,
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
                environmentVariables: {
                    ...piMaterialization!.env,
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
        const scopeChangedTracked: TrackedSession = {
            ...tracked,
            pid: 57,
            happySessionId:
                'session-request-auth-scope-changed',
            spawnOptions: {
                ...tracked.spawnOptions!,
                existingSessionId:
                    'session-request-auth-scope-changed',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: scopeChangedMaterializationId,
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
                environmentVariables: {
                    [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                        scopeChangedDescriptor.path,
                },
            },
        };
        const cutoverProcessCommand =
            'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs opencode --happy-starting-mode remote --started-by daemon';
        const cutoverTracked: TrackedSession = {
            ...tracked,
            pid: 46,
            happySessionId:
                'session-request-auth-source-cutover',
            reattachedInterruptedTurnId:
                'turn-request-auth-source-cutover',
            processCommand: cutoverProcessCommand,
            processCommandHash: createHash('sha256')
                .update(cutoverProcessCommand)
                .digest('hex'),
            processStartTimeMs: 6_000,
            spawnOptions: {
                ...tracked.spawnOptions!,
                existingSessionId:
                    'session-request-auth-source-cutover',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: 'csm_request_auth_source_cutover',
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
                environmentVariables: {
                    HAPPIER_OPENCODE_BROKER_STATE_PATH:
                        '/tmp/connected-service-broker.state.json',
                },
            },
        };
        const idlePromptCutoverTracked: TrackedSession = {
            ...cutoverTracked,
            pid: 48,
            happySessionId:
                'session-request-auth-idle-prompt-cutover',
            reattachedInterruptedTurnId:
                'turn-stale-before-idle-witness',
            processStartTimeMs: 8_000,
            spawnOptions: {
                ...cutoverTracked.spawnOptions!,
                existingSessionId:
                    'session-request-auth-idle-prompt-cutover',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: 'csm_request_auth_idle_prompt_cutover',
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
            },
        };
        const absentMarkerCutoverTracked: TrackedSession = {
            ...cutoverTracked,
            pid: 55,
            happySessionId:
                'session-request-auth-absent-marker-cutover',
            processStartTimeMs: 1_000,
            spawnOptions: {
                ...cutoverTracked.spawnOptions!,
                existingSessionId:
                    'session-request-auth-absent-marker-cutover',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: 'csm_request_auth_absent_marker_cutover',
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
            },
        };
        delete absentMarkerCutoverTracked.activeTurnId;
        delete absentMarkerCutoverTracked
            .reattachedInterruptedTurnId;
        const failedRespawnCutoverTracked: TrackedSession = {
            ...cutoverTracked,
            pid: 50,
            happySessionId:
                'session-request-auth-failed-respawn-cutover',
            reattachedInterruptedTurnId:
                'turn-request-auth-failed-respawn-cutover',
            processStartTimeMs: 10_000,
            spawnOptions: {
                ...cutoverTracked.spawnOptions!,
                existingSessionId:
                    'session-request-auth-failed-respawn-cutover',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: 'csm_request_auth_failed_respawn_cutover',
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
            },
        };
        const racingTurnCutoverTracked: TrackedSession = {
            ...cutoverTracked,
            pid: 56,
            happySessionId:
                'session-request-auth-racing-turn-cutover',
            reattachedInterruptedTurnId:
                'turn-request-auth-racing-turn-cutover',
            processStartTimeMs: 16_000,
            spawnOptions: {
                ...cutoverTracked.spawnOptions!,
                existingSessionId:
                    'session-request-auth-racing-turn-cutover',
                resume: 'remote-predecessor-resume-id',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: 'csm_request_auth_racing_turn_cutover',
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
            },
        };
        const windowsCutoverTracked: TrackedSession = {
            ...cutoverTracked,
            pid: 51,
            happySessionId:
                'session-request-auth-windows-cutover',
            reattachedInterruptedTurnId:
                'turn-request-auth-windows-cutover',
            processStartTimeMs: 11_000,
            spawnOptions: {
                ...cutoverTracked.spawnOptions!,
                existingSessionId:
                    'session-request-auth-windows-cutover',
                windowsRemoteSessionLaunchMode:
                    'windows_terminal',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: 'csm_request_auth_windows_cutover',
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
            },
        };
        const coldResumeCutoverTracked: TrackedSession = {
            ...cutoverTracked,
            pid: 52,
            happySessionId:
                'session-request-auth-cold-resume-cutover',
            reattachedInterruptedTurnId:
                'turn-request-auth-cold-resume-cutover',
            processStartTimeMs: 12_000,
            agentSessionStartupInstructionsMarkerV1: {
                v: 1,
                id: 'happier.global_voice_agent',
                revision: 7,
            },
            spawnOptions: {
                ...cutoverTracked.spawnOptions!,
                existingSessionId:
                    'session-request-auth-cold-resume-cutover',
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: 'csm_request_auth_cold_resume_cutover',
                    createdAt: 1_000,
                    source: 'first_spawn',
                },
            },
        };

        const pidToTrackedSession =
            new Map<number, TrackedSession>([
                [tracked.pid, tracked],
                [piTracked.pid, piTracked],
                [unprovableTracked.pid, unprovableTracked],
                [reusedTracked.pid, reusedTracked],
                [
                    changedIdentityTracked.pid,
                    changedIdentityTracked,
                ],
                [
                    scopeChangedTracked.pid,
                    scopeChangedTracked,
                ],
                [cutoverTracked.pid, cutoverTracked],
                [
                    idlePromptCutoverTracked.pid,
                    idlePromptCutoverTracked,
                ],
                [
                    absentMarkerCutoverTracked.pid,
                    absentMarkerCutoverTracked,
                ],
                [
                    failedRespawnCutoverTracked.pid,
                    failedRespawnCutoverTracked,
                ],
                [
                    racingTurnCutoverTracked.pid,
                    racingTurnCutoverTracked,
                ],
                [
                    windowsCutoverTracked.pid,
                    windowsCutoverTracked,
                ],
                [
                    coldResumeCutoverTracked.pid,
                    coldResumeCutoverTracked,
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
        type RespawnOwnerParams =
            Parameters<
                typeof sessionRunnerRespawnModule
                    .createSessionRunnerRespawnManager
            >[0];
        const respawnOwnerInputs: RespawnOwnerParams[] = [];
        const createSessionRunnerRespawnManager =
            sessionRunnerRespawnModule
                .createSessionRunnerRespawnManager;
        const respawnOwnerSpy = vi.spyOn(
            sessionRunnerRespawnModule,
            'createSessionRunnerRespawnManager',
        ).mockImplementation((input) => {
            respawnOwnerInputs.push(input);
            return createSessionRunnerRespawnManager(input);
        });
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
            const pidSafetyModule = await import('../pidSafety');
            plannedRestartPidSafetySpy = vi.spyOn(
                pidSafetyModule,
                'isPidSafeHappySessionProcess',
            ).mockResolvedValue(true);

            expect(startDaemonControlServer).toHaveBeenCalledOnce();
            const controlInput = vi
                .mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0];
            // Persisted marker absence is ambiguous: daemon A may have crashed
            // after Provider work began but before recording task_started. Only
            // the runner-local lifecycle witness may prove a safe boundary.
            expect(
                requestConnectedServiceSessionRestartSignalMock,
            ).not.toHaveBeenCalled();
            await expect(
                controlInput?.handleConnectedServiceTurnLifecycle?.({
                    sessionId:
                        'session-request-auth-source-cutover',
                    event: 'prompt_or_steer',
                }),
            ).resolves.toEqual({
                status: 'input_blocked',
                reason: 'request_auth_source_cutover',
            });
            expect(
                requestConnectedServiceSessionRestartSignalMock,
            ).not.toHaveBeenCalled();
            await expect(
                controlInput?.handleConnectedServiceTurnLifecycle?.({
                    sessionId:
                        'session-request-auth-source-cutover',
                    event: 'prompt_or_steer',
                    requestedAction: {
                        v: 1,
                        kind: 'steer_now',
                    },
                    activeTurnId:
                        'turn-request-auth-source-cutover',
                }),
            ).resolves.toEqual({
                status: 'continue',
                turnCustody: {
                    status: 'recorded',
                    activeTurnId:
                        'turn-request-auth-source-cutover',
                },
            });
            expect(
                requestConnectedServiceSessionRestartSignalMock,
            ).not.toHaveBeenCalled();
            expect(
                resolveSessionRunnerRestartEligibility(
                    cutoverTracked,
                ),
            ).toEqual({
                eligible: true,
                disabledReason: null,
            });

            const terminalCutover =
                controlInput?.handleConnectedServiceTurnLifecycle?.({
                    sessionId:
                        'session-request-auth-source-cutover',
                    event: 'assistant_message_end',
                    turnId:
                        'turn-request-auth-source-cutover',
                });
            await vi.waitFor(() => {
                expect(
                    requestConnectedServiceSessionRestartSignalMock,
                ).toHaveBeenCalledOnce();
            });
            expect(
                requestConnectedServiceSessionRestartSignalMock,
            ).toHaveBeenCalledWith(expect.objectContaining({
                pid: cutoverTracked.pid,
                delayMs: 0,
            }));
            await expect(Promise.race([
                Promise.resolve(terminalCutover)
                    .then(() => 'settled' as const),
                new Promise<'pending'>((resolve) => {
                    setImmediate(() => resolve('pending'));
                }),
            ])).resolves.toBe('pending');

            const replacementCutoverTracked: TrackedSession = {
                ...cutoverTracked,
                pid: 47,
                processStartTimeMs: 7_000,
                spawnOptions: {
                    ...cutoverTracked.spawnOptions!,
                    environmentVariables: {
                        [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                            resolveConnectedAccountRequestAuthCapabilityPath(
                                resolveConnectedServiceMaterializedRootDir({
                                    baseDir:
                                        materializationBaseDir,
                                    agentId: 'opencode',
                                    materializationKey:
                                        'csm_request_auth_source_cutover',
                                }),
                            ),
                    },
                },
            };
            delete replacementCutoverTracked.activeTurnId;
            delete replacementCutoverTracked
                .reattachedInterruptedTurnId;
            pidToTrackedSession.delete(cutoverTracked.pid);
            pidToTrackedSession.set(
                replacementCutoverTracked.pid,
                replacementCutoverTracked,
            );
            respawnOwnerInputs.at(-1)?.onRespawnSuccess?.({
                sessionId:
                    'session-request-auth-source-cutover',
                previousPid: cutoverTracked.pid,
                result: {
                    type: 'success',
                    sessionId:
                        'session-request-auth-source-cutover',
                },
            });
            await expect(terminalCutover).resolves.toEqual({
                status: 'continue',
                turnCustody: {
                    status: 'recorded',
                    activeTurnId: null,
                },
            });

            await expect(
                controlInput?.handleConnectedServiceTurnLifecycle?.({
                    sessionId:
                        'session-request-auth-idle-prompt-cutover',
                    event: 'task_started',
                    turnId:
                        'turn-stale-before-idle-witness',
                }),
            ).resolves.toEqual({
                status: 'continue',
                turnCustody: {
                    status: 'recorded',
                    activeTurnId:
                        'turn-stale-before-idle-witness',
                },
            });
            const idlePromptCutover =
                controlInput?.handleConnectedServiceTurnLifecycle?.({
                    sessionId:
                        'session-request-auth-idle-prompt-cutover',
                    event: 'prompt_or_steer',
                    requestedAction: {
                        v: 1,
                        kind: 'enqueue',
                    },
                    activeTurnId: null,
                });
            await vi.waitFor(() => {
                expect(
                    requestConnectedServiceSessionRestartSignalMock,
                ).toHaveBeenCalledTimes(2);
            });
            const idlePromptSignalRequest =
                requestConnectedServiceSessionRestartSignalMock
                    .mock.calls.at(-1)?.[0];
            expect(idlePromptSignalRequest).toBeDefined();
            expect(
                await idlePromptSignalRequest?.shouldSignal?.(),
            ).toBe(true);
            await expect(Promise.race([
                Promise.resolve(idlePromptCutover)
                    .then(() => 'settled' as const),
                new Promise<'pending'>((resolve) => {
                    setImmediate(() => resolve('pending'));
                }),
            ])).resolves.toBe('pending');

            const replacementIdlePromptTracked: TrackedSession = {
                ...idlePromptCutoverTracked,
                pid: 49,
                processStartTimeMs: 9_000,
                spawnOptions: {
                    ...idlePromptCutoverTracked.spawnOptions!,
                    environmentVariables: {
                        [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                            resolveConnectedAccountRequestAuthCapabilityPath(
                                resolveConnectedServiceMaterializedRootDir({
                                    baseDir:
                                        materializationBaseDir,
                                    agentId: 'opencode',
                                    materializationKey:
                                        'csm_request_auth_idle_prompt_cutover',
                                }),
                            ),
                    },
                },
            };
            delete replacementIdlePromptTracked.activeTurnId;
            delete replacementIdlePromptTracked
                .reattachedInterruptedTurnId;
            pidToTrackedSession.delete(
                idlePromptCutoverTracked.pid,
            );
            pidToTrackedSession.set(
                replacementIdlePromptTracked.pid,
                replacementIdlePromptTracked,
            );
            respawnOwnerInputs.at(-1)?.onRespawnSuccess?.({
                sessionId:
                    'session-request-auth-idle-prompt-cutover',
                previousPid:
                    idlePromptCutoverTracked.pid,
                result: {
                    type: 'success',
                    sessionId:
                        'session-request-auth-idle-prompt-cutover',
                },
            });
            await expect(idlePromptCutover).resolves.toEqual({
                status: 'input_blocked',
                reason: 'request_auth_source_cutover',
            });

            for (const blockedTracked of [
                windowsCutoverTracked,
                coldResumeCutoverTracked,
            ]) {
                await expect(
                    controlInput
                        ?.handleConnectedServiceTurnLifecycle?.({
                            sessionId:
                                blockedTracked.happySessionId!,
                            event: 'prompt_or_steer',
                            requestedAction: {
                                v: 1,
                                kind: 'enqueue',
                            },
                            activeTurnId: null,
                        }),
                ).resolves.toEqual({
                    status: 'input_blocked',
                    reason:
                        'request_auth_source_cutover',
                });
            }
            expect(
                requestConnectedServiceSessionRestartSignalMock,
            ).toHaveBeenCalledTimes(2);
            expect(
                windowsCutoverTracked.spawnOptions
                    ?.windowsRemoteSessionLaunchMode,
            ).toBe('windows_terminal');

            const failedRespawnCutover =
                controlInput
                    ?.handleConnectedServiceTurnLifecycle?.({
                        sessionId:
                            failedRespawnCutoverTracked
                                .happySessionId!,
                        event: 'prompt_or_steer',
                        requestedAction: {
                            v: 1,
                            kind: 'enqueue',
                        },
                        activeTurnId: null,
                    });
            await vi.waitFor(() => {
                expect(
                    requestConnectedServiceSessionRestartSignalMock,
                ).toHaveBeenCalledTimes(3);
            });
            respawnOwnerInputs.at(-1)?.onRespawnSuccess?.({
                sessionId:
                    failedRespawnCutoverTracked.happySessionId!,
                previousPid:
                    failedRespawnCutoverTracked.pid,
                result: {
                    type: 'success',
                    sessionId:
                        failedRespawnCutoverTracked
                            .happySessionId!,
                },
            });
            await expect(failedRespawnCutover).resolves.toEqual({
                status: 'input_blocked',
                reason: 'request_auth_source_cutover',
            });

            const failedRespawnRetry =
                controlInput
                    ?.handleConnectedServiceTurnLifecycle?.({
                        sessionId:
                            failedRespawnCutoverTracked
                                .happySessionId!,
                        event: 'prompt_or_steer',
                        requestedAction: {
                            v: 1,
                            kind: 'enqueue',
                        },
                        activeTurnId: null,
                    });
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });
            expect(
                requestConnectedServiceSessionRestartSignalMock,
            ).toHaveBeenCalledTimes(3);

            requestConnectedServiceSessionRestartSignalMock
                .mockImplementationOnce(async (input) => {
                    racingTurnCutoverTracked.activeTurnId =
                        'turn-started-during-final-signal-gate';
                    const shouldSignal =
                        await input.shouldSignal?.();
                    return shouldSignal === false
                        ? { status: 'skipped_stale_owner' as const }
                        : { status: 'requested' as const };
                });
            await expect(
                controlInput
                    ?.handleConnectedServiceTurnLifecycle?.({
                        sessionId:
                            racingTurnCutoverTracked
                                .happySessionId!,
                        event: 'assistant_message_end',
                        turnId:
                            'turn-request-auth-racing-turn-cutover',
                    }),
            ).resolves.toEqual({
                status: 'continue',
                turnCustody: {
                    status: 'recorded',
                    activeTurnId: null,
                },
            });
            expect(
                requestConnectedServiceSessionRestartSignalMock,
            ).toHaveBeenCalledTimes(4);
            expect(
                pidToTrackedSession.get(
                    racingTurnCutoverTracked.pid,
                ),
            ).toBe(racingTurnCutoverTracked);

            await expect(
                controlInput
                    ?.handleConnectedServiceTurnLifecycle?.({
                        sessionId:
                            racingTurnCutoverTracked
                                .happySessionId!,
                        event: 'assistant_message_end',
                        turnId:
                            'turn-request-auth-racing-turn-cutover',
                    }),
            ).resolves.toEqual({
                status: 'continue',
                turnCustody: {
                    status: 'ignored_turn_mismatch',
                    activeTurnId:
                        'turn-started-during-final-signal-gate',
                },
            });
            expect(
                requestConnectedServiceSessionRestartSignalMock,
            ).toHaveBeenCalledTimes(4);

            const racingTurnTerminal =
                controlInput
                    ?.handleConnectedServiceTurnLifecycle?.({
                        sessionId:
                            racingTurnCutoverTracked
                                .happySessionId!,
                        event: 'assistant_message_end',
                        turnId:
                            'turn-started-during-final-signal-gate',
                    });
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });
            expect(
                requestConnectedServiceSessionRestartSignalMock,
            ).toHaveBeenCalledTimes(5);
            const racingTurnSuccessor: TrackedSession = {
                ...racingTurnCutoverTracked,
                pid: 57,
                processStartTimeMs: 17_000,
                spawnOptions: {
                    ...racingTurnCutoverTracked.spawnOptions!,
                    environmentVariables: {
                        [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                            resolveConnectedAccountRequestAuthCapabilityPath(
                                resolveConnectedServiceMaterializedRootDir({
                                    baseDir:
                                        materializationBaseDir,
                                    agentId: 'opencode',
                                    materializationKey:
                                        'csm_request_auth_racing_turn_cutover',
                                }),
                            ),
                    },
                },
            };
            delete racingTurnSuccessor.activeTurnId;
            delete racingTurnSuccessor
                .reattachedInterruptedTurnId;
            pidToTrackedSession.delete(
                racingTurnCutoverTracked.pid,
            );
            pidToTrackedSession.set(
                racingTurnSuccessor.pid,
                racingTurnSuccessor,
            );
            respawnOwnerInputs.at(-1)?.onRespawnSuccess?.({
                sessionId:
                    racingTurnCutoverTracked.happySessionId!,
                previousPid:
                    racingTurnCutoverTracked.pid,
                result: {
                    type: 'success',
                    sessionId:
                        racingTurnCutoverTracked.happySessionId!,
                },
            });
            await expect(racingTurnTerminal).resolves.toEqual({
                status: 'continue',
                turnCustody: {
                    status: 'recorded',
                    activeTurnId: null,
                },
            });
            expect(
                racingTurnSuccessor.happySessionId,
            ).toBe(
                racingTurnCutoverTracked.happySessionId,
            );
            expect(
                racingTurnSuccessor.spawnOptions?.resume,
            ).toBe('remote-predecessor-resume-id');
            expect(executeSpawnSessionRequest)
                .not.toHaveBeenCalled();
            await expect(failedRespawnRetry).resolves.toEqual({
                status: 'input_blocked',
                reason: 'request_auth_source_cutover',
            });
            await expect(
                controlInput
                    ?.handleConnectedServiceTurnLifecycle?.({
                        sessionId:
                            failedRespawnCutoverTracked
                                .happySessionId!,
                        event: 'prompt_or_steer',
                        requestedAction: {
                            v: 1,
                            kind: 'enqueue',
                        },
                        activeTurnId: null,
                    }),
            ).resolves.toEqual({
                status: 'input_blocked',
                reason: 'request_auth_source_cutover',
            });
            expect(
                requestConnectedServiceSessionRestartSignalMock,
            ).toHaveBeenCalledTimes(5);

            pidToTrackedSession.delete(
                failedRespawnCutoverTracked.pid,
            );
            const failedRespawnSuccessor: TrackedSession = {
                ...failedRespawnCutoverTracked,
                pid: 53,
                processStartTimeMs: 13_000,
                spawnOptions: {
                    ...failedRespawnCutoverTracked
                        .spawnOptions!,
                    environmentVariables: {
                        [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                            resolveConnectedAccountRequestAuthCapabilityPath(
                                resolveConnectedServiceMaterializedRootDir({
                                    baseDir:
                                        materializationBaseDir,
                                    agentId: 'opencode',
                                    materializationKey:
                                        'csm_request_auth_failed_respawn_cutover',
                                }),
                            ),
                    },
                },
            };
            delete failedRespawnSuccessor.activeTurnId;
            delete failedRespawnSuccessor
                .reattachedInterruptedTurnId;
            pidToTrackedSession.set(
                failedRespawnSuccessor.pid,
                failedRespawnSuccessor,
            );
            await expect(
                controlInput
                    ?.handleConnectedServiceTurnLifecycle?.({
                        sessionId:
                            failedRespawnSuccessor
                                .happySessionId!,
                        event: 'prompt_or_steer',
                        requestedAction: {
                            v: 1,
                            kind: 'enqueue',
                        },
                        activeTurnId: null,
                    }),
            ).resolves.toEqual({
                status: 'continue',
                turnCustody: {
                    status:
                        'ignored_missing_exact_turn',
                    activeTurnId: null,
                },
            });
            expect(
                requestConnectedServiceSessionRestartSignalMock,
            ).toHaveBeenCalledTimes(5);

            const replacementDocument =
                await readConnectedAccountRequestAuthCapabilityFile(
                    oldDescriptor.path,
                );
            const replacementPiDocument =
                await readConnectedAccountRequestAuthCapabilityFile(
                    oldPiDescriptor.path,
                );
            expect(oldDescriptor.path).toBe(
                resolveConnectedAccountRequestAuthCapabilityPath(
                    materializedRootDir,
                ),
            );
            expect(replacementDocument?.capability)
                .not.toBe(oldCapability);
            expect(oldPiDescriptor.path).toBe(piCapabilityPath);
            expect(replacementPiDocument?.capability)
                .not.toBe(oldPiCapability);
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(oldCapability)).toBeNull();
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(oldPiCapability)).toBeNull();
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
            // Recovering an authority whose subject scope no longer equals the
            // one the running child was launched under must refuse instead of
            // committing credentials across the changed scope.
            expect(
                await readConnectedAccountRequestAuthCapabilityFile(
                    scopeChangedDescriptor.path,
                ),
            ).toBeNull();
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(
                    scopeChangedOldCapability,
                )).toBeNull();
            expect(
                sessionAttachCleanupByPid.get(
                    scopeChangedTracked.pid,
                ),
            ).toBe(scopeChangedPreviousAttachCleanup);
            expect(disposePurposeLease).toHaveBeenCalledWith(
                'session-request-auth-scope-changed',
            );
            const replacementPrincipal =
                controlInput?.connectedAccountRequestAuth
                    ?.authenticate(
                        replacementDocument?.capability,
                    );
            expect(replacementPrincipal).toMatchObject({
                subjectId:
                    'agent-session:session-request-auth-reattach',
                legacyServiceKeyedCompatibility: true,
            });
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(
                    replacementPiDocument?.capability,
                )).toMatchObject({
                subjectId:
                    'agent-session:session-pi-request-auth-reattach',
                legacyServiceKeyedCompatibility: true,
            });
            expect(getConnectedServiceCredentialPlain)
                .not.toHaveBeenCalled();
            const profileFetchesBeforeLookup =
                fetchAccountProfile.mock.calls.length;
            const replacementRequestAuthLease =
                await controlInput?.connectedAccountRequestAuth
                    ?.lookupRequestAuth({
                        subject: replacementPrincipal!,
                        purpose,
                    });
            expect(replacementRequestAuthLease).toMatchObject({
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
            expect(replacementRequestAuthLease)
                .not.toHaveProperty('legacyServiceKeyedCompatibility');
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
            ).toHaveBeenCalledWith({
                sessionId:
                    'session-pi-request-auth-reattach',
                purposes: [piPurpose],
                bindings: [piBinding],
            });
            expect(
                activateSessionPurposeBindings,
            ).toHaveBeenCalledTimes(5);
            expect(readProcessIdentityByPidFn)
                .toHaveBeenCalledTimes(5);
            // Every reattached record carries a process birth, so exact process generation is the
            // safety linearization point and the command-classification lookup must stay unused.
            expect(findHappyProcessByPidFn).not.toHaveBeenCalled();
            expect(readProcessIdentityByPidFn)
                .toHaveBeenCalledWith(tracked.pid);
            expect(readProcessIdentityByPidFn)
                .toHaveBeenCalledWith(reusedInitialPid);
            expect(readProcessIdentityByPidFn)
                .toHaveBeenCalledWith(piTracked.pid);
            expect(readProcessIdentityByPidFn)
                .toHaveBeenCalledWith(
                    changedIdentityTracked.pid,
                );
            expect(readProcessIdentityByPidFn)
                .toHaveBeenCalledWith(scopeChangedTracked.pid);
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
            expect(pidToTrackedSession.get(piTracked.pid))
                .toBe(piTracked);
            expect(piTracked.pid).toBe(54);
            expect(piTracked.processStartTimeMs).toBe(15_000);
            expect(executeSpawnSessionRequest)
                .not.toHaveBeenCalled();

            const replacementCleanup =
                sessionAttachCleanupByPid.get(tracked.pid);
            const piReplacementCleanup =
                sessionAttachCleanupByPid.get(piTracked.pid);
            expect(replacementCleanup)
                .not.toBe(previousAttachCleanup);
            expect(piReplacementCleanup)
                .not.toBe(piPreviousAttachCleanup);
            expect(sessionAttachCleanupByPid.size).toBe(5);
            await replacementCleanup?.();
            await replacementCleanup?.();
            await piReplacementCleanup?.();
            await piReplacementCleanup?.();
            expect(previousAttachCleanup).toHaveBeenCalledOnce();
            expect(piPreviousAttachCleanup).toHaveBeenCalledOnce();
            expect(disposePurposeLease).toHaveBeenCalledTimes(5);
            expect(disposePurposeLease).toHaveBeenCalledWith(
                'session-request-auth-reattach',
            );
            expect(disposePurposeLease).toHaveBeenCalledWith(
                'session-pi-request-auth-reattach',
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
            expect(controlInput?.connectedAccountRequestAuth
                ?.authenticate(
                    replacementPiDocument?.capability,
                )).toBeNull();
            expect(pidToTrackedSession.get(tracked.pid))
                .toBe(tracked);

            await controlInput?.beforeShutdown?.();
            expect(beforeShutdown).toHaveBeenCalledOnce();
            await runtime.stopControlServer();
        } finally {
            plannedRestartPidSafetySpy?.mockRestore();
            respawnOwnerSpy.mockRestore();
            fetchAccountProfile.mockRestore();
            await rm(materializationBaseDir, {
                recursive: true,
                force: true,
            });
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
                        legacyServiceKeyedCompatibility: true,
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
                    signal: new AbortController().signal,
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

    it('routes a manifest-qualified external group through the qualified 401 and quota recovery owner', async () => {
        const binding = {
            purpose: {
                consumer: {
                    pluginId: 'acme.agent',
                    localId: 'external-agent',
                },
                purpose: 'upstream-request',
            },
            target: {
                kind: 'group' as const,
                service: {
                    pluginId: 'acme.connected-accounts',
                    localId: 'subscription',
                },
                groupId: 'fallbacks',
            },
        };
        const primary = {
            account: {
                service: binding.target.service,
                accountId: 'external-primary',
            },
            group: {
                groupId: 'fallbacks',
                generation: 7,
            },
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        } as const;
        const firstRecoverySuccessor = {
            account: {
                service: binding.target.service,
                accountId: 'external-backup',
            },
            group: {
                groupId: 'fallbacks',
                generation: 8,
            },
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        } as const;
        const quotaRecoverySuccessor = {
            account: {
                service: binding.target.service,
                accountId: 'external-tertiary',
            },
            group: {
                groupId: 'fallbacks',
                generation: 9,
            },
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        } as const;
        let current:
            | typeof primary
            | typeof firstRecoverySuccessor
            | typeof quotaRecoverySuccessor = primary;
        const use = {
            purpose: binding.purpose,
            materialization: {
                kind: 'httpHeaders' as const,
                origin: 'https://api.example.test',
                headerNames: ['authorization'],
            },
        };
        const resolveCurrentRequestAuthBinding = vi.fn(async () => ({
            ...current,
            legacyServiceKeyedCompatibility: true as const,
        }));
        const materializeRequestAuthBearer = vi.fn<
            ConnectedAccountPurposeBindingOwner['materializeRequestAuthBearer']
        >(async ({ resolved }) => ({ accessToken: `qualified-${resolved.account.accountId}` }));
        const refreshConnectedServiceCredentialForQuota = vi.fn();
        const refreshQualifiedConnectedAccountCredentialForRequestAuth = vi.fn(
            async () => false,
        );
        qualifiedRequestAuthSwitchAfterClassifiedFailureMock
            .mockImplementationOnce(async () => {
                current = firstRecoverySuccessor;
                return { status: 'switched' };
            })
            .mockImplementationOnce(async () => {
                current = quotaRecoverySuccessor;
                return { status: 'switched' };
            });
        const fetchAccountProfile = vi.spyOn(axios, 'get').mockResolvedValue({
            status: 200,
            data: { id: 'external-request-auth-account' },
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
            getConnectedServiceRefreshCoordinator: () => ({
                refreshConnectedServiceCredentialForQuota,
                refreshQualifiedConnectedAccountCredentialForRequestAuth,
            }) as never,
            getConnectedServiceQuotasCoordinator: () => null,
            resolveQualifiedConnectedAccountV4Support: () => 'advertised',
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
            resolveCurrentRequestAuthBinding,
            materializeRequestAuthBearer,
        });

        try {
            const dependencies = connectedAccountRequestAuthServiceDependenciesCapture.current;
            if (!dependencies) throw new Error('Expected request-auth broker dependencies');
            const externalSubject = {
                subjectId: 'agent-session:external',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: (candidate) => (
                    JSON.stringify(candidate) === JSON.stringify(binding.purpose)
                        ? { binding, use }
                        : null
                ),
                listPurposeUses: () => [{ binding, use }],
            } satisfies ConnectedAccountRequestAuthSubject;
            await expect(dependencies.resolveCurrentBinding({
                subject: externalSubject,
                binding,
                signal: new AbortController().signal,
            })).resolves.toEqual(primary);
            expect(resolveCurrentRequestAuthBinding).toHaveBeenCalledWith(
                expect.objectContaining({
                    subjectId: 'agent-session:external',
                    binding,
                }),
            );
            const controlInput = vi
                .mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0];
            const requestAuth = controlInput?.connectedAccountRequestAuth;
            if (!requestAuth) {
                throw new Error('Expected request-auth control service');
            }
            const publicLease = await requestAuth.lookupRequestAuth({
                subject: externalSubject,
                purpose: binding.purpose,
            });
            expect(publicLease).toMatchObject({
                accessToken: 'qualified-external-primary',
                credentialContext: primary,
            });
            expect(publicLease).not.toHaveProperty(
                'legacyServiceKeyedCompatibility',
            );
            expect(publicLease.credentialContext).not.toHaveProperty(
                'legacyServiceKeyedCompatibility',
            );
            expect(materializeRequestAuthBearer).toHaveBeenCalledWith(
                expect.objectContaining({ binding }),
            );
            expect(
                materializeRequestAuthBearer.mock.calls.at(-1)?.[0]?.resolved,
            ).toEqual(primary);
            await expect(requestAuth.refreshAfterAuthFailure({
                subject: externalSubject,
                request: {
                    credentialContext: publicLease.credentialContext,
                    normalizedFailure: {
                        class: 'authentication',
                        evidence: {
                            httpStatus: 401,
                            limitCategory: 'auth_invalid',
                            quotaScope: 'unknown',
                            evidenceSource: { kind: 'structured' },
                        },
                    },
                },
            })).resolves.toEqual({ status: 'stale_context' });
            const quotaLease = await requestAuth.lookupRequestAuth({
                subject: externalSubject,
                purpose: binding.purpose,
            });
            expect(quotaLease).toMatchObject({
                accessToken: 'qualified-external-backup',
                credentialContext: firstRecoverySuccessor,
            });
            await expect(requestAuth.reportQuotaFailure({
                subject: externalSubject,
                request: {
                    credentialContext: quotaLease.credentialContext,
                    normalizedFailure: {
                        class: 'quota',
                        evidence: {
                            httpStatus: 429,
                            limitCategory: 'usage_limit',
                            quotaScope: 'account',
                            evidenceSource: { kind: 'structured' },
                        },
                    },
                },
            })).resolves.toEqual({ status: 'stale_context' });
            expect(qualifiedRequestAuthSwitchAfterClassifiedFailureMock)
                .toHaveBeenCalledTimes(2);
            for (const callIndex of [1, 2] as const) {
                expect(qualifiedRequestAuthSwitchAfterClassifiedFailureMock)
                    .toHaveBeenNthCalledWith(callIndex, expect.objectContaining({
                        serviceId: binding.target.service,
                        groupId: 'fallbacks',
                    }));
            }
            expect(refreshConnectedServiceCredentialForQuota).not.toHaveBeenCalled();
            expect(refreshQualifiedConnectedAccountCredentialForRequestAuth)
                .toHaveBeenCalledWith({
                    account: primary.account,
                    expectedCredentialRevision: primary.credentialRevision,
                });
            expect(requestAuthSwitchAfterClassifiedFailureMock).not.toHaveBeenCalled();
            expect(fetchAccountProfile).not.toHaveBeenCalled();
        } finally {
            fetchAccountProfile.mockRestore();
            await runtime.stopControlServer();
        }
    });

    it('keeps a genuine qualified currentness change replayable but rejects an operational resolver failure', async () => {
        const binding = {
            purpose: {
                consumer: {
                    pluginId: 'acme.agent',
                    localId: 'external-agent',
                },
                purpose: 'upstream-request',
            },
            target: {
                kind: 'account' as const,
                account: {
                    service: {
                        pluginId: 'acme.connected-accounts',
                        localId: 'subscription',
                    },
                    accountId: 'external-primary',
                },
            },
        };
        const initial = {
            account: binding.target.account,
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        } as const;
        const replaced = {
            account: binding.target.account,
            credentialRevision: 'csr_123456789ABCDEFGHJKMNPQRS',
        } as const;
        let current: typeof initial | typeof replaced = initial;
        let resolverOperational = true;
        const resolveCurrentRequestAuthBinding = vi.fn(async () => {
            if (!resolverOperational) {
                throw new Error('temporary request-auth currentness resolver outage');
            }
            return current;
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
            resolveQualifiedConnectedAccountV4Support: () => 'advertised',
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
            resolveCurrentRequestAuthBinding,
            materializeRequestAuthBearer: vi.fn(async () => ({
                accessToken: 'qualified-primary',
            })),
        });

        try {
            const controlInput = vi
                .mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0];
            const requestAuth = controlInput?.connectedAccountRequestAuth;
            if (!requestAuth) throw new Error('Expected request-auth control service');
            const use = {
                purpose: binding.purpose,
                materialization: {
                    kind: 'httpHeaders' as const,
                    origin: 'https://api.example.test',
                    headerNames: ['authorization'],
                },
            };
            const subject = {
                subjectId: 'agent-session:external-resolver-currentness',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: (candidate) => (
                    JSON.stringify(candidate) === JSON.stringify(binding.purpose)
                        ? { binding, use }
                        : null
                ),
                listPurposeUses: () => [{ binding, use }],
            } satisfies ConnectedAccountRequestAuthSubject;
            const lease = await requestAuth.lookupRequestAuth({
                subject,
                purpose: binding.purpose,
            });
            const request = {
                credentialContext: lease.credentialContext,
                normalizedFailure: {
                    class: 'authentication' as const,
                    evidence: {
                        httpStatus: 401,
                        limitCategory: 'auth_invalid' as const,
                        quotaScope: 'unknown' as const,
                        evidenceSource: { kind: 'structured' as const },
                    },
                },
            };

            current = replaced;
            await expect(requestAuth.refreshAfterAuthFailure({ subject, request }))
                .resolves.toEqual({ status: 'stale_context' });

            current = initial;
            resolverOperational = false;
            await expect(requestAuth.refreshAfterAuthFailure({ subject, request }))
                .rejects.toMatchObject({ code: 'request_auth_binding_unavailable' });
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('refreshes a novel manifest-qualified direct account at its exact credential revision after a 401', async () => {
        const binding = {
            purpose: {
                consumer: {
                    pluginId: 'acme.agent',
                    localId: 'external-agent',
                },
                purpose: 'upstream-request',
            },
            target: {
                kind: 'account' as const,
                account: {
                    service: {
                        pluginId: 'acme.connected-accounts',
                        localId: 'subscription',
                    },
                    accountId: 'external-primary',
                },
            },
        };
        const initial = {
            account: binding.target.account,
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        } as const;
        const refreshed = {
            account: binding.target.account,
            credentialRevision: 'csr_123456789ABCDEFGHJKMNPQRS',
        } as const;
        let current: typeof initial | typeof refreshed = initial;
        const refreshQualifiedConnectedAccountCredentialForRequestAuth = vi.fn(
            async (input: Readonly<{
                account: typeof binding.target.account;
                expectedCredentialRevision: string;
            }>) => {
                expect(input).toEqual({
                    account: initial.account,
                    expectedCredentialRevision: initial.credentialRevision,
                });
                current = refreshed;
                return true;
            },
        );
        const resolveCurrentRequestAuthBinding = vi.fn(async () => current);
        const materializeRequestAuthBearer = vi.fn<
            ConnectedAccountPurposeBindingOwner['materializeRequestAuthBearer']
        >(async ({ resolved }) => ({
            accessToken: `qualified-${resolved.credentialRevision}`,
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
                refreshQualifiedConnectedAccountCredentialForRequestAuth,
            }) as never,
            getConnectedServiceQuotasCoordinator: () => null,
            resolveQualifiedConnectedAccountV4Support: () => 'advertised',
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
            resolveCurrentRequestAuthBinding,
            materializeRequestAuthBearer,
        });

        try {
            const controlInput = vi
                .mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0];
            const requestAuth = controlInput?.connectedAccountRequestAuth;
            if (!requestAuth) throw new Error('Expected request-auth control service');
            const use = {
                purpose: binding.purpose,
                materialization: {
                    kind: 'httpHeaders' as const,
                    origin: 'https://api.example.test',
                    headerNames: ['authorization'],
                },
            };
            const subject = {
                subjectId: 'agent-session:external-direct-refresh',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: (candidate) => (
                    JSON.stringify(candidate) === JSON.stringify(binding.purpose)
                        ? { binding, use }
                        : null
                ),
                listPurposeUses: () => [{ binding, use }],
            } satisfies ConnectedAccountRequestAuthSubject;
            const initialLease = await requestAuth.lookupRequestAuth({
                subject,
                purpose: binding.purpose,
            });
            expect(initialLease.credentialContext).toMatchObject(initial);

            await expect(requestAuth.refreshAfterAuthFailure({
                subject,
                request: {
                    credentialContext: initialLease.credentialContext,
                    normalizedFailure: {
                        class: 'authentication',
                        evidence: {
                            httpStatus: 401,
                            limitCategory: 'auth_invalid',
                            quotaScope: 'unknown',
                            evidenceSource: { kind: 'structured' },
                        },
                    },
                },
            })).resolves.toEqual({ status: 'stale_context' });
            expect(refreshQualifiedConnectedAccountCredentialForRequestAuth)
                .toHaveBeenCalledOnce();
            expect(qualifiedRequestAuthSwitchAfterClassifiedFailureMock)
                .not.toHaveBeenCalled();
            expect(requestAuthSwitchAfterClassifiedFailureMock)
                .not.toHaveBeenCalled();

            await expect(requestAuth.lookupRequestAuth({
                subject,
                purpose: binding.purpose,
            })).resolves.toMatchObject({
                accessToken: `qualified-${refreshed.credentialRevision}`,
                credentialContext: refreshed,
            });
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('records a provider-scoped rate limit for a novel manifest-qualified direct account without switching it', async () => {
        const binding = {
            purpose: {
                consumer: {
                    pluginId: 'acme.agent',
                    localId: 'external-agent',
                },
                purpose: 'upstream-request',
            },
            target: {
                kind: 'account' as const,
                account: {
                    service: {
                        pluginId: 'acme.connected-accounts',
                        localId: 'subscription',
                    },
                    accountId: 'external-primary',
                },
            },
        };
        const resolved = {
            account: binding.target.account,
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        } as const;
        const recordQualifiedRequestAuthProviderBackoff = vi.fn(() => ({
            status: 'recorded' as const,
            consecutiveFailures: 1,
            nextAllowedAtMs: 10_500,
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
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => ({
                recordQualifiedRequestAuthProviderBackoff,
            }) as never,
            resolveQualifiedConnectedAccountV4Support: () => 'advertised',
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
            resolveCurrentRequestAuthBinding: vi.fn(async () => resolved),
            materializeRequestAuthBearer: vi.fn(async () => ({
                accessToken: 'qualified-primary',
            })),
        });

        try {
            const controlInput = vi
                .mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0];
            const requestAuth = controlInput?.connectedAccountRequestAuth;
            if (!requestAuth) throw new Error('Expected request-auth control service');
            const use = {
                purpose: binding.purpose,
                materialization: {
                    kind: 'httpHeaders' as const,
                    origin: 'https://api.example.test',
                    headerNames: ['authorization'],
                },
            };
            const subject = {
                subjectId: 'agent-session:external-direct-backoff',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: (candidate) => (
                    JSON.stringify(candidate) === JSON.stringify(binding.purpose)
                        ? { binding, use }
                        : null
                ),
                listPurposeUses: () => [{ binding, use }],
            } satisfies ConnectedAccountRequestAuthSubject;
            const lease = await requestAuth.lookupRequestAuth({
                subject,
                purpose: binding.purpose,
            });

            await expect(requestAuth.reportQuotaFailure({
                subject,
                request: {
                    credentialContext: lease.credentialContext,
                    normalizedFailure: {
                        class: 'quota',
                        evidence: {
                            httpStatus: 429,
                            retryAfterMs: 500,
                            limitCategory: 'rate_limit',
                            quotaScope: 'provider',
                            evidenceSource: { kind: 'structured' },
                        },
                    },
                },
            })).resolves.toEqual({ status: 'current_unchanged' });
            expect(recordQualifiedRequestAuthProviderBackoff).toHaveBeenCalledWith({
                account: resolved.account,
                groupId: null,
                groupGeneration: null,
                limitCategory: 'rate_limit',
                quotaScope: 'provider',
                retryAfterMs: 500,
                resetAtMs: null,
                providerCode: null,
            });
            expect(qualifiedRequestAuthSwitchAfterClassifiedFailureMock)
                .not.toHaveBeenCalled();
            expect(requestAuthSwitchAfterClassifiedFailureMock)
                .not.toHaveBeenCalled();
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
                        legacyServiceKeyedCompatibility: true,
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
                    signal: new AbortController().signal,
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

    it('routes a legacy-classified runtime failure through the qualified V4 group owner when V4 is advertised', async () => {
        // This dispatch assertion deliberately has no persisted session context: the
        // coordinator choice is made from the classified runtime failure and V4 support,
        // not from an Agent catalog lookup.
        fetchSessionByIdCompatMock.mockResolvedValue(null);
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: {
                    type: 'legacy',
                    secret: new Uint8Array(32).fill(1),
                },
            },
            api: {
                getConnectedServiceAuthGroup: vi.fn(async () => null),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir:
                '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            resolveQualifiedConnectedAccountV4Support: () =>
                'advertised',
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
            createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock
                .mockClear();
            createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinatorMock
                .mockClear();
            qualifiedRequestAuthSwitchAfterClassifiedFailureMock.mockClear();
            handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();

            const controlServerInput = vi.mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0];
            await controlServerInput?.handleConnectedServiceRuntimeAuthFailure?.({
                sessionId: 'sess-qualified-runtime-recovery',
                switchesThisTurn: 0,
                classification: {
                    kind: 'usage_limit',
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'fallbacks',
                    resetsAtMs: null,
                    planType: null,
                    rateLimits: null,
                    source: 'structured_provider_error',
                },
            });

            expect(
                createDaemonConnectedServiceAuthGroupSwitchCoordinatorMock,
            ).not.toHaveBeenCalled();
            expect(
                createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinatorMock,
            ).toHaveBeenCalledOnce();
            const qualifiedCoordinator =
                createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinatorMock
                    .mock.results.at(-1)?.value;
            const runtimeHandlerInput =
                handleConnectedServiceRuntimeAuthFailureForSessionMock
                    .mock.calls.at(-1)?.[0] as {
                        switchCoordinator?: {
                            switchAfterClassifiedFailure(input: Readonly<{
                                serviceId: string;
                                groupId: string;
                                observedProfileId: string;
                                reason: string;
                                switchesThisTurn: number;
                            }>): Promise<unknown>;
                        } | null;
                    } | undefined;
            expect(runtimeHandlerInput?.switchCoordinator).toBeDefined();
            expect(runtimeHandlerInput?.switchCoordinator).not.toBe(
                qualifiedCoordinator,
            );
            await runtimeHandlerInput?.switchCoordinator
                ?.switchAfterClassifiedFailure({
                    serviceId: 'openai-codex',
                    groupId: 'fallbacks',
                    observedProfileId: 'primary',
                    reason: 'usage_limit',
                    switchesThisTurn: 0,
                });
            expect(
                qualifiedRequestAuthSwitchAfterClassifiedFailureMock,
            ).toHaveBeenLastCalledWith(expect.objectContaining({
                serviceId: {
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                },
                groupId: 'fallbacks',
                observedProfileId: 'primary',
            }));
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
                    legacyServiceKeyedCompatibility: true,
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
                signal: new AbortController().signal,
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
        createCliActionExecutorFromCredentialsMock.mockClear();
        createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorMock.mockClear();
        handleConnectedServiceRuntimeAuthFailureForSessionMock.mockClear();
        dispatchActivityNotificationAsyncMock.mockClear();
        fetchSessionByIdMock.mockReset();
        fetchSessionByIdMock.mockImplementation(async () => ({
            id: 'sess-runtime',
            encryptionMode: 'plain',
        }));
        fetchAccountEncryptionCurrentnessMock.mockReset();
        fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
            mode: 'plain',
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
        });
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
        pluginReloadListenersMock.clear();
        pluginRunningSessionDispositionListenersMock.clear();
        pluginReloadStateMock.activeRegistry = null;
        commitSessionStoredMessageMock.mockClear();
        requestConnectedServiceSessionRestartSignalMock.mockReset();
        requestConnectedServiceSessionRestartSignalMock.mockImplementation(async () => ({ status: 'requested' as const }));
        markSessionMarkerConnectedServiceRestartIntentMock.mockReset();
        markSessionMarkerConnectedServiceRestartIntentMock.mockImplementation(async () => true);
        clearSessionMarkerConnectedServiceRestartIntentMock.mockReset();
        clearSessionMarkerConnectedServiceRestartIntentMock.mockImplementation(async () => {});
        updateSessionMarkerAgentSessionStartupInstructionsMarkerMock.mockReset();
        updateSessionMarkerAgentSessionStartupInstructionsMarkerMock.mockImplementation(async () => true);
        updateSessionMarkerAgentRuntimeSessionOpenAttestationMock.mockReset();
        updateSessionMarkerAgentRuntimeSessionOpenAttestationMock.mockImplementation(async () => true);
        removeSessionMarkerMock.mockReset();
        removeSessionMarkerMock.mockImplementation(async () => {});
        removeSessionMarkerIfOwnedMock.mockReset();
        removeSessionMarkerIfOwnedMock.mockImplementation(async () => true);
        readSessionMarkerForPidMock.mockReset();
        readSessionMarkerForPidMock.mockImplementation(async () => null);
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

    it('resolves Composer attachments through the current daemon registry using the stable admission identity', async () => {
        const sessionId = 'session-composer-attachment-dispatch';
        const binding = createAgentSessionRunnerFactoryBinding({
            v: 1,
            pluginId: 'plugin.runner',
            pluginVersion: '1.0.0',
            agentId: 'claude',
            localAgentId: 'claude',
            immutableGenerationId: 'generation-composer-attachment',
            locator: {
                module: './runtime.mjs',
                export: 'createRuntime',
                runtimeApiVersion: 1,
            },
            normalizedModulePath: '/immutable/runtime.mjs',
            loadMode: 'immutable-js',
        });
        const runner = Object.freeze({
            pid: 23123,
            processStartTimeMs: 1,
            processCommandHash: 'a'.repeat(64),
            snapshotIdentity: 'snapshot:composer-attachment',
        });
        const resolveForDispatch = vi.fn(async () => ({
            attachments: [{
                instanceId: 'review-1',
                status: 'ready' as const,
                context: 'Current review context.',
                data: { refreshed: true },
            }],
        }));
        const afterMessageAccepted = vi.fn(async () => {});
        const release = vi.fn(async () => {});
        const enqueueSessionPendingByMachine = vi.fn(async (
            request: SessionPendingEnqueueByMachineRequestV1,
        ) => ({
            status: 'accepted' as const,
            localId: request.localId,
        }));
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
            registry: {
                composerAttachments: {
                    isDeclared: vi.fn(() => true),
                    requires: vi.fn(() => true),
                    supports: vi.fn(() => true),
                    resolveForDispatch,
                    afterMessageAccepted,
                },
            },
            source: 'active',
            release,
        });
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-composer-attachment',
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
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => ({
                enqueueSessionPendingByMachine,
                registerLocalServicesRoutes: vi.fn(),
                registerSimulatorPreviewRoutes: vi.fn(),
            } as never),
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        try {
            const dispatch = vi.mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0].agentRuntimeDaemonServices?.dispatch;
            const signal = new AbortController().signal;
            const machineAdmissionRequest = {
                v: 1 as const,
                sessionId,
                targetMachineId: 'machine-composer-attachment',
                localId: 'local-1',
                content: {
                    t: 'plain' as const,
                    v: {
                        role: 'user' as const,
                        content: { type: 'text' as const, text: 'hello' },
                    },
                },
                requestedAction: { v: 1 as const, kind: 'enqueue' as const },
            };
            const admissionResponse = await dispatch?.(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: { token: 'a'.repeat(43), sessionId },
                    operation: {
                        kind: 'session.input.admit',
                        requestId: 'admit-session-input',
                        request: machineAdmissionRequest,
                    },
                }),
                {
                    sessionId,
                    runner,
                    retainedAgent: binding,
                    invocationContext: {
                        cwd: '/workspace',
                        environment: {},
                        providerBindingActive: false,
                    },
                    signal,
                },
            );
            expect(admissionResponse).toEqual({
                ok: true,
                result: {
                    kind: 'session.input.admission',
                    status: 'resolved',
                    admission: { status: 'accepted', localId: 'local-1' },
                },
            });
            expect(enqueueSessionPendingByMachine).toHaveBeenCalledWith(
                machineAdmissionRequest,
                { signal },
            );
            const wrongTargetResponse = await dispatch?.(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: { token: 'a'.repeat(43), sessionId },
                    operation: {
                        kind: 'session.input.admit',
                        requestId: 'admit-session-input-wrong-target',
                        request: {
                            ...machineAdmissionRequest,
                            targetMachineId: 'machine-stale',
                        },
                    },
                }),
                {
                    sessionId,
                    runner,
                    retainedAgent: binding,
                    invocationContext: {
                        cwd: '/workspace',
                        environment: {},
                        providerBindingActive: false,
                    },
                    signal,
                },
            );
            expect(wrongTargetResponse).toEqual({
                ok: true,
                result: {
                    kind: 'session.input.admission',
                    status: 'resolved',
                    admission: {
                        status: 'rejected',
                        code: 'session_input_target_update_required',
                    },
                },
            });
            expect(enqueueSessionPendingByMachine).toHaveBeenCalledOnce();
            const response = await dispatch?.(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: { token: 'a'.repeat(43), sessionId },
                    operation: {
                        kind: 'turn_contributions.resolve',
                        requestId: 'resolve-composer-attachment',
                        request: {
                            kind: 'composerAttachment',
                            attachment: {
                                pluginId: 'acme.review',
                                localId: 'review-comment',
                            },
                            request: {
                                sessionId,
                                localId: 'local-1',
                                attachments: [{
                                    instanceId: 'review-1',
                                    key: 'review-1',
                                    value: { reviewId: '42' },
                                }],
                            },
                        },
                    },
                }),
                {
                    sessionId,
                    runner,
                    retainedAgent: binding,
                    invocationContext: {
                        cwd: '/workspace',
                        environment: {},
                        providerBindingActive: false,
                    },
                    signal,
                },
            );

            expect(response).toEqual({
                ok: true,
                result: {
                    kind: 'turn_contributions',
                    status: 'resolved',
                    contributions: {
                        kind: 'composerAttachment',
                        result: {
                            attachments: [{
                                instanceId: 'review-1',
                                status: 'ready',
                                context: 'Current review context.',
                                data: { refreshed: true },
                            }],
                        },
                    },
                },
            });
            expect(resolveForDispatch).toHaveBeenCalledWith({
                attachment: {
                    pluginId: 'acme.review',
                    localId: 'review-comment',
                },
                request: {
                    sessionId,
                    localId: 'local-1',
                    attachments: [{
                        instanceId: 'review-1',
                        key: 'review-1',
                        value: { reviewId: '42' },
                    }],
                },
                signal,
            });
            expect(release).toHaveBeenCalledOnce();

            const acceptedResponse = await dispatch?.(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: { token: 'a'.repeat(43), sessionId },
                    operation: {
                        kind: 'turn_contributions.resolve',
                        requestId: 'notify-composer-attachment-accepted',
                        request: {
                            kind: 'composerAttachmentAccepted',
                            attachment: {
                                pluginId: 'acme.review',
                                localId: 'review-comment',
                            },
                            event: {
                                sessionId,
                                localId: 'local-1',
                                attachments: [{
                                    instanceId: 'review-1',
                                    key: 'review-1',
                                    value: { reviewId: '42' },
                                }],
                            },
                        },
                    },
                }),
                {
                    sessionId,
                    runner,
                    retainedAgent: binding,
                    invocationContext: {
                        cwd: '/workspace',
                        environment: {},
                        providerBindingActive: false,
                    },
                    signal,
                },
            );

            expect(acceptedResponse).toEqual({
                ok: true,
                result: {
                    kind: 'turn_contributions',
                    status: 'resolved',
                    contributions: {
                        kind: 'composerAttachmentAccepted',
                    },
                },
            });
            expect(afterMessageAccepted).toHaveBeenCalledWith({
                attachment: {
                    pluginId: 'acme.review',
                    localId: 'review-comment',
                },
                event: {
                    sessionId,
                    localId: 'local-1',
                    attachments: [{
                        instanceId: 'review-1',
                        key: 'review-1',
                        value: { reviewId: '42' },
                    }],
                },
                signal,
            });
            expect(release).toHaveBeenCalledTimes(2);
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('admits selected Composer attachments through current daemon transforms before persistence', async () => {
        const sessionId = 'session-composer-attachment-prepare';
        const binding = createAgentSessionRunnerFactoryBinding({
            v: 1,
            pluginId: 'plugin.runner',
            pluginVersion: '1.0.0',
            agentId: 'claude',
            localAgentId: 'claude',
            immutableGenerationId: 'generation-composer-attachment',
            locator: {
                module: './runtime.mjs',
                export: 'createRuntime',
                runtimeApiVersion: 1,
            },
            normalizedModulePath: '/immutable/runtime.mjs',
            loadMode: 'immutable-js',
        });
        const runner = Object.freeze({
            pid: 23124,
            processStartTimeMs: 1,
            processCommandHash: 'b'.repeat(64),
            snapshotIdentity: 'snapshot:composer-attachment-prepare',
        });
        const attachment = {
            v: 1 as const,
            instanceId: 'review-1',
            attachment: {
                pluginId: 'acme.review',
                localId: 'review-comment',
            },
            key: 'review-1',
            value: { reviewId: '42' },
            presentation: {
                label: 'Review #42',
                typeLabel: 'Forged review type label',
            },
        };
        const prepareForSend = vi.fn(async (input: {
            request: Readonly<{
                sessionId: string;
                localId: string;
                attachments: readonly Readonly<{
                    instanceId: string;
                    key: string;
                    value: unknown;
                }>[];
            }>;
        }) => ({
            attachments: input.request.attachments.map((candidate) => {
                const draftValue = candidate.value as Record<string, unknown>;
                if (draftValue.reviewId === 'blocked') {
                    return {
                        instanceId: candidate.instanceId,
                        status: 'unavailable' as const,
                        retryable: true,
                        message: 'Review service is unavailable',
                    };
                }
                return {
                    instanceId: candidate.instanceId,
                    status: 'ready' as const,
                    value: {
                        ...draftValue,
                        prepared: draftValue.reviewId !== 'prepared-invalid',
                    },
                };
            }),
        }));
        const transformSessionInput = vi.fn(async (rawEvent: unknown) => {
            const event = rawEvent as HookEventEnvelopeV1;
            return {
                ...(event.payload as Record<string, unknown>),
                text: `${event.payload.text} [transformed]`,
                meta: { transformedBy: 'fixture.plugin' },
            };
        });
        const transformAgentRequest = vi.fn(async (rawEvent: unknown) => {
            const event = rawEvent as HookEventEnvelopeV1;
            return {
                ...(event.payload as Record<string, unknown>),
                request: {
                    ...(event.payload.request as Record<string, unknown>),
                    prompt: [{ type: 'text', text: 'request transformed by fixture.plugin' }],
                },
            };
        });
        const release = vi.fn(async () => {});
        const reviewCommentAttachment = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review',
            pluginVersion: '1.0.0',
            identity: attachment.attachment,
            manifestPath: '/fixtures/acme.review/plugin.json',
            definition: {
                id: 'review-comment',
                title: {
                    key: 'composer.attachment.review-comment',
                    fallback: 'Canonical review comment',
                },
                icon: 'info',
                cardinality: 'one',
                valueSchema: {
                    type: 'object',
                    properties: { reviewId: { type: 'string' } },
                    required: ['reviewId'],
                    additionalProperties: false,
                },
                preparedValueSchema: {
                    type: 'object',
                    properties: {
                        reviewId: { type: 'string' },
                        prepared: { const: true },
                    },
                    required: ['reviewId', 'prepared'],
                    additionalProperties: false,
                },
                runtime: { prepareForSend: true },
            },
        } satisfies ResolvedComposerAttachmentContribution;
        // A second contribution with `many` cardinality so one preparation group can
        // legitimately carry two instances: the only shape that can prove a mixed
        // ready/blocked result is rejected whole instead of partially admitted.
        const reviewNoteAttachment = {
            ...reviewCommentAttachment,
            identity: { pluginId: 'acme.review', localId: 'review-note' },
            definition: {
                ...reviewCommentAttachment.definition,
                id: 'review-note',
                title: {
                    key: 'composer.attachment.review-note',
                    fallback: 'Canonical review note',
                },
                cardinality: 'many',
            },
        } satisfies ResolvedComposerAttachmentContribution;
        const noteAttachment = {
            ...attachment,
            attachment: reviewNoteAttachment.identity,
        };
        const admissionRegistry = createTargetComposerAttachmentRegistry({
            targetRegistrations: [],
            activateAttachmentOnDemand: async () => {
                throw new Error('direct attachment admission must not activate a plugin');
            },
            declaredAttachments: [reviewCommentAttachment, reviewNoteAttachment].map((contribution) => ({
                attachment: contribution.identity,
                title: contribution.definition.title,
                cardinality: contribution.definition.cardinality,
                valueSchema: contribution.definition.valueSchema,
                preparedValueSchema: contribution.definition.preparedValueSchema,
            })),
            resolveGenerationLifecycle: () => ({
                isCurrent: () => true,
                retirementSignal: new AbortController().signal,
            }),
            createInvocationContext: () => {
                throw new Error('direct attachment admission must not invoke a plugin callback');
            },
        });
        const admit = vi.fn((input: Parameters<typeof admissionRegistry.admit>[0]) => (
            admissionRegistry.admit(input)
        ));
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
            registry: {
                contributes: createResolvedContributionRegistry({
                    agents: [],
                    composerAttachments: [reviewCommentAttachment, reviewNoteAttachment],
                }),
                hookHandlersByHookId: new Map<string, readonly ResolvedPluginHookHandler[]>([
                    ['session.input.transform', Object.freeze([{
                        pluginId: 'fixture.transform',
                        hookId: 'session.input.transform',
                        priority: 0,
                        registrationIndex: 0,
                        manifestPath: '/fixtures/fixture.transform/plugin.json',
                        daemonEntryPath: '/fixtures/fixture.transform/daemon.mjs',
                        exportName: 'transform',
                        registration: {
                            provenance: 'external',
                            source: { kind: 'path' },
                            pluginId: 'fixture.transform',
                            manifestPath: '/fixtures/fixture.transform/plugin.json',
                            daemonEntryPath: '/fixtures/fixture.transform/daemon.mjs',
                            sourceSpec: {
                                kind: 'path',
                                locator: '/fixtures/fixture.transform',
                                trustPolicy: 'local_trusted',
                                installPolicy: 'link',
                            },
                            definition: {
                                hookApiVersion: 1,
                                id: 'session.input.transform',
                                category: 'augmentation',
                                scope: 'session',
                                executionKind: 'augment',
                            },
                        },
                        handler: transformSessionInput,
                    }])],
                    ['agent.request.before', Object.freeze([{
                        pluginId: 'fixture.transform',
                        hookId: 'agent.request.before',
                        priority: 0,
                        registrationIndex: 1,
                        manifestPath: '/fixtures/fixture.transform/plugin.json',
                        daemonEntryPath: '/fixtures/fixture.transform/daemon.mjs',
                        exportName: 'transformAgentRequest',
                        registration: {
                            provenance: 'external',
                            source: { kind: 'path' },
                            pluginId: 'fixture.transform',
                            manifestPath: '/fixtures/fixture.transform/plugin.json',
                            daemonEntryPath: '/fixtures/fixture.transform/daemon.mjs',
                            sourceSpec: {
                                kind: 'path',
                                locator: '/fixtures/fixture.transform',
                                trustPolicy: 'local_trusted',
                                installPolicy: 'link',
                            },
                            definition: {
                                hookApiVersion: 1,
                                id: 'agent.request.before',
                                category: 'augmentation',
                                scope: 'agent',
                                executionKind: 'augment',
                            },
                        },
                        handler: transformAgentRequest,
                    }])],
                ]),
                composerAttachments: {
                    admit,
                    isDeclared: vi.fn(() => true),
                    requires: vi.fn(() => true),
                    supports: vi.fn(() => true),
                    prepareForSend,
                },
            },
            source: 'active',
            release,
        });
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-composer-attachment',
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
            const dispatch = vi.mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0].agentRuntimeDaemonServices?.dispatch;
            const signal = new AbortController().signal;
            const response = await dispatch?.(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: { token: 'a'.repeat(43), sessionId },
                    operation: {
                        kind: 'turn_contributions.resolve',
                        requestId: 'prepare-composer-attachment',
                        request: {
                            kind: 'transformSessionInput',
                            payload: {
                                sessionId,
                                localId: 'local-prepare-1',
                                text: 'Review this comment.',
                                meta: {
                                    happierStructuredInputV1: {
                                        v: 1,
                                        composerAttachments: [attachment],
                                    },
                                },
                                timestampMs: 1,
                            },
                        },
                    },
                }),
                {
                    sessionId,
                    runner,
                    retainedAgent: binding,
                    invocationContext: {
                        cwd: '/workspace',
                        environment: {},
                        providerBindingActive: false,
                    },
                    signal,
                },
            );

            expect(prepareForSend).toHaveBeenCalledWith({
                attachment: attachment.attachment,
                request: {
                    sessionId,
                    localId: 'local-prepare-1',
                    attachments: [{
                        instanceId: 'review-1',
                        key: 'review-1',
                        value: { reviewId: '42' },
                    }],
                },
                signal,
            });
            expect(admit).toHaveBeenNthCalledWith(1, {
                phase: 'draft',
                attachments: [attachment],
            });
            expect(admit).toHaveBeenNthCalledWith(2, {
                phase: 'prepared',
                attachments: [{
                    ...attachment,
                    value: { reviewId: '42', prepared: true },
                    presentation: {
                        ...attachment.presentation,
                        typeLabel: 'Canonical review comment',
                    },
                }],
            });
            expect(transformSessionInput).toHaveBeenCalledOnce();
            expect(response).toMatchObject({
                ok: true,
                result: {
                    kind: 'turn_contributions',
                    status: 'resolved',
                    contributions: {
                        kind: 'transformSessionInput',
                        payload: expect.objectContaining({
                            text: 'Review this comment. [transformed]',
                            meta: {
                                transformedBy: 'fixture.plugin',
                                happierStructuredInputV1: {
                                    v: 1,
                                    composerAttachments: [attachment],
                                },
                            },
                            preparedComposerAttachments: [{
                                ...attachment,
                                value: { reviewId: '42', prepared: true },
                                presentation: {
                                    label: 'Review #42',
                                    typeLabel: 'Canonical review comment',
                                },
                            }],
                        }),
                    },
                },
            });
            const dispatchComposerAdmission = async (input: Readonly<{
                requestId: string;
                localId: string;
                attachments: readonly unknown[];
            }>) => await dispatch?.(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: { token: 'a'.repeat(43), sessionId },
                    operation: {
                        kind: 'turn_contributions.resolve',
                        requestId: input.requestId,
                        request: {
                            kind: 'transformSessionInput',
                            payload: {
                                sessionId,
                                localId: input.localId,
                                text: 'Review this comment.',
                                meta: {
                                    happierStructuredInputV1: {
                                        v: 1,
                                        composerAttachments: input.attachments,
                                    },
                                },
                                timestampMs: 1,
                            },
                        },
                    },
                }),
                {
                    sessionId,
                    runner,
                    retainedAgent: binding,
                    invocationContext: {
                        cwd: '/workspace',
                        environment: {},
                        providerBindingActive: false,
                    },
                    signal,
                },
            );
            await expect(dispatchComposerAdmission({
                requestId: 'reject-invalid-draft-composer-attachment',
                localId: 'local-invalid-draft-1',
                attachments: [{
                    ...attachment,
                    instanceId: 'review-invalid-draft-1',
                    key: 'review-invalid-draft-1',
                    value: { reviewId: 42 },
                }],
            })).rejects.toMatchObject({ code: 'composer_attachment_value_invalid' });
            await expect(dispatchComposerAdmission({
                requestId: 'reject-cardinality-composer-attachment',
                localId: 'local-cardinality-1',
                attachments: [
                    attachment,
                    {
                        ...attachment,
                        instanceId: 'review-cardinality-2',
                        key: 'review-cardinality-2',
                    },
                ],
            })).rejects.toMatchObject({ code: 'composer_attachment_cardinality_invalid' });
            await expect(dispatchComposerAdmission({
                requestId: 'reject-invalid-prepared-composer-attachment',
                localId: 'local-invalid-prepared-1',
                attachments: [{
                    ...attachment,
                    instanceId: 'review-invalid-prepared-1',
                    key: 'review-invalid-prepared-1',
                    value: { reviewId: 'prepared-invalid' },
                }],
            })).rejects.toMatchObject({ code: 'composer_attachment_value_invalid' });
            // All-or-none preparation: one blocked outcome rejects the whole Message
            // preparation and preserves the plugin's typed reason, exactly as the
            // dispatch-phase resolution owner already does.
            await expect(dispatchComposerAdmission({
                requestId: 'reject-partially-prepared-composer-attachment',
                localId: 'local-partially-prepared-1',
                attachments: [
                    {
                        ...noteAttachment,
                        instanceId: 'review-note-ready-1',
                        key: 'review-note-ready-1',
                        value: { reviewId: '43' },
                    },
                    {
                        ...noteAttachment,
                        instanceId: 'review-note-blocked-1',
                        key: 'review-note-blocked-1',
                        value: { reviewId: 'blocked' },
                    },
                ],
            })).rejects.toMatchObject({
                code: 'composer_attachment_prepare_unavailable',
                retryable: true,
                message: 'Review service is unavailable',
            });
            const retryResponse = await dispatchComposerAdmission({
                requestId: 'retry-invalid-draft-composer-attachment',
                localId: 'local-invalid-draft-1',
                attachments: [{
                    ...attachment,
                    instanceId: 'review-invalid-draft-1',
                    key: 'review-invalid-draft-1',
                }],
            });
            expect(retryResponse).toMatchObject({
                ok: true,
                result: {
                    kind: 'turn_contributions',
                    status: 'resolved',
                },
            });
            expect(release).toHaveBeenCalledTimes(6);

            const requestTransformResponse = await dispatch?.(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: { token: 'a'.repeat(43), sessionId },
                    operation: {
                        kind: 'turn_contributions.resolve',
                        requestId: 'transform-agent-request',
                        request: {
                            kind: 'transformAgentRequest',
                            payload: {
                                sessionId: 'spoofed-session',
                                agentId: 'spoofed-agent',
                                runtimeFamily: 'hostSession',
                                method: 'session/new',
                                request: {
                                    sessionId: 'provider-session-1',
                                    prompt: [{ type: 'text', text: 'original request' }],
                                },
                                timestampMs: 1,
                            },
                        },
                    },
                }),
                {
                    sessionId,
                    runner,
                    retainedAgent: binding,
                    invocationContext: {
                        cwd: '/workspace',
                        environment: {},
                        providerBindingActive: false,
                    },
                    signal,
                },
            );

            expect(transformAgentRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventId: 'agent.request.before',
                    happySessionId: sessionId,
                    agentId: 'claude',
                    payload: expect.objectContaining({
                        sessionId,
                        agentId: 'claude',
                        runtimeFamily: 'acpSession',
                        method: 'session/prompt',
                        request: {
                            sessionId: 'provider-session-1',
                            prompt: [{ type: 'text', text: 'original request' }],
                        },
                    }),
                }),
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
            expect(requestTransformResponse).toMatchObject({
                ok: true,
                result: {
                    kind: 'turn_contributions',
                    status: 'resolved',
                    contributions: {
                        kind: 'transformAgentRequest',
                        payload: {
                            sessionId,
                            agentId: 'claude',
                            runtimeFamily: 'acpSession',
                            method: 'session/prompt',
                            request: {
                                sessionId: 'provider-session-1',
                                prompt: [{ type: 'text', text: 'request transformed by fixture.plugin' }],
                            },
                        },
                    },
                },
            });
            expect(release).toHaveBeenCalledTimes(7);
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('does not publish canonical runner readiness before daemon-service authority refresh succeeds and leaves non-runner readiness unchanged', async () => {
        const sessionId = 'session-runner-authority-readiness';
        const tracked: TrackedSession = {
            pid: 2_147_483_000,
            startedBy: 'daemon',
            happySessionId: sessionId,
            agentRuntimeDaemonServiceAuthorityFilePath:
                '/tmp/runner-authority-readiness.json',
        };
        let spawnSuccessPublished = false;
        const onHappySessionWebhook = vi.fn(async (
            _reportedSessionId: string,
            _metadata: unknown,
            reconcileCanonicalReadiness?: (
                candidate: TrackedSession,
            ) => Promise<void>,
        ) => {
            await reconcileCanonicalReadiness?.(tracked);
            spawnSuccessPublished = true;
        });
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-runner-authority-readiness',
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
            pidToTrackedSession: new Map([[tracked.pid, tracked]]),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook,
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        try {
            const controlServerInput =
                vi.mocked(startDaemonControlServer)
                    .mock.calls.at(-1)?.[0];
            await expect(
                controlServerInput?.onHappySessionWebhook(
                    sessionId,
                    {} as never,
                ),
            ).rejects.toThrow(
                'Runner Agent daemon-service authority process identity is unavailable',
            );
            expect(spawnSuccessPublished).toBe(false);

            delete tracked.agentRuntimeDaemonServiceAuthorityFilePath;
            await expect(
                controlServerInput?.onHappySessionWebhook(
                    sessionId,
                    {} as never,
                ),
            ).resolves.toBeUndefined();
            expect(spawnSuccessPublished).toBe(true);
        } finally {
            await runtime.stopControlServer();
        }
    });

    it('retains ordinary updates and removals but stops a hard-revoked runner without resurrection', async () => {
        const priorPluginStoreConfiguration = {
            happyHomeDir: configuration.happyHomeDir,
            activeServerDir: configuration.activeServerDir,
            daemonStateFile: configuration.daemonStateFile,
        };
        const retainedProviderHappyHomeDir = await mkdtemp(join(
            tmpdir(),
            'happier-retained-provider-home-',
        ));
        Object.assign(configuration, {
            happyHomeDir: retainedProviderHappyHomeDir,
            activeServerDir: join(
                retainedProviderHappyHomeDir,
                'servers',
                'default',
            ),
            daemonStateFile: join(
                retainedProviderHappyHomeDir,
                'servers',
                'default',
                'daemon.state.json',
            ),
        });
        onTestFinished(async () => {
            Object.assign(
                configuration,
                priorPluginStoreConfiguration,
            );
            await rm(retainedProviderHappyHomeDir, {
                recursive: true,
                force: true,
            });
        });
        const tracked: TrackedSession = {
            pid: 91,
            sessionRunnerPid: 92,
            startedBy: 'daemon' as const,
            happySessionId: 'session-runner-admission',
        };
        const pidToTrackedSession =
            new Map([[tracked.pid, tracked]]);
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

        const controlServerInput =
            vi.mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0];
        const admission = {
            turnId: 'turn-exact',
            inputId: 'input-exact',
            userMessageSeq: 19,
            userMessageSeqs: [18, 19],
        };
        await expect(
            controlServerInput
                ?.recordAgentRuntimeDaemonServiceAdmission?.(
                    tracked,
                    admission,
                ),
        ).resolves.toBe(true);
        expect(updateSessionMarkerActiveTurnMock)
            .toHaveBeenCalledWith({
                pid: 92,
                sessionId: 'session-runner-admission',
                activeTurnId: 'turn-exact',
                agentRuntimeDaemonServiceActiveAdmission:
                    admission,
            });
        await expect(
            controlServerInput
                ?.clearAgentRuntimeDaemonServiceAdmission?.(
                    tracked,
                    admission,
                ),
        ).resolves.toBe(true);
        expect(updateSessionMarkerActiveTurnMock)
            .toHaveBeenCalledWith({
                pid: 92,
                sessionId: 'session-runner-admission',
                activeTurnId: null,
                expectedAgentRuntimeDaemonServiceActiveAdmission:
                    admission,
            });

        const binding =
            createAgentSessionRunnerFactoryBinding({
                v: 1,
                pluginId: 'plugin.runner',
                pluginVersion: '1.0.0',
                agentId: 'claude',
                localAgentId: 'claude',
                immutableGenerationId: 'generation-g',
                locator: {
                    module: './runtime.mjs',
                    export: 'createRuntime',
                    runtimeApiVersion: 1,
                },
                normalizedModulePath:
                    '/immutable/runtime.mjs',
                loadMode: 'immutable-js',
            });
        const runner = Object.freeze({
            pid: 92,
            processStartTimeMs: 123,
            processCommandHash: '5'.repeat(64),
            snapshotIdentity: 'snapshot:runner',
        });
        tracked.agentRuntimeDaemonServiceCapabilityHash =
            'capability-digest';
        tracked.processStartTimeMs = 123;
        tracked.processCommandHash = '5'.repeat(64);
        tracked.runnerAgentInvocationContext = {
            cwd: '/workspace',
            environment: {
                PROVIDER_SECRET: 'must-not-become-daemon-authority',
            },
            agentCliLaunch: {
                localAgentId: 'claude',
                spec: {
                    source: 'override',
                    resolvedPath: '/workspace/.profile/bin/claude',
                    command: '/workspace/.profile/bin/claude',
                    args: [],
                },
            },
            providerBindingActive: true,
        };
        tracked.runnerAgentImmutableGenerationId =
            binding.immutableGenerationId;
        tracked.agentRuntimeDaemonServiceAdmittedTurnId =
            admission.turnId;
        tracked.agentRuntimeDaemonServiceAdmittedInputId =
            admission.inputId;
        tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeq =
            admission.userMessageSeq;
        tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs =
            [...admission.userMessageSeqs];
        const daemonServiceContext = Object.freeze({
            sessionId: 'session-runner-admission',
            runner,
            retainedAgent: binding,
            invocationContext: tracked.runnerAgentInvocationContext,
            trackedSession: tracked,
        });
        const releasePluginServicesLease =
            vi.fn(async () => {});
        const invocationServices =
            createUnavailablePluginServices();
        const createInitialRetainedRunnerAgentInvocationServices =
            vi.fn(async () => ({
                services: invocationServices,
                resourceDescriptors: {},
                subscriptionCapabilities: {
                    settingsWatch: false,
                    eventSubscriptions: [],
                    resourceWatches: [],
                    notificationPreferencesWatch: false,
                },
            }));
        acquireAuthoritativePluginRuntimeRegistryLeaseMock
            .mockResolvedValue({
                registry: {
                    contributes: {
                        resources: [],
                        agentDefinitionsById: new Map(),
                    },
                    agentRuntimesByAgentId: new Map([
                        ['claude', {
                            hasPrimaryRuntime: true,
                            pluginId: 'plugin.runner',
                            pluginVersion: '1.0.0',
                            agentId: 'claude',
                            generation:
                                'runtime-generation-g',
                            immutableGenerationId:
                                'generation-g',
                            retirementSignal:
                                new AbortController().signal,
                            sessionRunnerFactoryBinding:
                                binding,
                            createRuntime: vi.fn(),
                            isCurrent: () => true,
                        }],
                    ]),
                    eventDeclarationsByPluginId:
                        new Map(),
                    createRetainedRunnerAgentInvocationServices:
                        createInitialRetainedRunnerAgentInvocationServices,
                },
                source: 'active',
                release:
                    releasePluginServicesLease,
            });
        const preparedPluginServices =
            await controlServerInput
                ?.agentRuntimeDaemonServices?.dispatch(
                    AgentRuntimeDaemonServiceRequestV1Schema.parse({
                        v: 1,
                        context: {
                            token: 'c'.repeat(43),
                            sessionId:
                                'session-runner-admission',
                        },
                        operation: {
                            kind:
                                'plugin_services.prepare_v1',
                            requestId:
                                'plugin-services-prepare',
                            invocationId:
                                'invocation-g',
                            witness: {
                                turnId:
                                    admission.turnId,
                                inputId:
                                    admission.inputId,
                                userMessageSeq:
                                    admission.userMessageSeq,
                                userMessageSeqs:
                                    admission.userMessageSeqs,
                            },
                        },
                    }),
                    daemonServiceContext,
                );
        expect(preparedPluginServices).toMatchObject({
            ok: true,
            result: {
                kind:
                    'plugin_services.result_v1',
                requestId:
                    'plugin-services-prepare',
            },
        });
        expect(
            createInitialRetainedRunnerAgentInvocationServices,
        )
            .toHaveBeenCalledWith({
                binding,
                sessionId: 'session-runner-admission',
                managedDependencyRetention: {
                    v: 1,
                    sourceGenerationIds: [],
                    qualifiedDependencyIds: [],
                },
                correlationId:
                    'invocation-g',
                cwd: '/workspace',
                environment: {},
                agentCliLaunch: {
                    localAgentId: 'claude',
                    spec: {
                        source: 'override',
                        resolvedPath: '/workspace/.profile/bin/claude',
                        command: '/workspace/.profile/bin/claude',
                        args: [],
                    },
                },
                providerBindingActive: true,
                signal: expect.any(AbortSignal),
                isGenerationCurrent:
                    expect.any(Function),
            });
        const closedPluginServices =
            await controlServerInput
                ?.agentRuntimeDaemonServices?.dispatch(
                    AgentRuntimeDaemonServiceRequestV1Schema.parse({
                        v: 1,
                        context: {
                            token: 'c'.repeat(43),
                            sessionId:
                                'session-runner-admission',
                        },
                        operation: {
                            kind:
                                'plugin_services.close_v1',
                            requestId:
                                'plugin-services-close',
                            invocationId:
                                'invocation-g',
                        },
                    }),
                    daemonServiceContext,
                );
        expect(closedPluginServices).toMatchObject({
            ok: true,
            result: {
                kind:
                    'plugin_services.result_v1',
                requestId:
                    'plugin-services-close',
            },
        });
        expect(releasePluginServicesLease)
            .toHaveBeenCalledOnce();

        const retainedConnectionId = ProviderConnectionIdSchema.parse(
            'pc_retained_provider_post_open',
        );
        const retainedMachineGrant = Object.freeze({
            v: 1 as const,
            machineId: 'machine-1',
            connectionId: retainedConnectionId,
            endpointSetFingerprint:
                'endpoint-set:retained-provider-post-open',
            connectionSecurityFingerprint:
                'connection-security:retained-provider-post-open',
            confirmedAt: 1,
        });
        const retainedRuntimeBindingBasis =
            ProviderRuntimeBindingBasisV1Schema.parse({
                v: 1,
                agentTargetKey: 'backend:claude',
                connectionId: retainedConnectionId,
                contributionKey: 'plugin.provider/gateway',
                runtimeCredentialTransport: null,
                prepared: {
                    v: 1,
                    materialization: 'spawnEnv',
                },
                adapterVersion: 1,
                agentSupport: {
                    acceptsProtocols: ['openai-responses'],
                    required: { streaming: true },
                    credentialSupport: {
                        supportsNoAuth: true,
                        apiKeyTransports: [],
                    },
                    authIsolation: {
                        suppressConnectedServiceIds: [],
                        ownedEnvKeys: [],
                    },
                    materialization: 'spawnEnv',
                    applyPolicy: 'restart_session',
                    supportsFreeformModelIds: true,
                },
                deployment: {
                    kind: 'managedLocal',
                    implementationIdentity: {
                        pluginId: 'plugin.provider',
                        localId: 'gateway',
                    },
                    managedRuntime: {
                        kind: 'managed',
                        endpointTemplateIds: ['responses'],
                        connectedAccounts: [],
                        requestAuthUses: [],
                    },
                    purposeBindings: {
                        v: 1,
                        bindings: [],
                    },
                },
                endpoint: {
                    endpointTemplateId: 'responses',
                    protocol: 'openai-responses',
                    publicHeaders: {},
                },
                credentialAuthorization: {
                    connectionSecurityFingerprint:
                        retainedMachineGrant
                            .connectionSecurityFingerprint,
                    grantFingerprint:
                        createProviderMachineGrantFingerprintV1(
                            retainedMachineGrant,
                        ),
                },
            });
        if (
            retainedRuntimeBindingBasis.deployment.kind
                !== 'managedLocal'
        ) {
            throw new Error('Expected retained managed Provider basis');
        }
        const retainedModel = Object.freeze({
            id: 'model-p',
            name: 'Model P',
        });
        const retainedCompatibilityFingerprint =
            'compatibility:retained-provider-post-open';
        tracked.spawnOptions = {
            directory: '/workspace',
            backendTarget: {
                kind: 'backend',
                backendId: 'claude',
                sourceKind: 'built_in',
            },
            modelSelection: {
                v: 1,
                updatedAt: 1,
                ref: {
                    agentTargetKey:
                        retainedRuntimeBindingBasis.agentTargetKey,
                    providerConnectionId:
                        retainedRuntimeBindingBasis.connectionId,
                    modelId: retainedModel.id,
                },
            },
            providerBindingMetadataV1:
                SessionProviderBindingMetadataV1Schema.parse({
                    v: 1,
                    connectionId:
                        retainedRuntimeBindingBasis.connectionId,
                    contributionKey:
                        retainedRuntimeBindingBasis.contributionKey,
                    connectionRevision: 1,
                    model: retainedModel,
                    protocol:
                        retainedRuntimeBindingBasis.endpoint.protocol,
                    materialization:
                        retainedRuntimeBindingBasis.prepared
                            .materialization,
                    compatibilityFingerprint:
                        retainedCompatibilityFingerprint,
                    bindingSecurityFingerprint:
                        createProviderBindingSecurityFingerprintV1({
                            agentTargetKey:
                                retainedRuntimeBindingBasis
                                    .agentTargetKey,
                            connectionId:
                                retainedRuntimeBindingBasis.connectionId,
                            modelId: retainedModel.id,
                            modelCapabilities: {},
                            endpointTemplateId:
                                retainedRuntimeBindingBasis.endpoint
                                    .endpointTemplateId,
                            protocol:
                                retainedRuntimeBindingBasis.endpoint
                                    .protocol,
                            publicHeaders:
                                retainedRuntimeBindingBasis.endpoint
                                    .publicHeaders,
                            materialization:
                                retainedRuntimeBindingBasis.prepared
                                    .materialization,
                            compatibilityFingerprint:
                                retainedCompatibilityFingerprint,
                            adapterVersion:
                                retainedRuntimeBindingBasis.adapterVersion,
                            deployment: {
                                kind: 'managedLocal',
                                implementationIdentity:
                                    retainedRuntimeBindingBasis
                                        .deployment
                                        .implementationIdentity,
                                managedRuntime:
                                    retainedRuntimeBindingBasis
                                        .deployment.managedRuntime,
                            },
                        }),
                    managedPurposeBindings:
                        retainedRuntimeBindingBasis.deployment
                            .purposeBindings,
                    runtimeBindingBasis:
                        retainedRuntimeBindingBasis,
                    displaySnapshot: {
                        providerName: 'Gateway',
                        connectionName: 'Retained P',
                        connectionRole: 'named',
                        connectionDisplayNameMode: 'custom',
                    },
                }),
        };
        getActiveAccountSettingsSnapshotMock.mockReturnValue({
            settings: AccountSettingsSchema.parse({
                schemaVersion: 2,
                providerSettingsV1: {
                    ...DEFAULT_PROVIDER_SETTINGS_V1,
                    connections: [{
                        v: 1,
                        id: retainedConnectionId,
                        source: {
                            kind: 'contribution',
                            contributionKey:
                                retainedRuntimeBindingBasis
                                    .contributionKey,
                        },
                        role: 'default',
                        displayName: 'Retained P',
                        displayNameMode: 'automatic',
                        deployment: { kind: 'managedLocal' },
                        revision: 1,
                        createdAt: 1,
                        updatedAt: 1,
                    }],
                    machineGrants: [retainedMachineGrant],
                },
            }),
            settingsSecretsReadKeys: [],
        });
        const retainedProviderSourceRoot = await mkdtemp(join(
            tmpdir(),
            'happier-retained-provider-fixture-',
        ));
        const retainedProviderManifestContents = JSON.stringify({
            schemaVersion: 2,
            id: 'plugin.provider',
            version: '1.0.0',
            displayName: 'Retained managed Provider fixture',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                providers: [{
                    v: 1,
                    id: 'gateway',
                    name: 'Gateway',
                    kind: 'aggregator',
                    endpointTemplates: [{
                        id: 'responses',
                        protocol: 'openai-responses',
                        baseUrl: 'http://127.0.0.1:4312/v1',
                        capabilities: {
                            streaming: 'supported',
                            toolRoundTrips: 'supported',
                            statefulResponses: 'unknown',
                            reasoningControls: 'supported',
                        },
                    }],
                    catalog: {
                        source: 'static',
                        manualModelPolicy: 'allowed',
                        staticModels: [{
                            id: retainedModel.id,
                            name: retainedModel.name,
                        }],
                    },
                    managedRuntime: {
                        kind: 'managed',
                        endpointTemplateIds: ['responses'],
                        connectedAccounts: [],
                        requestAuthUses: [],
                    },
                }],
            },
        });
        const retainedProviderImmutableGenerationId =
            `provider-immutable-p-${createHash('sha256')
                .update(retainedProviderSourceRoot)
                .digest('hex')
                .slice(0, 16)}`;
        const retainedProviderOperationClaimId = JSON.stringify([
            'managed-provider-session-demand',
            'session-runner-admission',
            'plugin.provider',
            'gateway',
            'provider-generation-p',
            retainedProviderImmutableGenerationId,
            'external',
        ]);
        const retainedScope = Object.freeze({
            v: 1 as const,
            sessionId: 'session-runner-admission',
            runtimeBindingBasis: retainedRuntimeBindingBasis,
            pluginId: 'plugin.provider',
            providerLocalId: 'gateway',
            activationGeneration: 'provider-generation-p',
            immutableGenerationId:
                retainedProviderImmutableGenerationId,
            manifestAuthority: 'external',
            operationClaimId: retainedProviderOperationClaimId,
        });
        const retainedAuthority = Object.freeze({
            v: 1 as const,
            scope: retainedScope,
            providerPluginHardRevocationRevisionAtAdmission: 0,
        });
        tracked.runnerManagedDependencyRetentionV1 = {
            v: 1,
            adoptedManagedProviderAuthority: {
                pluginId: retainedScope.pluginId,
                immutableGenerationId:
                    retainedScope.immutableGenerationId,
                manifestAuthority:
                    retainedScope.manifestAuthority,
                hardRevocationRevisionAtAdmission: 0,
            },
            sourceGenerationIds: [],
            qualifiedDependencyIds: [],
        };
        const packagedProviderSpec = Object.freeze({
            id: 'provider-wrapper',
            mode: Object.freeze({
                kind: 'spawn' as const,
                launch: Object.freeze({
                    executable: Object.freeze({
                        kind: 'packaged-runtime-binary' as const,
                        directorySegments: Object.freeze([
                            'tools',
                            'unpacked',
                        ]),
                        executableBaseName:
                            'provider-runtime',
                    }),
                    env: Object.freeze({
                        PROVIDER_MODE: 'session',
                    }),
                }),
                endpoint: Object.freeze({
                    kind: 'assignAndInject' as const,
                    port: Object.freeze({
                        kind: 'fixed' as const,
                        port: 4312,
                    }),
                }),
            }),
            healthCheck: Object.freeze({
                kind: 'none' as const,
            }),
        }) satisfies ManagedServiceSpec;
        const conflictingPackagedProviderSpec = Object.freeze({
            ...packagedProviderSpec,
            mode: Object.freeze({
                ...packagedProviderSpec.mode,
                launch: Object.freeze({
                    ...packagedProviderSpec.mode.launch,
                    executable: Object.freeze({
                        ...packagedProviderSpec.mode.launch.executable,
                        executableBaseName:
                            'provider-runtime-replacement',
                    }),
                }),
            }),
        }) satisfies ManagedServiceSpec;
        const repeatedPackagedProviderSpec = Object.freeze({
            ...packagedProviderSpec,
            mode: Object.freeze({
                ...packagedProviderSpec.mode,
                launch: Object.freeze({
                    ...packagedProviderSpec.mode.launch,
                    executable: Object.freeze({
                        ...packagedProviderSpec.mode.launch.executable,
                        directorySegments: Object.freeze([
                            ...packagedProviderSpec.mode.launch
                                .executable.directorySegments,
                        ]),
                    }),
                    env: Object.freeze({
                        ...packagedProviderSpec.mode.launch.env,
                    }),
                }),
            }),
        }) satisfies ManagedServiceSpec;
        const unavailableManagedDependency =
            async (): Promise<never> => {
                throw new Error(
                    'Managed dependency access is not part of launch correspondence',
                );
            };
        const custodyDependencies = Object.freeze({
            status: unavailableManagedDependency,
            ensure: unavailableManagedDependency,
            update: unavailableManagedDependency,
            remove: unavailableManagedDependency,
        }) satisfies ManagedDependenciesService;
        const wrappedManagedServices: ManagedServices[] = [];
        const freshManagedProviderCleanup = vi.fn(async () => {});
        const createManagedProviderRuntimeInvocationServices:
            NonNullable<
                ResolvedExecutablePluginRuntimeRegistry[
                    'createManagedProviderRuntimeInvocationServices'
                ]
            > = vi.fn(async (input) => {
                if (
                    input.operationClaim?.kind
                        !== 'sessionDemand'
                ) {
                    throw new Error(
                        'Expected Session-demand managed Provider custody',
                    );
                }
                const custody = await input.operationClaim
                    .bindSessionCustody(
                        {
                            sessionId:
                                input.operationClaim.sessionId,
                            runtimeBindingBasis:
                                input.operationClaim
                                    .runtimeBindingBasis,
                            identity: input.identity,
                            activationGeneration:
                                retainedScope.activationGeneration,
                            immutableGenerationId:
                                retainedScope.immutableGenerationId,
                            manifestAuthority:
                                retainedScope.manifestAuthority,
                            operationClaimId:
                                retainedScope.operationClaimId,
                        },
                        custodyDependencies,
                    );
                wrappedManagedServices.push(
                    custody.managedServices,
                );
                return Object.freeze({
                    bootstrap: Object.freeze({
                        identity: input.identity,
                        activationGeneration:
                            retainedScope.activationGeneration,
                        immutableGenerationId:
                            retainedScope.immutableGenerationId,
                        manifestAuthority:
                            retainedScope.manifestAuthority,
                        operationClaimId:
                            retainedScope.operationClaimId,
                        requestAuth: null,
                    }),
                    connectedAccounts:
                        createUnavailablePluginServices()
                            .connectedAccounts,
                    managedServices:
                        custody.managedServices,
                    projectEndpointAccess:
                        custody.projectEndpointAccess,
                    cleanup: freshManagedProviderCleanup,
                });
            });
        const retainedProviderCleanup = vi.fn(async () => {});
        let retainedAuthorityCurrentAtCreation = false;
        let retainedPolicyCurrentAtCreation = false;
        const createRetainedManagedProviderRuntimeInvocationServices:
            NonNullable<
                ResolvedExecutablePluginRuntimeRegistry[
                    'createRetainedManagedProviderRuntimeInvocationServices'
                ]
            > = vi.fn(async (input) => {
                expect(input.scope).toEqual({
                    sessionId: retainedScope.sessionId,
                    runtimeBindingBasis:
                        retainedScope.runtimeBindingBasis,
                    identity: {
                        pluginId: retainedScope.pluginId,
                        localId:
                            retainedScope.providerLocalId,
                    },
                    activationGeneration:
                        retainedScope.activationGeneration,
                    immutableGenerationId:
                        retainedScope.immutableGenerationId,
                    manifestAuthority:
                        retainedScope.manifestAuthority,
                    operationClaimId:
                        retainedScope.operationClaimId,
                });
                retainedAuthorityCurrentAtCreation = input.isCurrent();
                retainedPolicyCurrentAtCreation =
                    await input.revalidatePolicy();
                const unavailableServices =
                    createUnavailablePluginServices();
                return {
                    bootstrap: {
                        identity: {
                            pluginId: retainedScope.pluginId,
                            localId: retainedScope.providerLocalId,
                        },
                        activationGeneration:
                            retainedScope.activationGeneration,
                        immutableGenerationId:
                            retainedScope.immutableGenerationId,
                        manifestAuthority:
                            retainedScope.manifestAuthority,
                        operationClaimId:
                            retainedScope.operationClaimId,
                        requestAuth: null,
                    },
                    connectedAccounts:
                        unavailableServices.connectedAccounts,
                    managedServices:
                        unavailableServices.managedServices,
                    async projectEndpointAccess() {
                        throw new Error(
                            'Retained endpoint projection is not used by this fixture',
                        );
                    },
                    cleanup: retainedProviderCleanup,
                };
            });
        const createSuccessorRetainedRunnerAgentInvocationServices =
            vi.fn(async () => ({
                services: createUnavailablePluginServices(),
                resourceDescriptors: {},
                subscriptionCapabilities: {
                    settingsWatch: false,
                    eventSubscriptions: [],
                    resourceWatches: [],
                    notificationPreferencesWatch: false,
                },
            }));
        const successorBinding =
            createAgentSessionRunnerFactoryBinding({
                ...binding,
                immutableGenerationId: 'generation-h',
            });
        const releaseRetainedPluginServicesLease =
            vi.fn(async () => {});
        acquireAuthoritativePluginRuntimeRegistryLeaseMock
            .mockResolvedValue({
                registry: {
                    contributes: {
                        resources: [],
                        agentDefinitionsById: new Map(),
                        providers: [{
                            identity: {
                                pluginId:
                                    retainedScope.pluginId,
                                localId:
                                    retainedScope.providerLocalId,
                            },
                            definition: {
                                managedRuntime:
                                    retainedRuntimeBindingBasis
                                        .deployment
                                        .managedRuntime,
                            },
                        }],
                    },
                    agentRuntimesByAgentId: new Map([
                        ['claude', {
                            hasPrimaryRuntime: true,
                            pluginId: 'plugin.runner',
                            pluginVersion: '1.0.0',
                            agentId: 'claude',
                            generation:
                                'runtime-generation-h',
                            immutableGenerationId:
                                'generation-h',
                            retirementSignal:
                                new AbortController().signal,
                            sessionRunnerFactoryBinding:
                                successorBinding,
                            createRuntime: vi.fn(),
                            isCurrent: () => true,
                        }],
                    ]),
                    eventDeclarationsByPluginId: new Map(),
                    createRetainedRunnerAgentInvocationServices:
                        createSuccessorRetainedRunnerAgentInvocationServices,
                    createManagedProviderRuntimeInvocationServices,
                    createRetainedManagedProviderRuntimeInvocationServices,
                    acquireManagedProviderRuntime: vi.fn(),
                },
                source: 'active',
                release: releaseRetainedPluginServicesLease,
            });
        vi.mocked(callSessionRpc).mockResolvedValue({
            v: 1,
            kind: 'adoptedPublicOutcome',
            outcome: {
                operationClaimId:
                    retainedScope.operationClaimId,
                serviceId: 'provider-wrapper',
                endpointTemplateIds: ['responses'],
                endpoints: [{
                    endpointTemplateId: 'responses',
                    servicePath: '/v1',
                    endpointUrl: 'http://127.0.0.1:4312/v1',
                }],
                endpointAccess: 'runnerProjected',
            },
        });

        const pluginStorePaths = resolvePluginStorePaths({
            happyHomeDir: configuration.happyHomeDir,
        });
        const priorCommit =
            await readPluginRegistryCommitRecord(pluginStorePaths);
        const priorInstallationState = priorCommit
            ? await readInstallationStateRevision({
                paths: pluginStorePaths,
                reference: priorCommit.installationState,
            })
            : null;
        try {
            const manifestRelativePath =
                '.happier-plugin/plugin.json';
            await mkdir(join(
                retainedProviderSourceRoot,
                '.happier-plugin',
            ), { recursive: true });
            await writeFile(
                join(
                    retainedProviderSourceRoot,
                    manifestRelativePath,
                ),
                retainedProviderManifestContents,
                'utf8',
            );
            await writeFile(
                join(retainedProviderSourceRoot, 'daemon.mjs'),
                'export function activate() {}\n',
                'utf8',
            );
            const retainedProviderRecord =
                await createImmutablePluginGenerationRecordFromSource({
                    pluginId: retainedScope.pluginId,
                    sourceRootPath: retainedProviderSourceRoot,
                    manifestRelativePath,
                    distribution: {
                        kind: 'localPath',
                        canonicalPath: retainedProviderSourceRoot,
                    },
                    updatePolicy: 'manual',
                    createdAtMs: 1,
                    immutableGenerationId:
                        retainedScope.immutableGenerationId,
                });
            await prepareImmutablePluginGeneration({
                paths: pluginStorePaths,
                sourceRootPath: retainedProviderSourceRoot,
                record: retainedProviderRecord,
            });
        } finally {
            await rm(retainedProviderSourceRoot, {
                recursive: true,
                force: true,
            });
        }
        const retainedProviderState = {
            ...(priorInstallationState ?? {
                t: 'happier_plugin_installations_v1' as const,
                schemaVersion: 1 as const,
                createdAtMs: 1,
                plugins: {},
                rollbackRetention: [],
            }),
            revisionId:
                `retained-provider-state-${process.pid}-${Date.now()}`,
            plugins: {
                ...(priorInstallationState?.plugins ?? {}),
                [retainedScope.pluginId]: {
                    enabled: true,
                    source: {
                        distribution: {
                            kind: 'localPath' as const,
                            canonicalPath:
                                retainedProviderSourceRoot,
                        },
                    },
                    updatePolicy: 'manual' as const,
                    optionalAccess: [],
                },
            },
            hardRevocationRevisions: {
                ...(priorInstallationState
                    ?.hardRevocationRevisions ?? {}),
                [retainedScope.pluginId]: 0,
            },
        };
        const retainedProviderStateReference =
            await persistInstallationStateRevision({
                paths: pluginStorePaths,
                state: retainedProviderState,
            });
        await replacePluginRegistryCommitRecord({
            paths: pluginStorePaths,
            expectedCurrent: priorCommit ?? null,
            next: {
                t: 'happier_plugin_registry_commit_v1',
                schemaVersion: 1,
                revision: (priorCommit?.revision ?? -1) + 1,
                transactionId:
                    `retained-provider-commit-${process.pid}-${Date.now()}`,
                baseRevision: priorCommit?.revision ?? null,
                installationState:
                    retainedProviderStateReference,
                pluginGenerations:
                    priorCommit?.pluginGenerations ?? {},
                createdAtMs: Date.now(),
                creator: {
                    pid: process.pid,
                    instanceId:
                        `retained-provider-fixture-${process.pid}`,
                },
            },
        });
        await expect(
            readCurrentPluginImmutableGenerationIntegrityCurrentness({
                paths: pluginStorePaths,
                pluginId: retainedScope.pluginId,
                immutableGenerationId:
                    retainedScope.immutableGenerationId,
            }),
        ).resolves.toBe(true);
        const activeRetainedProviderSettings =
            getActiveAccountSettingsSnapshotMock().settings
                ?.providerSettingsV1;
        if (!activeRetainedProviderSettings) {
            throw new Error(
                'Expected active retained Provider settings',
            );
        }
        expect(isRetainedManagedProviderSettingsGrantCurrent({
            machineId: 'machine-1',
            providerSettings: ProviderSettingsV1Schema.parse(
                activeRetainedProviderSettings,
            ),
            runtimeBindingBasis: retainedRuntimeBindingBasis,
        })).toBe(true);

        const retainedSessionBindingMetadata =
            tracked.spawnOptions
                .providerBindingMetadataV1;
        if (!retainedSessionBindingMetadata) {
            throw new Error(
                'Expected managed Provider Session binding metadata',
            );
        }
        authorizeSessionModelTransitionProviderTargetWithLeaseMock
            .mockResolvedValue({
                selection: {
                    agentTargetKey:
                        retainedRuntimeBindingBasis.agentTargetKey,
                    providerConnectionId:
                        retainedRuntimeBindingBasis.connectionId,
                    modelId: retainedModel.id,
                },
                policy: 'restart_session',
                model: retainedModel,
                sessionBindingMetadata:
                    retainedSessionBindingMetadata,
                runtimeBindingBasis:
                    retainedRuntimeBindingBasis,
            });
        const superviseCustodyRequests: unknown[] = [];
        vi.mocked(callSessionRpc).mockImplementation(
            async (input) => {
                const request =
                    RunnerManagedServicesCustodyRequestV1Schema
                        .parse(input.request);
                if (request.kind !== 'supervise') {
                    throw new Error(
                        `Unexpected custody request ${request.kind}`,
                    );
                }
                superviseCustodyRequests.push(request);
                return {
                    v: 1,
                    kind: 'handle',
                    custodyScope: request.scope,
                    snapshot: {
                        id: request.spec.id,
                        state: 'healthy',
                        mode: 'spawn',
                        baseUrl:
                            'http://127.0.0.1:4312',
                        startedAtMs: 1,
                        lastHealthyAtMs: 1,
                        diagnostics: [],
                        diagnosticsTruncated: false,
                    },
                };
            },
        );
        const freshProviderInvocationId =
            'invocation-provider-launch';
        const prepareFreshProvider = async (
            requestId: string,
            invocationId: string = freshProviderInvocationId,
        ) => await controlServerInput
            ?.agentRuntimeDaemonServices?.dispatch(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: {
                        token: 'd'.repeat(43),
                        sessionId:
                            'session-runner-admission',
                    },
                    operation: {
                        kind: 'plugin_services.prepare_v1',
                        requestId,
                        invocationId,
                    },
                }),
                daemonServiceContext,
            );
        const closeFreshProvider = async (
            requestId: string,
        ) => await controlServerInput
            ?.agentRuntimeDaemonServices?.dispatch(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: {
                        token: 'd'.repeat(43),
                        sessionId:
                            'session-runner-admission',
                    },
                    operation: {
                        kind: 'plugin_services.close_v1',
                        requestId,
                        invocationId:
                            freshProviderInvocationId,
                    },
                }),
                daemonServiceContext,
            );

        authorizeSessionModelTransitionProviderTargetWithLeaseMock
            .mockResolvedValueOnce({
                selection: {
                    agentTargetKey:
                        retainedRuntimeBindingBasis.agentTargetKey,
                    providerConnectionId:
                        retainedRuntimeBindingBasis.connectionId,
                    modelId: retainedModel.id,
                },
                policy: 'restart_session',
                model: retainedModel,
                sessionBindingMetadata:
                    retainedSessionBindingMetadata,
                runtimeBindingBasis: {
                    ...retainedRuntimeBindingBasis,
                    adapterVersion:
                        retainedRuntimeBindingBasis.adapterVersion + 1,
                },
            });
        await expect(prepareFreshProvider(
            'fresh-provider-changed-basis-prepare',
            'invocation-provider-changed-basis',
        )).resolves.toMatchObject({
            ok: false,
            error: {
                code:
                    'plugin_services_managed_provider_authority_unavailable',
            },
        });
        await expect(prepareFreshProvider(
            'fresh-provider-prepare',
        )).resolves.toMatchObject({ ok: true });
        expect(wrappedManagedServices).toHaveLength(1);
        await expect(
            wrappedManagedServices[0]!.supervise(
                repeatedPackagedProviderSpec,
            ),
        ).resolves.toMatchObject({
            snapshot: expect.any(Function),
        });
        await expect(
            wrappedManagedServices[0]!.supervise(
                packagedProviderSpec,
            ),
        ).resolves.toMatchObject({
            snapshot: expect.any(Function),
        });
        expect(superviseCustodyRequests).toHaveLength(2);
        expect(() => wrappedManagedServices[0]!.supervise(
            conflictingPackagedProviderSpec,
        )).toThrowError(expect.objectContaining({
            code: 'plugin_managed_service_spec_conflict',
        }));
        expect(superviseCustodyRequests).toHaveLength(2);
        await expect(closeFreshProvider(
            'fresh-provider-close',
        )).resolves.toMatchObject({ ok: true });

        await expect(prepareFreshProvider(
            'fresh-provider-reuse-prepare',
        )).resolves.toMatchObject({ ok: true });
        expect(wrappedManagedServices).toHaveLength(2);
        await expect(
            wrappedManagedServices[1]!.supervise(
                conflictingPackagedProviderSpec,
            ),
        ).resolves.toMatchObject({
            snapshot: expect.any(Function),
        });
        expect(superviseCustodyRequests).toHaveLength(3);
        await expect(closeFreshProvider(
            'fresh-provider-reuse-close',
        )).resolves.toMatchObject({ ok: true });
        expect(freshManagedProviderCleanup)
            .toHaveBeenCalledTimes(2);
        vi.mocked(callSessionRpc).mockResolvedValue({
            v: 1,
            kind: 'adoptedPublicOutcome',
            outcome: {
                operationClaimId:
                    retainedScope.operationClaimId,
                serviceId: 'provider-wrapper',
                endpointTemplateIds: ['responses'],
                endpoints: [{
                    endpointTemplateId: 'responses',
                    servicePath: '/v1',
                    endpointUrl:
                        'http://127.0.0.1:4312/v1',
                }],
                endpointAccess: 'runnerProjected',
            },
        });
        expect(
            createRetainedManagedProviderRuntimeInvocationServices,
        ).not.toHaveBeenCalled();

        const retainedPrepared = await controlServerInput
            ?.agentRuntimeDaemonServices?.dispatch(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: {
                        token: 'd'.repeat(43),
                        sessionId: 'session-runner-admission',
                    },
                    operation: {
                        kind: 'plugin_services.prepare_v1',
                        requestId: 'retained-provider-prepare',
                        invocationId: 'invocation-p',
                        managedProviderRetention:
                            retainedAuthority,
                    },
                }),
                    daemonServiceContext,
                );
        expect(
            createRetainedManagedProviderRuntimeInvocationServices,
        ).toHaveBeenCalledOnce();
        expect(retainedAuthorityCurrentAtCreation).toBe(true);
        expect(retainedPolicyCurrentAtCreation).toBe(true);
        expect(retainedPrepared).toMatchObject({ ok: true });

        await expect(
            controlServerInput
                ?.agentRuntimeDaemonServices?.dispatch(
                    AgentRuntimeDaemonServiceRequestV1Schema.parse({
                        v: 1,
                        context: {
                            token: 'd'.repeat(43),
                            sessionId:
                                'session-runner-admission',
                        },
                        operation: {
                            kind:
                                'managed_server.supervision.authorize',
                            requestId:
                                'retained-provider-missing-stamp',
                            contributionId:
                                'plugin.provider/providers/gateway',
                            operationClaimId:
                                retainedScope.operationClaimId,
                            serverId:
                                'retained-provider-runtime',
                            executable: {
                                kind:
                                    'packaged-runtime-binary',
                                directorySegments: ['tools'],
                                executableBaseName:
                                    'retained-provider-runtime',
                            },
                            environmentKeys: [],
                        },
                    }),
                    daemonServiceContext,
                ),
        ).rejects.toMatchObject({
            code: 'plugin_managed_server_launch_denied',
        });

        const retainedStarted = await controlServerInput
            ?.agentRuntimeDaemonServices?.dispatch(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: {
                        token: 'd'.repeat(43),
                        sessionId: 'session-runner-admission',
                    },
                    operation: {
                        kind:
                            'plugin_services.managed_provider.start_v1',
                        requestId: 'retained-provider-start',
                        invocationId: 'invocation-p',
                        retained: retainedAuthority,
                    },
                }),
                daemonServiceContext,
            );
        expect(retainedStarted).toMatchObject({ ok: true });
        expect(
            createRetainedManagedProviderRuntimeInvocationServices,
        ).toHaveBeenCalledOnce();

        const retainedMaterialized = await controlServerInput
            ?.agentRuntimeDaemonServices?.dispatch(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: {
                        token: 'd'.repeat(43),
                        sessionId: 'session-runner-admission',
                    },
                    operation: {
                        kind:
                            'plugin_services.managed_provider.materialize_agent_binding_v1',
                        requestId:
                            'retained-provider-materialize',
                        invocationId: 'invocation-p',
                        retained: retainedAuthority,
                        endpointUrl:
                            'http://127.0.0.1:4312/v1',
                        credentialPlaceholder:
                            'provider-placeholder-aaaaaaaaaaaaaaaa',
                    },
                }),
                daemonServiceContext,
            );
        expect(retainedMaterialized).toMatchObject({
            ok: false,
            error: {
                code:
                    'plugin_services_turn_authority_unavailable',
            },
        });

        await controlServerInput
            ?.agentRuntimeDaemonServices?.dispatch(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: {
                        token: 'd'.repeat(43),
                        sessionId: 'session-runner-admission',
                    },
                    operation: {
                        kind: 'plugin_services.close_v1',
                        requestId: 'retained-provider-close',
                        invocationId: 'invocation-p',
                    },
                }),
                daemonServiceContext,
            );
        expect(releaseRetainedPluginServicesLease)
            .toHaveBeenCalledTimes(4);
        expect(retainedProviderCleanup).toHaveBeenCalledOnce();

        const listener = [
            ...pluginRunningSessionDispositionListenersMock,
        ][0];
        expect(listener).toBeDefined();
        listener?.({
            durableRevision: 7,
            changedPluginIds: ['plugin.runner'],
            runningSessionDisposition:
                'retainRunningSessions',
        });
        expect(tracked.agentRuntimeDaemonServiceCapabilityHash)
            .toBe('capability-digest');
        expect(tracked.agentRuntimeDaemonServiceAdmittedTurnId)
            .toBe('turn-exact');

        listener?.({
            durableRevision: 8,
            changedPluginIds: ['plugin.runner'],
            runningSessionDisposition:
                'retainRunningSessions',
        });
        const ordinaryRemovalState = {
            capabilityHash:
                tracked
                    .agentRuntimeDaemonServiceCapabilityHash,
            retainedAgentGeneration:
                tracked
                    .runnerAgentImmutableGenerationId,
            admittedTurnId:
                tracked
                    .agentRuntimeDaemonServiceAdmittedTurnId,
        };
        const successor: TrackedSession = {
            pid: 91,
            sessionRunnerPid: 93,
            startedBy: 'daemon',
            happySessionId:
                'session-runner-admission',
            processStartTimeMs: 456,
            processCommandHash: '6'.repeat(64),
        };
        // A stale asynchronous callback from the observed ordinary
        // removal must never acquire authority over replacement custody.
        pidToTrackedSession.set(successor.pid, successor);

        const revokedPid = 94;
        const revokedChildProcess = {
            pid: revokedPid,
            exitCode: null as number | null,
            signalCode: null as NodeJS.Signals | null,
            kill: vi.fn(() => true),
        };
        const revokedTracked: TrackedSession = {
            pid: revokedPid,
            sessionRunnerPid: 95,
            startedBy: 'daemon',
            happySessionId: 'session-hard-revoked',
            childProcess: revokedChildProcess as never,
            processStartTimeMs: 789,
            processCommandHash: '7'.repeat(64),
        };
        const revokedRunner = Object.freeze({
            pid: 95,
            processStartTimeMs: 789,
            processCommandHash: '7'.repeat(64),
            snapshotIdentity: 'snapshot:runner',
        });
        const revokedAuthorityPath =
            await createAgentRuntimeDaemonServiceAuthorityPath({
                happyHomeDir: configuration.happyHomeDir,
                publicReleaseRing: configuration.publicReleaseRing,
            });
        const revokedAuthority =
            await publishAgentRuntimeDaemonServiceAuthority({
                happyHomeDir: configuration.happyHomeDir,
                publicReleaseRing: configuration.publicReleaseRing,
                path: revokedAuthorityPath,
                sessionId: 'session-hard-revoked',
                runner: revokedRunner,
                retainedAgent: binding,
                httpPort: 3210,
                expectedPluginHardRevocationRevision: 0,
                readPluginHardRevocationRevision: async () => 0,
            });
        revokedTracked.agentRuntimeDaemonServiceCapabilityHash =
            revokedAuthority.capabilityDigest;
        revokedTracked.agentRuntimeDaemonServiceAuthorityFilePath =
            revokedAuthority.path;
        revokedTracked.runnerAgentImmutableGenerationId =
            binding.immutableGenerationId;
        revokedTracked.activeTurnId = 'turn-hard-revoked';
        revokedTracked.agentRuntimeDaemonServiceAdmittedTurnId =
            'turn-hard-revoked';
        revokedTracked.agentRuntimeDaemonServiceAdmittedInputId =
            'input-hard-revoked';
        revokedTracked.agentRuntimeDaemonServiceAdmittedUserMessageSeq = 22;
        revokedTracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs = [22];
        pidToTrackedSession.set(revokedPid, revokedTracked);
        const nonTargetBinding =
            createAgentSessionRunnerFactoryBinding({
                v: 1,
                pluginId: 'plugin.runner',
                pluginVersion: '1.0.0',
                agentId: 'claude',
                localAgentId: 'claude',
                immutableGenerationId: 'generation-h',
                locator: {
                    module: './runtime.mjs',
                    export: 'createRuntime',
                    runtimeApiVersion: 1,
                },
                normalizedModulePath:
                    '/immutable/runtime.mjs',
                loadMode: 'immutable-js',
            });
        const nonTargetTracked: TrackedSession = {
            pid: 96,
            sessionRunnerPid: 97,
            startedBy: 'daemon',
            happySessionId: 'session-non-target-generation',
            processStartTimeMs: 790,
            processCommandHash: '8'.repeat(64),
            agentRuntimeDaemonServiceCapabilityHash:
                'non-target-capability-digest',
            runnerAgentImmutableGenerationId:
                nonTargetBinding.immutableGenerationId,
            agentRuntimeDaemonServiceAdmittedTurnId:
                'turn-non-target',
            agentRuntimeDaemonServiceAdmittedInputId:
                'input-non-target',
            agentRuntimeDaemonServiceAdmittedUserMessageSeq: 20,
            agentRuntimeDaemonServiceAdmittedUserMessageSeqs: [20],
        };
        pidToTrackedSession.set(nonTargetTracked.pid, nonTargetTracked);
        // The revocation lifecycle is under test here; PID inspection is
        // the genuine OS boundary covered by the stop-session owner.
        const pidSafetyModule = await import('../pidSafety');
        const pidSafetySpy = vi.spyOn(
            pidSafetyModule,
            'isPidSafeHappySessionProcess',
        ).mockResolvedValue(true);
        const processKill = vi.spyOn(process, 'kill')
            .mockImplementation(((targetPid: number, signal?: number | NodeJS.Signals) => {
                if (
                    targetPid === -revokedPid
                    && signal === 'SIGTERM'
                ) {
                    pidToTrackedSession.delete(revokedPid);
                    return true;
                }
                if (targetPid === revokedPid && signal === 0) {
                    if (pidToTrackedSession.has(revokedPid)) {
                        return true;
                    }
                    throw Object.assign(
                        new Error('process exited'),
                        { code: 'ESRCH' },
                    );
                }
                return true;
            }) as typeof process.kill);

        let resolvePendingMarkerRead: () => void = () => undefined;
        const pendingMarkerRead = new Promise<null>((resolve) => {
            resolvePendingMarkerRead = () => resolve(null);
        });
        readSessionMarkerForPidMock.mockReturnValue(pendingMarkerRead);
        listener?.({
            durableRevision: 9,
            changedPluginIds: ['plugin.runner'],
            runningSessionDisposition:
                'revokeRunningSessions',
            runningSessionRevocationScope: {
                pluginId: 'plugin.runner',
                immutableGenerationId: 'generation-g',
            },
        });
        await vi.waitFor(() => {
            expect(revokedTracked.agentRuntimeRunnerRestartDisposition)
                .toBe('runner_authority_unavailable');
            expect(
                revokedTracked.agentRuntimeDaemonServiceCapabilityHash,
            ).toBeUndefined();
            expect(
                revokedTracked.agentRuntimeDaemonServiceAdmittedTurnId,
            ).toBeUndefined();
            expect(
                revokedTracked.agentRuntimeDaemonServiceAdmittedInputId,
            ).toBeUndefined();
        });
        expect.soft(
            nonTargetTracked.agentRuntimeRunnerRestartDisposition,
        ).toBeUndefined();
        expect.soft(
            nonTargetTracked.agentRuntimeDaemonServiceCapabilityHash,
        ).toBe('non-target-capability-digest');
        expect.soft(
            nonTargetTracked.runnerAgentImmutableGenerationId,
        ).toBe(nonTargetBinding.immutableGenerationId);
        expect.soft(
            nonTargetTracked.agentRuntimeDaemonServiceAdmittedTurnId,
        ).toBe('turn-non-target');
        resolvePendingMarkerRead();
        pluginReloadStateMock.activeRegistry = {
            agentRuntimesByAgentId: new Map([
                ['runner-agent', {
                    hasPrimaryRuntime: true,
                    pluginId: 'plugin.runner',
                }],
            ]),
        };
        let hardRevocationStopped = false;
        try {
            await vi.waitFor(() => {
                expect(processKill).toHaveBeenCalledWith(
                    -revokedPid,
                    'SIGTERM',
                );
                expect(pidToTrackedSession.has(revokedPid))
                    .toBe(false);
                expect(revokedTracked.stopRequestedAtMs)
                    .toEqual(expect.any(Number));
            }, { timeout: 2_000 });
            hardRevocationStopped = true;
        } catch {
            hardRevocationStopped = false;
        }
        expect.soft(processKill).not.toHaveBeenCalledWith(
            -nonTargetTracked.pid,
            'SIGTERM',
        );
        pidSafetySpy.mockRestore();
        processKill.mockRestore();
        await runtime.stopControlServer();

        expect.soft(ordinaryRemovalState).toEqual({
            capabilityHash: 'capability-digest',
            retainedAgentGeneration: binding.immutableGenerationId,
            admittedTurnId: 'turn-exact',
        });
        expect.soft(pidToTrackedSession.get(successor.pid))
            .toBe(successor);
        expect.soft(revokedTracked.agentRuntimeDaemonServiceCapabilityHash)
            .toBeUndefined();
        expect.soft(nonTargetTracked.agentRuntimeRunnerRestartDisposition)
            .toBeUndefined();
        expect.soft(nonTargetTracked.agentRuntimeDaemonServiceCapabilityHash)
            .toBe('non-target-capability-digest');
        expect.soft(nonTargetTracked.runnerAgentImmutableGenerationId)
            .toBe(nonTargetBinding.immutableGenerationId);
        expect.soft(nonTargetTracked.agentRuntimeDaemonServiceAdmittedTurnId)
            .toBe('turn-non-target');
        expect.soft(hardRevocationStopped).toBe(true);
    });

    it('authorizes and publishes an exact Agent managed server with a nonempty correlation claim while rejecting unmatched Provider claims', async () => {
        const sourceRootPath = await mkdtemp(join(
            tmpdir(),
            'happier-agent-claim-source-',
        ));
        const toolRootPath = await mkdtemp(join(
            tmpdir(),
            'happier-agent-claim-tool-',
        ));
        const immutableGenerationId = `agent-claim-${createHash('sha256')
            .update(sourceRootPath)
            .digest('hex')
            .slice(0, 16)}`;
        const storePaths = resolvePluginStorePaths({
            happyHomeDir: configuration.happyHomeDir,
        });
        const immutableGenerationRoot = join(
            storePaths.generationsDir,
            immutableGenerationId,
        );
        const previousPath = process.env.PATH;
        let runtime: Awaited<
            ReturnType<typeof startDaemonSessionControlRuntime>
        > | null = null;
        try {
            const manifest = OPENCODE_PLUGIN_MANIFEST;
            const moduleBytes =
                'export function createRuntime() { throw new Error("unused"); }';
            await mkdir(join(sourceRootPath, '.happier-plugin'), {
                recursive: true,
            });
            await mkdir(join(sourceRootPath, 'agent'), {
                recursive: true,
            });
            await writeFile(
                join(
                    sourceRootPath,
                    '.happier-plugin',
                    'plugin.json',
                ),
                JSON.stringify(manifest),
                'utf8',
            );
            await writeFile(
                join(sourceRootPath, 'agent', 'runtime.mjs'),
                moduleBytes,
                'utf8',
            );
            const record =
                await createImmutablePluginGenerationRecordFromSource({
                    pluginId: manifest.id,
                    sourceRootPath,
                    manifestRelativePath:
                        '.happier-plugin/plugin.json',
                    distribution: {
                        kind: 'localPath',
                        canonicalPath: sourceRootPath,
                    },
                    updatePolicy: 'manual',
                    createdAtMs: 1,
                    immutableGenerationId,
                });
            await prepareImmutablePluginGeneration({
                paths: storePaths,
                sourceRootPath,
                record,
            });
            const locator = {
                module: './agent/runtime',
                export: 'createRuntime',
                runtimeApiVersion: 1 as const,
            };
            await persistValidatedAgentSessionRunnerFactories({
                paths: storePaths,
                record,
                manifestAuthority: 'bundled_first_party',
                factories: [{
                    localAgentId: 'opencode',
                    locator,
                    normalizedModulePath: 'agent/runtime.mjs',
                    loadMode: 'immutable-js',
                }],
            });
            const executablePath = join(toolRootPath, 'opencode');
            await writeFile(executablePath, '', 'utf8');
            await chmod(executablePath, 0o700);
            process.env.PATH = toolRootPath;

            const binding = createAgentSessionRunnerFactoryBinding({
                v: 1,
                pluginId: manifest.id,
                pluginVersion: manifest.version,
                agentId: 'opencode',
                localAgentId: 'opencode',
                immutableGenerationId,
                locator,
                normalizedModulePath: 'agent/runtime.mjs',
                loadMode: 'immutable-js',
            });
            const sessionId = 'session-agent-correlation-claim';
            const runner = Object.freeze({
                pid: 43120,
                processStartTimeMs: 1,
                processCommandHash: '2'.repeat(64),
                snapshotIdentity: 'snapshot:agent-correlation-claim',
            });
            runtime = await startDaemonSessionControlRuntime({
                machineId: 'machine-agent-correlation-claim',
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
                processEnv: { PATH: toolRootPath },
            });
            const dispatch = vi.mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0]
                .agentRuntimeDaemonServices?.dispatch;
            expect(dispatch).toBeDefined();
            const context = {
                sessionId,
                runner,
                retainedAgent: binding,
                invocationContext: {
                    cwd: '/workspace',
                    environment: {},
                    providerBindingActive: false,
                },
            };
            const requestContext = {
                token: 'e'.repeat(43),
                sessionId,
            };
            const contributionId =
                `${manifest.id}/agents/opencode`;
            const operationClaimId = sessionId;
            const supervision = await dispatch?.(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: requestContext,
                    operation: {
                        kind:
                            'managed_server.supervision.authorize',
                        requestId: 'authorize-agent-claim',
                        contributionId,
                        operationClaimId,
                        serverId: 'opencode-server',
                        executable: {
                            kind: 'systemTool',
                            id: 'opencode-cli',
                        },
                        environmentKeys: [],
                    },
                }),
                context,
            );
            expect(supervision).toMatchObject({
                ok: true,
                result: {
                    kind: 'managed_server.supervision',
                    status: 'authorized',
                    launch: {
                        kind: 'daemonResolved',
                        value: { command: executablePath },
                    },
                },
            });
            if (
                !supervision?.ok
                || supervision.result.kind
                    !== 'managed_server.supervision'
                || supervision.result.status !== 'authorized'
            ) {
                throw new Error(
                    'Expected Agent managed-server supervision authorization',
                );
            }

            const projection = {
                sessionId,
                pluginId: manifest.id,
                contributionId,
                operationClaimId,
                serverId: 'opencode-server',
                instanceId: 'opencode-agent-claim-instance',
                immutableGenerationId,
                custodyOwner: 'sessionRunner' as const,
                mode: 'externalAttach' as const,
                endpoint: {
                    baseUrl: 'http://127.0.0.1:43120',
                    host: '127.0.0.1' as const,
                    port: 43120,
                },
                process: null,
                createdAtMs: 1,
            };
            const published = await dispatch?.(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: requestContext,
                    operation: {
                        kind: 'managed_server.endpoint.publish',
                        requestId: 'publish-agent-claim',
                        projection,
                    },
                }),
                context,
            );
            expect(published).toMatchObject({
                ok: true,
                result: {
                    kind: 'managed_server.endpoint',
                    status: 'published',
                },
            });

            const providerContributionId =
                `${manifest.id}/providers/gateway`;
            await expect(dispatch?.(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: requestContext,
                    operation: {
                        kind:
                            'managed_server.supervision.authorize',
                        requestId:
                            'authorize-unmatched-provider-claim',
                        contributionId: providerContributionId,
                        operationClaimId:
                            'unknown-provider-operation-claim',
                        serverId: 'provider-server',
                        executable: {
                            kind: 'packaged-runtime-binary',
                            directorySegments: ['tools'],
                            executableBaseName: 'provider-server',
                        },
                        environmentKeys: [],
                    },
                }),
                context,
            )).rejects.toMatchObject({
                code: 'plugin_managed_server_contribution_denied',
            });
            const mismatchedProviderPublish = await dispatch?.(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    v: 1,
                    context: requestContext,
                    operation: {
                        kind: 'managed_server.endpoint.publish',
                        requestId:
                            'publish-unmatched-provider-claim',
                        projection: {
                            ...projection,
                            contributionId: providerContributionId,
                            operationClaimId:
                                'unknown-provider-operation-claim',
                            instanceId:
                                'unmatched-provider-claim-instance',
                        },
                    },
                }),
                context,
            );
            expect(mismatchedProviderPublish).toMatchObject({
                ok: true,
                result: {
                    kind: 'managed_server.endpoint',
                    status: 'unavailable',
                },
            });

            if (
                published?.ok
                && published.result.kind
                    === 'managed_server.endpoint'
                && published.result.status === 'published'
            ) {
                await expect(dispatch?.(
                    AgentRuntimeDaemonServiceRequestV1Schema.parse({
                        v: 1,
                        context: requestContext,
                        operation: {
                            kind:
                                'managed_server.endpoint.release',
                            requestId: 'release-agent-claim',
                            pluginId: manifest.id,
                            instanceId: projection.instanceId,
                            projectionToken:
                                published.result.projectionToken,
                        },
                    }),
                    context,
                )).resolves.toMatchObject({
                    ok: true,
                    result: {
                        kind: 'managed_server.endpoint',
                        status: 'released',
                        released: true,
                    },
                });
            }
        } finally {
            if (previousPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = previousPath;
            }
            await runtime?.stopControlServer();
            await rm(immutableGenerationRoot, {
                recursive: true,
                force: true,
            });
            await rm(sourceRootPath, { recursive: true, force: true });
            await rm(toolRootPath, { recursive: true, force: true });
        }
    });

    it.each([
        ['idle', false, 'success', false, false],
        ['idle before tracked projection refresh', false, 'success', false, true],
        ['active', true, 'success', false, false],
        [
            'active with an Agent and Provider from the same plugin',
            true,
            'success',
            true,
            false,
        ],
        ['active with an unavailable custody channel', true, 'stop', false, false],
        ['active with an invalid custody response', true, 'wrong', false, false],
        [
            'active after replacement custody took ownership',
            true,
            'stale',
            false,
            false,
        ],
    ] as const)(
        'proactively fences a distinct adopted Provider through the existing authenticated runner channel while the Agent is %s',
        async (_activity, active, fenceOutcome, combinedPlugin, markerOnly) => {
        const sessionId =
            `session-provider-hard-revocation-${fenceOutcome}-${active ? 'active' : 'idle'}`;
        const runtimeBindingBasis = ProviderRuntimeBindingBasisV1Schema.parse({
            v: 1,
            deployment: {
                kind: 'managedLocal',
                implementationIdentity: {
                    pluginId: 'plugin.provider',
                    localId: 'gateway',
                },
                managedRuntime: {
                    kind: 'managed',
                    endpointTemplateIds: ['messages'],
                    connectedAccounts: [],
                    requestAuthUses: [],
                },
                purposeBindings: { v: 1, bindings: [] },
            },
            agentTargetKey: 'backend:claude',
            connectionId: 'pc_provider_hard_revocation',
            contributionKey: 'plugin.provider/gateway',
            endpoint: {
                endpointTemplateId: 'messages',
                protocol: 'anthropic',
                publicHeaders: {},
            },
            runtimeCredentialTransport: null,
            prepared: { v: 1, materialization: 'spawnEnv' },
            adapterVersion: 1,
            credentialAuthorization: {
                connectionSecurityFingerprint: 'connection-security',
                grantFingerprint: 'grant',
            },
            agentSupport: {
                acceptsProtocols: ['anthropic'],
                required: { streaming: true },
                credentialSupport: {
                    supportsNoAuth: true,
                    apiKeyTransports: [],
                },
                authIsolation: {
                    suppressConnectedServiceIds: [],
                    ownedEnvKeys: [],
                },
                materialization: 'spawnEnv',
                applyPolicy: 'restart_session',
                supportsFreeformModelIds: true,
            },
        });
        const tracked: TrackedSession = {
            pid: 196,
            sessionRunnerPid: 197,
            startedBy: 'daemon',
            happySessionId: sessionId,
            processStartTimeMs: 789,
            processCommandHash: '7'.repeat(64),
            ...(markerOnly
                ? {}
                : {
                    runnerManagedDependencyRetentionV1: {
                        v: 1 as const,
                        adoptedManagedProviderAuthority: {
                            pluginId: 'plugin.provider',
                            immutableGenerationId: 'generation-provider',
                            manifestAuthority: 'external',
                            hardRevocationRevisionAtAdmission: 7,
                        },
                        sourceGenerationIds: [],
                        qualifiedDependencyIds: [],
                    },
                }),
            spawnOptions: {
                directory: '/workspace',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'claude',
                    sourceKind: 'built_in',
                },
                providerBindingMetadataV1:
                    SessionProviderBindingMetadataV1Schema.parse({
                        v: 1,
                        connectionId:
                            runtimeBindingBasis.connectionId,
                        contributionKey:
                            runtimeBindingBasis.contributionKey,
                        connectionRevision: 3,
                        protocol: 'anthropic',
                        materialization: 'spawnEnv',
                        compatibilityFingerprint: 'compatibility',
                        bindingSecurityFingerprint: 'binding-security',
                        runtimeBindingBasis,
                        displaySnapshot: {
                            providerName: 'Gateway',
                            connectionName: 'Local',
                            connectionRole: 'named',
                            connectionDisplayNameMode: 'custom',
                        },
                    }),
            },
        };
        const agentBinding = createAgentSessionRunnerFactoryBinding({
            v: 1,
            pluginId: combinedPlugin
                ? 'plugin.provider'
                : 'plugin.runner',
            pluginVersion: '1.0.0',
            agentId: 'runner-agent',
            localAgentId: 'runner-agent',
            immutableGenerationId: 'generation-g',
            locator: {
                module: './runtime.mjs',
                export: 'createRuntime',
                runtimeApiVersion: 1,
            },
            normalizedModulePath: '/immutable/runtime.mjs',
            loadMode: 'immutable-js',
        });
        const agentRunner = Object.freeze({
            pid: 197,
            processStartTimeMs: 789,
            processCommandHash: '7'.repeat(64),
            snapshotIdentity: 'snapshot:runner',
        });
        if (active) {
            tracked.activeTurnId = 'turn-active';
            tracked.runnerAgentImmutableGenerationId =
                agentBinding.immutableGenerationId;
            tracked.agentRuntimeDaemonServiceAdmittedTurnId =
                'turn-active';
            tracked.agentRuntimeDaemonServiceAdmittedInputId =
                'input-active';
            tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeq = 21;
            tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs = [21];
            tracked.agentRuntimeDaemonServiceCapabilityHash =
                'active-agent-capability';
        }
        if (combinedPlugin) {
            const authorityPath =
                await createAgentRuntimeDaemonServiceAuthorityPath({
                    happyHomeDir: configuration.happyHomeDir,
                    publicReleaseRing: configuration.publicReleaseRing,
                });
            const authority =
                await publishAgentRuntimeDaemonServiceAuthority({
                    happyHomeDir: configuration.happyHomeDir,
                    publicReleaseRing: configuration.publicReleaseRing,
                    path: authorityPath,
                    sessionId,
                    runner: agentRunner,
                    retainedAgent: agentBinding,
                    httpPort: 3210,
                    expectedPluginHardRevocationRevision: 0,
                    readPluginHardRevocationRevision: async () => 0,
                });
            tracked.agentRuntimeDaemonServiceAuthorityFilePath =
                authority.path;
            tracked.agentRuntimeDaemonServiceCapabilityHash =
                authority.capabilityDigest;
        }
        if (markerOnly) {
            readSessionMarkerForPidMock.mockImplementation(async (pid) => (
                pid === tracked.sessionRunnerPid
                    ? {
                        pid,
                        happySessionId: sessionId,
                        startedBy: 'daemon',
                        happyHomeDir: '/tmp/happier-test-home',
                        processStartTimeMs:
                            tracked.processStartTimeMs,
                        processCommandHash:
                            tracked.processCommandHash,
                        runnerManagedDependencyRetentionV1: {
                            v: 1,
                            adoptedManagedProviderAuthority: {
                                pluginId: 'plugin.provider',
                                immutableGenerationId:
                                    'generation-provider',
                                manifestAuthority: 'external',
                                hardRevocationRevisionAtAdmission: 7,
                            },
                            sourceGenerationIds: [],
                            qualifiedDependencyIds: [],
                        },
                        createdAt: 1,
                        updatedAt: 1,
                    }
                    : null
            ));
        }
        const runnerMustStop = combinedPlugin
            || fenceOutcome === 'stop'
            || fenceOutcome === 'wrong';
        if (runnerMustStop) {
            tracked.childProcess = {
                pid: tracked.pid,
                exitCode: null,
                signalCode: null,
                kill: vi.fn(() => true),
            } as never;
        }
        fetchSessionByIdMock.mockResolvedValue({
            id: sessionId,
            encryptionMode: 'plain',
        } as never);
        const fenceError = new Error(
            'runner custody channel unavailable',
        );
        let rejectFence: (reason?: unknown) => void = () => undefined;
        if (fenceOutcome === 'success') {
            vi.mocked(callSessionRpc).mockResolvedValue({
                v: 1,
                kind: 'hardRevocationFenced',
                fencedServiceCount: 1,
            });
        } else if (fenceOutcome === 'wrong') {
            vi.mocked(callSessionRpc).mockResolvedValue({
                v: 1,
                kind: 'disposed',
            });
        } else {
            const pendingFence = new Promise<never>((_resolve, reject) => {
                rejectFence = reject;
            });
            vi.mocked(callSessionRpc).mockImplementation(
                async () => await pendingFence,
            );
        }
        const coexistingTracked = fenceOutcome === 'stale'
            ? {
                ...tracked,
                pid: 198,
                sessionRunnerPid: 199,
                processStartTimeMs: 791,
                processCommandHash: '9'.repeat(64),
            }
            : null;
        const pidToTrackedSession = new Map([
            [tracked.pid, tracked],
            ...(coexistingTracked
                ? [[coexistingTracked.pid, coexistingTracked] as const]
                : []),
        ]);
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
        const listener = [
            ...pluginRunningSessionDispositionListenersMock,
        ][0];
        expect(listener).toBeDefined();
        const processKill = runnerMustStop || fenceOutcome === 'stale'
            ? vi.spyOn(process, 'kill').mockImplementation((
                (targetPid: number, signal?: number | NodeJS.Signals) => {
                    if (
                        targetPid === -tracked.pid
                        && signal === 'SIGTERM'
                    ) {
                        pidToTrackedSession.delete(tracked.pid);
                        return true;
                    }
                    if (targetPid === tracked.pid && signal === 0) {
                        if (pidToTrackedSession.has(tracked.pid)) {
                            return true;
                        }
                        throw Object.assign(
                            new Error('process exited'),
                            { code: 'ESRCH' },
                        );
                    }
                    return true;
                }
            ) as typeof process.kill)
            : null;
        const pidSafetyModule =
            runnerMustStop
                ? await import('../pidSafety')
                : null;
        const pidSafetySpy = pidSafetyModule
            ? vi.spyOn(
                pidSafetyModule,
                'isPidSafeHappySessionProcess',
            ).mockResolvedValue(true)
            : null;

        listener?.({
            durableRevision: 10,
            changedPluginIds: ['plugin.provider'],
            runningSessionDisposition: 'retainRunningSessions',
        });
        await Promise.resolve();
        expect(callSessionRpc).not.toHaveBeenCalled();

        listener?.({
            durableRevision: 11,
            changedPluginIds: ['plugin.provider'],
            runningSessionDisposition: 'revokeRunningSessions',
        });
        const expectAgentAuthorityPreserved = (
            candidate: TrackedSession,
        ) => {
            expect(candidate.agentRuntimeRunnerRestartDisposition)
                .toBeUndefined();
            if (!active) return;
            expect(candidate.agentRuntimeDaemonServiceCapabilityHash)
                .toBe(combinedPlugin
                    ? tracked.agentRuntimeDaemonServiceCapabilityHash
                    : 'active-agent-capability');
            expect(candidate.runnerAgentImmutableGenerationId)
                .toBe(agentBinding.immutableGenerationId);
            expect(candidate.agentRuntimeDaemonServiceAdmittedTurnId)
                .toBe('turn-active');
            expect(candidate.agentRuntimeDaemonServiceAdmittedInputId)
                .toBe('input-active');
        };
        if (combinedPlugin) {
            await vi.waitFor(() => {
                expect(tracked.agentRuntimeRunnerRestartDisposition)
                    .toBe('runner_authority_unavailable');
                expect(tracked).toMatchObject({
                    activeTurnId: 'turn-active',
                });
                expect(tracked.agentRuntimeDaemonServiceCapabilityHash)
                    .toBeUndefined();
                expect(tracked.agentRuntimeDaemonServiceAdmittedTurnId)
                    .toBeUndefined();
            });
        } else {
            expectAgentAuthorityPreserved(tracked);
            if (coexistingTracked) {
                expectAgentAuthorityPreserved(coexistingTracked);
            }
        }
        await vi.waitFor(() => {
            expect(callSessionRpc).toHaveBeenCalledWith({
                token: 'token-daemon',
                sessionId,
                method:
                    `${sessionId}:${RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD}`,
                request: {
                    v: 1,
                    kind: 'fenceHardRevocation',
                    pluginId: 'plugin.provider',
                },
                mode: 'plain',
            });
        });
        expect(callSessionRpc).toHaveBeenCalledTimes(1);
        if (!combinedPlugin) {
            expectAgentAuthorityPreserved(tracked);
            if (coexistingTracked) {
                expectAgentAuthorityPreserved(coexistingTracked);
            }
        }
        if (fenceOutcome !== 'success') {
            const successor: TrackedSession | null =
                fenceOutcome === 'stale'
                    ? {
                        ...tracked,
                        processStartTimeMs: 790,
                        processCommandHash: '8'.repeat(64),
                    }
                    : null;
            if (successor) {
                pidToTrackedSession.set(tracked.pid, successor);
            }
            rejectFence(fenceError);
            if (runnerMustStop) {
                await vi.waitFor(() => {
                    expect(processKill).toHaveBeenCalledWith(
                        -tracked.pid,
                        'SIGTERM',
                    );
                    expect(tracked.stopRequestedAtMs)
                        .toEqual(expect.any(Number));
                    expect(pidToTrackedSession.has(tracked.pid))
                        .toBe(false);
                });
            } else {
                await vi.waitFor(() => {
                    expect(logger.debug).toHaveBeenCalledWith(
                        '[DAEMON RUN] Failed to fence hard-revoked managed Provider custody',
                        fenceError,
                    );
                });
                expect(processKill).not.toHaveBeenCalledWith(
                    -tracked.pid,
                    'SIGTERM',
                );
                expect(pidToTrackedSession.get(tracked.pid))
                    .toBe(successor);
            }
        } else if (runnerMustStop) {
            await vi.waitFor(() => {
                expect(processKill).toHaveBeenCalledWith(
                    -tracked.pid,
                    'SIGTERM',
                );
                expect(tracked.stopRequestedAtMs)
                    .toEqual(expect.any(Number));
                expect(pidToTrackedSession.has(tracked.pid))
                    .toBe(false);
            });
        } else if (active) {
            expect(tracked.stopRequestedAtMs).toBeUndefined();
        }
        listener?.({
            durableRevision: 12,
            changedPluginIds: ['plugin.provider'],
            runningSessionDisposition: 'retainRunningSessions',
        });
        await Promise.resolve();
        expect(callSessionRpc).toHaveBeenCalledTimes(1);
        if (combinedPlugin) {
            expect(tracked.agentRuntimeRunnerRestartDisposition)
                .toBe('runner_authority_unavailable');
        } else {
            expectAgentAuthorityPreserved(tracked);
        }
        processKill?.mockRestore();
        pidSafetySpy?.mockRestore();
        await runtime.stopControlServer();
    });

    it('keeps a validated Action bound to witness A when registry acquisition races with admission B', async () => {
        const tracked: TrackedSession = {
            pid: 94,
            sessionRunnerPid: 95,
            startedBy: 'daemon',
            happySessionId: 'session-action-witness-race',
        };
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-action-witness-race',
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
        const controlServerInput =
            vi.mocked(startDaemonControlServer)
                .mock.calls.at(-1)?.[0];
        const binding = createAgentSessionRunnerFactoryBinding({
            v: 1,
            pluginId: 'plugin.runner',
            pluginVersion: '1.0.0',
            agentId: 'claude',
            localAgentId: 'claude',
            immutableGenerationId: 'generation-action-g',
            locator: {
                module: './runtime.mjs',
                export: 'createRuntime',
                runtimeApiVersion: 1,
            },
            normalizedModulePath: '/immutable/runtime.mjs',
            loadMode: 'immutable-js',
        });
        const runner = Object.freeze({
            pid: tracked.sessionRunnerPid!,
            processStartTimeMs: 123,
            processCommandHash: '5'.repeat(64),
            snapshotIdentity: 'snapshot:action-witness-race',
        });
        const witnessA = Object.freeze({
            turnId: 'turn-a',
            inputId: 'input-a',
            userMessageSeq: 1,
            userMessageSeqs: Object.freeze([1]),
        });
        const witnessB = Object.freeze({
            turnId: 'turn-b',
            inputId: 'input-b',
            userMessageSeq: 2,
            userMessageSeqs: Object.freeze([2]),
        });
        Object.assign(tracked, {
            processStartTimeMs: runner.processStartTimeMs,
            processCommandHash: runner.processCommandHash,
            runnerAgentImmutableGenerationId:
                binding.immutableGenerationId,
            runnerAgentInvocationContext: {
                cwd: '/workspace',
                environment: {},
                providerBindingActive: false,
            },
            agentRuntimeDaemonServiceAdmittedTurnId: witnessA.turnId,
            agentRuntimeDaemonServiceAdmittedInputId: witnessA.inputId,
            agentRuntimeDaemonServiceAdmittedUserMessageSeq:
                witnessA.userMessageSeq,
            agentRuntimeDaemonServiceAdmittedUserMessageSeqs:
                [...witnessA.userMessageSeqs],
        });
        const daemonServiceContext = {
            sessionId: tracked.happySessionId!,
            runner,
            retainedAgent: binding,
            invocationContext: tracked.runnerAgentInvocationContext!,
            trackedSession: tracked,
        };
        const actionEffect = vi.fn(async () => ({
            ok: true as const,
            result: [],
        }));
        const runnerMaterialization = createPluginActionCallerMaterializationFixture(
            'plugin.runner',
        );
        const createCurrentActions = vi.fn(async (input: Readonly<{
            isGenerationCurrent(): boolean;
        }>) => createPluginInvocationActionsService({
            seed: {
                plugin: {
                    id: 'plugin.runner',
                    version: '1.0.0',
                },
                resolveCurrentPluginMaterializationRef:
                    runnerMaterialization.resolveCurrentPluginMaterializationRef,
                generation: 'generation-current',
                surface: 'agent',
                session: { id: tracked.happySessionId! },
                signal: new AbortController().signal,
                isGenerationCurrent:
                    input.isGenerationCurrent,
            },
            actionExecutor: { execute: actionEffect },
            invokeContributedAction: async () => {
                throw new Error('generation-private action was not expected');
            },
        }));
        const registry = {
            contributes: {
                resources: [],
                agentDefinitionsById: new Map(),
            },
            agentRuntimesByAgentId: new Map(),
            createRetainedRunnerAgentInvocationServices:
                vi.fn(async () => ({
                    services: createUnavailablePluginServices(),
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                })),
            createRetainedRunnerAgentCurrentGlobalActionsService:
                createCurrentActions,
        };
        let releaseActionLease!: () => void;
        const actionLeaseGate = new Promise<void>((resolve) => {
            releaseActionLease = resolve;
        });
        let actionLeaseRequested!: () => void;
        const actionLeaseEntered = new Promise<void>((resolve) => {
            actionLeaseRequested = resolve;
        });
        acquireAuthoritativePluginRuntimeRegistryLeaseMock
            .mockReset();
        acquireAuthoritativePluginRuntimeRegistryLeaseMock
            .mockResolvedValue({
                registry,
                source: 'active',
                release: vi.fn(async () => {}),
            });
        try {
            await expect(controlServerInput
                ?.agentRuntimeDaemonServices?.dispatch(
                    AgentRuntimeDaemonServiceRequestV1Schema.parse({
                        v: 1,
                        context: {
                            token: 'e'.repeat(43),
                            sessionId: tracked.happySessionId!,
                        },
                        operation: {
                            kind: 'plugin_services.prepare_v1',
                            requestId: 'prepare-action-race',
                            invocationId: 'invocation-action-race',
                            witness: witnessA,
                        },
                    }),
                    daemonServiceContext,
                )).resolves.toMatchObject({ ok: true });

            acquireAuthoritativePluginRuntimeRegistryLeaseMock
                .mockReset();
            acquireAuthoritativePluginRuntimeRegistryLeaseMock
                .mockImplementation(async () => {
                    actionLeaseRequested();
                    await actionLeaseGate;
                    return {
                        registry,
                        source: 'active',
                        release: vi.fn(async () => {}),
                    };
                });

            const action = controlServerInput
                ?.agentRuntimeDaemonServices?.dispatch(
                    AgentRuntimeDaemonServiceRequestV1Schema.parse({
                        v: 1,
                        context: {
                            token: 'e'.repeat(43),
                            sessionId: tracked.happySessionId!,
                        },
                        operation: {
                            kind: 'plugin_actions.execute_v1',
                            requestId: 'execute-action-race',
                            invocationId: 'invocation-action-race',
                            witness: witnessA,
                            actionId: 'session.list',
                            input: { t: 'object', value: {} },
                        },
                    }),
                    daemonServiceContext,
                );
            await actionLeaseEntered;
            Object.assign(tracked, {
                agentRuntimeDaemonServiceAdmittedTurnId:
                    witnessB.turnId,
                agentRuntimeDaemonServiceAdmittedInputId:
                    witnessB.inputId,
                agentRuntimeDaemonServiceAdmittedUserMessageSeq:
                    witnessB.userMessageSeq,
                agentRuntimeDaemonServiceAdmittedUserMessageSeqs:
                    [...witnessB.userMessageSeqs],
            });
            releaseActionLease();

            await expect(action).resolves.toMatchObject({
                ok: false,
                error: {
                    code:
                        'plugin_services_turn_authority_unavailable',
                },
            });
            expect(actionEffect).not.toHaveBeenCalled();
        } finally {
            releaseActionLease();
            await runtime.stopControlServer();
        }
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
                                        materializationKinds:
                                            ['httpHeaders'],
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
                        `execution-run:${runId}/runner:${runnerPid}/agent:codex`,
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

    it('makes explicit Stop supersede automatic recovery while keeping later internal resumes stop-fenced', async () => {
        const stoppedSessionId = 'session-internal-resume-stop-fence';
        const crashedSessionId = 'session-unstopped-crash';
        const pidToTrackedSession = new Map<number, TrackedSession>();
        const cancelInactiveUsageLimitRecovery = vi.fn(async () => null);
        const stageUsageLimitRecoveryMutation = vi.fn(async () => undefined);
        const cancelRuntimeAuthRecovery = vi
            .spyOn(RuntimeAuthRecoveryScheduler.prototype, 'cancel')
            .mockResolvedValue(null);
        const cancelTemporaryThrottleRecovery = vi
            .spyOn(ConnectedServiceTemporaryThrottleRetryScheduler.prototype, 'cancel')
            .mockResolvedValue(null);
        fetchSessionByIdCompatMock.mockResolvedValue({
            id: stoppedSessionId,
            metadata: JSON.stringify({
                sessionUsageLimitRecoveryV1: {
                    v: 1,
                    status: 'waiting',
                    resumePromptMode: 'standard',
                    issueFingerprint: 'replacement',
                    armedAtMs: 2_000,
                    runtimeAuthRecoveryAttemptId: 'runtime-b',
                    resetAtMs: 5_000,
                    nextCheckAtMs: 5_000,
                    attemptCount: 1,
                    maxAttempts: 3,
                    lastProbeError: null,
                    selectedAuth: { kind: 'native' },
                },
            }),
            metadataVersion: 1,
            encryptionMode: 'plain',
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
            cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop: cancelInactiveUsageLimitRecovery,
            daemonSessionMutationCustody: {
                stage: stageUsageLimitRecoveryMutation,
                async stageTranscriptEvent() {
                    return { persisted: true, delivered: true };
                },
            } as never,
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
            expect(cancelInactiveUsageLimitRecovery).toHaveBeenCalledWith({ sessionId: stoppedSessionId });
            expect(cancelRuntimeAuthRecovery).toHaveBeenCalledWith({ sessionId: stoppedSessionId });
            expect(cancelTemporaryThrottleRecovery).toHaveBeenCalledWith({ sessionId: stoppedSessionId });
            expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledWith(expect.objectContaining({
                mutation: expect.objectContaining({
                    sessionId: stoppedSessionId,
                    fieldId: 'runtime.usageLimitRecovery',
                    op: expect.objectContaining({
                        kind: 'set',
                        value: expect.objectContaining({
                            issueFingerprint: 'replacement',
                            runtimeAuthRecoveryAttemptId: 'runtime-b',
                            status: 'cancelled',
                            nextCheckAtMs: null,
                        }),
                    }),
                }),
                rawSession: expect.objectContaining({ id: stoppedSessionId }),
            }));
            cancelInactiveUsageLimitRecovery.mockRejectedValueOnce(
                new Error('durable recovery store unavailable'),
            );
            await expect(runtime.stopSession(stoppedSessionId)).resolves.toEqual({ status: 'not_found' });
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
            cancelRuntimeAuthRecovery.mockRestore();
            cancelTemporaryThrottleRecovery.mockRestore();
        }
    });

    it('threads an exact hard-revocation runner witness through asynchronous logical-stop cleanup', async () => {
        const sessionId = 'session-hard-revocation-cleanup-race';
        const pid = 8_803;
        const originalChildKill = vi.fn(() => true);
        const successorChildKill = vi.fn(() => true);
        const original: TrackedSession = {
            pid,
            sessionRunnerPid: 8_804,
            startedBy: 'daemon',
            happySessionId: sessionId,
            childProcess: {
                pid,
                exitCode: null,
                signalCode: null,
                kill: originalChildKill,
            } as never,
            processStartTimeMs: 1_000,
            processCommandHash: 'original-command',
        };
        const successor: TrackedSession = {
            ...original,
            sessionRunnerPid: 8_805,
            childProcess: {
                pid,
                exitCode: null,
                signalCode: null,
                kill: successorChildKill,
            } as never,
            processStartTimeMs: 2_000,
            processCommandHash: 'successor-command',
        };
        const pidToTrackedSession = new Map([[pid, original]]);
        removeRuntimeAuthFailureReportOutboxItemsForSessionMock
            .mockImplementationOnce(async (input) => {
                expect(input.sessionId).toBe(sessionId);
                pidToTrackedSession.set(pid, successor);
            });
        const pidSafetyModule = await import('../pidSafety');
        const pidSafetySpy = vi.spyOn(
            pidSafetyModule,
            'isPidSafeHappySessionProcess',
        ).mockResolvedValue(true);
        const killSpy = vi.spyOn(process, 'kill')
            .mockImplementation(((targetPid: number, signal?: number | NodeJS.Signals) => {
                if (targetPid === -pid && signal === 'SIGTERM') {
                    pidToTrackedSession.delete(pid);
                }
                if (targetPid === pid && signal === 0) {
                    if (pidToTrackedSession.has(pid)) return true;
                    throw Object.assign(new Error('process exited'), {
                        code: 'ESRCH',
                    });
                }
                return true;
            }) as typeof process.kill);
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-hard-revocation-cleanup-race',
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

        try {
            const stopSessionWithExpectedRunner: (
                sessionId: string,
                options: StopSessionOptions,
            ) => ReturnType<typeof runtime.stopSession> =
                runtime.stopSession;
            await expect(stopSessionWithExpectedRunner(sessionId, {
                expectedTrackedRunner: {
                    tracked: original,
                    sessionRunnerPid: original.sessionRunnerPid,
                    processStartTimeMs: original.processStartTimeMs,
                    processCommandHash: original.processCommandHash,
                },
            })).resolves.toEqual({ status: 'not_found' });
            expect(pidToTrackedSession.get(pid)).toBe(successor);
            expect(killSpy).not.toHaveBeenCalledWith(-pid, 'SIGTERM');
            expect(originalChildKill).not.toHaveBeenCalled();
            expect(successorChildKill).not.toHaveBeenCalled();
            expect(successor.stopRequestedAtMs).toBeUndefined();
        } finally {
            pidSafetySpy.mockRestore();
            killSpy.mockRestore();
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
            authority: { kind: 'generation' as const, publisherGeneration: '12' },
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
                authority: { kind: 'generation' as const, publisherGeneration: '31' },
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
                authority: { kind: 'generation', publisherGeneration: '31' },
            }));

            removeSessionMarkerIfOwnedMock.mockClear();
            captureMachineSessionTerminal
                .mockResolvedValueOnce({
                    v: 1,
                    status: 'captured',
                    sessionId: 'session-pre-webhook-cycle',
                    authority: { kind: 'generation' as const, publisherGeneration: '21' },
                })
                .mockResolvedValueOnce({
                    v: 1,
                    status: 'captured',
                    sessionId: 'session-pre-webhook-cycle',
                    authority: { kind: 'generation' as const, publisherGeneration: '22' },
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
                authority: { kind: 'generation', publisherGeneration: '22' },
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
                    authority: { kind: 'generation' as const, publisherGeneration: '61' },
                })
                .mockResolvedValueOnce({
                    v: 1,
                    status: 'captured',
                    sessionId: 'session-pre-webhook-success',
                    authority: { kind: 'generation' as const, publisherGeneration: '62' },
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
                    authority: { kind: 'generation' as const, publisherGeneration: '41' },
                })
                .mockResolvedValueOnce({
                    v: 1,
                    status: 'captured',
                    sessionId: 'session-late-success',
                    authority: { kind: 'generation' as const, publisherGeneration: '42' },
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
                authority: { kind: 'generation', publisherGeneration: '42' },
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

    it('routes a same-daemon final runner exit through exact terminal-host retirement', async () => {
        const sessionId = 'session-same-daemon-runner-exit';
        const trackedPid = 2_147_482_998;
        const attachment = await writeTerminalHostAttachmentInfo({
            happyHomeDir: configuration.happyHomeDir,
            sessionId,
            handle: {
                kind: 'tmux',
                sessionName: 'happier-same-daemon-runner-exit',
                paneId: 'pane-runner-exit',
                attachMetadata: {
                    attachStrategy: 'terminal_host',
                    topology: 'shared',
                    locality: 'same_machine',
                    liveProbe: 'required',
                },
            },
        });
        const dispose = vi.fn(async () => undefined);
        const trackedSessions = new Map<number, TrackedSession>([[
            trackedPid,
            {
                startedBy: 'daemon',
                happySessionId: sessionId,
                pid: trackedPid,
                happySessionMetadataFromLocalWebhook: {
                    path: '/tmp/project',
                    host: 'daemon',
                    name: 'same-daemon-runner-exit',
                    homeDir: '/tmp/home',
                    happyHomeDir: configuration.happyHomeDir,
                    happyLibDir: '/tmp/home/.happier/lib',
                    happyToolsDir: '/tmp/home/.happier/tools',
                    terminal: {
                        mode: 'tmux',
                        tmux: { target: 'happier-same-daemon-runner-exit:pane-runner-exit' },
                    },
                },
            },
        ]]);
        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-same-daemon-runner-exit',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession: trackedSessions,
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            loadTerminalHostAdapters: async () => ({
                tmux: {
                    kind: 'tmux',
                    createOrAttachHost: vi.fn(),
                    injectUserPrompt: vi.fn(),
                    interruptTurn: vi.fn(),
                    evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
                    dispose,
                },
            }),
            startupTerminalRecovery: {
                disconnectedTerminalHostCandidates: [],
                unresolvedTerminalHostSessionIds: [],
            },
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });
        try {
            await runtime.onChildExited(trackedPid, {
                reason: 'process-exited',
                code: 0,
                signal: null,
            });
            expect(trackedSessions.has(trackedPid)).toBe(false);

            await expect(runtime.stopSession(sessionId)).resolves.toEqual({ status: 'stopped' });
            expect(dispose).toHaveBeenCalledWith(attachment.handle);
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

    it('does not retain Agent catalog managed-server claim ownership', () => {
        const source = readStartDaemonSessionControlRuntimeSource();
        expect(source).not.toMatch(/listManagedServerClaimDescriptors/);
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

        try {
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
        } finally {
            await runtime.stopControlServer();
        }
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

        const runtime = await startDaemonSessionControlRuntime({
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
            deriveCredentialFingerprintFromSource: true,
        });
        await expect(Promise.race([
            intake,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
        ])).resolves.toEqual({
            status: 'snapshot_advanced',
            recordId: snapshot.recordId,
            persisted: true,
        });
        expect(runtimeRegistry.getBySessionId('sess_usage_group')?.activeBindings).toContainEqual(
            expect.objectContaining({
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'team',
                groupGeneration: 7,
            }),
        );
        expect(runtime.providerAccountUsageStore.resolveBySource({
            serviceId: 'openai-codex',
            profileId: 'primary',
            bindingKind: 'group_member',
            groupId: 'team',
            groupGeneration: 7,
        })?.recordId).toBe(snapshot.recordId);
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
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'codex-main',
                        activeProfileId: 'primary',
                        fallbackProfileId: 'primary',
                        generation: 6,
                    }]),
                },
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

        applyConnectedServiceAuthGenerationToTrackedSessionMock.mockClear();
        await expect(runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator.applyCredentialUpdate({
            sessionId: 'sess-quota-switch',
            serviceId: 'openai-codex',
            profileId: 'primary',
            reason: 'account_changed',
            executionAuthority: 'runtime_recovery',
        })).resolves.toEqual({ status: 'hot_applied' });
        expect(applyConnectedServiceAuthGenerationToTrackedSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                request: expect.objectContaining({
                    sessionId: 'sess-quota-switch',
                    expectedGroupGenerationByServiceId: { 'openai-codex': 6 },
                }),
            }),
        );

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

    it('reconciles a reattached direct profile only after the canonical materialization owner is ready without daemon secret projection', async () => {
        const materializationBaseDir = await mkdtemp(
            join(tmpdir(), 'happier-reattached-direct-projection-'),
        );
        const activeServerDir = await mkdtemp(
            join(tmpdir(), 'happier-reattached-direct-server-'),
        );
        const serviceId = 'openai-codex' as const;
        const profileId = 'primary';
        const oldCredentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
        const currentCredentialRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
        const currentCredential = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId,
            profileId,
            kind: 'oauth',
            expiresAt: null,
            oauth: {
                accessToken: 'current-reattached-access',
                refreshToken: 'current-reattached-refresh',
                idToken: 'current-reattached-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'current-reattached-account',
                providerEmail: null,
            },
        });
        const connectedServices = {
            v: 1,
            bindingsByServiceId: {
                [serviceId]: {
                    source: 'connected',
                    selection: 'profile',
                    profileId,
                },
            },
        } satisfies ConnectedServiceBindingsV1;
        const environmentVariables = {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                kind: 'profile',
                serviceId,
                profileId,
                credentialRevision: oldCredentialRevision,
            }]),
        };
        const trackedSessions = new Map<number, TrackedSession>([
            [7811, {
                startedBy: 'daemon',
                happySessionId: 'sess-reattached-direct-a',
                pid: 7811,
                reattachedFromDiskMarker: true,
                spawnOptions: {
                    directory: '/tmp/reattached-direct-a',
                    backendTarget: {
                        kind: 'backend',
                        backendId: 'codex',
                        sourceKind: 'built_in',
                    },
                    connectedServiceMaterializationIdentityV1: {
                        v: 1,
                        id: 'csm_reattached_direct_a',
                        createdAt: 1,
                    },
                    connectedServices,
                    environmentVariables,
                },
            }],
            [7812, {
                startedBy: 'daemon',
                happySessionId: 'sess-reattached-direct-b',
                pid: 7812,
                reattachedFromDiskMarker: true,
                spawnOptions: {
                    directory: '/tmp/reattached-direct-b',
                    backendTarget: {
                        kind: 'backend',
                        backendId: 'codex',
                        sourceKind: 'built_in',
                    },
                    connectedServiceMaterializationIdentityV1: {
                        v: 1,
                        id: 'csm_reattached_direct_b',
                        createdAt: 1,
                    },
                    connectedServices,
                    environmentVariables,
                },
            }],
        ]);
        const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
        const getConnectedServiceCredentialPlain = vi.fn(async () => ({
            revisionSemantics: 'revisioned' as const,
            credentialRevision: currentCredentialRevision,
            content: { t: 'plain' as const, v: currentCredential },
        }));
        const api = {
            getAccountEncryptionMode: vi.fn(async () => 'plain'),
            getConnectedServiceCredentialPlain,
            getConnectedServiceAuthGroup: vi.fn(async () => null),
            listConnectedServiceProfiles: vi.fn(async () => ({
                serviceId,
                profiles: [{ profileId, status: 'connected' as const }],
            })),
            push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
        };
        let refreshCoordinator: ConnectedServiceRefreshCoordinator | null = null;
        const accountProfileGet = vi.spyOn(axios, 'get').mockResolvedValue({
            status: 200,
            data: {
                id: 'account-reattached-direct',
                connectedServicesV2: [{
                    serviceId,
                    profiles: [{
                        profileId,
                        status: 'connected',
                        kind: 'oauth',
                    }],
                    groups: [],
                }],
                connectedServiceCredentialRevisionsV1: [{
                    serviceId,
                    profileId,
                    credentialRevision: currentCredentialRevision,
                }],
            },
        });
        fetchSessionByIdCompatMock.mockResolvedValue(null);

        let runtime: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | null = null;
        try {
            runtime = await startDaemonSessionControlRuntime({
                machineId: 'machine-reattached-direct',
                credentials: {
                    token: 'token-daemon',
                    encryption: {
                        type: 'legacy',
                        secret: new Uint8Array(32).fill(1),
                    },
                },
                api: api as never,
                loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
                connectedServicesMaterializationBaseDir: materializationBaseDir,
                getConnectedServiceRefreshCoordinator: () => refreshCoordinator,
                getConnectedServiceQuotasCoordinator: () => null,
                connectedServiceRuntimeRegistry,
                pidToTrackedSession: trackedSessions,
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

            await waitForStartupCondition(
                () => fetchSessionByIdCompatMock.mock.calls.length >= 2,
            );
            await new Promise((resolve) => setImmediate(resolve));

            expect(getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
            expect(vi.mocked(logger.debug).mock.calls.filter(([message]) =>
                message === '[DAEMON RUN] Failed to reconcile connected-service provider adoption after daemon replacement',
            )).toHaveLength(0);

            const resolveQualifiedPurposeBindingSnapshot: NonNullable<
                ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['resolveQualifiedPurposeBindingSnapshot']
            > = async (input) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                agentId: input.agentId,
                bindings: ConnectedServiceBindingsV1Schema.parse(
                    input.connectedServicesBindingsRaw,
                ),
                contributions: getResolvedContributionRegistry(),
            });
            await expect(resolveQualifiedPurposeBindingSnapshot({
                agentId: 'codex',
                connectedServicesBindingsRaw: connectedServices,
            })).resolves.toMatchObject({
                bindings: [expect.objectContaining({
                    target: expect.objectContaining({
                        account: expect.objectContaining({
                            accountId: profileId,
                        }),
                    }),
                })],
            });
            refreshCoordinator = new ConnectedServiceRefreshCoordinator({
                api: api as never,
                credentials: {
                    token: 'token-daemon',
                    encryption: {
                        type: 'legacy',
                        secret: new Uint8Array(32).fill(1),
                    },
                },
                machineIdProvider: () => 'machine-reattached-direct',
                activeServerDir,
                baseDir: materializationBaseDir,
                refreshWindowMs: 60_000,
                refreshLeaseMs: 30_000,
                now: () => 1_000,
                runtimeRegistry: connectedServiceRuntimeRegistry,
                resolveQualifiedPurposeBindingSnapshot,
            });
            await runtime.reconcileReattachedConnectedServiceCredentialProjection();

            expect(getConnectedServiceCredentialPlain).toHaveBeenCalledTimes(2);
            const codexAuthPath = join(
                activeServerDir,
                'daemon',
                'connected-services',
                'homes',
                serviceId,
                profileId,
                'codex',
                'codex-home',
                'auth.json',
            );
            await expect(readFile(codexAuthPath, 'utf8')).rejects.toMatchObject({
                code: 'ENOENT',
            });
            expect(requestConnectedServiceSessionRestartSignalMock)
                .not.toHaveBeenCalled();
            expect(trackedSessions.size).toBe(2);
            expect(connectedServiceRuntimeRegistry.listRefreshTargets())
                .toHaveLength(2);
        } finally {
            accountProfileGet.mockRestore();
            await runtime?.stopControlServer();
            await rm(materializationBaseDir, { recursive: true, force: true });
            await rm(activeServerDir, { recursive: true, force: true });
        }
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
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
                ownerMetadata,
            ),
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
                processCommandHash: 'hash-direct-run-deletion',
                processStartTimeMs: 12_345,
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
                                profileId: 'direct-run-primary',
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
            profileId: 'direct-run-primary',
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
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockImplementation(
            async () => ({
                registry: {
                    contributes: getResolvedContributionRegistry(),
                },
                source: 'active',
                release: vi.fn(async () => {}),
            }),
        );
        const activatePurposeBindings = vi.fn((input: Readonly<{
            subject: Readonly<{ isCurrent(): boolean }>;
            bindings: readonly unknown[];
        }>) => ({
            subjectId: `execution-run:${runId}/runner:${pid}/agent:codex`,
            isCurrent: input.subject.isCurrent,
            resolvePurposeBinding: (purpose: unknown) => (
                input.bindings.find((binding) => (
                    JSON.stringify((binding as Readonly<{ purpose: unknown }>).purpose)
                    === JSON.stringify(purpose)
                )) ?? null
            ),
            listPurposeBindings: () => input.bindings,
            dispose: vi.fn(),
        }));
        const pidSafetyModule = await import('../pidSafety');
        const pidSafetySpy = vi.spyOn(
            pidSafetyModule,
            'isPidSafeHappySessionProcess',
        ).mockResolvedValue(true);
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
                profiles: [{ profileId: 'direct-run-primary', status: 'connected' as const, kind: 'oauth' as const }],
                groups: [],
            }],
            connectedServiceCredentialRevisionsV1: [{
                serviceId: 'openai-codex' as const,
                profileId: 'direct-run-primary',
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
                        profiles: [{ profileId: 'direct-run-primary', status: 'connected' }],
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
                activatePurposeBindings: activatePurposeBindings as never,
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
                            profileId: 'direct-run-primary',
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
                    profileId: 'direct-run-primary',
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
            pidSafetySpy.mockRestore();
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

    it('routes session runtime-auth refresh through the exact catalog service hook', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
        registerRuntimeAuthRefreshTarget(runtimeRegistry, runtimeAuthRefreshRequest.sessionId);
        const unsupportedSelection = {
            kind: 'profile',
            serviceId: 'openai',
            profileId: 'unsupported-profile',
        } as const;
        runtimeRegistry.registerTarget({
            pid: 778,
            agentId: 'codex',
            sessionId: 'sess-unsupported-catalog-service',
            connectedServiceSelectionsEnv: {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                    ...unsupportedSelection,
                    credentialRevision: runtimeAuthRefreshRequest.expectedCredentialRevision,
                }]),
            },
        });
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
        const catalogBridgeForService = vi.fn(async (serviceId?: string) => (
            serviceId === 'openai-codex' ? catalogRefresh : null
        ));
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockImplementation(async () => ({
            registry: {
                contributes: createResolvedContributionRegistry({
                    agents: [],
                catalogEntries: [{
                    id: 'fixture-agent',
                    cliSubcommand: 'fixture-agent',
                    vendorResumeSupport: 'unsupported',
                    connectedServiceIds: ['openai-codex', 'openai'],
                    getConnectedServiceDaemonAuthBridgeRefresh: catalogBridgeForService,
                }, {
                    id: 'other-agent',
                    cliSubcommand: 'other-agent',
                    vendorResumeSupport: 'unsupported',
                    connectedServiceIds: ['claude-subscription'],
                    getConnectedServiceDaemonAuthBridgeRefresh: async () => {
                        throw new Error('the resolver must not invoke a different service hook');
                    },
                }],
                }),
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
        expect(catalogRefresh).toHaveBeenCalledWith(expect.objectContaining({
            serviceId: 'openai-codex',
            request: expect.objectContaining({
                sessionId: runtimeAuthRefreshRequest.sessionId,
                selection: runtimeAuthRefreshSelection,
                expectedCredentialRevision: runtimeAuthRefreshRequest.expectedCredentialRevision,
                forceRefresh: true,
            }),
        }));
        await expect(controlServerInput?.handleSessionConnectedServiceRuntimeAuthRefresh?.({
            sessionId: 'sess-unsupported-catalog-service',
            refreshAttemptId: 'unsupported-catalog-refresh-attempt',
            selection: unsupportedSelection,
            expectedCredentialRevision: runtimeAuthRefreshRequest.expectedCredentialRevision,
        })).resolves.toEqual({
            ok: false,
            errorCode: 'connected_service_daemon_auth_bridge_unavailable',
        });
        expect(catalogBridgeForService).toHaveBeenNthCalledWith(1, 'openai-codex');
        expect(catalogBridgeForService).toHaveBeenNthCalledWith(2, 'openai');
    });

    it('routes the real Codex and Claude daemon-auth refresh hooks from the active catalog', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
        const codexSessionId = 'sess-codex-catalog-refresh';
        const claudeSessionId = 'sess-claude-catalog-refresh';
        const codexSelection = {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'codex-profile',
        } as const;
        const claudeSelection = {
            kind: 'profile',
            serviceId: 'claude-subscription',
            profileId: 'claude-profile',
        } as const;
        const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        runtimeRegistry.registerTarget({
            pid: 778,
            agentId: 'codex',
            sessionId: codexSessionId,
            connectedServiceSelectionsEnv: {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                    ...codexSelection,
                    credentialRevision,
                }]),
            },
        });
        runtimeRegistry.registerTarget({
            pid: 779,
            agentId: 'claude',
            sessionId: claudeSessionId,
            connectedServiceSelectionsEnv: {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                    ...claudeSelection,
                    credentialRevision,
                }]),
            },
        });
        const refreshOpenAiCodexChatGptTokensForBridge = vi.fn(async () => ({
            accessToken: 'codex-access',
            chatgptAccountId: 'codex-account',
            chatgptPlanType: 'plus',
            credentialRevision,
        }));
        const refreshClaudeSubscriptionTokensForBridge = vi.fn(async () => ({
            accessToken: 'claude-access',
            anthropicAccountId: 'claude-account',
            expiresAt: null,
        }));
        const release = vi.fn(async () => {});
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockImplementation(async () => ({
            registry: { contributes: getResolvedContributionRegistry() },
            source: 'active',
            release,
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
                refreshClaudeSubscriptionTokensForBridge,
            }) as never,
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
        await expect(controlServerInput?.handleSessionConnectedServiceRuntimeAuthRefresh?.({
            sessionId: codexSessionId,
            refreshAttemptId: 'codex-catalog-refresh-attempt',
            selection: codexSelection,
            expectedCredentialRevision: credentialRevision,
        })).resolves.toEqual({
            ok: true,
            result: {
                status: 'refreshed',
                result: {
                    accessToken: 'codex-access',
                    chatgptAccountId: 'codex-account',
                    chatgptPlanType: 'plus',
                    credentialRevision,
                },
            },
        });
        await expect(controlServerInput?.handleSessionConnectedServiceRuntimeAuthRefresh?.({
            sessionId: claudeSessionId,
            refreshAttemptId: 'claude-catalog-refresh-attempt',
            selection: claudeSelection,
            expectedCredentialRevision: credentialRevision,
        })).resolves.toEqual({
            ok: true,
            result: {
                status: 'refreshed',
                result: {
                    accessToken: 'claude-access',
                    anthropicAccountId: 'claude-account',
                    expiresAt: null,
                },
            },
        });
        expect(refreshOpenAiCodexChatGptTokensForBridge).toHaveBeenCalledWith(expect.objectContaining({
            selection: codexSelection,
            forceRefresh: true,
            expectedCredentialRevision: credentialRevision,
        }));
        expect(refreshClaudeSubscriptionTokensForBridge).toHaveBeenCalledWith(expect.objectContaining({
            selection: claudeSelection,
            forceRefresh: true,
            expectedCredentialRevision: credentialRevision,
        }));
        expect(release).toHaveBeenCalledTimes(2);
    });

    it('resolves daemon auth bridges from the current plugin runtime registry on each lookup', async () => {
        vi.mocked(startDaemonControlServer).mockClear();
        const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
        registerRuntimeAuthRefreshTarget(runtimeRegistry, runtimeAuthRefreshRequest.sessionId);
        const firstRefresh = vi.fn(async () => ({
            status: 'refreshed' as const,
            result: { accessToken: 'first-access' },
        }));
        const secondRefresh = vi.fn(async () => ({
            status: 'refreshed' as const,
            result: { accessToken: 'second-access' },
        }));
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

        acquireAuthoritativePluginRuntimeRegistryLeaseMock
            .mockImplementationOnce(async () => ({
                registry: {
                    contributes: createResolvedContributionRegistry({
                        agents: [],
                        catalogEntries: [{
                            id: 'codex.first',
                            cliSubcommand: 'codex.first',
                            vendorResumeSupport: 'unsupported',
                            connectedServiceIds: ['openai-codex'],
                            getConnectedServiceDaemonAuthBridgeRefresh: async () => firstRefresh,
                        }],
                    }),
                },
                source: 'active',
                release: releaseFirst,
            }))
            .mockImplementationOnce(async () => ({
                registry: {
                    contributes: createResolvedContributionRegistry({
                        agents: [],
                        catalogEntries: [{
                            id: 'codex.second',
                            cliSubcommand: 'codex.second',
                            vendorResumeSupport: 'unsupported',
                            connectedServiceIds: ['openai-codex'],
                            getConnectedServiceDaemonAuthBridgeRefresh: async () => secondRefresh,
                        }],
                    }),
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
            status: 'continue',
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
        })).resolves.toEqual({
            status: 'continue',
            turnCustody: {
                status: 'recorded',
                activeTurnId: 'session-turn:current',
            },
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
            status: 'continue',
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
            status: 'continue',
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
                status: 'continue',
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
                status: 'continue',
                turnCustody: {
                    status: 'recorded',
                    activeTurnId: 'session-turn:exact-2',
                },
            },
        });
        await downstreamSettlementStartedPromise;
        expect(downstreamSettlementStarted).toHaveBeenCalledOnce();

        const shutdown = controlServerInput!.beforeShutdown!();
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
        })).resolves.toEqual({
            status: 'continue',
            turnCustody: {
                status: 'recorded',
                activeTurnId: null,
            },
        });
        await providerVerificationStarted;

        await expect(Promise.race([
            controlServerInput!.beforeShutdown!().then(() => 'settled' as const),
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

    it('prepares a missing connected-service materialization identity without treating pre-materialization continuity as proof', async () => {
        vi.mocked(executeSpawnSessionRequest).mockClear();
        fetchSessionByIdCompatMock.mockClear();
        updateSessionMetadataWithRetryMock.mockClear();
        resolveConnectedServiceSwitchContinuityMock.mockClear();
        resolveConnectedServiceSwitchContinuityMock.mockResolvedValueOnce({
            mode: 'unsupported',
            reason: 'provider_session_state_unavailable_for_resume',
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
        const repair = await repairMissingConnectedServiceMaterializationIdentityForSpawn?.({
            sessionId: 'sess-claude-repair',
            agentId: 'claude',
            connectedServices,
            vendorResumeId: 'claude-vendor-session-1',
        });

        expect(repair?.identity).toEqual(expect.objectContaining({
            v: 1,
            id: expect.stringMatching(/^csm_/),
        }));
        expect(resolveConnectedServiceSwitchContinuityMock).not.toHaveBeenCalled();
        expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
        expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();

        await repair?.persistAfterMaterialization();

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
        const privateSessionId = 'private-active-session-sentinel';
        const privatePublicationError = 'private-publication-error-sentinel';
        const privateNudgeError = 'private-nudge-error-sentinel';
        vi.mocked(callSessionRpc)
            .mockResolvedValueOnce({ ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' })
            .mockResolvedValueOnce({ ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' })
            .mockRejectedValueOnce(new Error(privateNudgeError));
        updateSessionMetadataWithRetryMock.mockRejectedValueOnce(new Error(privatePublicationError));
        const attachment = await writeTerminalHostAttachmentInfo({
            happyHomeDir: configuration.happyHomeDir,
            sessionId: privateSessionId,
            handle: {
                kind: 'tmux',
                sessionName: 'private-active-tmux-session',
                paneId: 'private-pane',
                attachMetadata: {
                    attachStrategy: 'terminal_host',
                    topology: 'shared',
                    locality: 'same_machine',
                    liveProbe: 'required',
                },
            },
        });
        const killSpy = vi.spyOn(process, 'kill');
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                process.pid,
                {
                    startedBy: 'daemon',
                    happySessionId: privateSessionId,
                    pid: process.pid,
                    spawnOptions: {
                        directory: '/tmp/project',
                        existingSessionId: privateSessionId,
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
            existingSessionId: privateSessionId,
            token: 'token-from-spawn-options',
        };

        try {
            await expect(runtime.spawnSession(optionsWithUnexpectedToken)).resolves.toEqual({
                type: 'success',
                sessionId: privateSessionId,
            });

            expect(callSessionRpc).toHaveBeenNthCalledWith(1, {
                token: 'token-daemon',
                sessionId: privateSessionId,
                mode: 'plain',
                method: `${privateSessionId}:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1}`,
                request: {},
                ctx: null,
            });
            expect(callSessionRpc).toHaveBeenNthCalledWith(3, expect.objectContaining({
                method: `${privateSessionId}:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1}`,
                request: { protocolVersion: 1 },
            }));
            expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
            expect(executeSpawnSessionRequest).not.toHaveBeenCalled();
            expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);

            const serializedLogs = JSON.stringify(
                [vi.mocked(logger.debug).mock.calls, vi.mocked(logger.warn).mock.calls],
                (_key, value) => value instanceof Error
                    ? { name: value.name, message: value.message, stack: value.stack }
                    : value,
            );
            expect(serializedLogs).not.toContain(privateSessionId);
            expect(serializedLogs).not.toContain(privatePublicationError);
            expect(serializedLogs).not.toContain(privateNudgeError);
        } finally {
            await runtime.stopControlServer();
            killSpy.mockRestore();
            await removeTerminalHostAttachmentInfo({
                happyHomeDir: configuration.happyHomeDir,
                sessionId: privateSessionId,
                expectedAttachmentId: attachment.attachmentId,
            });
        }
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
        let admitRuntimeAuthRecoveryTranscriptEvents!: () => void;
        const runtimeAuthRecoveryTranscriptAdmission = new Promise<Readonly<{
            persisted: true;
            delivered: boolean;
        }>>((resolveAdmission) => {
            admitRuntimeAuthRecoveryTranscriptEvents = () => resolveAdmission({
                persisted: true,
                delivered: false,
            });
        });
        const stageRuntimeAuthRecoveryTranscriptEvent = vi.fn<
            Parameters<typeof startDaemonSessionControlRuntimeRaw>[0][
                'daemonSessionMutationCustody'
            ]['stageTranscriptEvent']
        >(
            async () => await runtimeAuthRecoveryTranscriptAdmission,
        );
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
                path: '/home/coder/runtime-inactive-project',
                sessionWorkspaceLocationV1: {
                    v: 1,
                    machineId: 'machine-1',
                    agentPath: '/home/coder/runtime-inactive-project',
                    machinePath: '/tmp/runtime-inactive-project',
                },
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
            daemonSessionMutationCustody: {
                stageTranscriptEvent: stageRuntimeAuthRecoveryTranscriptEvent,
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
            expect(stageRuntimeAuthRecoveryTranscriptEvent).toHaveBeenCalled();
        });
        const durableIntentStore = recoveryIntentFileStoresMock.storesByPath.get(
            '/tmp/happier-test-home/servers/default/connected-services/runtime-auth-recovery.json',
        );
        expect(Array.from(durableIntentStore?.values() ?? [])).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pendingVisibleEvents: expect.arrayContaining([
                    expect.objectContaining({
                        attemptId: 'runtime-auth-attempt:control-runtime-visible-delivery',
                    }),
                ]),
            }),
        ]));

        admitRuntimeAuthRecoveryTranscriptEvents();
        await vi.waitFor(() => {
            expect(stageRuntimeAuthRecoveryTranscriptEvent).toHaveBeenCalledWith(expect.objectContaining({
                    sessionId: 'sess-runtime-inactive',
                    eventId: expect.any(String),
                    data: expect.objectContaining({
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
            expect(stageRuntimeAuthRecoveryTranscriptEvent).toHaveBeenCalledWith(expect.objectContaining({
                    sessionId: 'sess-runtime-predecessor',
                    eventId: expect.any(String),
            }));
            expect(Array.from(durableIntentStore?.values() ?? [])).not.toEqual(expect.arrayContaining([
                expect.objectContaining({
                    pendingVisibleEvents: expect.arrayContaining([
                        expect.objectContaining({
                            attemptId: 'runtime-auth-attempt:control-runtime-visible-delivery',
                        }),
                    ]),
                }),
            ]));
        });
        const stagedRuntimeAuthRecoveryEvents = stageRuntimeAuthRecoveryTranscriptEvent.mock.calls
            .map(([input]) => input);
        expect(stagedRuntimeAuthRecoveryEvents.filter((input) => (
            input.sessionId === 'sess-runtime-inactive'
            && input.data.status === 'retry_scheduled'
        ))).toHaveLength(1);
        expect(stagedRuntimeAuthRecoveryEvents.filter((input) => (
            input.sessionId === 'sess-runtime-predecessor'
            && input.data.status === 'retry_scheduled'
        ))).toHaveLength(1);
        expect(new Set(stagedRuntimeAuthRecoveryEvents.map((input) => input.eventId)).size)
            .toBe(stagedRuntimeAuthRecoveryEvents.length);
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
        const stageRuntimeAuthRecoveryTranscriptEvent = vi.fn(async () => ({
            persisted: true as const,
            delivered: false,
        }));
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
            daemonSessionMutationCustody: {
                stageTranscriptEvent: stageRuntimeAuthRecoveryTranscriptEvent,
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
        expect(stageRuntimeAuthRecoveryTranscriptEvent).not.toHaveBeenCalledWith(expect.objectContaining({
                sessionId: 'sess-provider-limit-target',
                data: expect.objectContaining({
                    status: 'retry_scheduled',
                    diagnostic: expect.objectContaining({
                        reason: 'local_server_storm',
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
            processCommandHash: 'hash-sess-runtime',
            processStartTimeMs: 12_345,
            spawnOptions: {
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'native',
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
                    processCommandHash: 'hash-sess-gemini-connected',
                    processStartTimeMs: 12_345,
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
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
                ownerMetadata,
            ),
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
