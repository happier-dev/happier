import { describe, expect, it, vi } from 'vitest';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { logger } from '@/ui/logger';
import {
    ApiTokenGrantV1Schema,
    AutomationRunCauseSchema,
    StrictJsonValueSchema,
    createActionExecutor,
    normalizeActionsSettingsV1,
    type ActionExecutorContext,
    type ActionExecutorDeps,
    type ActionDefinitionV1,
} from '@happier-dev/protocol';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams';
import { PluginError, readPluginErrorRequestIdV1, type JsonValue } from '@happier-dev/plugin-sdk';
import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { resolveActionSessionTargets } from '@happier-dev/protocol/actions/executor/sessionTargets';

import { createBrowserDaemonRuntimeActionExecutor } from '@/daemon/browser/actions/runtimeActionExecutor';
import { createBrowserDaemonControlBroker } from '@/daemon/browser/control/broker';
import { createBrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import { createBrowserAutomationOwnerRegistry } from '@/daemon/browser/automation/owners';
import { createBrowserAutomationDaemonService } from '@/daemon/browser/automation/service';
import { createBrowserAutomationCdpAdapter } from '@/daemon/browser/automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '@/daemon/browser/automation/adapters/controlBridge';
import { createBrowserSidecarCdpControlAdapter } from '@/daemon/browser/sidecar/controlAdapter';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';

import {
    createPluginInvocationActionsService,
    type ContributedActionInvocationResult,
    type InvokeContributedAction,
} from './actions';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createProductionPluginInvocationServiceOwners } from './production';
import { resolvePluginMachineExecutionOrigin } from '@/plugins/runtime/resolvePluginMachineExecutionOrigin';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createCommittedContributedActionInvoker } from '../actions/createCommittedContributedActionDeps';
import { createHostContributedActionInvoker } from '../actions/hostContributedActionInvoker';
import { createTargetActionInvocationRegistry } from '../targetActionRegistry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import { createWorkflowAccountRunActionOwner, type WorkflowAccountRunActionDeps } from '@happier-dev/protocol/actions';
import {
    WorkflowRunSummaryV1Schema,
    WorkflowRunStartRequestV1Schema,
    openWorkflowAcceptedSnapshotStoredEnvelopeV1,
    parseWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol';

type TestActionExecutorOverrides = Partial<Pick<
    ActionExecutorDeps,
    'pluginPermissionGrantAction'
    | 'sessionPermissionRespond'
    | 'sessionUserActionAnswer'
    | 'pluginWebhookAction'
    | 'sessionList'
    | 'approvalsCreate'
    | 'sessionSendMessage'
    | 'resolveSessionReference'
    | 'invokeContributedAction'
    | 'isActionApprovalRequired'
    | 'listContributedActionDefinitions'
>>;

function createActionExecutorForTest(overrides: TestActionExecutorOverrides = {}) {
    const deps: ActionExecutorDeps = {
        executionRunStart: async () => ({}),
        executionRunList: async () => ({}),
        executionRunGet: async () => ({}),
        detachedExecutionRunSend: async () => ({}),
        executionRunStop: async () => ({}),
        executionRunAction: async () => ({}),
        executionRunWait: async () => ({}),
        sessionOpen: async () => ({}),
        sessionFork: async () => ({}),
        sessionRollback: async () => ({}),
        sessionSpawnNew: async () => ({}),
        pathsListRecent: async () => ({ items: [] }),
        machinesList: async () => ({ items: [] }),
        serversList: async () => ({ items: [] }),
        reviewEnginesList: async () => ({ items: [] }),
        agentsBackendsList: async () => ({ items: [] }),
        agentsModelsList: async () => ({ items: [] }),
        sessionSendMessage: async () => ({}),
        sessionModeSet: async () => ({}),
        sessionModesList: async () => ({ items: [] }),
        sessionTargetPrimarySet: async () => ({}),
        sessionTargetTrackedSet: async () => ({
            ok: true as const,
            status: 'ok' as const,
            sessionIds: [],
            sessionAddresses: [],
            sessions: [],
        }),
        sessionList: async () => ({ sessions: [] }),
        sessionActivityGet: async () => ({}),
        sessionRecentMessagesGet: async () => ({}),
        daemonMemorySearch: async () => ({ v: 1, ok: true, hits: [] }),
        daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
        daemonMemoryEnsureUpToDate: async () => ({}),
        resetGlobalVoiceAgent: async () => {},
        isActionApprovalRequired: () => false,
        ...overrides,
    };
    return createActionExecutor(deps);
}

function createPermissionActionExecutor(
    pluginPermissionGrantAction: NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']>,
) {
    return createActionExecutorForTest({ pluginPermissionGrantAction });
}

/**
 * The host stamps a closed `ActionCaller` union; only the plugin arm carries a
 * plugin id. Narrowing here keeps the assertion discriminating: a caller
 * stamped as any other kind reads as `null` instead of silently matching.
 */
function readPluginCallerId(context: ActionExecutorContext | undefined): string | null {
    const caller = context?.actionCaller;
    return caller?.kind === 'plugin' ? caller.pluginId : null;
}

function createContributedActionExecutorForTest(invokeContributedAction: InvokeContributedAction,
    seed?: Parameters<typeof createPluginInvocationActionsService>[0]['seed'],
    resolveOrigin?: NonNullable<Parameters<typeof createHostContributedActionInvoker>[0]['resolveCurrentPluginExecutionOrigin']>) {
    return createActionExecutorForTest({ invokeContributedAction: createHostContributedActionInvoker({
        invokeContributedAction,
        revalidatePluginActionCallerOccurrence: async () => seed?.isOccurrenceCurrent() ?? true,
        revalidatePluginActionCallerMaterialization: async ref => {
            if (!seed) return true;
            const current = seed.resolveCurrentPluginMaterializationRef?.();
            return current?.pluginId === ref.pluginId && current.machineId === ref.machineId
                && current.materializationId === ref.materializationId;
        },
        ...(seed?.resolveCurrentPluginExecutionOrigin ? { resolveCurrentPluginExecutionOrigin: async () =>
            await seed.resolveCurrentPluginExecutionOrigin!() } : resolveOrigin ? { resolveCurrentPluginExecutionOrigin: resolveOrigin } : {}),
    }) });
}

function createContributedActionServiceForTest(params: Omit<Parameters<typeof createPluginInvocationActionsService>[0], 'actionExecutor'>) {
    return createPluginInvocationActionsService({ ...params,
        actionExecutor: createContributedActionExecutorForTest(params.invokeContributedAction, params.seed) });
}

describe('plugin invocation ActionsService', () => {
    it('uses the current Run attachment once per new Action and detaches without inheriting the Session profile', async () => {
        let approvalProfileId: string | null = 'builtin:read-propose';
        let reads = 0;
        let sessionReads = 0;
        let effects = 0;
        const pluginId = 'example.run-agent';
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                contribution: { id: 'agent', qualifiedId: `${pluginId}/agents/agent` },
                occurrenceId: 'run-agent-occurrence', surface: 'agent',
                session: { id: 'run-session' },
                sourceCustody: { kind: 'development', registeredRootId: 'run-agent-root' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture(pluginId).resolveCurrentPluginMaterializationRef,
                approvalContext: { serverId: 'home', runtimeAccountId: 'alice', approvalProfileId: 'builtin:full-trust' },
                readApprovalProfileId: () => { reads++; return approvalProfileId; },
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            },
            actionExecutor: createActionExecutor({
                ...createUnavailableActionTransportDeps(),
                readActionApprovalProfileId: async () => { sessionReads++; return 'builtin:read-propose'; },
                approvalsCreate: async () => ({ artifactId: 'run-profile-approval' }),
                agentsBackendsList: async () => { effects++; return { items: [] }; },
            }),
            invokeContributedAction: async () => { throw new Error('Unexpected contributed Action'); },
        });
        // This host boundary has no approval execution origin; a required review must refuse before effect.
        await expect(service.execute('agents.backends.list', {})).rejects.toMatchObject({ code: 'approval_origin_unavailable' });
        expect(effects).toBe(0);
        approvalProfileId = null;
        await expect(service.execute('agents.backends.list', {})).resolves.toMatchObject({ items: [] });
        expect(effects).toBe(1);
        expect(reads).toBe(2);
        expect(sessionReads).toBe(0);
    });

    it.each(['workflow', 'unrelated-detached'] as const)('binds the typed requester refusal only to a detached Workflow turn (%s)', async scope => {
        let cards = 0;
        let effects = 0;
        const failures: Error[] = [];
        const pluginId = 'example.workflow-agent';
        const seed = {
            plugin: { id: pluginId, version: '1.0.0' },
            contribution: { id: 'agent', qualifiedId: `${pluginId}/agents/agent` },
            occurrenceId: 'workflow-agent-occurrence',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'workflow-agent-root' },
            correlationId: 'detached-agent-run', surface: 'agent' as const,
            resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture(pluginId).resolveCurrentPluginMaterializationRef,
            workflowActionContext: { readRunId: () => scope === 'workflow' ? 'workflow-1' : undefined,
                fail: (error: Error) => { failures.push(error); } },
            approvalContext: { serverId: 'home', runtimeAccountId: 'alice' },
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        };
        const service = createPluginInvocationActionsService({ seed,
            actionExecutor: createActionExecutor({
                ...createUnavailableActionTransportDeps(),
                approvalsCreate: async () => { cards++; return { artifactId: 'must-not-create' }; },
                executionRunPermissionRespond: async () => { effects++; return { ok: true }; },
            }),
            invokeContributedAction: async () => { throw new Error('Unexpected contributed Action'); },
        });
        const pending = service.execute('execution.run.permission.respond', {
            runId: 'other-run', requestId: 'permission-1', approved: true,
        });
        if (scope === 'workflow') {
            await expect(pending).rejects.toMatchObject({ code: 'approval_requester_unavailable' });
            expect(failures).toEqual([expect.objectContaining({ code: 'approval_requester_unavailable' })]);
        } else {
            await expect(pending).resolves.toMatchObject({ kind: 'approval_request_created', artifactId: 'must-not-create' });
            expect(failures).toEqual([]);
        }
        expect(cards).toBe(scope === 'workflow' ? 0 : 1);
        expect(effects).toBe(0);
    });

    it.each(['bound', 'missing'] as const)('does not turn an exact Session routing address into current-Session authority (%s)', async anchor => {
        let sends = 0;
        const pluginId = 'example.session-bound-author';
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                contribution: { id: 'send', qualifiedId: `${pluginId}/actions/send` },
                occurrenceId: 'session-bound-current', sourceCustody: { kind: 'development', registeredRootId: 'session-bound-root' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture(pluginId).resolveCurrentPluginMaterializationRef,
                surface: 'background', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                ...(anchor === 'bound' ? { session: { id: 'caller-session' } } : {}), sessionListAccess: 'current_session',
                approvalContext: { serverId: 'bound-home', runtimeAccountId: 'bound-account' },
            },
            actionExecutor: createActionExecutorForTest({
                resolveSessionReference: async ({ sessionId, context }) => ({ kind: 'unique', address: {
                    serverId: context.serverId!, sessionId: sessionId!,
                } }),
                sessionSendMessage: async () => {
                sends++;
                return { status: 'accepted', localId: 'must-not-send' };
            } }),
            invokeContributedAction: async () => { throw new Error('Unexpected contributed dispatch'); },
        });
        const input = { sessionId: 'other-session', message: 'Outside the bound Session', idempotencyKey: 'bound-session-input' };
        await expect(service.execute('session.message.send', input)).rejects.toMatchObject({ code: 'unsupported_action' });
        const options = { sessionAddress: { serverId: 'bound-home', sessionId: input.sessionId } };
        await expect(service.execute('session.message.send', input, options)).rejects.toMatchObject({ code: 'session_target_unavailable' });
        expect(sends).toBe(0);
    });

    it('retains exact Session address scope on bound host Actions and refuses unsupported routing before effects', async () => {
        const sent: Parameters<NonNullable<ActionExecutorDeps['sessionSendMessage']>>[0][] = [];
        const controller = new AbortController();
        const pluginId = 'example.session-author';
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                contribution: { id: 'start', qualifiedId: `${pluginId}/actions/start` },
                occurrenceId: 'session-author-current', sourceCustody: { kind: 'development', registeredRootId: 'session-author-root' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture(pluginId).resolveCurrentPluginMaterializationRef,
                surface: 'background', signal: controller.signal, isOccurrenceCurrent: () => true,
                approvalContext: { serverId: 'bound-home', runtimeAccountId: 'bound-account', expectedAccountId: 'bound-account' },
            },
            actionExecutor: createActionExecutorForTest({
                // The Home reference read is a transport boundary; prefix behavior
                // is exercised through the real CLI adapter in its composed suite.
                resolveSessionReference: async ({ sessionId, context }) => ({ kind: 'unique', address: {
                    serverId: context.serverId!, sessionId: sessionId!,
                } }),
                sessionSendMessage: async request => {
                sent.push(request);
                return { status: 'accepted', localId: 'addressed-input' };
            } }),
            // Cross-plugin dispatch is a process boundary, but an explicit
            // Session address may not be silently discarded at that boundary.
            invokeContributedAction: async () => { throw new Error('Unsupported contributed scope reached a target'); },
        });
        const address = { serverId: 'bound-home', sessionId: 'created-session' };
        const options = { signal: controller.signal, sessionAddress: address };
        await expect(service.execute('session.message.send', {
            sessionId: address.sessionId, message: 'Continue the created Session', idempotencyKey: 'addressed-input',
        }, options)).resolves.toMatchObject({ status: 'accepted', localId: 'addressed-input' });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ sessionId: 'created-session', context: {
            serverId: 'bound-home', runtimeAccountId: 'bound-account',
            expectedAccountId: 'bound-account', authority: 'account_automation',
            actionCaller: { kind: 'plugin', pluginId },
        } });
        expect(sent[0]!.context.defaultSessionId).toBeUndefined();
        for (const { sessionAddress, code } of [
            { sessionAddress: { serverId: 'foreign-home', sessionId: address.sessionId }, code: 'plugin_action_session_address_unavailable' },
            { sessionAddress: { serverId: address.serverId, sessionId: 'different-session' }, code: 'session_address_mismatch' },
        ]) {
            await expect(service.execute('session.message.send', {
                sessionId: address.sessionId, message: 'Must not send elsewhere', idempotencyKey: 'must-not-send',
            }, { ...options, sessionAddress })).rejects.toMatchObject({ name: 'PluginError', code });
        }
        await expect(service.execute('session.message.send', {
            sessionId: { selector: 'workers' }, message: 'Must not fan out', idempotencyKey: 'must-not-fan-out',
        }, options)).rejects.toMatchObject({ name: 'PluginError', code: 'session_address_mismatch' });
        await expect(service.execute('session.list', {}, options)).rejects.toMatchObject({ name: 'PluginError', code: 'session_address_unsupported' });
        await expect(service.execute({ pluginId: 'example.other', localId: 'write' }, {}, options))
            .rejects.toMatchObject({ name: 'PluginError', code: 'session_address_unsupported' });
        expect(sent).toHaveLength(1);
        controller.abort();
        await expect(service.execute('session.message.send', {
            sessionId: address.sessionId, message: 'Must not send after cancellation', idempotencyKey: 'must-not-send-after-cancel',
        }, options)).rejects.toMatchObject({ name: 'PluginError' });
        expect(sent).toHaveLength(1);
    });

    it('admits contributed exact Session addresses only from host targets and resolves the child declaration independently', async () => {
        const address = { serverId: 'bound-home', sessionId: 'admitted-session' };
        const pluginId = 'example.session-author';
        const child = { pluginId: 'example.session-recipient', localId: 'update' };
        const definition: ActionDefinitionV1 = {
            kindVersion: 1, id: 'example.session-recipient/actions/update', title: 'Update', description: 'Update one Session',
            safety: 'safe', sideEffectClass: 'write', placements: [], slash: null, bindings: null, examples: null,
            surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false, api: true, plugin: true },
            sessionTarget: { field: 'recipient.sessionId', cardinality: 'one' },
            inputSchema: { type: 'object' },
        };
        const resolveSessionReference: NonNullable<ActionExecutorDeps['resolveSessionReference']> = async ({ sessionId, context }) => ({
            kind: 'unique', address: { serverId: context.serverId!, sessionId: sessionId! },
        });
        const admitted = await resolveActionSessionTargets({ ...createUnavailableActionTransportDeps(), resolveSessionReference }, {
            actionId: 'session.message.send', declaration: { field: 'sessionId', cardinality: 'many' },
            input: { sessionId: address.sessionId }, context: { surface: 'plugin', authority: 'account_automation',
                serverId: address.serverId, expectedSessionAddress: address },
        });
        if (!admitted || 'ok' in admitted) throw new Error('Host target admission must succeed');
        const effects: Parameters<InvokeContributedAction>[0][] = [];
        const invokeContributedAction: InvokeContributedAction = async request => {
            effects.push(request);
            return { status: 'executed', value: { updated: true } };
        };
        const service = (options: {
            admission?: typeof admitted | null;
            home?: string;
            definition?: ActionDefinitionV1;
            currentSessionOnly?: boolean;
        } = {}) => {
            const admission = options.admission === undefined ? admitted : options.admission;
            const seed: Parameters<typeof createPluginInvocationActionsService>[0]['seed'] = {
                plugin: { id: pluginId, version: '1.0.0' },
                contribution: { id: 'update', qualifiedId: pluginId + '/actions/update' },
                occurrenceId: 'session-address-occurrence',
                sourceCustody: { kind: 'development', registeredRootId: 'session-address-root' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture(pluginId).resolveCurrentPluginMaterializationRef,
                surface: 'background', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                approvalContext: { serverId: options.home ?? address.serverId, runtimeAccountId: 'bound-account',
                    ...(admission ? { sessionTargetsV1: admission } : {}) },
                ...(options.currentSessionOnly ? { session: { id: 'caller-session' }, sessionListAccess: 'current_session' } : {}),
            };
            return createPluginInvocationActionsService({ seed, invokeContributedAction,
                actionExecutor: createActionExecutorForTest({
                    listContributedActionDefinitions: () => [options.definition ?? definition],
                    resolveSessionReference,
                    invokeContributedAction: createHostContributedActionInvoker({ invokeContributedAction,
                        revalidatePluginActionCallerMaterialization: async () => true,
                        revalidatePluginActionCallerOccurrence: async () => true,
                    }),
                }),
            });
        };
        const input = { recipient: { sessionId: address.sessionId }, message: 'Continue admitted work' };
        await expect(service().execute(child, input, { sessionAddress: address })).resolves.toEqual({ updated: true });
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({ input, approvalContext: { expectedSessionAddress: address,
            sessionTargetsV1: { actionId: 'action.invoke', field: 'input.recipient.sessionId', targets: [address] },
        } });
        // A parent's admitted target permits the routing option, never an inherited child operand or authority.
        expect(effects[0]!.approvalContext!.sessionTargetsV1!.actionId).not.toBe(admitted.actionId);
        await expect(service({ admission: null }).execute(child, input, { sessionAddress: address }))
            .rejects.toMatchObject({ code: 'session_address_unsupported' });
        await expect(service().execute(child, input, { sessionAddress: { ...address, sessionId: 'unadmitted-session' } }))
            .rejects.toMatchObject({ code: 'session_address_unsupported' });
        await expect(service({ home: 'foreign-home' }).execute(child, input, { sessionAddress: address }))
            .rejects.toMatchObject({ code: 'plugin_action_session_address_unavailable' });
        for (const sessionId of ['different-session', { selector: 'self', of: address.sessionId }]) {
            await expect(service().execute(child, { ...input, recipient: { sessionId } }, { sessionAddress: address }))
                .rejects.toMatchObject({ code: 'session_address_mismatch' });
        }
        const { sessionTarget: omitted, ...withoutSessionTarget } = definition;
        await expect(service({ definition: withoutSessionTarget }).execute(child, input, { sessionAddress: address }))
            .rejects.toMatchObject({ code: 'session_address_unsupported' });
        await expect(service({ currentSessionOnly: true }).execute(child, input, { sessionAddress: address }))
            .rejects.toMatchObject({ code: 'session_target_unavailable' });
        expect(effects).toHaveLength(1);
    });

    it.each(['source', 'source-machine', 'source-with-materialization', 'materialization'] as const)('stamps the exact %s origin through production services and the real target handler', async (kind) => {
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'caller-root' };
        let machineId = 'machine-1';
        let currentSource = sourceCustody;
        let changeDuringHandler = false;
        let handlerCalls = 0;
        const resolveOrigin = () => resolvePluginMachineExecutionOrigin({
            pluginId: 'acme.caller', context: { serverIdentityId: 'srv_home-1', machineId },
            ...(kind === 'materialization' ? { materializationId: 'caller-materialization' } : { sourceCustody: currentSource }),
        });
        expect(resolveOrigin()).not.toBeNull();
        let targets: ReturnType<typeof createTargetActionInvocationRegistry>;
        const invokeContributedAction: InvokeContributedAction = async request => {
            const result = await targets.invoke({
                pluginId: request.action.pluginId, localId: request.action.localId,
                input: request.input, surface: request.surface, invocationSurface: request.surface,
                caller: request.caller, signal: request.signal,
            });
            if (result.status === 'deferred') throw new Error('Safe fixture must not request approval');
            return result;
        };
        const owners = createProductionPluginInvocationServiceOwners({
            actionExecutor: createContributedActionExecutorForTest(invokeContributedAction, undefined, async () => resolveOrigin()), invokeContributedAction,
            resolveCurrentPluginExecutionOrigin: async () => resolveOrigin(),
        });
        const occurrenceId = createPluginRuntimeOccurrenceId('acme.provider');
        targets = createTargetActionInvocationRegistry({
            actions: [{ pluginId: 'acme.provider', pluginVersion: '1.0.0', occurrenceId,
                sourceCustody: { kind: 'development', registeredRootId: 'provider-root' }, localId: 'read-caller',
                definition: { id: 'read-caller', dangerLevel: 'safe', scopes: ['global'], surfaces: ['plugin'], inputSchema: { type: 'object' }, resultSchema: {} },
                handler: async (_input, context) => {
                    handlerCalls += 1;
                    const caller = StrictJsonValueSchema.parse(context.caller);
                    if (changeDuringHandler) {
                        if (kind === 'source' || kind === 'source-with-materialization') currentSource = { ...sourceCustody, registeredRootId: 'replacement-root' };
                        else machineId = 'replacement-machine';
                    }
                    return caller;
                },
            }],
            resolveAuthorizationFacts: target => ({ generation: { targetGeneration: target.occurrenceId,
                desiredGeneration: target.occurrenceId, appliedGeneration: target.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
            createServices: owners.createServices, resolveHostBinding: owners.resolveHostBinding,
            readCurrentPluginOccurrenceId: pluginId => pluginId === 'acme.provider' ? occurrenceId : null,
        });
        try {
            const service = owners.createServices({
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/caller' },
                occurrenceId: 'caller-occurrence', sourceCustody,
                correlationId: 'source-origin-callback', surface: 'background',
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                // The real release-less registry also publishes a materialization;
                // its current execution origin remains source custody.
                ...(kind === 'materialization' || kind === 'source-with-materialization' ? { resolveCurrentPluginMaterializationRef: () => ({
                    pluginId: 'acme.caller', machineId, materializationId: 'caller-materialization',
                }) } : {}),
            }, owners.createOrdinaryServiceBinding('caller-occurrence', 'source-origin-callback')).actions;
            await expect(service.getCurrentExecutionRouting?.()).resolves.toEqual({
                serverIdentityId: 'srv_home-1', machineId, pluginId: 'acme.caller',
            });
            await expect(service.getCurrentExecutionRouting?.({ signal: AbortSignal.abort() })).resolves.toBeNull();
            await expect(service.execute({ pluginId: 'acme.provider', localId: 'read-caller' }, {}))
                .resolves.toMatchObject({ executionOrigin: resolveOrigin(),
                    contribution: { id: 'caller', qualifiedId: 'acme.caller/caller' }, originSurface: 'background' });
            const admittedOrigin = resolveOrigin();
            changeDuringHandler = true;
            // The caller is admitted before dispatch: the settled effect keeps
            // its admitted origin, and the change applies at the next call.
            await expect(service.execute({ pluginId: 'acme.provider', localId: 'read-caller' }, {}))
                .resolves.toMatchObject({ executionOrigin: admittedOrigin });
            changeDuringHandler = false;
            await expect(service.getCurrentExecutionRouting?.()).resolves.toEqual(
                kind === 'source' || kind === 'source-with-materialization' ? null
                    : { serverIdentityId: 'srv_home-1', machineId: 'replacement-machine', pluginId: 'acme.caller' },
            );
            if (kind === 'source' || kind === 'source-with-materialization') {
                await expect(service.execute({ pluginId: 'acme.provider', localId: 'read-caller' }, {}))
                    .rejects.toMatchObject({ code: 'plugin_action_caller_unavailable' });
                expect(handlerCalls).toBe(2);
            }
        } finally {
            targets.dispose();
            await owners.dispose();
        }
    });
    it.each([
        { name: 'autonomous background', initiatingActionCaller: undefined, startedBy: 'trigger' },
        { name: 'host', initiatingActionCaller: { kind: 'host' }, startedBy: 'user' },
        { name: 'Session agent', initiatingActionCaller: { kind: 'session', sessionId: 'session-origin', starterDepth: 1, turnDepth: 2 }, startedBy: 'agent' },
        { name: 'nested host', initiatingActionCaller: { kind: 'plugin', pluginId: 'acme.outer', initiatingCaller: { kind: 'host' } }, startedBy: 'user' },
        { name: 'nested Session agent', initiatingActionCaller: { kind: 'plugin', pluginId: 'acme.outer', initiatingCaller: { kind: 'session', sessionId: 'session-origin', starterDepth: 1, turnDepth: 2 } }, startedBy: 'agent' },
        { name: 'manual automation', initiatingActionCaller: { kind: 'automationRun', runId: 'automation-run', automationId: 'automation-1', cause: { kind: 'manual', invokedAt: 1 } }, startedBy: 'user' },
        { name: 'scheduled automation overrides host', initiatingActionCaller: { kind: 'host' },
            transportStartedBy: 'user',
            automationCaller: { kind: 'automationRun', runId: 'automation-run', automationId: 'automation-1',
                cause: AutomationRunCauseSchema.parse({ kind: 'trigger', triggerId: 'trigger-1', triggerRevision: 1, triggerKind: 'schedule',
                    occurrenceKey: 'A'.repeat(43), occurredAt: 1, evidence: { scheduledFor: 1 } }) }, startedBy: 'trigger' },
        { name: 'Workflow', initiatingActionCaller: { kind: 'workflowRun', runId: 'workflow-origin', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } }, startedBy: 'agent' },
        { name: 'committed host', initiatingActionCaller: { kind: 'host' }, startedBy: 'user', viaCommitted: true },
        { name: 'committed Session agent', initiatingActionCaller: { kind: 'session', sessionId: 'session-origin', starterDepth: 1, turnDepth: 2 }, startedBy: 'agent', viaCommitted: true },
        { name: 'committed Workflow', initiatingActionCaller: { kind: 'workflowRun', runId: 'workflow-origin', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } }, startedBy: 'agent', viaCommitted: true },
    ] as const)('freezes $name starter through the real host Actions service without changing plugin authority', async (scenario) => {
        const runId = '99999999-9999-4999-8999-999999999999';
        let acceptedEnvelope: string | undefined;
        const run = WorkflowRunSummaryV1Schema.parse({ id: runId, sourceArtifactId: null,
            attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
            ownerAccountId: 'account-1', visibleTeamId: null, origin: { kind: 'direct' }, state: 'queued', revision: 0,
            machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
            availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
        const deps: WorkflowAccountRunActionDeps = {
            resolveAccountId: async () => 'account-1',
            storage: { execute: async operation => {
                if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
                if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
                acceptedEnvelope = String(operation.acceptedEnvelope);
                return { kind: 'created', run };
            } },
            definitions: { get: async () => { throw new Error('inline_definition_only'); } },
            resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
            normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
            randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
            prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
            resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
        };
        const owner = createWorkflowAccountRunActionOwner(deps);
        const seed = Object.assign({
            plugin: { id: 'acme.background', version: '1.0.0' },
            contribution: { id: 'job', qualifiedId: 'acme.background/backgroundServices/job' },
            occurrenceId: 'background-1', sourceCustody: { kind: 'development' as const, registeredRootId: 'background-root' },
            surface: 'background' as const, signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        }, scenario.initiatingActionCaller === undefined ? {} : { initiatingActionCaller: scenario.initiatingActionCaller },
        'transportStartedBy' in scenario ? { startedBy: scenario.transportStartedBy } : {},
        'automationCaller' in scenario ? { caller: scenario.automationCaller } : {});
        const actionExecutor = {
            // The daemon's Account host supplies target and permission authority; storage above is the external boundary.
            execute: async (actionId, input, context) => {
                if (actionId !== 'workflow.run.start') throw new Error('unexpected_host_action');
                const result = await owner.execute({ actionId, input: WorkflowRunStartRequestV1Schema.parse(input),
                    context: { ...context, callerPermissionMode: 'default',
                        externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } } } });
                return { ok: true, result };
            },
        } satisfies import('./actions').PluginActionsHostExecutor;
        let runtime: ResolvedExecutablePluginRuntimeRegistry | undefined;
        // Loading/acquiring the process registry is the system boundary; the committed dispatcher remains real.
        const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => {
            if (!runtime) throw new Error('runtime_registry_not_loaded');
            return { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} };
        } });
        const invokeContributedAction: InvokeContributedAction = async request => {
            const result = await invoke({ action: request.action, input: request.input,
                context: { surface: request.surface, actionCaller: request.initiatingActionCaller,
                    defaultSessionId: request.sessionId }, signal: request.signal });
            return result.ok
                ? { status: 'executed', value: StrictJsonValueSchema.parse(result.result) }
                : { status: 'failed', code: result.errorCode, message: result.error };
        };
        const service = createPluginInvocationActionsService({ seed, actionExecutor, invokeContributedAction });
        const startInput = { runId, source: { kind: 'inline' as const, definition: {
            version: 1 as const, blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Review', references: [], attachments: [] } }],
        } } };
        if (!('viaCommitted' in scenario)) {
            await service.execute('workflow.run.start', startInput);
            const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
            envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope) });
            expect(opened).toMatchObject({ kind: 'available', content: {
            startedBy: scenario.startedBy,
            authorization: { principal: { kind: 'plugin', pluginId: 'acme.background', contributionLocalId: 'job',
                sourceCustody: { kind: 'development', registeredRootId: 'background-root' } } },
            } });
            return;
        }
        const services = createProductionPluginInvocationServiceOwners({ actionExecutor, invokeContributedAction });
        const targetOccurrenceId = createPluginRuntimeOccurrenceId('acme.background');
        const targetActionInvocations = createTargetActionInvocationRegistry({
            actions: [{ pluginId: 'acme.background', pluginVersion: '1.0.0', occurrenceId: targetOccurrenceId,
                sourceCustody: { kind: 'development', registeredRootId: 'background-root' }, localId: 'start',
                definition: { id: 'start', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'], inputSchema: { type: 'object' }, resultSchema: {} },
                handler: async (_input, context) => {
                    expect(Object.prototype.hasOwnProperty.call(context, 'initiatingActionCaller')).toBe(false);
                    await context.services.actions.execute('workflow.run.start', startInput);
                    return null;
                },
            }],
            resolveAuthorizationFacts: target => ({ generation: { targetGeneration: target.occurrenceId,
                desiredGeneration: target.occurrenceId, appliedGeneration: target.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
            createServices: services.createServices, resolveHostBinding: services.resolveHostBinding,
            readCurrentPluginOccurrenceId: pluginId => pluginId === 'acme.background' ? targetOccurrenceId : null,
        });
        // The process registry lookup/lease is the system boundary; target admission and service construction remain real.
        const contribution = { pluginId: 'acme.background', definition: { id: 'start', surfaces: { cli: true } } } as unknown as ResolvedActionContribution;
        runtime = { contributes: { actionsById: new Map([['acme.background/start', contribution]]) }, targetActionInvocations } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        const admittedContext = { surface: 'cli' as const, actionCaller: scenario.initiatingActionCaller };
        const admitted = await invoke({ action: { pluginId: 'acme.background', localId: 'start' }, input: {}, context: admittedContext });
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true });
        const nested = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
            envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope) });
        expect(nested).toMatchObject({ kind: 'available', content: { startedBy: scenario.startedBy,
            authorization: { principal: { kind: 'plugin', pluginId: 'acme.background', contributionLocalId: 'start' } } } });
        targetActionInvocations.dispose();
        await services.dispose();
    });
    it('preserves host-private external PAT authority for a nested host Action', async () => {
        const execute = vi.fn().mockResolvedValue({
            ok: true,
            result: {
                id: 'team-1',
                name: 'Platform',
                description: null,
                logo: null,
                archivedAt: null,
                recovery: null,
                policy: {
                    v: 1,
                    sessionCreationPolicy: 'private_default',
                    externalSharingPolicy: 'allowed',
                    defaultSessionHistoryAccess: 'from_membership',
                    admissionMode: 'invite_only',
                    authenticationPolicy: null,
                    authenticationPolicyStatus: 'available',
                },
                viewerRole: 'owner',
                capabilities: NO_TEAM_CAPABILITIES_V1,
                admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
                counts: null,
            },
        });
        const signExternalActionApprovalInput = vi.fn().mockReturnValue('machine-signature');
        const externalActionContext = {
            authority: 'account_automation' as const,
            serverId: 'home-profile-1',
            serverIdentityId: 'home-identity-1',
            actionRequestId: 'outer-request-1',
            externalActionCredential: {
                accountId: 'account-1', principalId: 'pat-principal-1', credentialId: 'pat-1',
                grant: ApiTokenGrantV1Schema.parse({
                    v: 1,
                    actions: { families: [], ids: ['teams.archive'] },
                    targets: null,
                    approve: false,
                    origins: [],
                    models: null,
                    permissionModes: null,
                    create: null,
                }),
            },
            externalActionExecutionAuthorization: { opaque: 'authorization' } as never,
            externalActionTarget: { kind: 'session' as const, sessionId: 'session-1' },
            signExternalActionApprovalInput,
        };
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'plugin.example', version: '1.0.0' },
                contribution: { id: 'action', qualifiedId: 'plugin.example/action' },
                occurrenceId: 'immutable-occurrenceId-1', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: 'plugin-call-1',
                surface: 'plugin',
                externalActionContext,
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture('plugin.example')
                        .resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await service.execute('teams.archive', { v: 1, teamId: 'team-1' });

        expect(execute).toHaveBeenCalledWith(
            'teams.archive',
            { v: 1, teamId: 'team-1' },
            expect.objectContaining({
                ...externalActionContext,
                surface: 'plugin',
                authority: 'account_automation',
                actionCaller: expect.objectContaining({ kind: 'plugin', pluginId: 'plugin.example' }),
            }),
        );
    });
    it('returns a Lane 01 approval deferral as typed admitted data instead of rejecting it as a malformed Team result', async () => {
        const pluginId = 'acme.external-home-admin';
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'archive-team', qualifiedId: `${pluginId}/actions/archive-team` },
                occurrenceId: 'external-home-admin-occurrenceId', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: 'external-home-admin-archive',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: true as const,
                    result: {
                        kind: 'approval_request_created' as const,
                        artifactId: 'approval-1',
                        actionId: 'teams.archive',
                    },
                })),
            },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('teams.archive', {
            v: 1,
            teamId: 'team-1',
        })).resolves.toEqual({
            kind: 'approval_request_created',
            artifactId: 'approval-1',
            actionId: 'teams.archive',
        });
    });

    it.each([
        'update_required',
        'outcome_unknown',
        'cancelled',
        'server_unreachable',
    ] as const)('preserves the typed Lane 01 %s settlement for plugin callers', async (errorCode) => {
        const pluginId = 'acme.external-home-admin';
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'archive-team', qualifiedId: `${pluginId}/actions/archive-team` },
                occurrenceId: 'external-home-admin-occurrenceId', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: `external-home-admin-${errorCode}`,
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: {
                execute: vi.fn(async () => ({ ok: false as const, errorCode, error: errorCode })),
            },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('teams.archive', {
            v: 1,
            teamId: 'team-1',
        })).rejects.toMatchObject({ name: 'PluginError', code: errorCode });
    });

    it('gives bundled and trusted external installed plugins the same Lane 01 governance Action contract', async () => {
        const result = {
            id: 'team-1',
            name: 'Platform',
            description: null,
            logo: null,
            archivedAt: null,
            recovery: null,
            policy: {
                v: 1 as const,
                sessionCreationPolicy: 'private_default' as const,
                externalSharingPolicy: 'allowed' as const,
                defaultSessionHistoryAccess: 'from_membership' as const,
                admissionMode: 'invite_only' as const,
                authenticationPolicy: null,
                authenticationPolicyStatus: 'available' as const,
            },
            viewerRole: 'owner' as const,
            capabilities: NO_TEAM_CAPABILITIES_V1,
            admission: { historyChoice: { admin: 'choice' as const, member: 'choice' as const, guest: 'hidden' as const } },
            counts: null,
        };
        const execute = vi.fn(async (
            _actionId: string,
            _input: unknown,
            _context?: ActionExecutorContext,
        ) => ({ ok: true as const, result }));
        const createService = (pluginId: string) => createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'team-admin', qualifiedId: `${pluginId}/actions/team-admin` },
                occurrenceId: `${pluginId}-immutable-occurrenceId`, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: `${pluginId}-lane01`,
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });
        const input = { v: 1 as const, teamId: 'team-1' };

        for (const pluginId of ['happier.builtin', 'acme.external-installed']) {
            await expect(createService(pluginId).execute('teams.archive', input)).resolves.toEqual(result);
        }
        expect(execute.mock.calls.map((call) => readPluginCallerId(call[2]))).toEqual([
            'happier.builtin',
            'acme.external-installed',
        ]);
        for (const call of execute.mock.calls) {
            expect(call[0]).toBe('teams.archive');
            expect(call[1]).toEqual(input);
            expect(call[2]).toMatchObject({ surface: 'plugin', authority: 'account_automation' });
        }
    });

    it('dispatches every bounded Lane 03 identity handoff through the trusted external-plugin Action ABI', async () => {
        const provider = {
            v: 1 as const,
            owner: { kind: 'team' as const, teamId: 'team-1' },
            id: 'provider-1',
            kind: 'oidc' as const,
            displayName: 'Company login',
            enabled: true,
            firstEnabledAt: 1,
            securityRevision: 2,
            revision: 3,
            config: {
                v: 1 as const,
                kind: 'oidc' as const,
                issuer: 'https://id.example.test',
                clientId: 'happier',
                clientAuthenticationMethod: 'client_secret_post' as const,
                scopes: 'openid profile email',
                httpTimeoutSeconds: 30,
                claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
                allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                fetchUserInfo: true,
                storeRefreshToken: false,
                ui: { buttonColor: null, iconHint: 'oidc' },
            },
            secret: { configured: true, health: 'configured' as const },
            lastSuccessfulTest: { at: 10, testedSecurityRevision: 2, current: true },
            createdByAccountId: 'account-1',
            createdAt: 1,
            updatedAt: 10,
            teamConsumers: [],
        };
        const connection = {
            v: 1 as const,
            id: 'connection-1',
            teamId: 'team-1',
            provider: { id: 'provider-1', kind: 'oidc' as const, displayName: 'Company login' },
            externalReference: { v: 1 as const, kind: 'oidc' as const },
            settings: {
                v: 1 as const,
                kind: 'oidc' as const,
                allowedUsers: [],
                allowedEmailDomains: [],
                groupsAny: [],
                groupsAll: [],
            },
            enabled: true,
            firstEnabledAt: 1,
            revision: 3,
            state: 'connected' as const,
            allowedActions: ['teams.identity.connections.test.start'] as const,
            lastObservation: { v: 1 as const, kind: 'oidc' as const },
            lastSuccessfulTest: { at: 10, runtimeFingerprint: 'runtime-1', current: true },
            createdAt: 1,
            updatedAt: 10,
        };
        const cases = [
            {
                id: 'identity.providers.test.start' as const,
                input: { owner: { kind: 'team' as const, teamId: 'team-1' }, id: 'provider-1', expectedRevision: 3, expectedSecurityRevision: 2 },
                result: { authorizeUrl: 'https://id.example.test/authorize', attemptId: 'attempt-provider' },
            },
            {
                id: 'identity.providers.test.consume' as const,
                input: { owner: { kind: 'team' as const, teamId: 'team-1' }, id: 'provider-1', resultHandle: 'result-provider' },
                result: { provider, testedAt: 10, subjectPresent: true as const },
            },
            {
                id: 'teams.identity.connections.test.start' as const,
                input: { v: 1 as const, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 3 },
                result: { authorizeUrl: 'https://id.example.test/authorize', attemptId: 'attempt-connection' },
            },
            {
                id: 'teams.identity.connections.test.consume' as const,
                input: { v: 1 as const, teamId: 'team-1', connectionId: 'connection-1', resultHandle: 'result-connection' },
                result: { connection },
            },
            {
                id: 'teams.identity.workos.adminPortalLink.create' as const,
                input: { v: 1 as const, teamId: 'team-1', connectionId: 'connection-1', intent: 'sso' as const },
                result: { url: 'https://setup.workos.test/portal' },
            },
        ];
        const resultByActionId = new Map<string, unknown>(cases.map((entry) => [entry.id, entry.result]));
        const execute = vi.fn(async (
            actionId: string,
            _input: unknown,
            _context?: ActionExecutorContext,
        ) => ({
            ok: true as const,
            result: resultByActionId.get(actionId),
        }));
        const pluginId = 'acme.external-installed';
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'identity-admin', qualifiedId: `${pluginId}/actions/identity-admin` },
                occurrenceId: 'external-identity-occurrenceId', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: 'external-identity',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        for (const entry of cases) {
            await expect(service.execute(entry.id, entry.input)).resolves.toEqual(entry.result);
        }
        expect(execute).toHaveBeenCalledTimes(cases.length);
        for (const call of execute.mock.calls) {
            expect(call[2]).toMatchObject({
                surface: 'plugin',
                authority: 'account_automation',
                actionCaller: { kind: 'plugin', pluginId, contributionLocalId: 'identity-admin' },
            });
        }
    });

    it('gives bundled and trusted external installed plugins the same public Team removal-preview Action', async () => {
        const result = {
            v: 1 as const,
            status: 'allowed' as const,
            sourceId: 'source-1',
            sourceLabel: 'Corporate directory',
            impact: {
                teamMembershipsRemoved: 2,
                groupMembershipsRemoved: 3,
                groupContributionsRemoved: 1,
                directoryCreatedGroupsRetained: 1,
                nativeMembershipsPreserved: 4,
                nativeGroupContributionsPreserved: 2,
            },
        };
        const execute = vi.fn(async (
            _actionId: string,
            _input: unknown,
            _context?: ActionExecutorContext,
        ) => ({ ok: true as const, result }));
        const createService = (pluginId: string) => createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'admin', qualifiedId: `${pluginId}/actions/admin` },
                occurrenceId: `${pluginId}-immutable-occurrenceId`, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: `${pluginId}-preview`,
                surface: 'cli',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });
        const input = { v: 1 as const, teamId: 'team-1', sourceId: 'source-1' };

        await expect(createService('happier.builtin').execute(
            'teams.directory.sources.remove.preview', input,
        )).resolves.toEqual(result);
        await expect(createService('acme.external-installed').execute(
            'teams.directory.sources.remove.preview', input,
        )).resolves.toEqual(result);

        expect(execute).toHaveBeenCalledTimes(2);
        for (const call of execute.mock.calls) {
            expect(call[0]).toBe('teams.directory.sources.remove.preview');
            expect(call[1]).toEqual(input);
            expect(call[2]).toMatchObject({ surface: 'plugin', authority: 'account_automation' });
        }
        expect(execute.mock.calls.map((call) => readPluginCallerId(call[2]))).toEqual([
            'happier.builtin',
            'acme.external-installed',
        ]);
    });

    it('gives bundled and trusted external installed plugins the same redacted GitHub App listing Action', async () => {
        const result = { registrations: [], installations: [] };
        const execute = vi.fn(async (
            _actionId: string,
            _input: unknown,
            _context?: ActionExecutorContext,
        ) => ({ ok: true as const, result }));
        const createService = (pluginId: string) => createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'identity-read', qualifiedId: `${pluginId}/actions/identity-read` },
                occurrenceId: `${pluginId}-immutable-occurrenceId`, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: `${pluginId}-github-app-list`,
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });
        const input = { owner: { kind: 'team' as const, teamId: 'team-1' } };

        for (const pluginId of ['happier.builtin', 'acme.external-installed']) {
            await expect(createService(pluginId).execute('identity.githubApps.list', input))
                .resolves.toEqual(result);
        }
        expect(execute.mock.calls.map((call) => readPluginCallerId(call[2]))).toEqual([
            'happier.builtin',
            'acme.external-installed',
        ]);
        for (const call of execute.mock.calls) {
            expect(call[0]).toBe('identity.githubApps.list');
            expect(call[1]).toEqual(input);
            expect(call[2]).toMatchObject({ surface: 'plugin', authority: 'account_automation' });
        }
    });

    it('gives bundled and trusted external installed plugins the same Lane 10 resource Actions', async () => {
        const resultByActionId = new Map<string, unknown>([
            // The canonical page schemas carry `nextCursor`, so the parity
            // expectation is the parsed page a plugin actually receives — not
            // a cursor-free shape the production parser would never produce.
            ['teams.credentials.list', { resources: [], viewer: { manageCredentials: false, offerOwnCredential: false }, nextCursor: null }],
            ['teams.credentials.sources.list', {
                candidates: [],
                supportedKinds: ['connected_account', 'connected_pool', 'provider_connection'],
                brokerPresentation: {
                    selectedTarget: null,
                    eligibleTargets: [],
                    selectedPool: null,
                    eligiblePools: [],
                },
            }],
            ['teams.credentials.entitled.list', { resources: [], nextCursor: null }],
            ['teams.credentials.externalKeys.list', { keys: [] }],
            ['secrets.shared.list', { resources: [] }],
        ]);
        const execute = vi.fn(async (
            actionId: string,
            _input: unknown,
            _context?: ActionExecutorContext,
        ) => ({
            ok: true as const,
            result: resultByActionId.get(actionId),
        }));
        const createService = (pluginId: string) => createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'credential-consumer', qualifiedId: `${pluginId}/actions/credential-consumer` },
                occurrenceId: `${pluginId}-immutable-occurrenceId`, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: `${pluginId}-credentials`,
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });
        const cases = [
            ['teams.credentials.list', { teamId: 'team-1' }],
            ['teams.credentials.sources.list', { teamId: 'team-1' }],
            ['teams.credentials.entitled.list', { teamId: 'team-1' }],
            ['teams.credentials.externalKeys.list', { resourceId: 'resource-1' }],
            ['secrets.shared.list', {}],
        ] as const;

        for (const pluginId of ['happier.builtin', 'acme.external-installed']) {
            const service = createService(pluginId);
            for (const [actionId, input] of cases) {
                await expect(service.execute(actionId, input)).resolves.toEqual(resultByActionId.get(actionId));
            }
        }
        expect(execute).toHaveBeenCalledTimes(cases.length * 2);
        expect(execute.mock.calls.map((call) => readPluginCallerId(call[2]))).toEqual([
            ...Array(cases.length).fill('happier.builtin'),
            ...Array(cases.length).fill('acme.external-installed'),
        ]);
        for (const call of execute.mock.calls) {
            expect(call[2]).toMatchObject({ surface: 'plugin', authority: 'account_automation' });
        }
    });

    it('preserves Lane 10 approval deferral and typed failure for trusted external plugins', async () => {
        const pending = {
            kind: 'approval_request_created' as const,
            artifactId: 'approval-lane10-1',
            actionId: 'secrets.shared.update',
        };
        const baseSeed = {
            plugin: { id: 'acme.external-installed', version: '1.0.0' },
            resolveCurrentPluginMaterializationRef:
                createPluginActionCallerMaterializationFixture('acme.external-installed')
                    .resolveCurrentPluginMaterializationRef,
            contribution: {
                id: 'credential-consumer',
                qualifiedId: 'acme.external-installed/actions/credential-consumer',
            },
            occurrenceId: createPluginRuntimeOccurrenceId('acme.external-installed'),
            sourceCustody: { kind: 'development' as const, registeredRootId: 'fixture-root' },
            correlationId: 'lane10-approval',
            surface: 'background' as const,
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        };
        const input = {
            resourceId: 'resource-1',
            expectedRevision: 3,
            displayName: 'Rotated API key',
            kind: 'apiKey' as const,
            storedContent: {
                t: 'plain' as const,
                v: { v: 1 as const, name: 'Rotated API key', kind: 'apiKey' as const, value: 'secret' },
            },
        };
        const deferred = createPluginInvocationActionsService({
            seed: baseSeed,
            actionExecutor: { execute: async () => ({ ok: true, result: pending }) },
            invokeContributedAction: vi.fn(),
        });
        await expect(deferred.execute('secrets.shared.update', input)).resolves.toEqual(pending);

        const changed = createPluginInvocationActionsService({
            seed: baseSeed,
            actionExecutor: {
                execute: async () => ({
                    ok: false,
                    errorCode: 'resource_changed',
                    error: 'The Saved Secret changed before this update.',
                    details: { expectedRevision: 3 },
                }),
            },
            invokeContributedAction: vi.fn(),
        });
        await expect(changed.execute('secrets.shared.update', input)).rejects.toMatchObject({
            name: 'PluginError',
            code: 'resource_changed',
            message: 'The Saved Secret changed before this update.',
        });
    });

    it('does not treat an exact retained turn as authority to list the ambient Account corpus', async () => {
        const sessionList = vi.fn(async () => ({ sessions: [{ id: 'private-account-session', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null }));
        const owners = createProductionPluginInvocationServiceOwners({
            actionExecutor: createActionExecutorForTest({ sessionList }),
            invokeContributedAction: vi.fn(),
        });
        const service = owners.createServices({
                plugin: { id: 'acme.agent', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.agent').resolveCurrentPluginMaterializationRef,
                contribution: { id: 'agent', qualifiedId: 'acme.agent/agents/agent' },
                occurrenceId: 'occurrenceId-1',
                correlationId: 'retained-list-1',
                surface: 'agent',
                session: { id: 'session-1' },
                sessionListAccess: 'unavailable',
                signal: new AbortController().signal,
                readActiveTurnAdmissionWitness: () => ({
                    inputId: 'input-1', turnId: 'turn-1', userMessageSeq: 7, userMessageSeqs: [7],
                    callerPermissionMode: 'yolo',
                }),
                isOccurrenceCurrent: () => true,
            }, owners.createOrdinaryServiceBinding('occurrenceId-1', 'retained-current-global-actions')).actions;
        await expect(service.execute('session.list', {})).rejects.toMatchObject({ code: 'unsupported_action' });
        expect(sessionList).not.toHaveBeenCalled();
    });
    it('preserves canonical execution-run repair issues and certainty in the public PluginError', async () => {
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.automations').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                correlationId: 'automation-run-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: createActionExecutorForTest(),
            invokeContributedAction: vi.fn(),
        });

        const error = await service.execute('execution.run.start', {
            sessionId: 'session-1',
            intent: 'delegate',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
            configOptions: { reasoning_effort: 'low' },
            sessionConfigOptionOverrides: buildAcpConfigOptionOverridesV1({ updatedAt: 1,
                overrides: { reasoning_effort: { value: 'high', updatedAt: 1 } } }),
        }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'invalid_parameters' });
        expect(error).toHaveProperty('details', {
            executionRunStart: { v: 1, runCreation: 'noRunCreated' },
            issues: expect.arrayContaining([expect.objectContaining({ path: ['configOptions', 'reasoning_effort'] })]),
        });
    });

    it('defaults malformed start evidence to outcome-unknown and drops non-start failure details', async () => {
        const materialization = createPluginActionCallerMaterializationFixture('acme.automations');
        const seed = {
            plugin: { id: 'acme.automations', version: '1.0.0' },
            resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
            occurrenceId: 'occurrenceId-1',
            surface: 'background' as const,
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        };
        const malformedStart = createPluginInvocationActionsService({
            seed,
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: false as const,
                    errorCode: 'execution_run_target_unavailable',
                    error: 'execution_run_target_unavailable',
                    details: { executionRunStart: { v: 2, runCreation: 'noRunCreated' } },
                })),
            },
            invokeContributedAction: vi.fn(),
        });

        await expect(malformedStart.execute('execution.run.start', {
            sessionId: null,
            intent: 'task',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        })).rejects.toMatchObject({
            code: 'execution_run_target_unavailable',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
        });

        const nonStart = createPluginInvocationActionsService({
            seed,
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: false as const,
                    errorCode: 'action_disabled',
                    error: 'action_disabled',
                    details: { secret: 'must-not-cross-the-plugin-boundary' },
                })),
            },
            invokeContributedAction: vi.fn(),
        });
        const error = await nonStart.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'action_disabled' });
        expect(error).not.toHaveProperty('details');
    });

    it('classifies plugin retirement before and after host start dispatch without granting retry authority', async () => {
        const startInput = {
            sessionId: null,
            intent: 'task',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        } as const;
        const materialization = createPluginActionCallerMaterializationFixture('acme.automations');
        const inactiveBeforeDispatch = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => false,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction: vi.fn(),
        });
        await expect(inactiveBeforeDispatch.execute('execution.run.start', startInput)).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        });

        let currentnessChecks = 0;
        const inactiveAfterDispatch = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => ++currentnessChecks < 3,
            },
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: true as const,
                    result: { runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1' },
                })),
            },
            invokeContributedAction: vi.fn(),
        });
        await expect(inactiveAfterDispatch.execute('execution.run.start', startInput)).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
        });
    });

    it('classifies plugin input rejection before dispatch and output rejection after dispatch', async () => {
        const materialization = createPluginActionCallerMaterializationFixture('acme.automations');
        const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(Reflect.apply(service.execute, service, ['execution.run.start', {}])).rejects.toMatchObject({
            code: 'plugin_action_input_schema_invalid',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        });
        expect(execute).not.toHaveBeenCalled();

        await expect(service.execute('execution.run.start', {
            sessionId: null,
            intent: 'task',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        })).rejects.toMatchObject({
            code: 'plugin_action_result_schema_invalid',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
        });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('routes user-action answers through default Ask and explicit plugin Allow', async () => {
        let settings = normalizeActionsSettingsV1({ v: 1 });
        const sessionUserActionAnswer = vi.fn<NonNullable<ActionExecutorDeps['sessionUserActionAnswer']>>(
            async (_args) => ({ ok: true }),
        );
        const approvalsCreate = vi.fn<NonNullable<ActionExecutorDeps['approvalsCreate']>>(async () => ({ artifactId: 'answer-review' }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.interactions', version: '1.0.0' },
                contribution: { id: 'manage', qualifiedId: 'acme.interactions/actions/manage' },
                sourceCustody: createManagedPluginSourceCustody('interactions-policy-generation'),
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.interactions').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                correlationId: 'interaction-1',
                surface: 'ui',
                session: { id: 'session-bound' },
                approvalContext: { runtimeAccountId: 'alice', serverId: 'home', serverIdentityId: 'srv_policy_fixture' },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: createActionExecutorForTest({
                sessionUserActionAnswer,
                approvalsCreate,
                isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
            }),
            invokeContributedAction: vi.fn(),
        });

        // Trusted plugins use ordinary user-changeable Action policy, never a
        // hard present-person floor. Only the approval transport is substituted.
        await expect(service.execute('session.user_action.answer', {
            requestId: 'question-1',
            answers: [{ question: 'Continue?', values: ['Yes'] }],
        })).resolves.toMatchObject({ kind: 'approval_request_created' });
        expect(sessionUserActionAnswer).not.toHaveBeenCalled();
        expect(approvalsCreate).toHaveBeenCalledOnce();
        settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'session.user_action.answer': ['plugin'] } });
        await expect(service.execute('session.user_action.answer', {
            requestId: 'question-1', answers: [{ question: 'Continue?', values: ['Yes'] }],
        })).resolves.toEqual({ ok: true });
        expect(sessionUserActionAnswer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-bound',
            context: expect.objectContaining({ authority: 'account_automation', surface: 'plugin',
                actionCaller: expect.objectContaining({ kind: 'plugin', pluginId: 'acme.interactions' }) }) }));
        expect(approvalsCreate).toHaveBeenCalledOnce();
    });

    // The daemon-side durable-push transfer repair reaches the generic webhook
    // endpoint through exactly this seam. Its ordinary Action preference must
    // remain user-changeable without changing the plugin's stamped identity.
    it('routes generic webhook observation and retarget through default Ask and explicit plugin Allow', async () => {
        let settings = normalizeActionsSettingsV1({ v: 1 });
        const pluginWebhookAction = vi.fn<NonNullable<ActionExecutorDeps['pluginWebhookAction']>>(
            async ({ actionId }) => actionId === 'plugin.webhook.endpoint.read' ? {
                webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', revision: 4,
                contribution: { pluginId: 'happier.channels', localId: 'webhook' },
                targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'happier.channels' },
                sourceInstanceId: 'channels.connection.connection-1', routing: 'accountEndpoint', readiness: 'ready',
                publicUrl: 'https://webhook.example.test/endpoint', createdAt: 1,
            } : actionId === 'plugin.webhook.endpoint.retarget' ? {
                kind: 'retargeted', webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', revision: 5,
                previousTargetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'happier.channels' },
                targetMaterialization: { machineId: 'machine-2', materializationId: 'materialization-2', pluginId: 'happier.channels' },
            } : ({
                kind: 'ready' as const,
                webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
                revision: 4,
            }),
        );
        const approvalsCreate = vi.fn<NonNullable<ActionExecutorDeps['approvalsCreate']>>(async () => ({ artifactId: 'webhook-review' }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'happier.channels', version: '1.0.0' },
                contribution: { id: 'manage', qualifiedId: 'happier.channels/actions/manage' },
                sourceCustody: createManagedPluginSourceCustody('channels-policy-generation'),
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('happier.channels').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                correlationId: 'connection-transfer-1',
                surface: 'background',
                approvalContext: { runtimeAccountId: 'alice', serverId: 'home', serverIdentityId: 'srv_policy_fixture' },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: createActionExecutorForTest({ pluginWebhookAction, approvalsCreate,
                isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context) }),
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('plugin.webhook.endpoint.read', {
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        })).resolves.toMatchObject({ kind: 'approval_request_created' });

        await expect(service.execute('plugin.webhook.endpoint.retarget', {
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
            expectedRevision: 4,
            targetMaterialization: {
                machineId: 'machine-2',
                materializationId: 'materialization-2',
                pluginId: 'happier.channels',
            },
            idempotencyKey: 'xfer.connection-1.5.webhook',
        })).resolves.toMatchObject({ kind: 'approval_request_created' });

        expect(pluginWebhookAction).not.toHaveBeenCalled();
        expect(approvalsCreate).toHaveBeenCalledTimes(2);
        settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
            'plugin.webhook.endpoint.read': ['plugin'], 'plugin.webhook.endpoint.retarget': ['plugin'],
        } });
        await expect(service.execute('plugin.webhook.endpoint.read', { webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA' }))
            .resolves.toMatchObject({ revision: 4, readiness: 'ready' });
        await expect(service.execute('plugin.webhook.endpoint.retarget', { webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
            expectedRevision: 4, targetMaterialization: { machineId: 'machine-2', materializationId: 'materialization-2', pluginId: 'happier.channels' },
            idempotencyKey: 'xfer.connection-1.5.webhook' })).resolves.toMatchObject({ kind: 'retargeted' });
        expect(pluginWebhookAction.mock.calls.slice(0, 2).map(([request]) => request.caller)).toEqual([
            expect.objectContaining({ kind: 'plugin', pluginId: 'happier.channels' }),
            expect.objectContaining({ kind: 'plugin', pluginId: 'happier.channels' }),
        ]);

        await expect(service.execute('plugin.webhook.endpoint.checkCorrespondence', {
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
            webhookContribution: { pluginId: 'happier.channels', localId: 'webhook' },
            targetMaterialization: {
                machineId: 'machine-2',
                materializationId: 'materialization-2',
                pluginId: 'happier.channels',
            },
            sourceInstanceId: 'channels.connection.connection-1',
            setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
        })).resolves.toMatchObject({ kind: 'ready' });

        expect(pluginWebhookAction).toHaveBeenCalledTimes(3);
        expect(approvalsCreate).toHaveBeenCalledTimes(2);
    });

    // The composed seam the durable-push transfer actually depends on: a
    // daemon-side Channels caller with no present user must be able to
    // converge the endpoint it already owns onto its committed desired
    // target, carrying the stamped caller through to the canonical webhook
    // owner and no endpoint revision of its own.
    it('admits correspondence-gated endpoint target convergence for a daemon-side plugin caller', async () => {
        const pluginWebhookAction = vi.fn<NonNullable<ActionExecutorDeps['pluginWebhookAction']>>(
            async () => ({
                kind: 'converged' as const,
                webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
                revision: 5,
                targetMaterialization: {
                    machineId: 'machine-2',
                    materializationId: 'materialization-2',
                    pluginId: 'happier.channels',
                },
                targetIntentEpoch: 5,
            }),
        );
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'happier.channels', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('happier.channels').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                correlationId: 'connection-transfer-2',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: createActionExecutorForTest({ pluginWebhookAction }),
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('plugin.webhook.endpoint.convergeTarget', {
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
            webhookContribution: { pluginId: 'happier.channels', localId: 'webhook' },
            sourceInstanceId: 'channels.connection.connection-1',
            setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
            desiredTargetMaterialization: {
                machineId: 'machine-2',
                materializationId: 'materialization-2',
                pluginId: 'happier.channels',
            },
            targetIntentEpoch: 5,
        })).resolves.toMatchObject({ kind: 'converged', revision: 5, targetIntentEpoch: 5 });

        expect(pluginWebhookAction).toHaveBeenCalledOnce();
        expect(pluginWebhookAction.mock.calls[0]?.[0]).toMatchObject({
            actionId: 'plugin.webhook.endpoint.convergeTarget',
            caller: { kind: 'plugin', pluginId: 'happier.channels' },
        });
    });

    it('reaches the canonical daemon browser owner with host-stamped identity and composed cancellation', async () => {
        const view = { browserSessionId: 'browser-session-1', viewId: 'view-1' };
        // Only Chromium's CDP transport is substituted; view binding and input
        // control use the same composed owners as the daemon.
        const transport = {
            openPage: async () => ({ targetId: 'target', sessionId: 'cdp-session' }),
            dispatchPageCommand: vi.fn(async ({ method }: { method: string }) => method === 'Page.getFrameTree'
                ? { frameTree: { frame: { id: 'frame', loaderId: 'document', url: 'https://example.com' } } }
                : { frameId: 'frame', loaderId: 'document' }),
            dispatchBrowserCommand: async () => ({ success: true }),
        };
        const owners = createBrowserAutomationOwnerRegistry();
        const adapter = createBrowserSidecarCdpControlAdapter({
            browserSessionId: view.browserSessionId, sidecarId: 'sidecar', transport,
            resolveInputControl: owners.getInputControl,
        });
        const automation = createBrowserAutomationDaemonService({ owners,
            adapter: createBrowserAutomationCdpAdapter({ transport: createControlAdapterAutomationTransport({ adapter,
                contextCapture: { transport, resolvePageHandle: adapter.resolvePageHandle, getNavigationState: adapter.getNavigationState },
            }) }), subscribeViewLifecycle: adapter.subscribeViewLifecycle,
        });
        await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', ...view, platform: 'web',
            focus: true,
            target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.com' } });
        transport.dispatchPageCommand.mockClear();
        const broker = createBrowserDaemonControlBroker();
        broker.registerAdapter(adapter);
        const canonicalBrowserExecute = createBrowserDaemonRuntimeActionExecutor({
            control: createBrowserDaemonControlRoutes({ broker, automation: () => automation }),
            featureGate: {
                isEnabled: () => true,
                refresh: async () => {},
            },
        });
        const runtimeActionExecute = vi.fn(canonicalBrowserExecute);
        const actionExecutor = createCliActionExecutor({
            token: 'token',
            sessionId: 'plugin-global',
            mode: 'plain',
            ctx: null,
            runtimeActionExecute,
            actionsSettingsProvider: {
                getActionsSettings: () => normalizeActionsSettingsV1({
                    v: 1,
                    actions: {},
                    approvalWaivedSurfaces: { 'browser.navigate': ['plugin'] },
                }),
            },
        } as Parameters<typeof createCliActionExecutor>[0] & Readonly<{
            runtimeActionExecute: typeof runtimeActionExecute;
        }>);
        const retirement = new AbortController();
        const caller = new AbortController();
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.browser', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.browser').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'cli',
                signal: retirement.signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor,
            invokeContributedAction: vi.fn(),
        });

        try {
            await expect(service.execute('browser.navigate', {
                kind: 'navigate',
                commandId: 'command-1',
                browserSessionId: 'browser-session-1',
                viewId: 'view-1',
                url: 'https://example.com',
            }, { signal: caller.signal })).resolves.toMatchObject({
                v: 1,
                commandId: 'command-1',
                status: 'dispatched',
            });

            expect(runtimeActionExecute).toHaveBeenCalledOnce();
            expect(runtimeActionExecute.mock.calls[0]?.[0].context).toMatchObject({
                surface: 'plugin',
                actionCaller: { kind: 'plugin', pluginId: 'acme.browser' },
            });
            const signal = runtimeActionExecute.mock.calls[0]?.[0].context.signal;
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(signal).not.toBe(retirement.signal);
            expect(signal).not.toBe(caller.signal);
            expect(transport.dispatchPageCommand).toHaveBeenCalledWith(expect.objectContaining({
                method: 'Page.navigate', params: { url: 'https://example.com' },
            }));
            caller.abort();
            expect(signal?.aborted).toBe(true);
        } finally {
            automation.dispose();
            adapter.dispose();
        }
    });

    it('binds host action execution to the plugin surface and host-stamped caller identity', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { v: 1, ok: true as const, hits: [] },
        }));
        const retirement = new AbortController();
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.memory');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    callerMaterialization.resolveCurrentPluginMaterializationRef,
                contribution: { id: 'search', qualifiedId: 'acme.memory/actions/search' },
                occurrenceId: 'memory-occurrence-a',
                sourceCustody: { kind: 'development', registeredRootId: 'memory-root' },
                correlationId: 'correlation-1',
                surface: 'cli',
                session: { id: 'session-1' },
                signal: retirement.signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('memory.search', {
            machineId: 'machine-1',
            query: {
                v: 1,
                query: 'architecture owner',
                scope: { type: 'global' },
                mode: 'hints',
            },
        })).resolves.toEqual({ v: 1, ok: true, hits: [] });

        expect(execute).toHaveBeenCalledWith(
            'memory.search',
            {
                machineId: 'machine-1',
                query: {
                    v: 1,
                    query: 'architecture owner',
                    scope: { type: 'global' },
                    mode: 'hints',
                },
            },
            expect.objectContaining({
                defaultSessionId: 'session-1',
                surface: 'plugin',
                authority: 'account_automation',
                actionCaller: {
                    kind: 'plugin',
                    pluginId: 'acme.memory',
                    contributionLocalId: 'search',
                    contributionQualifiedId: 'acme.memory/actions/search',
                    originSurface: 'cli',
                    materialization: callerMaterialization.materialization,
                    occurrenceId: 'memory-occurrence-a',
                    sourceCustody: { kind: 'development', registeredRootId: 'memory-root' },
                },
                actionRequestId: 'correlation-1:memory.search:1',
                signal: retirement.signal,
            }),
        );
    });

    it('binds retained Agent Actions to the active turn authority and source Session', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { sessions: [] },
        }));
        const causalPermissionAuthority = Object.freeze({
            kind: 'admittedSessionInputV1' as const,
            admittedPermissionCeiling: 'read-only',
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.agent', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture('acme.agent')
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'agent', qualifiedId: 'acme.agent/agents/agent' },
                occurrenceId: 'occurrenceId-1',
                correlationId: 'invocation-1',
                surface: 'agent',
                session: { id: 'session-1' },
                signal: new AbortController().signal,
                readActiveTurnAdmissionWitness: () => ({
                    inputId: 'input-1',
                    turnId: 'turn-1',
                    userMessageSeq: 7,
                    userMessageSeqs: [7],
                    causalPermissionAuthority,
                    callerPermissionMode: 'yolo',
                }),
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('session.list', {})).resolves.toEqual({ sessions: [] });
        expect(execute).toHaveBeenCalledWith(
            'session.list',
            {},
            expect.objectContaining({
                surface: 'agent',
                authority: 'account_automation',
                sessionListAccess: 'current_session',
                callerPermissionMode: 'yolo',
                causalPermissionAuthority,
                sessionInputSource: {
                    sourceSessionId: 'session-1',
                    sourceTurnId: 'turn-1',
                    sourceInputId: 'input-1',
                    via: 'action',
                },
            }),
        );
    });

    it.each(['witness', 'contributed'] as const)('keeps native Realtime decisions denied through the %s origin and the real executor', async (origin) => {
        const delivered: string[] = [];
        const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'session.permission.respond': ['agent'] } });
        const executor = createActionExecutorForTest({
            isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
            sessionPermissionRespond: async ({ decision }) => { delivered.push(decision); return { ok: true }; },
        });
        let native = true;
        const attempt = new AbortController();
        const inheritedContext = { nativeRealtimeInput: origin === 'contributed' ? true as const : undefined, signal: attempt.signal };
        const service = createPluginInvocationActionsService({
            seed: {
                approvalContext: inheritedContext,
                plugin: { id: 'acme.agent', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.agent').resolveCurrentPluginMaterializationRef,
                contribution: { id: 'agent', qualifiedId: 'acme.agent/agents/agent' },
                occurrenceId: 'native-occurrence', correlationId: 'native-invocation', surface: 'agent',
                session: { id: 'session-1' }, signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                readActiveTurnAdmissionWitness: () => ({
                    inputId: 'native-input', turnId: 'native-turn', userMessageSeq: null, userMessageSeqs: [],
                    callerPermissionMode: 'yolo',
                    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
                    ...(native && origin === 'witness' ? { nativeRealtimeAdmission: { admissionId: 'native-admission', occurrenceId: 'native-occurrence', attemptId: 'native-attempt' }, signal: attempt.signal } : {}),
                }),
            },
            actionExecutor: executor, invokeContributedAction: vi.fn(),
        });
        for (const decision of ['allow', 'deny'] as const) {
            await expect(service.execute('session.permission.respond', { sessionId: 'session-1', requestId: 'permission-1', decision }))
                .rejects.toMatchObject({ code: 'present_user_required' });
        }
        expect(delivered).toEqual([]);
        native = false;
        inheritedContext.nativeRealtimeInput = undefined;
        await expect(service.execute('session.permission.respond', { sessionId: 'session-1', requestId: 'permission-1', decision: 'allow' }))
            .resolves.toMatchObject({ ok: true });
        expect(delivered).toEqual(['allow']);
    });

    it('cancels an Agent Action when its exact native Realtime admission ends', async () => {
        const attempt = new AbortController();
        let entered!: () => void;
        const entering = new Promise<void>(resolve => { entered = resolve; });
        const executor = createActionExecutorForTest({
            sessionList: async ({ context }) => await new Promise((_resolve, reject) => {
                context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true });
                entered();
            }),
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.agent', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.agent').resolveCurrentPluginMaterializationRef,
                contribution: { id: 'agent', qualifiedId: 'acme.agent/agents/agent' },
                occurrenceId: 'native-occurrence', correlationId: 'native-invocation', surface: 'agent',
                session: { id: 'session-1' }, signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                readActiveTurnAdmissionWitness: () => ({
                    inputId: 'native-input', turnId: 'native-turn', userMessageSeq: null, userMessageSeqs: [],
                    callerPermissionMode: 'default',
                    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
                    nativeRealtimeAdmission: { admissionId: 'native-admission', occurrenceId: 'native-occurrence', attemptId: 'native-attempt' },
                    signal: attempt.signal,
                }),
            },
            actionExecutor: executor, invokeContributedAction: vi.fn(),
        });
        const pending = service.execute('session.list', {});
        const settled = expect(pending).rejects.toMatchObject({ code: 'plugin_action_aborted' });
        await entering;
        attempt.abort(new Error('native Realtime ended'));
        await settled;
        await expect(service.execute('session.list', {})).rejects.toMatchObject({ code: 'plugin_action_aborted' });
    });

    it('keeps each requester through production services and the real Action executor without changing executor authority', async () => {
        const contexts: ActionExecutorContext[] = [];
        const executor = createActionExecutorForTest({
            // Session-list transport is the system boundary; host admission stays real.
            sessionList: async ({ context }) => { contexts.push(context); return { sessions: [] }; },
        });
        let accountId = 'bob';
        const owners = createProductionPluginInvocationServiceOwners({ actionExecutor: executor,
            invokeContributedAction: async () => { throw new Error('No contributed effect expected'); } });
        const services = owners.createServices({
            plugin: { id: 'acme.agent', version: '1.0.0' },
            resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.agent').resolveCurrentPluginMaterializationRef,
            contribution: { id: 'agent', qualifiedId: 'acme.agent/agents/agent' },
            occurrenceId: 'requester-occurrence', correlationId: 'requester-invocation', surface: 'agent',
            session: { id: 'bot' }, signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            readActiveTurnAdmissionWitness: () => ({
                inputId: `${accountId}-input`, turnId: `${accountId}-turn`, userMessageSeq: 1, userMessageSeqs: [1],
                callerPermissionMode: 'default',
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
                actionRequestAttributionV1: { requestRef: `${accountId}-input`,
                    requester: { serverId: 'home', accountId }, persona: { serverId: 'home', sessionId: 'bot' }, origin: null },
            }),
        }, owners.createOrdinaryServiceBinding('requester-occurrence', 'requester-invocation'));
        try {
            await services.actions.execute('session.list', {});
            accountId = 'carol';
            await services.actions.execute('session.list', {});
            expect(contexts.map(context => ({ authority: context.authority, attribution: context.actionRequestAttributionV1 })))
                .toEqual(['bob', 'carol'].map(requester => ({ authority: 'account_automation', attribution: {
                    requestRef: `${requester}-input`, requester: { serverId: 'home', accountId: requester },
                    persona: { serverId: 'home', sessionId: 'bot' }, origin: null,
                } })));
        } finally { await owners.dispose(); }
    });

    it('refuses an unsigned shared requester through production services before preview or effect', async () => {
        let approval: unknown;
        const effects: string[] = [];
        const executor = createActionExecutorForTest({
            approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'bob-preview' }; },
            sessionSendMessage: async ({ message }) => { effects.push(message); return { status: 'accepted', localId: 'effect' }; },
        });
        const owners = createProductionPluginInvocationServiceOwners({ actionExecutor: executor,
            invokeContributedAction: async () => { throw new Error('No contributed effect expected'); } });
        const id = 'shared-plugin-request';
        const services = owners.createServices({ plugin: { id: 'acme.agent', version: '1.0.0' },
            resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.agent').resolveCurrentPluginMaterializationRef,
            contribution: { id: 'post', qualifiedId: 'acme.agent/actions/post' },
            occurrenceId: id, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
            correlationId: id, surface: 'plugin', session: { id: 'bot' },
            approvalContext: { runtimeAccountId: 'alice', serverId: 'home', defaultSessionId: 'bot',
                actionRequestAttributionV1: { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' },
                    persona: { serverId: 'home', sessionId: 'bot' }, origin: null } },
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        }, owners.createOrdinaryServiceBinding(id, id));
        try {
            await expect(services.actions.execute('session.message.send', { sessionId: 'bot', message: 'Review this update', idempotencyKey: 'shared-plugin-request' }))
                .rejects.toMatchObject({ code: 'approval_requester_unavailable' });
            expect(approval).toBeUndefined();
            expect(effects).toEqual([]);
        } finally { await owners.dispose(); }
    });

    it('keeps a finite invocation cause, but never reuses it when an active-turn owner reports no cause', async () => {
        const contexts: ActionExecutorContext[] = [];
        const executor = createActionExecutorForTest({ sessionList: async ({ context }) => {
            contexts.push(context); return { sessions: [] };
        } });
        const owners = createProductionPluginInvocationServiceOwners({ actionExecutor: executor,
            invokeContributedAction: async () => { throw new Error('No contributed effect expected'); } });
        const cause = { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' },
            persona: { serverId: 'home', sessionId: 'bot' }, origin: null };
        try {
            for (const activeOwner of [false, true]) {
                const id = `finite-${activeOwner}`;
                const services = owners.createServices({ plugin: { id: 'acme.agent', version: '1.0.0' },
                    resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.agent').resolveCurrentPluginMaterializationRef,
                    contribution: { id: 'agent', qualifiedId: 'acme.agent/agents/agent' },
                    occurrenceId: id, correlationId: id, surface: 'agent', session: { id: 'bot' },
                    actionRequestAttributionV1: cause,
                    ...(activeOwner ? { readActiveTurnAdmissionWitness: () => ({ inputId: 'autonomous', turnId: 'autonomous-turn',
                        userMessageSeq: null, userMessageSeqs: [] }) } : {}),
                    signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                }, owners.createOrdinaryServiceBinding(id, id));
                await services.actions.execute('session.list', {});
            }
            expect(contexts.map(context => context.actionRequestAttributionV1)).toEqual([cause, undefined]);
        } finally { await owners.dispose(); }
    });

    it('propagates the Agent active-turn admission witness through composed invocation services', async () => {
        // The composed services owner builds the actions seed explicitly. Dropping the
        // witness there silently strips the caller permission mode and causal authority
        // from every Agent-placed Action, so Run dispatch fails closed.
        const execute = vi.fn(async () => ({ ok: true as const, result: { sessions: [] } }));
        const causalPermissionAuthority = Object.freeze({
            kind: 'admittedSessionInputV1' as const,
            admittedPermissionCeiling: 'read-only',
        });
        const owners = createProductionPluginInvocationServiceOwners({
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });
        const service = owners.createServices({
            plugin: { id: 'acme.agent', version: '1.0.0' },
            resolveCurrentPluginMaterializationRef:
                createPluginActionCallerMaterializationFixture('acme.agent')
                    .resolveCurrentPluginMaterializationRef,
            contribution: { id: 'agent', qualifiedId: 'acme.agent/agents/agent' },
            occurrenceId: 'occurrenceId-1',
            correlationId: 'invocation-1',
            surface: 'agent',
            session: { id: 'session-1' },
            signal: new AbortController().signal,
            readActiveTurnAdmissionWitness: () => ({
                inputId: 'input-1',
                turnId: 'turn-1',
                userMessageSeq: 7,
                userMessageSeqs: [7],
                causalPermissionAuthority,
                callerPermissionMode: 'yolo',
            }),
            isOccurrenceCurrent: () => true,
        }, owners.createOrdinaryServiceBinding('occurrenceId-1', 'composed-witness-actions')).actions;

        await expect(service.execute('session.list', {})).resolves.toEqual({ sessions: [] });
        expect(execute).toHaveBeenCalledWith(
            'session.list',
            {},
            expect.objectContaining({
                surface: 'agent',
                authority: 'account_automation',
                callerPermissionMode: 'yolo',
                causalPermissionAuthority,
                sessionInputSource: {
                    sourceSessionId: 'session-1',
                    sourceTurnId: 'turn-1',
                    sourceInputId: 'input-1',
                    via: 'action',
                },
            }),
        );
    });

    it('strictly validates the plugin-recipient result and reports executor failures as PluginError', async () => {
        const invalidResult = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'cli',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: {
                execute: async () => ({ ok: true, result: { privateMemoryRows: [] } }),
            },
            invokeContributedAction: vi.fn(),
        });
        await expect(invalidResult.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        })).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_action_result_schema_invalid',
        });

        const denied = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'cli',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: {
                execute: async () => ({ ok: false, errorCode: 'action_disabled', error: 'action_disabled' }),
            },
            invokeContributedAction: vi.fn(),
        });
        await expect(denied.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        })).rejects.toMatchObject({ code: 'action_disabled' });
    });

    it('rejects a semantic transcript result that is outside the plugin external-shareable projection', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: {
                ok: true as const,
                sessionId: 'session-1',
                items: [],
                nextCursor: null,
                hasMore: false,
                diagnostics: {
                    rawRowsScanned: 0,
                    pagesFetched: 0,
                    scanLimitReached: false,
                    payloadTruncations: 0,
                },
            },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.channels', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.channels').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('session.transcript.get', {
            sessionId: 'session-1',
            projection: 'externalShareableV1',
        })).rejects.toMatchObject({
            code: 'plugin_action_result_schema_invalid',
        });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('forwards the host-private interception bypass only for hook-originated service seeds', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { v: 1, ok: true as const, hits: [] },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.hook', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.hook').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
                bypassActionInterception: true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await service.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        });
        expect(execute).toHaveBeenCalledWith(
            'memory.search',
            expect.anything(),
            expect.objectContaining({ bypassActionInterception: true }),
        );
    });

    it('binds permission-request identity from the host seed instead of accepting plugin-authored identity', async () => {
        const pluginPermissionGrantAction: NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']> = vi.fn(async () => ({
            ok: false as const,
            errorCode: 'test_stop_after_binding',
            error: 'test_stop_after_binding',
        }));
        const actionExecutor = createPermissionActionExecutor(pluginPermissionGrantAction);
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'ui',
                session: { id: 'session-7' },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor,
            invokeContributedAction: vi.fn(),
        });

        await expect(Reflect.apply(service.execute, service, [
            'plugins.permissions.grants.request',
            {
                capability: 'reviews.comments.write.direct',
                targetScope: { kind: 'account' },
                subject: { kind: 'general' },
                reason: 'Publish approved review comments directly',
            },
        ])).rejects.toMatchObject({ code: 'test_stop_after_binding' });
        expect(pluginPermissionGrantAction).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'plugins.permissions.grants.request',
            input: expect.objectContaining({
                pluginId: 'acme.caller',
                requester: {
                    kind: 'plugin',
                    pluginId: 'acme.caller',
                    sessionId: 'session-7',
                },
            }),
            caller: expect.objectContaining({
                kind: 'plugin',
                pluginId: 'acme.caller',
                materialization: expect.objectContaining({
                    machineId: 'machine-1',
                    materializationId: 'materialization-acme-caller-current',
                }),
            }),
        }));
    });

    it('routes own-grant revoke and user-waivable grant Ask through the real policy', async () => {
        let settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'plugins.permissions.grants.revoke': ['plugin'] } });
        const pluginPermissionGrantAction: NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']> = vi.fn(async () => ({
            ok: false as const,
            errorCode: 'test_stop_after_binding',
            error: 'test_stop_after_binding',
        }));
        const approvalsCreate = vi.fn<NonNullable<ActionExecutorDeps['approvalsCreate']>>(async () => ({ artifactId: 'grant-review' }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'manage', qualifiedId: 'acme.caller/actions/manage' },
                sourceCustody: createManagedPluginSourceCustody('grants-policy-generation'),
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                correlationId: 'grant-management-1',
                surface: 'ui',
                approvalContext: { runtimeAccountId: 'alice', serverId: 'home', serverIdentityId: 'srv_policy_fixture' },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: createActionExecutorForTest({ pluginPermissionGrantAction, approvalsCreate,
                isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context) }),
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('plugins.permissions.grants.revoke', {
            grantId: 'grant-1',
        })).rejects.toMatchObject({ code: 'test_stop_after_binding' });
        expect(pluginPermissionGrantAction).toHaveBeenCalledWith({
            actionId: 'plugins.permissions.grants.revoke',
            input: { grantId: 'grant-1' },
            caller: expect.objectContaining({
                kind: 'plugin',
                pluginId: 'acme.caller',
                materialization: expect.objectContaining({
                    machineId: 'machine-1',
                    materializationId: 'materialization-acme-caller-current',
                }),
            }),
            signal: expect.any(AbortSignal),
        });

        await expect(service.execute('plugins.permissions.grants.grant', {
            requestId: 'request-1',
        })).resolves.toMatchObject({ kind: 'approval_request_created' });
        expect(pluginPermissionGrantAction).toHaveBeenCalledTimes(1);
        expect(approvalsCreate).toHaveBeenCalledOnce();
        settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
            'plugins.permissions.grants.revoke': ['plugin'], 'plugins.permissions.grants.grant': ['plugin'],
        } });
        await expect(service.execute('plugins.permissions.grants.grant', { requestId: 'request-1' }))
            .rejects.toMatchObject({ code: 'test_stop_after_binding' });
        expect(pluginPermissionGrantAction).toHaveBeenLastCalledWith(expect.objectContaining({
            actionId: 'plugins.permissions.grants.grant', input: { requestId: 'request-1' },
            caller: expect.objectContaining({ kind: 'plugin', pluginId: 'acme.caller' }),
        }));
        expect(pluginPermissionGrantAction).toHaveBeenCalledTimes(2);
        expect(approvalsCreate).toHaveBeenCalledOnce();
    });

    it('returns the executed contributed result when the host-stamped caller materialization changes during dispatch', async () => {
        const initialCaller = createPluginActionCallerMaterializationFixture('acme.caller', {
            materializationId: 'materialization-caller-before',
        }).materialization;
        let currentCaller = initialCaller;
        const invokeContributedAction = vi.fn(async () => {
            currentCaller = createPluginActionCallerMaterializationFixture('acme.caller', {
                materializationId: 'materialization-caller-after',
            }).materialization;
            return {
                status: 'executed' as const,
                value: { accepted: true },
            };
        });
        const service = createContributedActionServiceForTest({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: () => currentCaller,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            invokeContributedAction,
        });

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).resolves.toEqual({ accepted: true });
        expect(invokeContributedAction).toHaveBeenCalledOnce();
        expect(invokeContributedAction).toHaveBeenCalledWith(expect.objectContaining({
            caller: expect.objectContaining({
                materialization: initialCaller,
            }),
        }));
    });

    it.each([true, false])('retains the initiating request identity when a real contributed target retires (request supplied: %s)', async supplied => {
        let effects = 0;
        let current = true;
        let callerCurrent = true;
        let failHandler = false;
        const warning = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const occurrenceId = createPluginRuntimeOccurrenceId('acme.target');
        let targets: ReturnType<typeof createTargetActionInvocationRegistry>;
        const invokeContributedAction: InvokeContributedAction = async request => {
            const result = await targets.invoke({
                pluginId: request.action.pluginId, localId: request.action.localId,
                input: request.input, surface: request.surface, invocationSurface: request.surface,
                caller: request.caller, signal: request.signal,
                ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
            });
            if (result.status === 'deferred') throw new Error('Safe fixture must not request approval');
            return result;
        };
        const owners = createProductionPluginInvocationServiceOwners({
            actionExecutor: createContributedActionExecutorForTest(invokeContributedAction), invokeContributedAction,
        });
        targets = createTargetActionInvocationRegistry({
            actions: [{ pluginId: 'acme.target', pluginVersion: '1.0.0', occurrenceId,
                sourceCustody: createManagedPluginSourceCustody('target'), localId: 'inspect',
                definition: { id: 'inspect', dangerLevel: 'safe', scopes: ['global'], surfaces: ['plugin'], inputSchema: { type: 'object' }, resultSchema: {} },
                handler: async () => {
                    if (failHandler) throw new PluginError({ code: 'fixture_target_failed', message: 'Private author failure' });
                    effects++; return { accepted: true };
                },
            }],
            resolveAuthorizationFacts: target => ({ generation: { targetGeneration: target.occurrenceId,
                desiredGeneration: target.occurrenceId, appliedGeneration: target.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
            createServices: owners.createServices, resolveHostBinding: owners.resolveHostBinding,
            readCurrentPluginOccurrenceId: pluginId => pluginId === 'acme.target' && current ? occurrenceId : null,
        });
        const service = createContributedActionServiceForTest({ seed: {
            plugin: { id: 'acme.caller', version: '1.0.0' },
            contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
            occurrenceId: 'caller-current', sourceCustody: createManagedPluginSourceCustody('caller'),
            surface: 'plugin', correlationId: 'traced-invocation',
            ...(supplied ? { requestId: 'initiating-request' } : {}),
            signal: new AbortController().signal, isOccurrenceCurrent: () => callerCurrent,
        }, invokeContributedAction });
        try {
            await expect(service.execute({ pluginId: 'acme.target', localId: 'inspect' }, {})).resolves.toEqual({ accepted: true });
            failHandler = true;
            const failed: unknown = await service.execute({ pluginId: 'acme.target', localId: 'inspect' }, {}).catch(error => error);
            const requestId = supplied ? 'initiating-request' : 'traced-invocation';
            expect(readPluginErrorRequestIdV1(failed)).toBe(requestId);
            expect(warning.mock.calls.filter(call => call[0] === 'Plugin Action failed')).toEqual([
                ['Plugin Action failed', { pluginId: 'acme.target', localId: 'inspect', code: 'fixture_target_failed', requestId }],
            ]);
            current = false;
            const error: unknown = await service.execute({ pluginId: 'acme.target', localId: 'inspect' }, {}).catch(error => error);
            expect(error).toMatchObject({ code: 'plugin_action_generation_retired' });
            expect(readPluginErrorRequestIdV1(error)).toBe(supplied ? 'initiating-request' : 'traced-invocation');
            callerCurrent = false;
            const retiredCaller: unknown = await service.execute({ pluginId: 'acme.target', localId: 'inspect' }, {}).catch(error => error);
            expect(retiredCaller).toMatchObject({ code: 'plugin_action_generation_retired' });
            expect(readPluginErrorRequestIdV1(retiredCaller)).toBe(requestId);
            expect(effects).toBe(1);
        } finally { warning.mockRestore(); targets.dispose(); await owners.dispose(); }
    });

    it('reads only the canonical projected fields when reconstructing a contributed action failure', async () => {
        const cause = new Error('provider credential is secret');
        const original = new PluginError({
            code: 'fixture_provider_failed',
            message: 'provider credential is secret',
            retryable: true,
            details: { credential: 'secret' },
            remediation: { kind: 'openSettings', path: 'accounts/acme' },
            diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'private' }],
        }, { cause });
        // Boundary fixture: a malformed richer result whose author vocabulary
        // sits at the top level instead of inside the canonical `data` payload.
        const richResult = Object.freeze({
            status: 'failed' as const,
            code: original.code,
            message: original.message,
            retryable: original.retryable,
            details: original.details,
            remediation: original.remediation,
            diagnostics: original.diagnostics,
            cause: original,
        });
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createContributedActionServiceForTest({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            // Boundary fixture intentionally models a malformed richer result
            // that must not cross the generic service boundary.
            invokeContributedAction: vi.fn<InvokeContributedAction>(async () => richResult),
        });

        const received = await service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        ).catch((error: unknown) => error);

        expect(received).toBeInstanceOf(PluginError);
        expect(received).not.toBe(original);
        // `retryable` is a canonical projected field, so it crosses. The author
        // vocabulary is read only from the canonical `data` payload: a fixture
        // that hangs `details`/`remediation`/`diagnostics`/`cause` off the
        // result itself publishes nothing, and no error class is transported.
        expect(received).toMatchObject({
            code: 'fixture_provider_failed',
            message: 'provider credential is secret',
            retryable: true,
            details: undefined,
            remediation: undefined,
            diagnostics: undefined,
        });
        expect(Object.hasOwn(received as object, 'cause')).toBe(false);
        expect((received as PluginError).data).toEqual({
            name: 'PluginError',
            code: 'fixture_provider_failed',
            message: 'provider credential is secret',
            retryable: true,
        });
    });

    it.each([
        { details: { requestId: 'target-request', field: 'title', attempted: 2 } },
        { details: { field: 'title', attempted: 2 } },
        { details: 'author-defined-details' },
        { details: ['author-defined-details'] },
        { details: { requestId: 'target-request' }, direct: true },
    ] satisfies ReadonlyArray<{ details: JsonValue; direct?: true }>)('carries a target plugin canonical error retryable and data across a plugin-to-plugin failure ($details, direct: $direct)', async scenario => {
        const { details } = scenario;
        // Plugins are trusted code. A target's own published failure payload is
        // the failure its caller receives, not a bare taxonomy code.
        const target = new PluginError({
            code: 'fixture_provider_failed',
            message: 'provider rejected the publish',
            retryable: true,
            details,
            remediation: { kind: 'openSettings', path: 'accounts/acme' },
            diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'quota exhausted' }],
        });
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createContributedActionServiceForTest({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                requestId: 'caller-request', correlationId: 'caller-trace',
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            invokeContributedAction: vi.fn<InvokeContributedAction>(async () => Object.freeze({
                status: 'failed' as const,
                code: target.code,
                message: target.message,
                retryable: target.retryable,
                data: target.data as JsonValue,
            })),
        });

        const action = { pluginId: 'acme.target', localId: 'publish' };
        const input = { title: 'Ready' };
        const received = await ('direct' in scenario
            ? service.execute('action.invoke', { action, input })
            : service.execute(action, input)).catch((error: unknown) => error);

        expect(received).toBeInstanceOf(PluginError);
        expect(received).not.toBe(target);
        expect(received).toMatchObject({
            code: 'fixture_provider_failed',
            message: 'provider rejected the publish',
            retryable: true,
            details,
            remediation: { kind: 'openSettings', path: 'accounts/acme' },
            diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'quota exhausted' }],
        });
        expect((received as PluginError).data).toEqual(target.data);
    });

    it('preserves only the generic proof that a contributed handler never began', async () => {
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createContributedActionServiceForTest({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            invokeContributedAction: vi.fn<InvokeContributedAction>(async () => (
                Object.freeze({
                    status: 'unavailable' as const,
                    code: 'plugin_action_handler_missing',
                    message: 'No committed target handler exists',
                    actionHandlerInvocation: 'notStarted',
                } satisfies ContributedActionInvocationResult)
            )),
        });

        const received = await service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        ).catch((error: unknown) => error);

        expect(received).toMatchObject({
            name: 'PluginError',
            code: 'plugin_action_handler_missing',
            actionHandlerInvocation: 'notStarted',
            data: {
                actionHandlerInvocation: 'notStarted',
            },
        });
    });

    it.each(['materialization', 'source'] as const)('returns a host-stamped exact %s target execution origin only for the contributed-Action origin call', async (kind) => {
        const executionOrigin = Object.freeze({
            serverIdentityId: 'srv_action_origin_fixture',
            ...(kind === 'materialization' ? { materializationRef: Object.freeze({
                pluginId: 'acme.target',
                machineId: 'machine-target',
                materializationId: 'materialization-target-current',
            }) } : { sourceRef: Object.freeze({
                pluginId: 'acme.target', machineId: 'machine-target',
                sourceCustody: { kind: 'development' as const, registeredRootId: 'target-source-root' },
            }) }),
        });
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
            executionOrigin,
        }));
        const signal = new AbortController().signal;
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller', {
            materializationId: 'materialization-caller-current',
        });
        const service = createContributedActionServiceForTest({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal,
                isOccurrenceCurrent: () => true,
            },
            invokeContributedAction,
        });

        await expect(service.executeWithExecutionOrigin(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
            {
                expectedExecutionOrigin: executionOrigin,
                expectedExecutionRouting: { serverIdentityId: 'srv_action_origin_fixture', machineId: 'machine-target', pluginId: 'acme.target' },
            },
        )).resolves.toEqual({
            result: { accepted: true },
            executionOrigin,
        });
        expect(invokeContributedAction).toHaveBeenCalledWith(expect.objectContaining({
            action: { pluginId: 'acme.target', localId: 'publish' },
            input: { title: 'Ready' },
            surface: 'plugin',
            captureExecutionOrigin: true,
            expectedExecutionOrigin: executionOrigin,
            expectedExecutionRouting: { serverIdentityId: 'srv_action_origin_fixture', machineId: 'machine-target', pluginId: 'acme.target' },
            caller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                materialization: callerMaterialization.materialization,
                originSurface: 'agent',
            },
            signal,
        }));
        expect(invokeContributedAction.mock.calls[0]?.[0]).not.toHaveProperty('executionOrigin');

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).resolves.toEqual({ accepted: true });
        expect(invokeContributedAction.mock.calls[1]?.[0]).not.toHaveProperty('captureExecutionOrigin');
        expect(invokeContributedAction.mock.calls[1]?.[0]).not.toHaveProperty('executionOrigin');
    });

    it.each([
        { expectedExecutionOrigin: { serverIdentityId: 'not-a-server-identity', materializationRef: {
            pluginId: 'acme.target', machineId: 'machine-target', materializationId: 'materialization-target-current',
        } } },
        { expectedExecutionRouting: { serverIdentityId: 'not-a-server-identity', machineId: 'machine-target', pluginId: 'acme.target' } },
        { expectedExecutionRouting: { serverIdentityId: 'srv_action_origin_fixture', machineId: 'machine-target', pluginId: 'acme.target', materializationId: 'not-routing' } },
    ])('rejects a malformed expected target before contributed Action dispatch (%j)', async (options) => {
        const invokeContributedAction = vi.fn(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
            executionOrigin: {
                serverIdentityId: 'srv_action_origin_fixture',
                materializationRef: {
                    pluginId: 'acme.target',
                    machineId: 'machine-target',
                    materializationId: 'materialization-target-current',
                },
            },
        }));
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createContributedActionServiceForTest({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'occurrenceId-1',
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            invokeContributedAction,
        });

        await expect(Reflect.apply(service.executeWithExecutionOrigin, service, [
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
            options,
        ])).rejects.toMatchObject({
            code: 'plugin_action_execution_origin_invalid',
        });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });

    it('fails closed instead of inventing caller authority when its own materialization is unavailable', async () => {
        const invokeContributedAction = vi.fn(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const service = createContributedActionServiceForTest({
            seed: {
                plugin: { id: 'acme.unbound', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.unbound/actions/caller' },
                occurrenceId: 'occurrenceId-1',
                surface: 'agent',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            invokeContributedAction,
        });

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).rejects.toMatchObject({ code: 'plugin_action_caller_unavailable' });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });

    it('fails closed for unknown and plugin-unavailable runtime action strings', async () => {
        const execute = vi.fn();
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'ui',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(Reflect.apply(service.execute, service, ['unknown.action', {}]))
            .rejects.toMatchObject({ code: 'plugin_action_unknown' });
        // This raw durable Start is known to the host Action registry but not
        // exposed on the Plugin surface. Runtime calls that bypass the SDK
        // type union must fail that generic surface admission before parsing
        // the raw RPC input schema.
        await expect(Reflect.apply(service.execute, service, ['sessions.external.takeover.start', {}]))
            .rejects.toMatchObject({ code: 'plugin_action_not_available' });
        expect(execute).not.toHaveBeenCalled();
    });

    it('exposes bounded Session-subagent reads to plugin callers and keeps lifecycle mutations internal', async () => {
        const subagentRef = {
            id: 'subagent-1',
            parentSessionId: 'session-bound',
            origin: 'agent' as const,
            kind: 'native' as const,
            agentRef: { agentId: 'codex' },
            status: 'pending' as const,
            createdAt: 123,
        };
        const execute = vi.fn(async (actionId: string, _input: unknown, _context: unknown) => {
            if (actionId === 'sessions.subagents.list') {
                return { ok: true as const, result: [subagentRef] };
            }
            if (actionId === 'sessions.subagents.get') {
                return { ok: true as const, result: subagentRef };
            }
            return { ok: true as const, result: { kind: 'snapshot' as const, subagents: [subagentRef] } };
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'ui',
                session: { id: 'session-bound' },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(Reflect.apply(service.execute, service, ['sessions.subagents.list', {}]))
            .resolves.toEqual([subagentRef]);
        await expect(Reflect.apply(service.execute, service, ['sessions.subagents.get', { id: 'subagent-1' }]))
            .resolves.toEqual(subagentRef);
        await expect(Reflect.apply(service.execute, service, ['sessions.subagents.watch', {}]))
            .resolves.toEqual({ kind: 'snapshot', subagents: [subagentRef] });
        expect(execute).toHaveBeenCalledTimes(3);
        for (const call of execute.mock.calls) {
            expect(call[2]).toMatchObject({
                surface: 'plugin',
                authority: 'account_automation',
            });
        }

        const unavailableExecute = vi.fn();
        const guardedService = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'ui',
                session: { id: 'session-bound' },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: unavailableExecute },
            invokeContributedAction: vi.fn(),
        });
        for (const actionId of [
            'sessions.subagents.upsert',
            'sessions.subagents.updateStatus',
            'sessions.subagents.complete',
        ] as const) {
            await expect(Reflect.apply(guardedService.execute, guardedService, [actionId, {}]))
                .rejects.toMatchObject({ code: 'plugin_action_not_available' });
        }

        expect(unavailableExecute).not.toHaveBeenCalled();
    });

    it('invokes an executor-backed runtime action through its exact canonical schemas', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: {
                v: 1 as const,
                commandId: 'command-1',
                status: 'dispatched' as const,
                adapterKind: 'chromiumSidecar' as const,
                events: [],
            },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.browser', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.browser').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'ui',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('browser.navigate', {
            kind: 'navigate',
            commandId: 'command-1',
            browserSessionId: 'browser-session-1',
            viewId: 'view-1',
            url: 'https://example.com',
        })).resolves.toMatchObject({ status: 'dispatched', commandId: 'command-1' });
        await expect(Reflect.apply(service.execute, service, ['browser.navigate', {
            kind: 'navigate',
            commandId: 'command-2',
            browserSessionId: 'browser-session-1',
            viewId: 'view-1',
        }])).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('composes caller cancellation with occurrenceId retirement and rejects late publication', async () => {
        let current = true;
        const retirement = new AbortController();
        const caller = new AbortController();
        const execute = vi.fn(async (
            _actionId: unknown,
            _input: unknown,
            context?: Readonly<{ signal?: AbortSignal }>,
        ) => {
            expect(context?.signal).not.toBe(caller.signal);
            expect(context?.signal).not.toBe(retirement.signal);
            expect(context?.signal?.aborted).toBe(false);
            current = false;
            return { ok: true as const, result: { v: 1, ok: true as const, hits: [] } };
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'cli',
                signal: retirement.signal,
                isOccurrenceCurrent: () => current,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        }, { signal: caller.signal })).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
        });
    });

    it('rechecks occurrenceId authority immediately before invoking the host Action executor', async () => {
        let currentnessReads = 0;
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { v: 1, ok: true as const, hits: [] },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'agent',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => {
                    currentnessReads += 1;
                    return currentnessReads === 1;
                },
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('memory.search', {
            machineId: 'machine-1',
            query: {
                v: 1,
                query: 'witness race',
                scope: { type: 'global' },
                mode: 'hints',
            },
        })).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
        });
        expect(execute).not.toHaveBeenCalled();
    });
});
