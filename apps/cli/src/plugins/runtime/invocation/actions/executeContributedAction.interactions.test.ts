import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { definePlugin, type JsonValue } from '@happier-dev/plugin-sdk';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import type { InteractionTransientResultV1 } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalProfileV1Schema } from '@happier-dev/protocol/actions/approvalProfiles';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { createNativeAgentCurrentSessionUiServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { registerCurrentSessionUiBinding } from '@/session/presentation/currentSessionUiBindings';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader } from './createCommittedContributedActionDeps';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { executeContributedAction } from './executeContributedAction';

// Login storage and the Session client are external persistence/transport
// boundaries. The authored runtime, consent issuer and interaction owners run.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => null }));
afterEach(() => { vi.unstubAllEnvs(); resetActiveAccountSettingsSnapshotForTests(); });

async function fixture(options: Readonly<{
    abortRequests?: boolean;
    bindSession?: boolean;
    nestedInput?: 'scalar' | 'omitted' | 'defaulted';
    nestedTargeted?: boolean;
    requireNestedApproval?: boolean;
    approvalProfile?: 'child-ask' | 'parent-ask' | 'allow';
    approvalTarget?: 'scalar' | 'omitted' | 'defaulted';
}> = {}) {
    const { abortRequests = false, bindSession = true, nestedInput, nestedTargeted = false, requireNestedApproval = false, approvalProfile,
        approvalTarget = nestedInput ?? 'scalar' } = options;
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const accountSettings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: requireNestedApproval ? {
        [formatQualifiedPluginActionId(nestedTargeted ? { pluginId: 'example.parent-consent-source', localId: 'step' }
            : { pluginId: 'example.parent-consent', localId: approvalTarget })]: { approvalRequiredSurfaces: ['plugin'] },
    } : {} } });
    const profile = approvalProfile ? ApprovalProfileV1Schema.parse({ id: 'test:contributed', name: 'Contributed test',
        actions: approvalProfile === 'allow' ? {} : {
            [formatQualifiedPluginActionId({ pluginId: 'example.parent-consent',
                localId: approvalProfile === 'parent-ask' ? 'run' : 'scalar' })]: { approvalRequiredSurfaces: ['cli', 'plugin'] },
        },
    }) : null;
    setActiveAccountSettingsSnapshot({ scopeKey: 'parent-consent-test', source: 'network', settingsVersion: 1,
        settings: accountSettings, rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
        promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    const controller = new AbortController();
    const rpc = new ServerBoundPermissionRpcHandlerManager('plugin-parent-consent-session');
    const session = createMutableApiSessionClientFixture({ sessionId: 'plugin-parent-consent-session',
        overrides: { rpcHandlerManager: rpc as unknown as ApiSessionClient['rpcHandlerManager'] } });
    const handler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Test]' });
    const unbind = bindSession ? registerCurrentSessionUiBinding({ sessionId: session.sessionId,
        service: createNativeAgentCurrentSessionUiServices({ permissionHandler: handler,
            pluginId: 'happier.agent.host', contributionId: 'host', runtimeId: 'host', sessionId: session.sessionId,
            occurrenceId: createPluginRuntimeOccurrenceId('happier.agent.host'), isCurrent: () => true,
            signal: controller.signal }), signal: controller.signal, isCurrent: () => true }) : () => {};
    const results: InteractionTransientResultV1[] = [];
    const action = { pluginId: 'example.parent-consent', localId: 'run' };
    const scalarInputs: JsonValue[] = [];
    const omittedInputs: JsonValue[] = [];
    const defaultedInputs: JsonValue[] = [];
    // This is the authored target's executable input contract, not a caller-side
    // normalizer. Raw JSON Schema defaults are annotations, not parsed values.
    const defaultedBase = defineProtocolObject({ mode: defineProtocolString().optional() }, { policy: 'closed' });
    const defaultedSchema = { ...defaultedBase,
        parse(value: unknown) { const parsed = defaultedBase.parse(value); return { mode: parsed.mode ?? 'target-default' }; },
        safeParse(value: unknown) { const parsed = defaultedBase.safeParse(value);
            return parsed.success ? { success: true as const, data: { mode: parsed.data.mode ?? 'target-default' } } : parsed; },
    };
    const stepInput = defineProtocolObject({}, { policy: 'closed' });
    const stepProtocol = defineContributionProtocol({ id: 'confirmed-steps', version: 1, operations: {
        step: { required: true, input: { kind: 'protocolDefined', schema: stepInput }, resultSchema: defineProtocolLiteral(null),
            action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
        approvalProfileCatalog: profile ? [{ id: profile.id, profile, access: 'owner',
            revision: { headerVersion: 1, bodyVersion: 1 } }] : [],
    } });
    const steps = stepProtocol.point();
    const plugin = definePlugin({ id: action.pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        contributionPoints: { steps },
        actions: { run: { title: 'Run confirmed operation', dangerLevel: 'safe',
            scopes: ['global'], surfaces: ['cli', 'plugin'],
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            run: async (_input, context): Promise<null> => {
                if (nestedInput) {
                    const ref = { pluginId: action.pluginId, localId: nestedInput };
                    if (nestedInput === 'omitted') await context.services.actions.execute('action.invoke', { action: ref });
                    else await context.services.actions.execute(ref, nestedInput === 'scalar' ? 'requested-scalar' : {});
                    return null;
                }
                if (nestedTargeted) {
                    const observation = context.services.targetedContributions.observeForSelf(plugin.contributionPoints.steps, { onInvalidated() {} });
                    try {
                        const snapshot = await observation.readCurrent();
                        const operation = snapshot.contributions[0]?.operations.step;
                        if (!operation) throw new Error('Missing installed public step role');
                        await context.services.actions.executeAdmittedTargetedOperation(operation, {});
                    } finally { observation.dispose(); }
                    return null;
                }
                const signal = abortRequests ? AbortSignal.abort() : undefined;
                results.push(await context.services.interactions.requestApproval({ kind: 'approval', title: 'Perform internal step',
                    subject: { kind: 'tool', name: 'Bash', input: { command: 'internal-step' } }, allowSessionPersistence: false }, { signal }));
                results.push(await context.services.interactions.confirm({ kind: 'confirmation', title: 'Continue internal step', message: 'Continue?' }, { signal }));
                results.push(await context.services.interactions.askQuestions({ kind: 'questions', title: 'Required input',
                    questions: [{ id: 'password', type: 'text', prompt: 'OS password', required: true }] }, { signal }));
                return null;
            } }, scalar: { title: 'Scalar internal step', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli', 'plugin'],
                inputSchema: { type: 'string' }, run: async (input, context) => {
                    if (typeof input !== 'string') throw new Error('The scalar target did not receive its admitted string');
                    scalarInputs.push(input);
                    results.push(await context.services.interactions.confirm({ kind: 'confirmation', title: 'Scalar step', message: 'Continue?' }));
                    return null;
                } }, omitted: { title: 'No-input internal step', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli', 'plugin'],
                run: async (input, context) => {
                    omittedInputs.push(input);
                    results.push(await context.services.interactions.confirm({ kind: 'confirmation', title: 'No-input step', message: 'Continue?' }));
                    return null;
                } }, defaulted: { title: 'Defaulted internal step', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli', 'plugin'],
                inputSchema: defaultedSchema, run: async (input, context) => {
                    defaultedInputs.push(input);
                    results.push(await context.services.interactions.confirm({ kind: 'confirmation', title: 'Defaulted step', message: 'Continue?' }));
                    return null;
                } } } });
    let targetedEffects = 0;
    const source = definePlugin({ id: 'example.parent-consent-source', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        actions: { step: { title: 'Contributed internal step', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: stepInput,
            resultSchema: defineProtocolLiteral(null), run: async (_input, context) => {
                targetedEffects++;
                results.push(await context.services.interactions.confirm({ kind: 'confirmation', title: 'Contributed step', message: 'Continue?' }));
                return null;
            } } }, contributesTo: { [action.pluginId]: { steps: {
                source: stepProtocol.contribute({ operations: { step: stepProtocol.operations.step.bind('step') } }),
            } } },
    });
    const home = fastify();
    // No accidental test invocation reaches a developer's Home. An unexpected
    // network requirement fails at this transport boundary, with owners real.
    home.all('/*', async (_request, reply) => reply.code(503).send({ error: 'unsupported_fixture_transport' }));
    const origin = 'http://plugin-parent-consent.test';
    const restoreTransport = installAxiosFastifyAdapter({ app: home, origin });
    const runtime = await runWithServerHttpBaseUrl(origin, () => createAuthoredAdmittedPluginRuntimeFixture({ plugins: [plugin, source].map(authored => ({ manifest: authored.manifest,
        files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: authored.activate }) })),
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
        ...(nestedInput || nestedTargeted ? { runtimeOptions: {
            scopedActionRuntime: { credentials: { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'parent-consent-account' })).toString('base64url')}.fixture`, encryption: null },
                actionsSettingsProvider: createActionSettingsProvider({ accountSettings }) },
            resolveCurrentMachineId: () => 'machine',
            resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: 'srv_parent-consent' }),
        } } : {}),
    })).catch(async error => {
        controller.abort(); unbind(); restoreTransport(); await home.close(); throw error;
    });
    const context = { surface: 'cli' as const, defaultSessionId: session.sessionId, signal: controller.signal,
        authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
        runtimeAccountId: 'parent-consent-account', serverId: configuration.activeServerId, serverIdentityId: 'srv_parent-consent',
        ...(profile ? { approvalProfileId: profile.id, approvalProfile: { profile,
            resolution: { status: 'available' as const, requestedId: profile.id } } } : {}) };
    const parent = { actionId: 'machines.setup.apply', input: MachineSetupApplyInputV1Schema.parse({
        homeId: configuration.activeServerId, machineId: 'machine',
        targets: [{ homeId: configuration.activeServerId, machineId: 'machine',
            sources: [{ kind: 'direct', setup: {} }], desiredRevision: 0, recipePlans: [] }],
    }) };
    const invoke = (reviewed: boolean) => {
        const execute = (approvalContext?: import('@happier-dev/protocol').ActionExecutorContext) => executeContributedAction({
            runtimeRegistry: runtime.registry, actionId: `${action.pluginId}/${action.localId}`, input: {}, context,
            ...(approvalContext || approvalProfile ? { approvalContext: approvalContext ?? context } : {}),
        });
        return runWithServerHttpBaseUrl(origin, () => reviewed ? invokeHostReviewedChildV1({
            parent,
            context, child: { action, role: 'setup', input: {} },
            admittedReview: { action, role: 'setup', surface: context.surface },
            execute: async (_input, childContext) => { const result = await execute(childContext);
                return result.matched ? result.result : { ok: false, errorCode: 'not_matched', error: 'not_matched' }; },
        }) : execute());
    };
    const requests = () => Object.entries(session.__getAgentState().requests ?? {});
    const list = createCommittedContributedActionDefinitionLister({
        tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: runtime.controller }),
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
        invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => runtime.controller.acquireRuntimeRegistry() }),
    });
    const invokeScalarChild = () => runWithServerHttpBaseUrl(origin, () => invokeHostReviewedChildV1({
        parent, context,
        child: { action: { pluginId: action.pluginId, localId: 'scalar' }, role: 'actions.execute', input: 'requested-scalar' },
        admittedReview: { action: { pluginId: action.pluginId, localId: 'scalar' }, role: 'actions.execute', surface: context.surface },
        execute: (input, childContext, actionId) => executor.execute(actionId, input, childContext),
    }));
    const invokeOmittedChild = () => runWithServerHttpBaseUrl(origin, () => invokeHostReviewedChildV1({
        parent, context,
        child: { action: 'action.invoke', role: 'actions.execute', input: { action: { pluginId: action.pluginId, localId: 'omitted' } } },
        admittedReview: { action: 'action.invoke', role: 'actions.execute', surface: context.surface },
        execute: (input, childContext, actionId) => executor.execute(actionId, input, childContext),
    }));
    const invokeDefaultedChild = () => runWithServerHttpBaseUrl(origin, () => invokeHostReviewedChildV1({
        parent, context,
        child: { action: { pluginId: action.pluginId, localId: 'defaulted' }, role: 'actions.execute', input: {} },
        admittedReview: { action: { pluginId: action.pluginId, localId: 'defaulted' }, role: 'actions.execute', surface: context.surface },
        execute: (input, childContext, actionId) => executor.execute(actionId, input, childContext),
    }));
    const answer = async (response: Record<string, JsonValue>, kind: 'user_action' | 'permission' = 'user_action') => {
        const respond = rpc.handlers.get(kind === 'user_action' ? 'session.user_action.answer' : 'session.permission.respond');
        if (!respond) throw new Error('Missing real Session permission response entry');
        await respond(response);
    };
    return { results, scalarInputs, omittedInputs, defaultedInputs, requests, answer, invoke, invokeScalarChild, invokeOmittedChild, invokeDefaultedChild,
        targetedEffects: () => targetedEffects,
        async dispose() { controller.abort(); unbind(); try { await runtime.dispose(); }
            finally { restoreTransport(); await handler.abortPendingRequestsAndFlush('test cleanup');
                await session.close(); await home.close(); } } };
}

describe('plugin steps of a reviewed parent operation', () => {
    it.each(['child-ask', 'parent-ask'] as const)('applies the bound %s profile through real contributed dispatch', async approvalProfile => {
        const f = await fixture({ bindSession: false, nestedInput: 'scalar', approvalProfile });
        try {
            await expect(f.invoke(false)).resolves.toMatchObject({ matched: true, result: {
                ok: false, errorCode: 'plugin_action_current_intent_unavailable',
            } });
            expect(f.scalarInputs).toEqual([]);
        } finally { await f.dispose(); }
    });

    it.each(['child-ask', 'parent-ask', 'allow'] as const)('retains host-issued reviewed consent with the bound %s profile', async approvalProfile => {
        const f = await fixture({ bindSession: false, nestedInput: 'scalar', approvalProfile });
        try {
            const result = await f.invoke(true);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
            expect(f.scalarInputs).toEqual(['requested-scalar']);
            expect(f.results).toEqual([{ requestId: expect.any(String), kind: 'confirmation', status: 'approved' }]);
        } finally { await f.dispose(); }
    });

    it('keeps safe contributed Actions available under an allow profile', async () => {
        const f = await fixture({ bindSession: false, nestedInput: 'scalar', approvalProfile: 'allow' });
        try {
            await expect(f.invoke(false)).resolves.toMatchObject({ matched: true, result: { ok: true } });
            expect(f.scalarInputs).toEqual(['requested-scalar']);
        } finally { await f.dispose(); }
    });

    it('inherits consent through real contributed dispatch, but still asks for required input', async () => {
        const f = await fixture();
        const execution = f.invoke(true);
        try {
            await vi.waitFor(() => expect(f.requests().length > 0 || f.results.length > 0).toBe(true));
            expect(f.requests().map(([, request]) => request.tool)).not.toContain('Bash');
            expect(f.results.slice(0, 2)).toEqual([
                { requestId: expect.any(String), kind: 'approval', status: 'approved', persistence: 'once' },
                { requestId: expect.any(String), kind: 'confirmation', status: 'approved' },
            ]);
            await vi.waitFor(() => expect(f.requests()).toHaveLength(1));
            const [id] = f.requests()[0]!;
            await f.answer({ id, approved: true, answers: { password: ['fixture-only-password'] } });
            await expect(execution).resolves.toMatchObject({ ok: true });
            expect(f.results[2]).toMatchObject({ kind: 'questions', status: 'answered',
                answers: { password: { kind: 'text', value: 'fixture-only-password' } } });
        } finally { await f.dispose(); await execution; }
    });

    it('keeps ordinary unconfirmed plugin approval and confirmation requests interactive', async () => {
        const f = await fixture();
        const execution = f.invoke(false);
        try {
            await vi.waitFor(() => expect(f.requests()).toHaveLength(1));
            const approvalId = f.requests()[0]![0];
            await f.answer({ id: approvalId, approved: true, decision: 'approved' }, 'permission');
            await vi.waitFor(() => expect(f.results).toHaveLength(1));
            await vi.waitFor(() => {
                expect(f.requests()).toHaveLength(1);
                expect(f.requests()[0]![0]).not.toBe(approvalId);
                expect(f.requests()[0]![1].tool).toBe('AskUserQuestion');
            });
            await f.answer({ id: f.requests()[0]![0], approved: true, answers: { confirmation: ['confirm'] } });
            await vi.waitFor(() => expect(f.results).toHaveLength(2));
            expect(f.results.map(result => result.status)).toEqual(['approved', 'approved']);
        } finally { await f.dispose(); await execution; }
    });

    it('retains per-request cancellation inside an admitted parent operation', async () => {
        const f = await fixture({ abortRequests: true });
        try {
            await expect(f.invoke(true)).resolves.toMatchObject({ ok: true });
            expect(f.results.map(result => result.status)).toEqual(['requesterAborted', 'requesterAborted', 'requesterAborted']);
            expect(f.requests()).toEqual([]);
        } finally { await f.dispose(); }
    });

    it('does not require a Session for affirmative inherited consent', async () => {
        const f = await fixture({ bindSession: false });
        try {
            await expect(f.invoke(true)).resolves.toMatchObject({ ok: true });
            expect(f.results.map(result => result.status)).toEqual(['approved', 'approved', 'unavailable']);
            expect(f.requests()).toEqual([]);
        } finally { await f.dispose(); }
    });

    it('preserves scalar input through a nested authored Action of the confirmed operation', async () => {
        const f = await fixture({ bindSession: false, nestedInput: 'scalar' });
        try {
            await expect(f.invoke(true)).resolves.toMatchObject({ ok: true });
            expect(f.scalarInputs).toEqual(['requested-scalar']);
            expect(f.results).toEqual([{ requestId: expect.any(String), kind: 'confirmation', status: 'approved' }]);
        } finally { await f.dispose(); }
    });

    it('admits a real scalar contributed Action through the sole reviewed-child issuer', async () => {
        const f = await fixture({ bindSession: false });
        try {
            const result = await f.invokeScalarChild();
            expect('errorCode' in result ? result.errorCode : null).toBeNull();
            expect(result).toMatchObject({ ok: true });
            expect(f.scalarInputs).toEqual(['requested-scalar']);
        } finally { await f.dispose(); }
    });

    it.each(['omitted', 'defaulted'] as const)('preserves %s input through a nested authored Action of the confirmed operation', async nestedInput => {
        const f = await fixture({ bindSession: false, nestedInput, requireNestedApproval: true });
        try {
            await expect(f.invoke(true)).resolves.toMatchObject({ ok: true });
            expect(nestedInput === 'omitted' ? f.omittedInputs : f.defaultedInputs)
                .toEqual(nestedInput === 'omitted' ? [null] : [{ mode: 'target-default' }]);
            expect(f.results).toEqual([{ requestId: expect.any(String), kind: 'confirmation', status: 'approved' }]);
        } finally { await f.dispose(); }
    });

    it.each(['omitted', 'defaulted'] as const)('admits a real %s contributed Action through the sole reviewed-child issuer', async inputKind => {
        const f = await fixture({ bindSession: false, requireNestedApproval: true, approvalTarget: inputKind });
        try {
            const result = await (inputKind === 'omitted' ? f.invokeOmittedChild() : f.invokeDefaultedChild());
            expect('errorCode' in result ? result.errorCode : null).toBeNull();
            expect(result).toMatchObject({ ok: true });
            expect(inputKind === 'omitted' ? f.omittedInputs : f.defaultedInputs)
                .toEqual(inputKind === 'omitted' ? [null] : [{ mode: 'target-default' }]);
        } finally { await f.dispose(); }
    });

    it('answers internal child policy with the confirmed parent operation', async () => {
        const f = await fixture({ bindSession: false, nestedInput: 'scalar', requireNestedApproval: true });
        try {
            await expect(f.invoke(true)).resolves.toMatchObject({ ok: true });
            expect(f.scalarInputs).toEqual(['requested-scalar']);
            expect(f.results).toEqual([{ requestId: expect.any(String), kind: 'confirmation', status: 'approved' }]);
        } finally { await f.dispose(); }
    });

    it('retains explicit child Ask for an ordinary unconfirmed plugin invocation', async () => {
        const f = await fixture({ bindSession: false, nestedInput: 'scalar', requireNestedApproval: true });
        const execution = f.invoke(false);
        try {
            await expect(execution).resolves.toMatchObject({ matched: true, result: {
                ok: false, errorCode: 'plugin_action_current_intent_unavailable',
            } });
            expect(f.scalarInputs).toEqual([]);
        } finally { await f.dispose(); }
    });

    it.each([true, false])('retains original targeted-role custody while inheriting only confirmed parent consent (reviewed=%s)', async reviewed => {
        const f = await fixture({ bindSession: false, nestedTargeted: true, requireNestedApproval: true });
        try {
            const result = await f.invoke(reviewed);
            expect(result).toMatchObject(reviewed ? { ok: true } : { matched: true, result: {
                ok: false, errorCode: 'plugin_action_current_intent_unavailable',
            } });
            expect(f.targetedEffects()).toBe(reviewed ? 1 : 0);
            expect(f.results).toEqual(reviewed
                ? [{ requestId: expect.any(String), kind: 'confirmation', status: 'approved' }] : []);
        } finally { await f.dispose(); }
    });
});
