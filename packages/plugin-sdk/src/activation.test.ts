import { describe, expectTypeOf, it } from 'vitest';

import type {
    PluginApi,
    PluginActivationModule,
    PluginCleanup,
    PluginMcpDiscoveryResult,
    PluginVoiceConnectionMediaHost,
    PluginVoiceProviderExecutionAuthority,
    PluginVoiceProviderRuntimeRegistration,
    PluginVoicePcmConnection,
    PluginVoiceRealtimeCanonicalEvent,
} from './activation.js';
import type {
    PluginVoiceAgentSessionRealtimeService,
} from './experimental/agentRuntime/realtime.js';
import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionSource,
    AgentExternalSessionTakeoverContribution,
    AgentExternalSessionTakeoverResolveLaunchRequest,
    AgentExternalSessionsContribution,
    AgentExternalSessionsInvocation,
    AgentExternalSessionsResult,
    AgentExternalSessionsResolveSourceResult,
} from './sessions/index.js';
import type { McpDiscoveryWarningV1, McpServerSpecV1 } from './mcp.js';
import type {
    VoiceRealtimeToolCallV1,
    VoiceRealtimeToolResultV1,
    VoiceRealtimeJsonValue,
    VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';
import type { Disposable } from './lifecycle.js';
import type {
    PluginConnectedAccountAuthCompletionResult,
    PluginConnectedAccountAuthenticationAttempt,
    PluginConnectedAccountBindingEvent,
    PluginConnectedAccountBindingSummary,
    PluginConnectedAccountConnectedResult,
    PluginConnectedAccountMaterialization,
    PluginConnectedAccountMaterializationKind,
    PluginConnectedAccountMaterializationRequest,
    PluginConnectedAccountRuntime,
    PluginConnectedAccountRuntimeConfiguration,
    PluginConnectedAccountsService,
} from './services/connectedAccounts.js';
import type {
    PluginConnectedAccountAuthenticationModeRuntime,
    PluginConnectedAccountRuntimeConfiguration as RuntimePluginConnectedAccountRuntimeConfiguration,
} from '@happier-dev/plugin-sdk/runtime';
import type { PluginUiHostApi } from './ui/hostApi.js';

describe('plugin activation contract', () => {
    it('makes every manifest-declared registration static and non-disposable', () => {
        expectTypeOf<ReturnType<PluginApi['actions']['register']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['agents']['register']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['agents']['registerExternalSessions']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['agents']['registerExternalSessionTakeover']>>()
            .toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['hooks']['register']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['events']['register']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['notifications']['registerChannel']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['connectedAccounts']['register']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['scm']['registerHostingProvider']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['scm']['registerBackend']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['mcp']['registerServer']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['mcp']['registerDiscoveryProvider']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['interceptors']['register']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['voiceProviders']['register']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['voiceProviders']['registerSpeech']>>().toEqualTypeOf<void>();
        expectTypeOf<PluginApi>().not.toHaveProperty('lifecycle');
    });

    it('exposes the frozen multi-mode Connected Account producer contract', () => {
        expectTypeOf<keyof PluginConnectedAccountRuntime['authentication']>()
            .toEqualTypeOf<'modes'>();
        expectTypeOf<
            PluginConnectedAccountRuntime['authentication']['modes'][string]
        >().toEqualTypeOf<PluginConnectedAccountAuthenticationModeRuntime>();
        expectTypeOf<
            keyof Extract<
                PluginConnectedAccountAuthenticationModeRuntime,
                { kind: 'oauthDeviceCode' }
            >
        >().toEqualTypeOf<'kind' | 'begin' | 'poll' | 'cancel' | 'reconcile'>();
        expectTypeOf<keyof PluginConnectedAccountRuntimeConfiguration>()
            .toEqualTypeOf<'target' | 'revision' | 'values' | 'getSecret'>();
        expectTypeOf<RuntimePluginConnectedAccountRuntimeConfiguration>()
            .toEqualTypeOf<PluginConnectedAccountRuntimeConfiguration>();
        expectTypeOf<PluginConnectedAccountRuntimeConfiguration['target']['kind']>()
            .toEqualTypeOf<'service' | 'account' | 'attempt'>();
        expectTypeOf<
            keyof Extract<
                PluginConnectedAccountRuntimeConfiguration['target'],
                { kind: 'attempt' }
            >
        >().toEqualTypeOf<'kind' | 'attemptId' | 'service' | 'modeId'>();
        expectTypeOf<
            Extract<PluginConnectedAccountAuthenticationAttempt, { kind: 'reconnect' }>['account']
        >().toHaveProperty('accountId');
        expectTypeOf<PluginConnectedAccountAuthCompletionResult['status']>()
            .toEqualTypeOf<'connected' | 'rejected' | 'unavailable' | 'outcomeUnknown'>();
        expectTypeOf<PluginConnectedAccountConnectedResult['accountId']>()
            .toEqualTypeOf<string | undefined>();
        expectTypeOf<NonNullable<PluginConnectedAccountConnectedResult['providerIdentity']>>()
            .toEqualTypeOf<Readonly<{ accountId?: string; email?: string }>>();
    });

    it('registers the bounded External Sessions auxiliary on the Agent local id', () => {
        type RegisterExternalSessions = PluginApi['agents']['registerExternalSessions'];
        expectTypeOf<Parameters<RegisterExternalSessions>[0]>().toEqualTypeOf<string>();
        expectTypeOf<Parameters<RegisterExternalSessions>[1]>().toEqualTypeOf<AgentExternalSessionsContribution>();

        expectTypeOf<keyof AgentExternalSessionsContribution>().toEqualTypeOf<
            | 'resolveSource'
            | 'listCandidates'
            | 'resolveLinkIdentity'
            | 'resolveLinkedIdentity'
            | 'pageTranscript'
            | 'readAfterTranscript'
        >();
        expectTypeOf<AgentExternalSessionsContribution>().not.toHaveProperty('status');
        expectTypeOf<AgentExternalSessionsContribution>().not.toHaveProperty('follow');
        expectTypeOf<AgentExternalSessionsContribution>().not.toHaveProperty('takeover');

        type ResolveSourceRequest = Parameters<AgentExternalSessionsContribution['resolveSource']>[0];
        expectTypeOf<ResolveSourceRequest>().toMatchTypeOf<AgentExternalSessionsInvocation>();
        expectTypeOf<ResolveSourceRequest['signal']>().toEqualTypeOf<AbortSignal>();
        expectTypeOf<ResolveSourceRequest['deadlineAtMs']>().toEqualTypeOf<number>();
        expectTypeOf<ResolveSourceRequest['maxSerializedBytes']>().toEqualTypeOf<number>();

        type ListRequest = Parameters<AgentExternalSessionsContribution['listCandidates']>[0];
        type PageRequest = Parameters<AgentExternalSessionsContribution['pageTranscript']>[0];
        type ReadAfterRequest = Parameters<AgentExternalSessionsContribution['readAfterTranscript']>[0];
        expectTypeOf<ListRequest['maxItems']>().toEqualTypeOf<number>();
        expectTypeOf<PageRequest['maxItems']>().toEqualTypeOf<number>();
        expectTypeOf<ReadAfterRequest['maxItems']>().toEqualTypeOf<number>();
        expectTypeOf<PageRequest['source']>().toEqualTypeOf<AgentExternalSessionSource>();
        expectTypeOf<ReadAfterRequest['source']>().toEqualTypeOf<AgentExternalSessionSource>();
        expectTypeOf<PageRequest>().not.toHaveProperty('linkData');
        expectTypeOf<ReadAfterRequest>().not.toHaveProperty('linkData');
        expectTypeOf<Awaited<ReturnType<AgentExternalSessionsContribution['resolveSource']>>>()
            .toEqualTypeOf<AgentExternalSessionsResult<AgentExternalSessionsResolveSourceResult>>();
    });

    it('registers exactly the three-method observation facet beside External Sessions', () => {
        type RegisterObservation = PluginApi['agents']['registerExternalSessionObservation'];
        expectTypeOf<Parameters<RegisterObservation>[0]>().toEqualTypeOf<string>();
        expectTypeOf<Parameters<RegisterObservation>[1]>()
            .toEqualTypeOf<AgentExternalSessionObservationContribution>();
        expectTypeOf<ReturnType<RegisterObservation>>().toEqualTypeOf<void>();
        expectTypeOf<keyof AgentExternalSessionObservationContribution>().toEqualTypeOf<
            'describeResource' | 'observeResource' | 'reconcileResource'
        >();
        expectTypeOf<AgentExternalSessionsContribution>()
            .not.toHaveProperty('externalSessionObservation');
    });

    it('registers exactly the request-only takeover facet beside External Sessions', () => {
        type RegisterTakeover =
            PluginApi['agents']['registerExternalSessionTakeover'];
        expectTypeOf<Parameters<RegisterTakeover>[0]>().toEqualTypeOf<string>();
        expectTypeOf<Parameters<RegisterTakeover>[1]>()
            .toEqualTypeOf<AgentExternalSessionTakeoverContribution>();
        expectTypeOf<ReturnType<RegisterTakeover>>().toEqualTypeOf<void>();
        expectTypeOf<keyof AgentExternalSessionTakeoverContribution>()
            .toEqualTypeOf<'resolveLaunch'>();
        expectTypeOf<
            Parameters<AgentExternalSessionTakeoverContribution['resolveLaunch']>
        >().toEqualTypeOf<
            [request: AgentExternalSessionTakeoverResolveLaunchRequest]
        >();
        expectTypeOf<AgentExternalSessionsContribution>()
            .not.toHaveProperty('takeover');
    });

    it('owns one cleanup only through a successfully resolved activation', () => {
        expectTypeOf<ReturnType<PluginActivationModule['activate']>>().toEqualTypeOf<
            void | PluginCleanup | Promise<void | PluginCleanup>
        >();
        expectTypeOf<ReturnType<PluginConnectedAccountsService['watch']>>().toEqualTypeOf<Disposable>();
        expectTypeOf<keyof PluginConnectedAccountsService>().toEqualTypeOf<
            'getBinding' | 'requestSelection' | 'materialize' | 'watch'
        >();
        expectTypeOf<PluginConnectedAccountsService>().not.toHaveProperty('list');
        expectTypeOf<PluginConnectedAccountsService>().not.toHaveProperty('get');
        expectTypeOf<PluginConnectedAccountsService>().not.toHaveProperty('reportFailure');
        expectTypeOf<PluginConnectedAccountsService>().not.toHaveProperty('refresh');
        expectTypeOf<keyof PluginConnectedAccountBindingSummary>().toEqualTypeOf<
            'purpose' | 'service' | 'target'
        >();
        expectTypeOf<keyof PluginConnectedAccountBindingSummary['target']>().toEqualTypeOf<
            'kind' | 'displayName'
        >();
        expectTypeOf<PluginConnectedAccountBindingSummary['target']['kind']>()
            .toEqualTypeOf<'account' | 'group'>();
        expectTypeOf<PluginConnectedAccountsService['getBinding']>()
            .returns.resolves.toEqualTypeOf<PluginConnectedAccountBindingSummary | null>();
        expectTypeOf<PluginConnectedAccountBindingSummary>().not.toHaveProperty('accountId');
        expectTypeOf<PluginConnectedAccountBindingSummary>().not.toHaveProperty('groupId');
        expectTypeOf<PluginConnectedAccountBindingSummary>().not.toHaveProperty('generation');
        expectTypeOf<PluginConnectedAccountBindingSummary>().not.toHaveProperty('revision');
        expectTypeOf<keyof PluginConnectedAccountBindingEvent>().toEqualTypeOf<'kind'>();
        expectTypeOf<PluginConnectedAccountBindingEvent['kind']>().toEqualTypeOf<'resync'>();
        expectTypeOf<Parameters<PluginConnectedAccountsService['getBinding']>[0]>()
            .toEqualTypeOf<string>();
        expectTypeOf<Parameters<PluginConnectedAccountsService['getBinding']>[1]>()
            .toEqualTypeOf<{ signal?: AbortSignal } | undefined>();
        expectTypeOf<Parameters<PluginConnectedAccountsService['requestSelection']>[0]>()
            .toEqualTypeOf<Readonly<{ purpose: string; reason: string }>>();
        expectTypeOf<Parameters<PluginConnectedAccountsService['requestSelection']>[1]>()
            .toEqualTypeOf<{ signal?: AbortSignal } | undefined>();
        expectTypeOf<Parameters<PluginConnectedAccountsService['materialize']>[0]>()
            .toEqualTypeOf<string>();
        expectTypeOf<Parameters<PluginConnectedAccountsService['materialize']>[1]>()
            .toEqualTypeOf<PluginConnectedAccountMaterializationRequest>();
        expectTypeOf<Parameters<PluginConnectedAccountsService['materialize']>[2]>()
            .toEqualTypeOf<{ signal?: AbortSignal } | undefined>();
        expectTypeOf<PluginConnectedAccountsService['materialize']>()
            .returns.resolves.toEqualTypeOf<PluginConnectedAccountMaterialization>();
        expectTypeOf<PluginConnectedAccountMaterializationRequest['kind']>()
            .toEqualTypeOf<PluginConnectedAccountMaterializationKind>();
        expectTypeOf<PluginConnectedAccountMaterialization['kind']>()
            .toEqualTypeOf<PluginConnectedAccountMaterializationKind>();
        expectTypeOf<keyof Extract<
            PluginConnectedAccountMaterializationRequest,
            { kind: 'httpHeaders' }
        >>().toEqualTypeOf<'kind' | 'origin' | 'headerNames'>();
        expectTypeOf<keyof Extract<
            PluginConnectedAccountMaterializationRequest,
            { kind: 'environment' }
        >>().toEqualTypeOf<'kind' | 'keys'>();
        expectTypeOf<keyof Extract<
            PluginConnectedAccountMaterializationRequest,
            { kind: 'files' }
        >>().toEqualTypeOf<'kind' | 'fileIds'>();
        expectTypeOf<keyof Extract<
            PluginConnectedAccountMaterialization,
            { kind: 'httpHeaders' }
        >>().toEqualTypeOf<'kind' | 'headers'>();
        expectTypeOf<Extract<
            PluginConnectedAccountMaterialization,
            { kind: 'httpHeaders' }
        >['headers']>().toEqualTypeOf<Readonly<Record<string, string>>>();
        expectTypeOf<keyof Extract<
            PluginConnectedAccountMaterialization,
            { kind: 'environment' }
        >>().toEqualTypeOf<'kind' | 'env'>();
        expectTypeOf<Extract<
            PluginConnectedAccountMaterialization,
            { kind: 'environment' }
        >['env']>().toEqualTypeOf<Readonly<Record<string, string>>>();
        expectTypeOf<keyof Extract<
            PluginConnectedAccountMaterialization,
            { kind: 'files' }
        >>().toEqualTypeOf<'kind' | 'files'>();
        expectTypeOf<Extract<
            PluginConnectedAccountMaterialization,
            { kind: 'files' }
        >['files']>().toEqualTypeOf<Readonly<Record<string, Uint8Array>>>();
        expectTypeOf<Parameters<PluginConnectedAccountsService['watch']>[0]>()
            .toEqualTypeOf<string>();
        expectTypeOf<Parameters<PluginConnectedAccountsService['watch']>[1]>()
            .toEqualTypeOf<(event: PluginConnectedAccountBindingEvent) => void>();
        expectTypeOf<Disposable['dispose']>().toBeFunction();
    });

    it('removes V1 names without changing the active MCP and Voice contracts', () => {
        expectTypeOf<NonNullable<PluginMcpDiscoveryResult['servers']>[number]>()
            .toEqualTypeOf<McpServerSpecV1>();
        expectTypeOf<McpDiscoveryWarningV1>().toMatchTypeOf<
            NonNullable<PluginMcpDiscoveryResult['warnings']>[number]
        >();
        expectTypeOf<VoiceTranscriptCanonicalEventV1>().toMatchTypeOf<
            Extract<PluginVoiceRealtimeCanonicalEvent, { type: 'transcript' }>['event']
        >();
        expectTypeOf<VoiceRealtimeToolCallV1>().toMatchTypeOf<
            Extract<PluginVoiceRealtimeCanonicalEvent, { type: 'tool_calls' }>['calls'][number]
        >();
        expectTypeOf<Extract<
            PluginVoiceRealtimeCanonicalEvent,
            { type: 'provider_event' }
        >>().toEqualTypeOf<never>();
        expectTypeOf<VoiceRealtimeToolResultV1>().toMatchTypeOf<
            Parameters<PluginVoiceProviderRuntimeRegistration['encodeToolResults']>[0][number]
        >();
    });

    it('gives Voice connection operations the existing UI action host and caller lifetime', () => {
        type ConnectionInput = Parameters<PluginVoiceProviderRuntimeRegistration['createConnection']>[0];
        expectTypeOf<keyof ConnectionInput>().toEqualTypeOf<
            'session' | 'attemptId' | 'mic' | 'interruption' | 'levels' | 'media' | 'tools' | 'ui' | 'signal' | 'execution'
        >();
        expectTypeOf<ConnectionInput['ui']>().toEqualTypeOf<PluginUiHostApi>();
        expectTypeOf<ConnectionInput['signal']>().toEqualTypeOf<AbortSignal>();
        expectTypeOf<ConnectionInput['media']>().toEqualTypeOf<PluginVoiceConnectionMediaHost>();
        expectTypeOf<ConnectionInput['execution']>().toEqualTypeOf<PluginVoiceProviderExecutionAuthority>();
        expectTypeOf<Extract<
            ConnectionInput['execution'],
            { kind: 'experimental_agent_session_realtime' }
        >['agentSessionRealtime']>().toEqualTypeOf<PluginVoiceAgentSessionRealtimeService>();
        expectTypeOf<Parameters<ConnectionInput['media']['createWebRtcConnection']>[0]>()
            .toEqualTypeOf<Readonly<{
                signaling: Readonly<{
                    exchangeOffer(input: Readonly<{
                        offerSdp: string;
                        signal: AbortSignal;
                    }>): Promise<Readonly<{ answerSdp: string }>>;
                }>;
                control: Readonly<{
                    label: string;
                    onOpen(input: Readonly<{
                        sendJson(value: VoiceRealtimeJsonValue): Promise<void>;
                    }>): void | Promise<void>;
                }>;
            }>>();
        expectTypeOf<ReturnType<ConnectionInput['media']['createPcmConnection']>>()
            .toEqualTypeOf<PluginVoicePcmConnection>();
        expectTypeOf<Parameters<ConnectionInput['media']['createPcmConnection']>[0]>().not.toHaveProperty('mic');
        expectTypeOf<Parameters<ConnectionInput['media']['createPcmConnection']>[0]['output']>()
            .not.toHaveProperty('retainedOutputMaxMs');
    });
});
