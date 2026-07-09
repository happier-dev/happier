import { describe, expectTypeOf, it } from 'vitest';

import type {
    AgentCliReadinessQueryV1,
    AgentCliReadinessResultV1,
    AgentsRuntimeServiceV1,
    AcpRuntimeExtensionHandlerContextV1,
    AcpRuntimeExtensionsV1,
    AcpRuntimeNotificationHandlerV1,
    AcpRuntimeRequestHandlerV1,
    CreateAcpRuntimeParamsV1,
    PluginContextV1,
    PluginReviewCommentsServiceV1,
    ProviderAccountUsageAdoptProvisionalRecordInputV1,
    ProviderAccountUsageAdoptProvisionalRecordResultV1,
    ProviderAccountUsageSourceContextInputV1,
    ProviderAccountUsageSourceContextV1,
    ProviderAccountUsageRecordSnapshotInputV1,
    ProviderAccountUsageRecordSnapshotResultV1,
    ProviderAccountUsageRuntimeServiceV1,
} from './context.js';
import type { TerminalHostRuntimeServiceV1 } from './terminalHost.js';
import type { ManagedServerSpecV1 } from './managedServer.js';
import type {
    SessionAgentStateWriteRequestV1,
    SessionMcpElicitRequestV1,
    SessionMcpElicitResultV1,
    SessionMetadataWriteRequestV1,
    SessionPermissionDecisionRequestV1,
    SessionPermissionDecisionResultV1,
    SessionPermissionModeV1,
    SessionPermissionFollowUpPromptIntentV1,
    SessionPermissionPersistAllowRuleV1,
    SessionPermissionsServiceV1,
    SessionProviderAcceptedUserMessageDeliveryQueryV1,
    SessionRuntimeAuthRefreshRequestV1,
    SessionRuntimeAuthRefreshResultV1,
    SessionScopedSendRequestV1,
    SessionScopedSendResultV1,
    SessionScopedSubscribeRequestV1,
    SessionScopedSubscriptionEventV1,
    SessionStateFieldWriteRequestV1,
} from './sessions/index.js';
import type {
    TranscriptFileFollowHandleV1,
    TranscriptFileFollowInputV1,
} from './transcripts.js';

describe('PluginContextV1 permission surface', () => {
    it('keeps plugin permissions flat while session decisions stay on session-owned surfaces', () => {
        expectTypeOf<PluginContextV1['permissions']>().toMatchTypeOf<Readonly<{
            isGranted(id: string): boolean;
            list(): readonly string[];
        }>>();
        expectTypeOf<PluginContextV1['sessions']['current']['permissions']>().toEqualTypeOf<SessionPermissionsServiceV1>();
        expectTypeOf<PluginContextV1['sessions']['permissions']>().toMatchTypeOf<Readonly<{
            forSession(sessionId: string): Promise<SessionPermissionsServiceV1 | null>;
        }>>();
        expectTypeOf<PluginContextV1['sessions']['permissions']['forSession']>()
            .toEqualTypeOf<(sessionId: string) => Promise<SessionPermissionsServiceV1 | null>>();
        // @ts-expect-error A.5x requires explicit session targeting through forSession(...).
        type UntargetedSessionsPermissionRequest = PluginContextV1['sessions']['permissions']['requestDecision'];
        void (undefined as unknown as UntargetedSessionsPermissionRequest);
        expectTypeOf<PluginContextV1['actions']['approvals']>().toHaveProperty('request');
        // @ts-expect-error R5 removes the old ctx.capabilities inventory.
        type FlatCapabilities = PluginContextV1['capabilities'];
        void (undefined as unknown as FlatCapabilities);
    });

    it('exposes typed session-scoped runtime services without raw request/result escape hatches', () => {
        expectTypeOf<PluginContextV1['sessions']['current']['send']>()
            .toEqualTypeOf<(request: SessionScopedSendRequestV1) => Promise<SessionScopedSendResultV1>>();
        expectTypeOf<PluginContextV1['sessions']['current']['subscribe']>()
            .toEqualTypeOf<(
                request: SessionScopedSubscribeRequestV1,
                onEvent: (event: SessionScopedSubscriptionEventV1) => void,
            ) => { unsubscribe(): void }>();
        expectTypeOf<PluginContextV1['sessions']['current']['writeMetadata']>()
            .toEqualTypeOf<(request: SessionMetadataWriteRequestV1) => Promise<void>>();
        expectTypeOf<PluginContextV1['sessions']['current']['writeAgentState']>()
            .toEqualTypeOf<(request: SessionAgentStateWriteRequestV1) => Promise<void>>();
        expectTypeOf<PluginContextV1['sessions']['current']['writeStateField']>()
            .toEqualTypeOf<<F extends SessionStateFieldWriteRequestV1['fieldId']>(
                request: SessionStateFieldWriteRequestV1<F>,
            ) => Promise<void>>();
        expectTypeOf<PluginContextV1['sessions']['current']['permissions']['requestDecision']>()
            .toEqualTypeOf<(
                request: SessionPermissionDecisionRequestV1,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) => Promise<SessionPermissionDecisionResultV1>>();
        expectTypeOf<SessionPermissionDecisionResultV1>()
            .toMatchTypeOf<Readonly<{
                answers?: Readonly<Record<string, string>>;
                followUpPrompt?: SessionPermissionFollowUpPromptIntentV1;
                persistAllowRule?: SessionPermissionPersistAllowRuleV1;
                updatedInput?: Readonly<Record<string, unknown>>;
            }>>();
        expectTypeOf<PluginContextV1['sessions']['current']['permissions']['getMode']>()
            .toEqualTypeOf<() => SessionPermissionModeV1>();
        expectTypeOf<PluginContextV1['sessions']['current']['hasProviderAcceptedUserMessageDelivery']>()
            .toEqualTypeOf<((query: SessionProviderAcceptedUserMessageDeliveryQueryV1) => boolean) | undefined>();
        expectTypeOf<PluginContextV1['sessions']['current']['mcp']['elicit']>()
            .toEqualTypeOf<(
                request: SessionMcpElicitRequestV1,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) => Promise<SessionMcpElicitResultV1>>();
        expectTypeOf<PluginContextV1['sessions']['current']['auth']['services']['refreshRuntimeAuth']>()
            .toEqualTypeOf<(
                request: SessionRuntimeAuthRefreshRequestV1,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) => Promise<SessionRuntimeAuthRefreshResultV1>>();
    });

    it('types ACP custom runtime extension dispatch params without changing the public method shape', () => {
        const requestHandler: AcpRuntimeRequestHandlerV1 = async (params, context) => {
            expectTypeOf(params).toEqualTypeOf<unknown>();
            expectTypeOf(context).toMatchTypeOf<AcpRuntimeExtensionHandlerContextV1>();
            expectTypeOf(context.method).toEqualTypeOf<string>();
            expectTypeOf(context.requestId).toEqualTypeOf<string | undefined>();
            expectTypeOf(context.sessionId).toEqualTypeOf<string>();
            expectTypeOf(context.agentId).toEqualTypeOf<string>();
            expectTypeOf(context.agentName).toEqualTypeOf<string | undefined>();
            expectTypeOf(context.signal).toEqualTypeOf<AbortSignal>();
            return { accepted: true };
        };
        const notificationHandler: AcpRuntimeNotificationHandlerV1 = async (_params, context) => {
            expectTypeOf(context).toMatchTypeOf<AcpRuntimeExtensionHandlerContextV1>();
        };
        const params = {
            sessionId: 'session-1',
            cwd: '/workspace',
            clientSpec: {
                launch: {
                    kind: 'binary',
                    executablePath: '/bin/acme-agent',
                    args: ['--acp'],
                },
                transport: {
                    kind: 'stdio',
                    framing: { kind: 'strict-lf-json' },
                    encoding: 'utf8',
                },
                protocol: { kind: 'json-rpc-2.0' },
            },
            extensions: {
                requests: {
                    'fixture/customRequest': requestHandler,
                },
                notifications: {
                    'fixture/customNotification': notificationHandler,
                },
            },
            lifecycle: {
                signal: new AbortController().signal,
                initializeMeta: {
                    parameterizedModelPicker: true,
                },
            },
        } satisfies CreateAcpRuntimeParamsV1;

        expectTypeOf(params.extensions).toMatchTypeOf<AcpRuntimeExtensionsV1 | undefined>();
        expectTypeOf<PluginContextV1['agentRuntime']['acp']['createRuntime']>()
            .toEqualTypeOf<(
                spec: PluginContextV1['agentRuntime']['acp']['defineAcpBackend'] extends (spec: infer TSpec) => unknown ? TSpec : never,
                params: CreateAcpRuntimeParamsV1,
            ) => Promise<PluginContextV1['agentRuntime']['acp']['createRuntime'] extends (...args: readonly unknown[]) => Promise<infer THandle> ? THandle : never>>();
    });

    it('exposes durable review comment operations through a plugin-scoped reviews surface', () => {
        expectTypeOf<PluginContextV1['reviews']['comments']>()
            .toEqualTypeOf<PluginReviewCommentsServiceV1>();
        expectTypeOf<PluginContextV1['reviews']['comments']['create']>()
            .toMatchTypeOf<PluginReviewCommentsServiceV1['create']>();
        expectTypeOf<PluginContextV1['reviews']['comments']['transition']>()
            .toMatchTypeOf<PluginReviewCommentsServiceV1['transition']>();
        expectTypeOf<PluginContextV1['reviews']['comments']['get']>()
            .toMatchTypeOf<PluginReviewCommentsServiceV1['get']>();
        expectTypeOf<PluginContextV1['reviews']['comments']['reply']>()
            .toMatchTypeOf<PluginReviewCommentsServiceV1['reply']>();
        expectTypeOf<PluginContextV1['reviews']['comments']['setDisposition']>()
            .toMatchTypeOf<PluginReviewCommentsServiceV1['setDisposition']>();
        expectTypeOf<PluginContextV1['reviews']['comments']['attachEvidence']>()
            .toMatchTypeOf<PluginReviewCommentsServiceV1['attachEvidence']>();
    });

    it('exposes provider-account usage recording only through a typed runtime service', () => {
        expectTypeOf<PluginContextV1['agentRuntime']['accountUsage']>()
            .toEqualTypeOf<ProviderAccountUsageRuntimeServiceV1>();
        // @ts-expect-error alias-context authority was replaced by explicit source-context resolution.
        type AliasContext = PluginContextV1['agentRuntime']['accountUsage']['resolveAliasContext'];
        void (undefined as unknown as AliasContext);
        expectTypeOf<PluginContextV1['agentRuntime']['accountUsage']['resolveSourceContext']>()
            .toEqualTypeOf<(
                input: ProviderAccountUsageSourceContextInputV1,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) => Promise<ProviderAccountUsageSourceContextV1 | null>>();
        expectTypeOf<PluginContextV1['agentRuntime']['accountUsage']['recordSnapshot']>()
            .toEqualTypeOf<(
                input: ProviderAccountUsageRecordSnapshotInputV1,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) => Promise<ProviderAccountUsageRecordSnapshotResultV1>>();
        expectTypeOf<ProviderAccountUsageRecordSnapshotInputV1>().toMatchTypeOf<Readonly<{
            source?: ProviderAccountUsageSourceContextV1 | null;
        }>>();
        expectTypeOf<PluginContextV1['agentRuntime']['accountUsage']['adoptProvisionalRecord']>()
            .toEqualTypeOf<(
                input: ProviderAccountUsageAdoptProvisionalRecordInputV1,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) => Promise<ProviderAccountUsageAdoptProvisionalRecordResultV1>>();
    });

    it('exposes terminal-host control through a dedicated provider-neutral service', () => {
        expectTypeOf<PluginContextV1['agentRuntime']['terminalHost']>()
            .toEqualTypeOf<TerminalHostRuntimeServiceV1>();
    });

    it('exposes transcript file following only under the transcript runtime service', () => {
        expectTypeOf<PluginContextV1['agentRuntime']['transcripts']['fileFollow']['follow']>()
            .toEqualTypeOf<(input: TranscriptFileFollowInputV1) => Promise<TranscriptFileFollowHandleV1>>();
        // @ts-expect-error A.12.2 deliberately avoids a broad top-level ctx.fileFollow filesystem watcher.
        type FlatFileFollow = PluginContextV1['fileFollow'];
        void (undefined as unknown as FlatFileFollow);
    });

    it('exposes structured agent CLI readiness without widening exec system-tool grants', () => {
        expectTypeOf<PluginContextV1['agentRuntime']['agents']>()
            .toEqualTypeOf<AgentsRuntimeServiceV1>();
        expectTypeOf<PluginContextV1['agentRuntime']['agents']['cli']['checkReadiness']>()
            .toEqualTypeOf<(query: AgentCliReadinessQueryV1) => Promise<AgentCliReadinessResultV1>>();
        expectTypeOf<AgentCliReadinessResultV1['status']>()
            .toEqualTypeOf<'launchable' | 'missing' | 'blocked' | 'unknown'>();
        expectTypeOf<AgentCliReadinessResultV1['launchable'][number]>()
            .toMatchTypeOf<Readonly<{
                status: 'launchable';
                scope: 'launch';
                checks: Readonly<{
                    launch: 'passed';
                    auth: 'not_checked';
                    buildPolicy: 'not_checked';
                }>;
            }>>();
    });

    it('does not advertise unsupported managed-server restart policies in public SDK types', () => {
        const accepted = {
            id: 'server-1',
            launch: { kind: 'binary', executablePath: '/bin/true' },
            restart: 'never',
        } satisfies ManagedServerSpecV1;
        expectTypeOf(accepted.restart).toEqualTypeOf<'never'>();

        const unsupported = {
            id: 'server-2',
            launch: { kind: 'binary', executablePath: '/bin/true' },
            // @ts-expect-error managed-server restart supervision is not part of the V1 public SDK contract.
            restart: 'on_failure',
        } satisfies ManagedServerSpecV1;
        void unsupported;
    });
});
