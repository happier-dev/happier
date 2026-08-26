import { describe, expect, expectTypeOf, it } from 'vitest';

import type { PluginInvocableActionId } from '@happier-dev/plugin-sdk/actions';

import {
    RunnerDaemonExternalSessionsAttachResultV1Schema,
    RunnerDaemonExternalSessionsCapabilitiesResultV1Schema,
    RunnerDaemonExternalSessionsFollowEventV1Schema,
    RunnerDaemonExternalSessionsListResultV1Schema,
    RunnerDaemonExternalSessionsTakeoverResultV1Schema,
    RunnerDaemonExternalSessionsTranscriptResultV1Schema,
    RUNNER_DAEMON_PROVIDER_OPERATION_IDS_V1,
    RUNNER_DAEMON_PLUGIN_SERVICE_OPERATION_V1_SCHEMAS,
    RunnerDaemonManagedProviderCustodyScopeV1Schema,
    RunnerDaemonPluginServiceOperationV1Schema,
    RunnerDaemonPluginServiceResultV1Schema,
    RunnerDaemonPluginServiceSubscriptionEventV1Schema,
    decodeRunnerDaemonPluginServiceWireValueV1,
    encodeRunnerDaemonPluginServiceWireValueV1,
    type RunnerDaemonPluginServiceOperationV1,
} from './agentRuntimeDaemonPluginServicesProtocol';
import {
    RUNNER_AGENT_DAEMON_FACET_OPERATION_SCHEMAS,
    type RunnerAgentDaemonFacetOperationV1,
} from './agentRuntimeDaemonFacetProtocol';

type RetainedGenerationDependency =
    | 'stable'
    | 'current-global'
    | 'generation-private';
type RetainedRunnerOperationKind =
    | RunnerDaemonPluginServiceOperationV1['kind']
    | RunnerAgentDaemonFacetOperationV1['kind'];
type RunnerPluginActionExecuteOperationV1 = Extract<
    RunnerDaemonPluginServiceOperationV1,
    Readonly<{ kind: 'plugin_actions.execute_v1' }>
>;

const retainedRunnerOperationClassification = [
    // SVC09 custody remains separately domain-owned by the managed-services corridor.
    {
        dependency: 'stable',
        kinds: [
            'plugin_services.prepare_v1',
            'plugin_services.close_v1',
            'plugin_logger.write_v1',
            'plugin_storage.get_v1',
            'plugin_storage.set_v1',
            'plugin_storage.delete_v1',
            'plugin_storage.list_v1',
            'plugin_storage.transaction.open_v1',
            'plugin_storage.transaction.get_v1',
            'plugin_storage.transaction.set_v1',
            'plugin_storage.transaction.delete_v1',
            'plugin_storage.transaction.commit_v1',
            'plugin_storage.transaction.rollback_v1',
            'plugin_settings.snapshot_v1',
            'plugin_settings.get_v1',
            'plugin_settings.set_v1',
            'plugin_settings.reset_v1',
            'plugin_settings.watch.open_v1',
            'plugin_secrets.status_v1',
            'plugin_secrets.get_v1',
            'plugin_secrets.set_v1',
            'plugin_secrets.delete_v1',
            'plugin_events.emit_v1',
            'plugin_events.subscribe.open_v1',
            'plugin_events.host.subscribe.open_v1',
            'plugin_fetch.request_v1',
            'plugin_fs.read_file_v1',
            'plugin_fs.write_file_v1',
            'plugin_fs.stat_v1',
            'plugin_fs.list_v1',
            'plugin_fs.remove_v1',
            'plugin_resources.describe_v1',
            'plugin_resources.read_v1',
            'plugin_resources.watch.open_v1',
            'plugin_mcp.client.list_tools_v1',
            'plugin_mcp.client.call_tool_v1',
            'plugin_mcp.client.list_resources_v1',
            'plugin_mcp.client.list_resource_templates_v1',
            'plugin_mcp.client.read_resource_v1',
            'plugin_mcp.client.subscribe_resource.open_v1',
            'plugin_mcp.client.list_prompts_v1',
            'plugin_mcp.client.get_prompt_v1',
            'plugin_mcp.client.close_v1',
            'plugin_notifications.list_categories_v1',
            'plugin_notifications.preferences_v1',
            'plugin_notifications.watch_preferences.open_v1',
            'plugin_connected_accounts.get_binding_v1',
            'plugin_connected_accounts.materialize_v1',
            'plugin_connected_accounts.list_accounts_v1',
            'plugin_connected_accounts.materialize_listed_account_v1',
            'plugin_connected_accounts.watch.open_v1',
            'plugin_connected_accounts.watch.next_v1',
            'plugin_services.subscription.next_v1',
            'plugin_services.subscription.close_v1',
            'plugin_exec.agent_cli.check_readiness_v1',
            'plugin_exec.system_tools.resolve_v1',
            'plugin_exec.launch.authorize_v1',
            'plugin_exec.launch.release_v1',
        ],
    },
    {
        dependency: 'current-global',
        kinds: [
            'plugin_actions.execute_v1',
            'plugin_providers.invoke_v1',
            'plugin_mcp.list_v1',
            'plugin_mcp.discover_v1',
            'plugin_mcp.connect_v1',
            'plugin_notifications.send_v1',
            'plugin_notifications.list_channels_v1',
            'plugin_connected_accounts.request_selection_v1',
            'plugin_sessions.external.capabilities_v1',
            'plugin_sessions.external.list_v1',
            'plugin_sessions.external.attach_v1',
            'plugin_sessions.external.read_transcript_v1',
            'plugin_sessions.external.follow_transcript.open_v1',
            'plugin_sessions.external.takeover_v1',
        ],
    },
    {
        dependency: 'generation-private',
        kinds: [
            'plugin_services.managed_provider.start_v1',
            'plugin_services.managed_provider.materialize_agent_binding_v1',
            'external_session.follow.open',
            'external_session.follow.next',
            'external_session.follow.close',
            'voice.authority.snapshot',
            'voice.authority.waitRetired',
        ],
    },
] as const satisfies readonly Readonly<{
    dependency: RetainedGenerationDependency;
    kinds: readonly RetainedRunnerOperationKind[];
}>[];

describe('runner daemon PluginServices v1 protocol', () => {
    it('keeps generic Action execution aligned with the public Plugin Action projection', () => {
        expectTypeOf<RunnerPluginActionExecuteOperationV1['actionId']>()
            .toEqualTypeOf<PluginInvocableActionId>();

        const operation = {
            kind: 'plugin_actions.execute_v1',
            requestId: 'request-action',
            invocationId: 'invocation-1',
            actionId: 'session.list',
            input: { t: 'object', value: {} },
        } as const;
        expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse(operation).success).toBe(true);
        expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
            ...operation,
            actionId: 'sessions.external.takeover.start',
        }).success).toBe(false);
    });

    it('rejects private or broadened fields in every External Sessions result family', () => {
        const unavailable = { status: 'unavailable', code: 'not_available' } as const;
        const values = [
            [RunnerDaemonExternalSessionsCapabilitiesResultV1Schema, {
                list: unavailable,
                attach: unavailable,
                takeover: unavailable,
                transcript: unavailable,
                follow: unavailable,
            }],
            [RunnerDaemonExternalSessionsListResultV1Schema, {
                items: [],
                nextCursor: null,
            }],
            [RunnerDaemonExternalSessionsAttachResultV1Schema, { sessionId: 'session-1' }],
            [RunnerDaemonExternalSessionsTranscriptResultV1Schema, {
                mode: 'page',
                items: [],
                nextCursor: null,
            }],
            [RunnerDaemonExternalSessionsTakeoverResultV1Schema, {
                sessionId: 'session-1',
                operationId: 'operation-1',
                revision: 1,
            }],
            [RunnerDaemonExternalSessionsFollowEventV1Schema, {
                kind: 'resyncRequired',
                reason: 'cursorDiscontinuity',
                cursor: null,
            }],
        ] as const;

        for (const [schema, value] of values) {
            expect(schema.safeParse(value).success).toBe(true);
            expect(schema.safeParse({ ...value, privateDaemonField: 'must-not-cross' }).success)
                .toBe(false);
        }
    });
    it('applies the canonical transcript item identity to runner reads and follow events', () => {
        // Placement must not change validity or identity: the public contract is
        // nonempty, trim-equal and at most 2,000 code units, rejected rather than
        // normalized. A generic 512-code-unit trimming id schema silently did both.
        const item = (id: string) => ({ id, kind: 'agent', data: { type: 'text', text: 'x' } });
        const page = (id: string) => ({ mode: 'page', items: [item(id)], nextCursor: null });
        const follow = (id: string) => ({
            kind: 'data',
            items: [item(id)],
            fromCursor: null,
            nextCursor: 'cursor-1',
        });

        for (const build of [page, follow] as const) {
            const schema = build === page
                ? RunnerDaemonExternalSessionsTranscriptResultV1Schema
                : RunnerDaemonExternalSessionsFollowEventV1Schema;
            const exact = 'x'.repeat(2_000);
            const parsedExact = schema.safeParse(build(exact));
            expect(parsedExact.success).toBe(true);
            expect(schema.safeParse(build('x'.repeat(2_001))).success).toBe(false);
            expect(schema.safeParse(build(` ${'x'.repeat(600)} `)).success).toBe(false);
            expect(schema.safeParse(build('')).success).toBe(false);
            const preserved = 'external::/%?=+#[]@!$&\'()*+,;\u{1F642}';
            const parsedPreserved = schema.safeParse(build(preserved));
            expect(parsedPreserved.success).toBe(true);
            expect(parsedPreserved.success
                && (parsedPreserved.data as { items: readonly { id: string }[] }).items[0]?.id)
                .toBe(preserved);
        }
    });

    it('uses the public author follow-event cursor and collection bounds', () => {
        const follow = (cursor: string, items: readonly unknown[] = []) => ({
            kind: 'data' as const,
            items,
            fromCursor: null,
            nextCursor: cursor,
        });
        const item = (index: number) => ({
            id: `item-${index}`,
            kind: 'agent' as const,
            data: { type: 'text', text: 'x' },
        });
        const maximumCursor = 'c'.repeat(4_096);

        expect(RunnerDaemonExternalSessionsFollowEventV1Schema.safeParse(
            follow(maximumCursor),
        ).success).toBe(true);
        expect(RunnerDaemonExternalSessionsFollowEventV1Schema.safeParse(
            follow(`${maximumCursor}c`),
        ).success).toBe(false);
        expect(RunnerDaemonExternalSessionsFollowEventV1Schema.safeParse(
            follow('cursor-1', Array.from({ length: 1_001 }, (_, index) => item(index))),
        ).success).toBe(true);
    });

    it('requires explicit external or bundled authority in exact Provider custody', () => {
        const scope = {
            v: 1,
            sessionId: 'session-1',
            runtimeBindingBasis: {
                v: 1,
                agentTargetKey: 'backend:claude',
                connectionId: 'connection-1',
                contributionKey: 'provider.plugin/gateway',
                runtimeCredentialTransport: null,
                prepared: { v: 1, materialization: 'spawnEnv' },
                adapterVersion: 1,
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
                deployment: {
                    kind: 'managedLocal',
                    implementationIdentity: {
                        pluginId: 'provider.plugin',
                        localId: 'gateway',
                    },
                    managedRuntime: {
                        kind: 'managed',
                        dependencies: [],
                        endpointTemplateIds: ['messages'],
                        connectedAccounts: [],
                        requestAuthUses: [],
                    },
                    purposeBindings: { v: 1, bindings: [] },
                },
                endpoint: {
                    endpointTemplateId: 'messages',
                    protocol: 'anthropic',
                    publicHeaders: {},
                },
                credentialAuthorization: {
                    connectionSecurityFingerprint: 'connection-security',
                    grantFingerprint: 'grant',
                },
            },
            pluginId: 'provider.plugin',
            providerLocalId: 'gateway',
            activationGeneration: 'activation-1',
            immutableGenerationId: 'generation-1',
            manifestAuthority: 'external',
            operationClaimId: 'session-demand:session-1:generation-1',
        } as const;
        expect(
            RunnerDaemonManagedProviderCustodyScopeV1Schema.safeParse(scope)
                .success,
        ).toBe(true);
        const { manifestAuthority: _authority, ...withoutAuthority } = scope;
        expect(
            RunnerDaemonManagedProviderCustodyScopeV1Schema.safeParse(
                withoutAuthority,
            ).success,
        ).toBe(false);
        expect(
            RunnerDaemonManagedProviderCustodyScopeV1Schema.safeParse({
                ...scope,
                manifestAuthority: 'plugin-id-inferred',
            }).success,
        ).toBe(false);
    });

    it('exposes exactly the eleven Provider facade operations', () => {
        expect(RUNNER_DAEMON_PROVIDER_OPERATION_IDS_V1).toEqual([
            'connections.describe',
            'connections.mutate',
            'connections.bindingStatus',
            'catalog.probe',
            'catalog.listModels',
            'catalog.setModelLoad',
            'catalog.projectModels',
            'catalog.mutateModelSettings',
            'migrations.preview',
            'migrations.confirm',
            'migrations.confirmConflict',
        ]);
    });

    it('accepts explicit PluginServices operations and rejects generic authority', () => {
        const witness = {
            inputId: 'input-1',
            turnId: 'turn-1',
            userMessageSeq: 1,
            userMessageSeqs: [1],
        };
        const operations = [
            { kind: 'plugin_services.prepare_v1', requestId: 'request-1', invocationId: 'invocation-1', witness },
            { kind: 'plugin_logger.write_v1', requestId: 'request-1a', invocationId: 'invocation-1', witness, entry: { kind: 'log', level: 'info', message: 'retained runner log', fields: { t: 'object', value: {} } } },
            { kind: 'plugin_storage.get_v1', requestId: 'request-2', invocationId: 'invocation-1', scope: 'daemon', key: 'state' },
            { kind: 'plugin_storage.set_v1', requestId: 'request-3', invocationId: 'invocation-1', scope: 'daemonSession', key: 'state', value: { t: 'string', value: 'ready' } },
            { kind: 'plugin_storage.delete_v1', requestId: 'request-4', invocationId: 'invocation-1', scope: 'daemon', key: 'state' },
            { kind: 'plugin_storage.list_v1', requestId: 'request-5', invocationId: 'invocation-1', scope: 'ephemeral', prefix: 'a', cursor: '2', limit: 5 },
            { kind: 'plugin_storage.transaction.open_v1', requestId: 'request-5a', invocationId: 'invocation-1', transactionId: 'transaction-1', scope: 'daemonSession' },
            { kind: 'plugin_storage.transaction.get_v1', requestId: 'request-5b', invocationId: 'invocation-1', transactionId: 'transaction-1', key: 'state' },
            { kind: 'plugin_storage.transaction.set_v1', requestId: 'request-5c', invocationId: 'invocation-1', transactionId: 'transaction-1', key: 'state', value: { t: 'boolean', value: true } },
            { kind: 'plugin_storage.transaction.delete_v1', requestId: 'request-5d', invocationId: 'invocation-1', transactionId: 'transaction-1', key: 'state' },
            { kind: 'plugin_storage.transaction.commit_v1', requestId: 'request-5e', invocationId: 'invocation-1', transactionId: 'transaction-1' },
            { kind: 'plugin_storage.transaction.rollback_v1', requestId: 'request-5f', invocationId: 'invocation-1', transactionId: 'transaction-1' },
            { kind: 'plugin_settings.snapshot_v1', requestId: 'request-6', invocationId: 'invocation-1', scope: 'account' },
            { kind: 'plugin_settings.get_v1', requestId: 'request-7', invocationId: 'invocation-1', scope: 'daemon', id: 'theme' },
            { kind: 'plugin_settings.set_v1', requestId: 'request-8', invocationId: 'invocation-1', scope: 'daemon', id: 'theme', value: { t: 'string', value: 'dark' }, expectedRevision: 'revision-1' },
            { kind: 'plugin_settings.reset_v1', requestId: 'request-9', invocationId: 'invocation-1', scope: 'account', id: 'theme' },
            { kind: 'plugin_settings.watch.open_v1', requestId: 'request-9a', invocationId: 'invocation-1', scope: 'account', subscriptionId: 'settings-watch' },
            { kind: 'plugin_secrets.status_v1', requestId: 'request-10', invocationId: 'invocation-1', id: 'token' },
            { kind: 'plugin_secrets.get_v1', requestId: 'request-11', invocationId: 'invocation-1', id: 'token', reason: 'connect' },
            { kind: 'plugin_secrets.set_v1', requestId: 'request-12', invocationId: 'invocation-1', id: 'token', value: 'secret' },
            { kind: 'plugin_secrets.delete_v1', requestId: 'request-13', invocationId: 'invocation-1', id: 'token' },
            { kind: 'plugin_events.emit_v1', requestId: 'request-14', invocationId: 'invocation-1', eventId: 'changed', payload: { t: 'null' } },
            { kind: 'plugin_events.subscribe.open_v1', requestId: 'request-14a', invocationId: 'invocation-1', subscriptionId: 'event-watch', event: { pluginId: 'fixture.plugin', localId: 'changed' } },
            { kind: 'plugin_events.host.subscribe.open_v1', requestId: 'request-14b', invocationId: 'invocation-1', subscriptionId: 'host-event-watch', target: { eventId: '@happier/runtime/turn-complete', scope: { kind: 'session', sessionId: 'session-1' } } },
            { kind: 'plugin_fetch.request_v1', requestId: 'request-15', invocationId: 'invocation-1', request: { url: 'https://example.com', redirect: 'error' } },
            { kind: 'plugin_actions.execute_v1', requestId: 'request-15-action', invocationId: 'invocation-1', actionId: 'session.list', input: { t: 'object', value: {} } },
            { kind: 'plugin_providers.invoke_v1', requestId: 'request-15a', invocationId: 'invocation-1', operation: 'connections.describe', request: { t: 'object', value: {} } },
            { kind: 'plugin_fs.read_file_v1', requestId: 'request-16', invocationId: 'invocation-1', path: { root: 'workspace', relativePath: 'README.md' } },
            { kind: 'plugin_fs.write_file_v1', requestId: 'request-17', invocationId: 'invocation-1', path: { root: 'pluginData', relativePath: 'state.bin' }, data: 'AA==' },
            { kind: 'plugin_fs.stat_v1', requestId: 'request-18', invocationId: 'invocation-1', path: { root: 'workspace', relativePath: '.' } },
            { kind: 'plugin_fs.list_v1', requestId: 'request-19', invocationId: 'invocation-1', path: { root: 'workspace', relativePath: '.' } },
            { kind: 'plugin_fs.remove_v1', requestId: 'request-20', invocationId: 'invocation-1', path: { root: 'pluginData', relativePath: 'state.bin' } },
            { kind: 'plugin_resources.describe_v1', requestId: 'request-21', invocationId: 'invocation-1', id: 'prompt' },
            { kind: 'plugin_resources.read_v1', requestId: 'request-22', invocationId: 'invocation-1', id: 'prompt' },
            { kind: 'plugin_resources.watch.open_v1', requestId: 'request-22a', invocationId: 'invocation-1', subscriptionId: 'resource-watch', id: 'prompt' },
            { kind: 'plugin_mcp.list_v1', requestId: 'request-23', invocationId: 'invocation-1' },
            { kind: 'plugin_mcp.discover_v1', requestId: 'request-24', invocationId: 'invocation-1', provider: { pluginId: 'acme.plugin', localId: 'discover' } },
            { kind: 'plugin_mcp.connect_v1', requestId: 'request-25', invocationId: 'invocation-1', clientId: 'client-1', ref: { pluginId: 'acme.plugin', localId: 'server' }, elicitation: { mode: 'reject' } },
            { kind: 'plugin_mcp.client.list_tools_v1', requestId: 'request-26', invocationId: 'invocation-1', clientId: 'client-1' },
            { kind: 'plugin_mcp.client.call_tool_v1', requestId: 'request-27', invocationId: 'invocation-1', clientId: 'client-1', name: 'tool', input: { t: 'null' } },
            { kind: 'plugin_mcp.client.list_resources_v1', requestId: 'request-27a', invocationId: 'invocation-1', clientId: 'client-1', cursor: 'resource-cursor' },
            { kind: 'plugin_mcp.client.list_resource_templates_v1', requestId: 'request-27b', invocationId: 'invocation-1', clientId: 'client-1' },
            { kind: 'plugin_mcp.client.read_resource_v1', requestId: 'request-27c', invocationId: 'invocation-1', clientId: 'client-1', uri: 'file:///guide.md' },
            { kind: 'plugin_mcp.client.subscribe_resource.open_v1', requestId: 'request-27d', invocationId: 'invocation-1', clientId: 'client-1', subscriptionId: 'mcp-resource-watch', uri: 'file:///guide.md' },
            { kind: 'plugin_mcp.client.list_prompts_v1', requestId: 'request-27e', invocationId: 'invocation-1', clientId: 'client-1', cursor: 'prompt-cursor' },
            { kind: 'plugin_mcp.client.get_prompt_v1', requestId: 'request-27f', invocationId: 'invocation-1', clientId: 'client-1', name: 'review', args: { scope: 'src' } },
            { kind: 'plugin_mcp.client.close_v1', requestId: 'request-28', invocationId: 'invocation-1', clientId: 'client-1' },
            { kind: 'plugin_notifications.send_v1', requestId: 'request-29', invocationId: 'invocation-1', request: { clientRequestId: 'client-request-1', categoryId: 'build', title: 'Done' } },
            { kind: 'plugin_notifications.list_channels_v1', requestId: 'request-30', invocationId: 'invocation-1' },
            { kind: 'plugin_notifications.list_categories_v1', requestId: 'request-31', invocationId: 'invocation-1' },
            { kind: 'plugin_notifications.preferences_v1', requestId: 'request-32', invocationId: 'invocation-1', categoryId: 'build' },
            { kind: 'plugin_notifications.watch_preferences.open_v1', requestId: 'request-32a', invocationId: 'invocation-1', subscriptionId: 'notification-watch', categoryId: 'build' },
            { kind: 'plugin_connected_accounts.get_binding_v1', requestId: 'request-33', invocationId: 'invocation-1', purpose: 'upstream' },
            { kind: 'plugin_connected_accounts.request_selection_v1', requestId: 'request-34', invocationId: 'invocation-1', purpose: 'upstream', reason: 'select account' },
            { kind: 'plugin_connected_accounts.materialize_v1', requestId: 'request-35', invocationId: 'invocation-1', purpose: 'upstream', request: { kind: 'environment', keys: ['TOKEN'] } },
            { kind: 'plugin_connected_accounts.watch.open_v1', requestId: 'request-35a', invocationId: 'invocation-1', subscriptionId: 'subscription-1', purpose: 'upstream' },
            { kind: 'plugin_connected_accounts.watch.next_v1', requestId: 'request-35aa', invocationId: 'invocation-1', subscriptionId: 'subscription-1' },
            { kind: 'plugin_services.subscription.next_v1', requestId: 'request-35ab', invocationId: 'invocation-1', subscriptionId: 'subscription-1', acknowledgement: 'settled' },
            { kind: 'plugin_services.subscription.close_v1', requestId: 'request-35b', invocationId: 'invocation-1', subscriptionId: 'subscription-1' },
            { kind: 'plugin_exec.agent_cli.check_readiness_v1', requestId: 'request-36', invocationId: 'invocation-1', request: { candidates: ['codex'], requirement: 'any' } },
            { kind: 'plugin_exec.system_tools.resolve_v1', requestId: 'request-37', invocationId: 'invocation-1', request: { toolId: 'codex', purpose: 'session' } },
            { kind: 'plugin_exec.launch.authorize_v1', requestId: 'request-38', invocationId: 'invocation-1', request: { executable: { kind: 'systemTool', id: 'codex' }, args: ['--version'] } },
            { kind: 'plugin_exec.launch.release_v1', requestId: 'request-38a', invocationId: 'invocation-1', authorizationId: 'authorization-1' },
            { kind: 'plugin_services.close_v1', requestId: 'request-39', invocationId: 'invocation-1' },
        ];

        for (const operation of operations) {
            expect(
                RunnerDaemonPluginServiceOperationV1Schema.safeParse(operation).success,
                operation.kind,
            ).toBe(true);
        }
        expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
            kind: 'plugin_services.invoke_v1',
            requestId: 'request-40',
            invocationId: 'invocation-1',
            service: 'exec',
            method: 'spawn',
        }).success).toBe(false);
        expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
            ...operations[1],
            ambientAuthority: true,
        }).success).toBe(false);
        for (const retiredScope of ['session', 'local', 'synced']) {
            expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
                kind: 'plugin_storage.get_v1',
                requestId: `request-retired-${retiredScope}`,
                invocationId: 'invocation-1',
                scope: retiredScope,
                key: 'state',
            }).success).toBe(false);
        }
        expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
            kind: 'plugin_providers.invoke_v1',
            requestId: 'request-provider-invalid',
            invocationId: 'invocation-1',
            operation: 'connections.rawMachineRequest',
            request: { t: 'object', value: {} },
        }).success).toBe(false);
        // The canonical Plugin surface is owned by the Action registry
        // (`PLUGIN_SURFACE_EXCLUSION_REASONS` plus each spec's `surfaces.plugin`),
        // not by this transport schema. These literals restate that owner's
        // current decision for the two families the runner forwards, so a
        // silent widening or narrowing of the Plugin surface fails here.
        for (const actionId of ['voice_agent.start']) {
            expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
                kind: 'plugin_actions.execute_v1',
                requestId: `request-action-${actionId}`,
                invocationId: 'invocation-1',
                actionId,
                input: { t: 'object', value: {} },
            }).success, actionId).toBe(true);
        }
        for (const actionId of [
            'sessions.subagents.list',
            'sessions.subagents.get',
            'sessions.subagents.watch',
            'sessions.subagents.upsert',
            'sessions.subagents.updateStatus',
            'sessions.subagents.complete',
            'sessions.external.takeover.start',
        ]) {
            expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
                kind: 'plugin_actions.execute_v1',
                requestId: `request-action-${actionId}`,
                invocationId: 'invocation-1',
                actionId,
                input: { t: 'object', value: {} },
            }).success, actionId).toBe(false);
        }
        expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
            kind: 'plugin_actions.execute_v1',
            requestId: 'request-action-malformed',
            invocationId: 'invocation-1',
            actionId: 'not-a-canonical-action',
            input: { t: 'object', value: {} },
        }).success).toBe(false);
        expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
            ...operations[0],
            cwd: '/',
            environment: { PATH: '/arbitrary' },
            providerBindingActive: true,
        }).success).toBe(false);

        for (const operation of operations.filter((candidate) =>
            candidate.kind.startsWith('plugin_connected_accounts.'))
        ) {
            expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
                ...operation,
                serviceScope: 'managedProvider',
            }).success).toBe(true);
        }
        const connectedAccountOperation = operations.find((candidate) =>
            candidate.kind
                === 'plugin_connected_accounts.get_binding_v1'
        );
        expect(connectedAccountOperation).toBeDefined();
        expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
            ...connectedAccountOperation,
            serviceScope: 'provider',
        }).success).toBe(false);
        expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
            ...operations[1],
            serviceScope: 'managedProvider',
        }).success).toBe(false);
    });

    it('round-trips every canonical Connected Account materialization discriminator', () => {
        const requests = [
            {
                input: {
                    kind: 'httpHeaders',
                    origin: 'https://api.example.com',
                    headerNames: ['Authorization'],
                },
                output: {
                    kind: 'httpHeaders',
                    origin: 'https://api.example.com',
                    headerNames: ['authorization'],
                },
            },
            {
                input: { kind: 'environment', keys: ['ACCESS_TOKEN'] },
                output: { kind: 'environment', keys: ['ACCESS_TOKEN'] },
            },
            {
                input: { kind: 'files', fileIds: ['service-account'] },
                output: { kind: 'files', fileIds: ['service-account'] },
            },
        ] as const;

        for (const [index, request] of requests.entries()) {
            const operation = RunnerDaemonPluginServiceOperationV1Schema.parse({
                kind: 'plugin_connected_accounts.materialize_v1',
                requestId: `materialize-${index}`,
                invocationId: 'invocation-1',
                purpose: 'upstream',
                request: request.input,
            });
            expect(operation).toMatchObject({ request: request.output });
            expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse(
                JSON.parse(JSON.stringify(operation)),
            ).success).toBe(true);
        }

        for (const request of [
            { kind: 'httpHeaders', origin: 'https://api.example.com', headerNames: [] },
            { kind: 'environment', keys: ['ACCESS_TOKEN', 'ACCESS_TOKEN'] },
            { kind: 'files', fileIds: ['service-account'], unexpected: true },
        ]) {
            expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
                kind: 'plugin_connected_accounts.materialize_v1',
                requestId: 'invalid-materialize',
                invocationId: 'invocation-1',
                purpose: 'upstream',
                request,
            }).success).toBe(false);
        }
    });

    it('carries a compare-only observed account precondition without accepting account selection', () => {
        const expectedAccount = {
            service: { pluginId: 'acme.accounts', localId: 'openai' },
            accountId: 'account-a',
        };
        const operation = RunnerDaemonPluginServiceOperationV1Schema.parse({
            kind: 'plugin_connected_accounts.materialize_v1',
            requestId: 'materialize-current-binding',
            invocationId: 'invocation-1',
            purpose: 'upstream',
            expectedAccount,
            request: { kind: 'environment', keys: ['TOKEN'] },
        });

        expect(operation).toMatchObject({ expectedAccount });
        expect(RunnerDaemonPluginServiceOperationV1Schema.safeParse({
            ...operation,
            account: expectedAccount,
        }).success).toBe(false);
    });

    it('classifies every retained runner operation without a runtime classifier', () => {
        const schemaKinds = [
            ...RUNNER_DAEMON_PLUGIN_SERVICE_OPERATION_V1_SCHEMAS
                .map((schema) => schema.shape.kind.value),
            ...RUNNER_AGENT_DAEMON_FACET_OPERATION_SCHEMAS
                .map((schema) => schema.shape.kind.value),
        ].sort();
        const flattenedClassifiedKinds = retainedRunnerOperationClassification
            .flatMap((entry) => entry.kinds);
        const classifiedKinds = [
            ...new Set(flattenedClassifiedKinds),
        ].sort();

        expect(flattenedClassifiedKinds.length).toBe(classifiedKinds.length);
        expect(classifiedKinds).toEqual(schemaKinds);
        expect(
            retainedRunnerOperationClassification.map(
                (entry) => entry.dependency,
            ),
        ).toEqual([
            'stable',
            'current-global',
            'generation-private',
        ]);
        expect(
            retainedRunnerOperationClassification
                .filter((entry) => new Set<RetainedRunnerOperationKind>(
                    entry.kinds,
                ).has(
                    'plugin_services.managed_provider.materialize_agent_binding_v1',
                ))
                .map((entry) => entry.dependency),
        ).toEqual(['generation-private']);
        for (const entry of retainedRunnerOperationClassification) {
            expect(
                new Set(entry.kinds).size,
                entry.dependency,
            ).toBe(entry.kinds.length);
        }
    });

    it('preserves present empty and non-empty binary operation payloads', () => {
        for (const base64 of ['', 'AAH/']) {
            expect(RunnerDaemonPluginServiceOperationV1Schema.parse({
                kind: 'plugin_fetch.request_v1',
                requestId: `fetch-${base64 || 'empty'}`,
                invocationId: 'invocation-1',
                request: {
                    url: 'https://example.test/binary',
                    redirect: 'error',
                    body: base64,
                },
            })).toMatchObject({
                request: { body: base64 },
            });
            expect(RunnerDaemonPluginServiceOperationV1Schema.parse({
                kind: 'plugin_exec.launch.authorize_v1',
                requestId: `exec-${base64 || 'empty'}`,
                invocationId: 'invocation-1',
                request: {
                    executable: {
                        kind: 'managedDependency',
                        id: 'fixture-adapter',
                    },
                    stdin: base64,
                },
            })).toMatchObject({
                request: { stdin: base64 },
            });
        }
    });

    it('accepts only strict callback events for a registered subscription', () => {
        for (const event of [
            {
                kind:
                    'plugin_settings.watch.event_v1',
                invocationId: 'invocation-1',
                subscriptionId: 'subscription-1',
                scope: 'account',
                change: {
                    revision: 'revision-1',
                    changedIds: ['theme'],
                    values: {
                        theme: { t: 'string', value: 'dark' },
                    },
                },
            },
            {
                kind:
                    'plugin_events.subscribe.event_v1',
                invocationId: 'invocation-1',
                subscriptionId: 'subscription-1',
                event: {
                    ref: {
                        pluginId: 'fixture.plugin',
                        localId: 'changed',
                    },
                    payload: { t: 'boolean', value: true },
                    sequence: 1,
                },
            },
            {
                kind:
                    'plugin_events.host.subscribe.event_v1',
                invocationId: 'invocation-1',
                subscriptionId: 'subscription-1',
                event: {
                    eventId:
                        '@happier/runtime/turn-complete',
                    scope: {
                        kind: 'session',
                        sessionId: 'session-1',
                    },
                    payload: {
                        t: 'object',
                        value: {
                            sequence: {
                                t: 'number',
                                value: 1,
                            },
                            sessionId: {
                                t: 'string',
                                value: 'session-1',
                            },
                            emittedAtMs: {
                                t: 'number',
                                value: 2,
                            },
                            kind: {
                                t: 'string',
                                value: 'turn-complete',
                            },
                            turnId: {
                                t: 'string',
                                value: 'turn-1',
                            },
                        },
                    },
                },
            },
            {
                kind:
                    'plugin_events.host.subscribe.event_v1',
                invocationId: 'invocation-1',
                subscriptionId: 'subscription-1',
                event: {
                    eventId:
                        '@happier/automation/run-state-changed',
                    scope: { kind: 'account' },
                    payload: {
                        t: 'object',
                        value: {
                            runId: { t: 'string', value: 'run-1' },
                            automationId: { t: 'string', value: 'automation-1' },
                            originKind: { t: 'string', value: 'scheduled' },
                            previousState: { t: 'null' },
                            currentState: { t: 'string', value: 'queued' },
                            transitionedAt: { t: 'number', value: 1 },
                            claimedByMachineId: { t: 'null' },
                        },
                    },
                },
            },
            {
                kind:
                    'plugin_resources.watch.event_v1',
                invocationId: 'invocation-1',
                subscriptionId: 'subscription-1',
                change: { digest: 'sha256:changed' },
            },
            {
                kind:
                    'plugin_sessions.external.follow_transcript.opened_v1',
                invocationId: 'invocation-1',
                subscriptionId: 'subscription-1',
                result: {
                    status: 'following',
                    startingCursor: 'cursor-1',
                },
            },
            {
                kind:
                    'plugin_mcp.client.subscribe_resource.event_v1',
                invocationId: 'invocation-1',
                subscriptionId: 'subscription-1',
                event: { uri: 'file:///guide.md' },
            },
            {
                kind:
                    'plugin_notifications.watch_preferences.event_v1',
                invocationId: 'invocation-1',
                subscriptionId: 'subscription-1',
                preferences: {
                    categoryId: 'build',
                    enabled: true,
                    channelIds: ['desktop'],
                    revision: 'revision-1',
                },
            },
            {
                    kind:
                        'plugin_connected_accounts.watch.event_v1',
                    invocationId: 'invocation-1',
                    subscriptionId: 'subscription-1',
                    event: { kind: 'resync' },
            },
        ]) {
            expect(
                RunnerDaemonPluginServiceSubscriptionEventV1Schema
                    .safeParse(event).success,
                event.kind,
            ).toBe(true);
        }
        expect(
            RunnerDaemonPluginServiceSubscriptionEventV1Schema
                .safeParse({
                    kind:
                        'plugin_connected_accounts.watch.event_v1',
                    invocationId: 'invocation-1',
                    subscriptionId: 'subscription-1',
                    event: { kind: 'edge' },
                }).success,
        ).toBe(false);
    });

    it('round-trips binary and JSON values without object-tag ambiguity', () => {
        const value = {
            nested: [{ t: 'bytes', value: 'plugin-owned-json' }],
            bytes: new Uint8Array([0, 127, 255]),
            enabled: true,
            count: 3,
            missing: null,
        };
        const encoded = encodeRunnerDaemonPluginServiceWireValueV1(value);
        expect(RunnerDaemonPluginServiceResultV1Schema.safeParse({
            kind: 'plugin_services.result_v1',
            requestId: 'request-1',
            value: encoded,
        }).success).toBe(true);
        expect(decodeRunnerDaemonPluginServiceWireValueV1(encoded)).toEqual(value);
    });

    it('rejects malformed payloads and leaves failures to the outer authority transport', () => {
        expect(RunnerDaemonPluginServiceResultV1Schema.safeParse({
            kind: 'plugin_services.result_v1',
            requestId: 'request-1',
            value: { t: 'number', value: Number.NaN },
        }).success).toBe(false);
        expect(RunnerDaemonPluginServiceResultV1Schema.safeParse({
            kind: 'plugin_services.error_v1',
            requestId: 'request-1',
            code: 'plugin_service_unavailable',
            message: 'Unavailable',
            outcome: 'unknown_after_dispatch',
        }).success).toBe(false);
    });
});
