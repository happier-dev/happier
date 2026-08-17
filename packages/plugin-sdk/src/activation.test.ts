import { describe, expectTypeOf, it } from 'vitest';

import type {
    PluginApi,
    PluginActivationModule,
    PluginCleanup,
    PluginMcpDiscoveredEndpoint,
    PluginMcpDiscoveryResult,
} from './activation.js';
import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionSource,
    AgentExternalSessionTakeoverContribution,
    AgentExternalSessionTakeoverResolveLaunchRequest,
    AgentExternalSessionsContribution,
    AgentExternalSessionsInvocation,
    AgentExternalSessionsManagedEndpointServiceRequest,
    AgentExternalSessionsResult,
    AgentExternalSessionsResolveSourceResult,
} from './sessions/external/index.js';
import type { ManagedServiceSpec } from './managed-services/contract.js';
import type { ExecService } from './exec.js';
import type { McpDiscoveryWarningV1 } from './mcp.js';
import type { Disposable } from './lifecycle.js';
import type {
    PluginConnectedAccountAuthCompletionResult,
    PluginConnectedAccountAuthenticationAttempt,
    PluginConnectedAccountBindingEvent,
    PluginConnectedAccountBindingSummary,
    PluginConnectedAccountConnectedResult,
    PluginConnectedAccountMaterialization,
    PluginConnectedAccountMaterializationOptions,
    PluginConnectedAccountMaterializationRequest,
    PluginConnectedAccountRef,
    PluginConnectedAccountRuntime,
    PluginConnectedAccountRuntimeConfiguration,
    ConnectedAccountsService,
} from './services/connectedAccounts.js';
import type {
    ConnectedAccountAuthenticationModeRuntime as PluginConnectedAccountAuthenticationModeRuntime,
    ConnectedAccountRuntimeConfiguration as RuntimePluginConnectedAccountRuntimeConfiguration,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    ConnectedAccountMaterializationRequest,
    PluginConnectedAccountMaterializationKind,
} from '@happier-dev/protocol';

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
        expectTypeOf<ReturnType<PluginApi['mcp']['registerDiscoverySource']>>().toEqualTypeOf<void>();
        expectTypeOf<ReturnType<PluginApi['voiceProviders']['register']>>().toEqualTypeOf<void>();
        expectTypeOf<keyof PluginApi['voiceProviders']>().toEqualTypeOf<'register'>();
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
            | 'resolveManagedEndpointService'
        >();
        expectTypeOf<AgentExternalSessionsContribution>().not.toHaveProperty('status');
        expectTypeOf<AgentExternalSessionsContribution>().not.toHaveProperty('follow');
        expectTypeOf<AgentExternalSessionsContribution>().not.toHaveProperty('takeover');

        type ResolveSourceRequest = Parameters<AgentExternalSessionsContribution['resolveSource']>[0];
        expectTypeOf<ResolveSourceRequest>().toMatchTypeOf<AgentExternalSessionsInvocation>();
        expectTypeOf<ResolveSourceRequest['signal']>().toEqualTypeOf<AbortSignal>();
        expectTypeOf<ResolveSourceRequest['deadlineAtMs']>().toEqualTypeOf<number>();
        expectTypeOf<ResolveSourceRequest['maxSerializedBytes']>().toEqualTypeOf<number>();
        expectTypeOf<AgentExternalSessionsInvocation['exec']>().toEqualTypeOf<ExecService>();

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
        expectTypeOf<AgentExternalSessionsContribution['resolveManagedEndpointService']>()
            .toEqualTypeOf<(
                (request: AgentExternalSessionsManagedEndpointServiceRequest) => (
                    Promise<ManagedServiceSpec | null> | ManagedServiceSpec | null
                )
            ) | undefined>();
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
        expectTypeOf<ReturnType<ConnectedAccountsService['watch']>>().toEqualTypeOf<Disposable>();
        expectTypeOf<keyof ConnectedAccountsService>().toEqualTypeOf<
            | 'getBinding'
            | 'listAccounts'
            | 'materialize'
            | 'materializeListedAccount'
            | 'requestSelection'
            | 'watch'
        >();
        expectTypeOf<ConnectedAccountsService>().not.toHaveProperty('list');
        expectTypeOf<ConnectedAccountsService>().not.toHaveProperty('get');
        expectTypeOf<ConnectedAccountsService>().not.toHaveProperty('reportFailure');
        expectTypeOf<ConnectedAccountsService>().not.toHaveProperty('refresh');
        expectTypeOf<keyof PluginConnectedAccountBindingSummary>().toEqualTypeOf<
            'purpose' | 'service' | 'account' | 'target'
        >();
        expectTypeOf<PluginConnectedAccountBindingSummary['account']>()
            .toEqualTypeOf<PluginConnectedAccountRef>();
        expectTypeOf<keyof PluginConnectedAccountBindingSummary['target']>().toEqualTypeOf<
            'kind' | 'displayName'
        >();
        expectTypeOf<PluginConnectedAccountBindingSummary['target']['kind']>()
            .toEqualTypeOf<'account' | 'group'>();
        expectTypeOf<ConnectedAccountsService['getBinding']>()
            .returns.resolves.toEqualTypeOf<PluginConnectedAccountBindingSummary | null>();
        expectTypeOf<PluginConnectedAccountBindingSummary>().not.toHaveProperty('accountId');
        expectTypeOf<PluginConnectedAccountBindingSummary>().not.toHaveProperty('groupId');
        expectTypeOf<PluginConnectedAccountBindingSummary>().not.toHaveProperty('generation');
        expectTypeOf<PluginConnectedAccountBindingSummary>().not.toHaveProperty('revision');
        expectTypeOf<keyof PluginConnectedAccountBindingEvent>().toEqualTypeOf<'kind'>();
        expectTypeOf<PluginConnectedAccountBindingEvent['kind']>().toEqualTypeOf<'resync'>();
        expectTypeOf<Parameters<ConnectedAccountsService['getBinding']>[0]>()
            .toEqualTypeOf<string>();
        expectTypeOf<Parameters<ConnectedAccountsService['getBinding']>[1]>()
            .toEqualTypeOf<Readonly<{ signal?: AbortSignal }> | undefined>();
        expectTypeOf<Parameters<ConnectedAccountsService['requestSelection']>[0]>()
            .toEqualTypeOf<Readonly<{ purpose: string; reason: string }>>();
        expectTypeOf<Parameters<ConnectedAccountsService['requestSelection']>[1]>()
            .toEqualTypeOf<Readonly<{ signal?: AbortSignal }> | undefined>();
        expectTypeOf<Parameters<ConnectedAccountsService['materialize']>[0]>()
            .toEqualTypeOf<string>();
        expectTypeOf<Parameters<ConnectedAccountsService['materialize']>[1]>()
            .toEqualTypeOf<PluginConnectedAccountMaterializationRequest>();
        expectTypeOf<Parameters<ConnectedAccountsService['materialize']>[2]>()
            .toEqualTypeOf<PluginConnectedAccountMaterializationOptions | undefined>();
        expectTypeOf<Readonly<{
            signal?: AbortSignal;
        }>>().toMatchTypeOf<PluginConnectedAccountMaterializationOptions>();
        expectTypeOf<Readonly<{
            signal?: AbortSignal;
            expectedAccount: PluginConnectedAccountRef;
        }>>().toMatchTypeOf<PluginConnectedAccountMaterializationOptions>();
        expectTypeOf<PluginConnectedAccountMaterializationOptions>()
            .not.toHaveProperty('account');
        expectTypeOf<ConnectedAccountsService['materialize']>()
            .returns.resolves.toEqualTypeOf<PluginConnectedAccountMaterialization>();
        expectTypeOf<PluginConnectedAccountMaterializationRequest['kind']>()
            .toEqualTypeOf<PluginConnectedAccountMaterializationKind>();
        expectTypeOf<PluginConnectedAccountMaterializationRequest>()
            .toEqualTypeOf<ConnectedAccountMaterializationRequest>();
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
        expectTypeOf<Parameters<ConnectedAccountsService['watch']>[0]>()
            .toEqualTypeOf<string>();
        expectTypeOf<Parameters<ConnectedAccountsService['watch']>[1]>()
            .toEqualTypeOf<(event: PluginConnectedAccountBindingEvent) => void>();
        expectTypeOf<Disposable['dispose']>().toBeFunction();
    });

    it('removes V1 names without changing the active MCP contract', () => {
        expectTypeOf<NonNullable<PluginMcpDiscoveryResult['endpoints']>[number]>()
            .toEqualTypeOf<PluginMcpDiscoveredEndpoint>();
        expectTypeOf<keyof PluginMcpDiscoveredEndpoint>()
            .toEqualTypeOf<'id' | 'name' | 'kind' | 'url'>();
        expectTypeOf<McpDiscoveryWarningV1>().toMatchTypeOf<
            NonNullable<PluginMcpDiscoveryResult['warnings']>[number]
        >();
    });
});
