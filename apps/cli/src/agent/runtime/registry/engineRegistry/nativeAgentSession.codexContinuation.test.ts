import { describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { MessageQueue2 } from '../../modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '../../permissions/queuedPrompt';
import { runPermissionModePromptLoop } from '../../runPermissionModePromptLoop';
import { createSessionProviderInputConsumer } from '../../session/input/sessionProviderInputConsumer';
import { createSessionProviderInputConsumerSessionAdapter } from '../../waitForNextPermissionModeMessage';
import { PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/codex/src/manifest';
import { createCodexAgentRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/engine';
import { withCodexNativeAttachFixture } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import {
    createExternalContributionFixtures,
    createLease,
    createNativeAgentRuntimeSessionPlanFixture,
    createNativeSessionClientTestPort,
    createSessionHostServiceOwners,
} from './nativeAgentSession.testkit';

// OS user-home discovery is a genuine boundary. Keep startup locks off the
// developer's live native-client lock while retaining the real lock owner.
const osBoundary = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: osBoundary.home || actual.userInfo().homedir }) };
});

describe('native Codex continuation startup settlement', () => {
    it('revises a retained daemon thread through native developer history with prefix-free input', async () => {
        const lifetime = new AbortController();
        onTestFinished(() => { lifetime.abort(); osBoundary.home = ''; });
        await withCodexNativeAttachFixture(async fixture => {
            osBoundary.home = fixture.directory;
            const contributions = createExternalContributionFixtures('acme-codex-startup-fixture');
            const admitted = ingestPluginManifestV2(PLUGIN_MANIFEST);
            if (!admitted.ok) throw new Error('Invalid Codex manifest');
            const declaredAgent = admitted.manifest.contributes.agents[0];
            if (!declaredAgent || !('primary' in declaredAgent) || declaredAgent.primary !== 'sessions') throw new Error('Missing Codex Session Agent');
            const runtime = await createCodexAgentRuntime({
                plugin: { id: 'happier.agent.codex', version: '0.0.0' },
                agent: { id: 'codex' }, signal: lifetime.signal,
            });
            const sessionInput = buildPluginSessionBindingInput({
                credentials: { token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
                directory: fixture.directory, resume: 'retained-thread',
                resolveLateEnvironment: async () => ({ environmentVariables: fixture.launchEnvironment.values,
                    unsetEnvironmentVariables: [], sensitiveEnvironmentVariableNames: [] }),
            });
            const plan = await createNativeAgentRuntimeSessionPlanFixture({
                generationSignal: lifetime.signal, runtime, lease: createLease(contributions.agent.id),
                backend: contributions.backend,
                agent: { ...contributions.agent, richDefinition: {
                    ...contributions.agent.richDefinition, definition: {
                        ...contributions.agent.richDefinition.definition, capabilities: declaredAgent.capabilities,
                    },
                } },
                sessionInput: { ...sessionInput, bootstrap: { ...sessionInput.bootstrap,
                    runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {
                        backendMode: 'appServer', providerSessionId: 'retained-thread', appServerTransport: 'daemonProxy',
                    } },
                } },
                createSessionHostServiceOwners,
                createInvocationServices: async () => ({ ...createUnavailablePluginServices(), exec: fixture.exec,
                    logger: { debug() {}, info() {}, error() {}, warn() {}, diagnostic() {} } }),
            });
            const session = createMutableApiSessionClientFixture({ sessionId: 'codex-startup-session',
                metadata: createTestMetadata({ path: fixture.directory, permissionMode: 'default', permissionModeUpdatedAt: 0 }),
                overrides: { readSessionTurnsProjection: async () => null } });
            // Only the Session persistence boundary admits input; host/native logic stays real.
            session.reconcileSessionInputForProviderDispatch = async () => 'admitted';
            const permission = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Codex startup fixture]' });
            let currentPlan = 'PLAN_V3';
            const created = await plan.config.createSessionRuntime({
                directory: fixture.directory, metadata: {}, machineId: 'machine-fixture', session,
                transcriptSession: session, messageBuffer: {}, mcpServers: {}, permissionHandler: permission,
                getPermissionMode: () => 'default', setThinking() {}, memoryRecallGuidanceEnabled: false,
                resolveFreshSessionSystemPrompt: async () => currentPlan,
            } as never);
            try {
                expect(created.operations.readSessionStartupInstructionsSupport?.()).toBe(true);
                expect(created.operations.readSessionStartupInstructions?.()?.instructions).toBe('PLAN_V3');
                const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => mode.permissionMode,
                    { batcher: combinePermissionModeQueuedPrompts });
                const inputConsumer = createSessionProviderInputConsumer({ messageQueue: queue,
                    session: createSessionProviderInputConsumerSessionAdapter(session) });
                const accepted = new Map<string, (() => void) | null>();
                created.nativeRuntime?.setOnPromptDeliveryOutcome(outcome => {
                    if (outcome.type === 'input-accepted') {
                        accepted.get('localInputId' in outcome ? outcome.localInputId : outcome.localId)?.();
                    }
                });
                const turns = [{ text: 'apply V3', plan: 'PLAN_V3' }, { text: 'apply V4', plan: 'PLAN_V4' },
                    { text: 'unchanged V4', plan: 'PLAN_V4' }];
                let index = 0;
                const enqueue = () => queue.push({ text: turns[index]!.text, localId: `input-${index}`, userMessageSeq: index + 1,
                    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' } },
                { permissionMode: 'default' });
                enqueue();
                const failures: unknown[] = [];
                await runPermissionModePromptLoop({
                    providerName: 'Codex', agentMessageType: 'qwen', explicitPermissionMode: undefined,
                    session, messageQueue: queue, inputConsumer, permissionHandler: permission, runtime: created.operations,
                    createOverrideSynchronizer: () => ({ syncFromMetadata() {}, async flushPendingAfterStart() {} }),
                    messageBuffer: new MessageBuffer(), shouldExit: () => index === turns.length,
                    getAbortSignal: () => lifetime.signal, keepAlive() {}, setThinking() {},
                    sendReady: () => { index += 1; if (index < turns.length) { currentPlan = turns[index]!.plan; enqueue(); } },
                    currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {},
                    initialResumeId: 'retained-thread', resolveFreshSessionSystemPrompt: async () => currentPlan,
                    readSessionPromptPlanDeliveryState: () => ({
                        startupInstructionsSupported: declaredAgent.capabilities.sessions.startupInstructions?.versions.includes(1) === true,
                        revisionChanges: declaredAgent.capabilities.sessions.startupInstructions?.revisionChanges,
                    }),
                    registerProviderAcceptedEffect: (localId, effect) => { accepted.set(localId, effect); },
                    onPromptFailure: error => { failures.push(error); }, formatPromptErrorMessage: String,
                });
                expect(failures).toEqual([]);
                expect(fixture.requests.filter(request => request.method === 'turn/start').map(request => request.params.input))
                    .toEqual(['apply V3', 'apply V4', 'unchanged V4']
                        .map(text => [expect.objectContaining({ type: 'text', text })]));
                const resumes = fixture.requests.filter(request => request.method === 'thread/resume');
                expect(resumes).toHaveLength(2);
                const injections = fixture.requests.filter(request => request.method === 'thread/inject_items');
                expect(injections).toHaveLength(2);
                expect(injections.map(request => request.params.items)).toEqual(['PLAN_V3', 'PLAN_V4'].map(text => [{
                    type: 'message', role: 'developer', content: [{ type: 'input_text', text: expect.stringContaining(text) }],
                }]));
                expect(fixture.nativeLaunches).toEqual([]);
            } finally {
                await created.operations.resetOrDisposeRuntime();
                await permission.reset();
            }
        }, { onTurnStart: ({ socket, params, turnId }) => {
            socket.send(JSON.stringify({ method: 'turn/completed', params: {
                threadId: params.threadId, turn: { id: turnId, status: 'completed' },
            } }));
        } });
    });

    it.each(['silent', 'rejected'] as const)('settles %s thread/read through real native-open before input admission', async mode => {
        let stage = 'fixture_setup';
        const methods: string[] = [];
        const diagnostics: { code: string; details: unknown }[] = [];
        const lifetime = new AbortController();
        onTestFinished(() => { lifetime.abort(); osBoundary.home = ''; });
        onTestFailed(() => {
            lifetime.abort();
            console.error('Native startup boundary evidence', { stage, methods, codes: diagnostics.map(item => item.code) });
        });
        await withCodexNativeAttachFixture(async fixture => {
            osBoundary.home = fixture.directory;
            stage = 'runtime_plan';
            if (mode === 'rejected') fixture.failRead();
            const agentId = 'acme-codex-startup-fixture';
            const contributions = createExternalContributionFixtures(agentId);
            const admittedManifest = ingestPluginManifestV2(PLUGIN_MANIFEST);
            if (!admittedManifest.ok) throw new Error('Codex manifest fixture is invalid');
            const declaredAgent = admittedManifest.manifest.contributes.agents[0];
            if (!declaredAgent || !('primary' in declaredAgent) || declaredAgent.primary !== 'sessions') throw new Error('Codex Session Agent declaration is absent');
            const runtime = await createCodexAgentRuntime({
                plugin: { id: 'happier.agent.codex', version: '0.0.0' },
                agent: { id: 'codex' }, signal: new AbortController().signal,
            });
            const plan = await createNativeAgentRuntimeSessionPlanFixture({
                generationSignal: lifetime.signal,
                runtime, lease: createLease(agentId), backend: contributions.backend,
                agent: { ...contributions.agent, richDefinition: {
                    ...contributions.agent.richDefinition,
                    definition: { ...contributions.agent.richDefinition.definition,
                        capabilities: declaredAgent.capabilities },
                } },
                sessionInput: buildPluginSessionBindingInput({
                    credentials: { token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
                    directory: fixture.directory, backendTarget: { kind: 'backend', backendId: agentId },
                    resume: 'retained-thread',
                    resolveLateEnvironment: async () => ({
                        environmentVariables: { ...fixture.launchEnvironment.values,
                            // Use the existing configurable RPC owner budget.
                            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250' },
                        unsetEnvironmentVariables: [], sensitiveEnvironmentVariableNames: [],
                    }),
                }),
                createSessionHostServiceOwners,
                createInvocationServices: async () => ({ ...createUnavailablePluginServices(), exec: fixture.exec,
                    logger: { diagnostic() {}, debug(code: string) { diagnostics.push({ code, details: undefined }); }, info() {}, error() {}, warn(code: string, details?: unknown) {
                        diagnostics.push({ code, details });
                    } } }),
            });
            stage = 'native_open';
            const opening = plan.config.createSessionRuntime({
                directory: fixture.directory, metadata: {}, machineId: 'machine-fixture',
                session: createNativeSessionClientTestPort('session-fixture'), transcriptSession: {},
                messageBuffer: {}, mcpServers: {}, permissionHandler: {}, getPermissionMode: () => 'default',
                setThinking() {}, memoryRecallGuidanceEnabled: false,
            } as never);
            await expect(opening).rejects.toMatchObject({ name: 'AgentSessionContinuationUnreachableError' });
            stage = 'refusal_assertions';
            expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'codex_continuation_unreachable' }));
            if (mode === 'rejected') {
                expect(diagnostics).toContainEqual({ code: 'codex_continuation_unreachable',
                    details: expect.objectContaining({ errorCode: '-32000' }) });
            }
            expect(fixture.requests.some(request => request.method === 'thread/read')).toBe(true);
            expect(fixture.requests.some(request => request.method === 'thread/resume' || request.method === 'turn/start')).toBe(false);
            stage = 'fixture_cleanup';
        }, { ignoreThreadRead: mode === 'silent', observer: {
            recordAppServerRequest(method) { methods.push(method); }, recordLaunch() {},
        } });
    });
});
