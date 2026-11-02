import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { getAgentStaticModels } from '@happier-dev/agents';
import { getActionSpec, ExecutionRunStartRequestSchema, ExecutionRunScmDiffSummaryInputV1Schema, ScmComparisonSchema, PluginManifestV2Schema,
    createActionExecutor, accountSettingsParse, ExecutionRunStartResponseSchema,
    type BackendTargetRefV2, type ScmDiffSummaryGenerateInput } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputAdmissionReceiptV1Schema,
    settleSessionInputRequestV1, settleSessionInputRequestV2, withSessionInputAuthority,
} from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ScmComparisonCaptureOutputSchema, ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';

import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { gitCheckpointAdapter, resolveGitCheckpointBackendContext } from '@/scm/checkpoints/gitCheckpointAdapter';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints/refs';
import { retainRepositoryCheckpointTurnEvidence } from '@/scm/checkpoints/sessionEvidence';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { ScmDiffSummaryProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/ScmDiffSummaryProfile';
import { startExecutionRun } from '@/agent/runtime/bridges/executionRun/startExecutionRun';
import { stopExecutionRun } from '@/agent/runtime/bridges/executionRun/executionRunStop';
import { sendBackendLongLivedRun } from '@/agent/runtime/bridges/executionRun/send/backendLongLivedPrompt';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { executeScmDiffSummaryAction } from './executeScmDiffSummaryAction';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { createEncryptedRpcTestClient } from '@/rpc/handlers/encryptedRpc.testkit';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { logger } from '@/ui/logger';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings, writeDaemonState } from '@/persistence';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { readAppliedParentConnectedServices } from '@/daemon/controlClient';
import { isValidConnectedServiceRunMaterializeToken } from '@/daemon/connectedServices/runs/capabilityToken';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CLAUDE_PLUGIN } from '@happier-dev/plugins-claude/manifest';
import { createExecutionRunHostBackendFromConversationRuntime,
    type AgentRuntime, type AgentExecutionRunConversationEventV1, type AgentSessionSendRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { createMutableApiSessionClientFixture, createSessionRecordFixture, type MutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { ExecutionRunAdmittedPendingInputV1 } from '@/api/session/client/transport/sessionClientInteractionApi';
import { UserMessageSchema } from '@/api/types';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { DurableProviderInputAcceptanceV1 } from '@/agent/runtime/session/input/providerInputOutcome';
import { ExecutionRunListResponseSchema, ExecutionRunStartFailureDetailsV1Schema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createSessionRunReportPolicyReader } from '@/api/sessionFollowCreationPreferences';
import { SessionAutoFollowPreferencesResponseSchema } from '@happier-dev/protocol/sessions/follow/api';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { resolveTrackedSessionRunnerActivity } from '@/daemon/sessionRunnerRuntime/resolveRuntimeState';
import { requestPlannedRunnerRestart } from '@/daemon/plannedRunnerRestart/requestPlannedRunnerRestart';
import type { TrackedSession } from '@/daemon/types';
// Reuse the composed journey's UI platform setup before loading the real producer.
// Runtime URLs keep UI-only platform declarations out of CLI compilation.
await import(new URL('../../../../ui/sources/dev/vitestSetup.ts', import.meta.url).href);
// Keep the real internal glyph owner below the platform boundary, as in the composed journey.
vi.doUnmock(fileURLToPath(new URL('../../../../ui/sources/components/ui/icons/Icon.tsx', import.meta.url)));
type UiGenerationModule = Readonly<{
    createScmDiffSummaryOperations(deps: Readonly<{ actionExecutor: ReturnType<typeof createActionExecutor> }>): Readonly<{
        generateFromUserAction(params: Readonly<{ sessionId: string; backendTarget: BackendTargetRefV2;
            input: ScmDiffSummaryGenerateInput; settings: Readonly<Record<string, unknown>> }>): Promise<Readonly<{ ok: boolean; key: string }>>;
        getState(): Readonly<{ entriesByKey: Readonly<Record<string, Readonly<{ latestOutput: unknown }>>> }>;
    }>;
}>;
// The module loader is the boundary; its request/output below use the real Protocol validators.
const { createScmDiffSummaryOperations }: UiGenerationModule = await import(
    new URL('../../../../ui/sources/sync/ops/scmDiffSummary/generate.ts', import.meta.url).href);

// Model discovery's installation/filesystem boundary uses the canonical publication fixture.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
    return createBundledPluginPublicationFsFixture(actual);
});

describe('SCM generation through real host admission', () => {
    const directories: string[] = [];
    beforeEach(async () => {
        vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
        const home = await mkdtemp(join(tmpdir(), 'scm-admission-home-'));
        directories.push(home);
        vi.stubEnv('HAPPIER_HOME_DIR', home);
        for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) vi.stubEnv(key, home);
        for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) vi.stubEnv(key, undefined);
        const fileName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
        writeExecutableShimSync({ dir: home, fileName, contents: process.platform === 'win32'
            ? '@echo off\r\necho {"loggedIn":false}\r\nexit /b 1\r\n'
            : '#!/bin/sh\nprintf \'{"loggedIn":false}\'\nexit 1\n' });
        vi.stubEnv('HAPPIER_CLAUDE_PATH', join(home, fileName));
        vi.stubEnv('PATH', `${home}${delimiter}${process.env.PATH ?? ''}`);
        reloadConfiguration();
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        reloadConfiguration();
        await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
    });

    describe('registered native Run', () => {
        let nativeRuntime: AgentRuntime | undefined;
        let admitted: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>;
        let realRegistrations: Awaited<ReturnType<typeof createPluginTestkit>>;
        let backendTarget: BackendTargetRefV2;

        // Source admission and physical fixture preparation have no independent
        // cutoff. The Run behavior below retains the normal test-body budget.
        beforeAll(async () => {
            const declaration = PluginManifestV2Schema.parse(JSON.parse(await readFile(
                new URL('../../../assets/bundled-plugin-manifests/claude.json', import.meta.url), 'utf8')));
            // Bundled first-party custody cannot be replaced by an authored callback.
            // Keep the real declaration closed under its own fixture occurrence.
            const fixturePluginId = 'acme.scm-generation';
            realRegistrations = await createPluginTestkit({ manifest: CLAUDE_PLUGIN.manifest,
                module: { activate: CLAUDE_PLUGIN.activate } });
            const realAgent = realRegistrations.registration('agents', 'claude');
            const subscription = realRegistrations.registration('connectedAccountDescriptors', 'claude-subscription');
            const anthropic = realRegistrations.registration('connectedAccountDescriptors', 'anthropic');
            if (!realAgent || !subscription || !anthropic) {
                throw new Error('Real Claude contribution registration fixture is incomplete');
            }
            // Admit real declarations and registrations; only native vendor
            // conversation/catalog I/O is supplied by the boundary fixture.
            admitted = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
                // Record I/O is the persistence boundary; scoped defaults and
                // validation remain the real settings owner.
                runtimeOptions: { accountSettingsRecordAdapter: {
                    async bindOperation() { return {
                        async readRecord() { return { status: 'absent' as const }; },
                        async writeRecord() { throw new Error('Read-only generation must not write Account settings'); },
                    }; },
                } }, plugins: [{
                    manifest: createPluginManifestV2Fixture({ id: fixturePluginId, contributes: {
                        agents: declaration.contributes?.agents,
                        connectedAccountDescriptors: declaration.contributes?.connectedAccountDescriptors,
                        settings: declaration.contributes?.settings,
                        systemTools: declaration.contributes?.systemTools,
                    } }),
                    files: {
                        'agent-runtime.mjs': `export let nativeFixture;
                            export let externalSessions;
                            export function configure(factory, companion) { nativeFixture = factory; externalSessions = companion; }`,
                        'daemon.mjs': `import * as leaf from './agent-runtime.mjs';
                            export function activate() {}
                            export function createActivationUnitModule(factory, agent, accounts, models) {
                                leaf.configure(factory, agent.externalSessions);
                                return { activate(api) {
                                    api.agents.register('claude', leaf.nativeFixture, {
                                        cliAuth: agent.cliAuth,
                                        preflightSessionControls: { probeModels: models },
                                        sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'nativeFixture',
                                            runtimeApiVersion: 1, externalSessionsExport: 'externalSessions' }
                                    });
                                    api.agents.registerTerminal('claude', agent.terminal);
                                    api.agents.registerExternalSessions('claude', leaf.externalSessions);
                                    api.connectedAccounts.register('claude-subscription', accounts.subscription);
                                    api.connectedAccounts.register('anthropic', accounts.anthropic);
                                } };
                            }`,
                    },
                    instantiateCommittedModule: module => {
                        const configure = module.createActivationUnitModule;
                        if (typeof configure !== 'function') throw new Error('Authored activation unit factory is unavailable');
                        // The admitted factory owns one runtime for its occurrence.
                        // Dispatch vendor I/O to the current case without replacing that runtime.
                        const nativeBoundary: AgentRuntime = { sessions: {
                            open: (request, context) => {
                                if (!nativeRuntime?.sessions) throw new Error('Native runtime may open only in the behavior test');
                                return nativeRuntime.sessions.open(request, context);
                            },
                            executionRunContextV1: { open: (request, context) => {
                                const sessions = nativeRuntime?.sessions;
                                if (!sessions?.executionRunContextV1) throw new Error('Native Run context fixture is unavailable');
                                return sessions.executionRunContextV1.open(request, context);
                            } },
                        } };
                        const configured: unknown = configure(() => nativeBoundary, realAgent,
                            { subscription, anthropic }, () => getAgentStaticModels('claude', { catalogOnly: true }));
                        if (!configured || typeof configured !== 'object' || !('activate' in configured)) {
                            throw new Error('Authored activation unit did not return its module');
                        }
                        // Physical module boundary, not callback byte-integrity evidence.
                        return configured as PluginDaemonModuleNamespace;
                    },
                }] });
            const agent = [...admitted.registry.contributes.agentDefinitionsById.values()]
                .find(candidate => candidate.identity?.pluginId === fixturePluginId && candidate.identity.localId === 'claude');
            if (!agent) throw new Error('Admitted native Agent declaration is missing');
            // Match the Action producer's retained routing shape from Q10B-GEN.
            backendTarget = { kind: 'backend', backendId: agent.id, sourceKind: 'built_in' };
        }, 0);
        afterAll(async () => {
            try { await admitted?.dispose(); } finally { await realRegistrations?.dispose(); }
        }, 0);

        it.each([
            { investigateSurroundingFiles: false, parentAvailable: true, automaticModel: false },
            { investigateSurroundingFiles: true, parentAvailable: true, automaticModel: false },
            { investigateSurroundingFiles: false, parentAvailable: false, automaticModel: false },
            { investigateSurroundingFiles: false, parentAvailable: true, automaticModel: true },
            { investigateSurroundingFiles: false, parentAvailable: false, automaticModel: true },
        ].map(config => ({ ...config, disabledOnly: false, credentialedMachine: false })).concat([
            { investigateSurroundingFiles: false, parentAvailable: true, automaticModel: false, disabledOnly: true, credentialedMachine: false },
            { investigateSurroundingFiles: false, parentAvailable: true, automaticModel: false, disabledOnly: false, credentialedMachine: true },
        ]))('admits UI commit generation with investigation $investigateSurroundingFiles, applied parent $parentAvailable, automatic model $automaticModel, disabled-only $disabledOnly and credentialed Machine $credentialedMachine through the registered Run RPC', async ({ investigateSurroundingFiles, parentAvailable, automaticModel, disabledOnly, credentialedMachine }) => {
            const logObservation = vi.spyOn(logger, 'infoFile');
            onTestFinished(() => logObservation.mockRestore());
            const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-session-rpc-' });
            directories.push(fixture.rootPath);
            await writeFile(join(fixture.rootPath, 'surrounding.txt'), 'Captured surrounding context\n');
            runScmExecutable(fixture.rootPath, 'git', ['add', '--', 'surrounding.txt']);
            runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'test: captured surrounding file']);
            await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Pending change\n');
            const sessionId = `c${randomUUID().replaceAll('-', '').slice(0, 24)}`;
            const models = getAgentStaticModels('claude', { catalogOnly: true });
            const modelId = models.find(model => model.id === 'claude-haiku-4-5')?.id;
            if (!modelId) throw new Error('Native structured model fixture is unavailable');
            let manager: ExecutionRunHostBridge | undefined;
            let observedModel: string | undefined;
            let forbidParentSelectionReads = false;
            let forbiddenParentSelectionReads = 0;
            const observedPrompts: string[] = [];
            const reservedPromptEchoes: string[] = [];
            const promptEchoReservedBeforeAcceptance: boolean[] = [];
            let notifyNativePromptReservationStarted!: () => void;
            const nativePromptReservationStarted = new Promise<void>(resolve => { notifyNativePromptReservationStarted = resolve; });
            const observedPermissions: Array<{ read: string; write: string }> = [];
            const observedSnapshots: Array<{ directory: string; before: string | null; after: string | null }> = [];
            let checkPermissions: (() => Promise<void>) | undefined;
            const machineId = 'fixture-machine';
            const accountId = 'scm-generation-account';
            const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
            const controlToken = 'scm-generation-daemon-fixture';
            const admissionDrain = createDaemonAdmissionDrain();
            const parentRegistry = new ConnectedServiceRuntimeRegistry();
            if (parentAvailable) parentRegistry.registerTarget({ pid: process.pid, sessionId, agentId: 'claude',
                connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {} } });
            // Run registration's real HTTP client reaches the real daemon routes,
            // strict schemas, scoped-token verifier and lifecycle admission owner.
            const daemon = createDaemonControlApp({ machineId, controlToken, admissionDrain, getChildren: () => [],
                stopSession: async () => { throw new Error('Generation cannot stop Sessions'); },
                spawnSession: async () => { throw new Error('Generation cannot spawn Sessions'); },
                requestShutdown: () => { throw new Error('Generation cannot shut down the daemon'); },
                onHappySessionWebhook: () => {},
                verifyRunMaterializeToken: provided => isValidConnectedServiceRunMaterializeToken(provided, controlToken),
                readAppliedSessionConnectedServices: input => parentRegistry.readAppliedSessionBindings(input),
            });
            const http = createServer((request, response) => {
                const path = new URL(request.url ?? '/', 'http://fixture.test').pathname;
                const data = path === `/v2/sessions/${sessionId}`
                    ? { session: createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain', machineId,
                        metadata: JSON.stringify({ path: fixture.rootPath,
                            runtimeDescriptorV1: { v: 1, agentId: backendTarget.backendId, agent: {} } }), share: null }) }
                    : path === '/v1/account/encryption/currentness'
                        ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
                        : path === '/v2/account/session-follow-preferences'
                            ? SessionAutoFollowPreferencesResponseSchema.parse({ assigned: true, direct: false, team: false, group: false,
                                managerPolicy: { preset: 'important' }, runReportPolicy: { preset: 'important' },
                                discussionReceivePolicy: { preset: 'important' } })
                        : undefined;
                response.writeHead(data ? 200 : 404, { 'content-type': 'application/json' });
                response.end(JSON.stringify(data ?? { error: 'not_found' }));
            });
            const sockets = new Server(http, { path: '/v1/updates/' });
            try {
                await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
                const address = http.address();
                if (!address || typeof address === 'string') throw new Error('SCM transport fixture did not listen');
                const serverUrl = `http://127.0.0.1:${address.port}`;
                vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', configuration.activeServerId);
                vi.stubEnv('HAPPIER_SERVER_URL', serverUrl);
                reloadConfiguration();
                await daemon.listen({ port: 0, host: '127.0.0.1' });
                const daemonAddress = daemon.server.address();
                if (!daemonAddress || typeof daemonAddress === 'string') throw new Error('Daemon fixture did not listen');
                writeDaemonState({ pid: process.pid, httpPort: daemonAddress.port, controlToken, startedAt: Date.now(),
                    startedWithCliVersion: 'test' });
                await updateSettings(settings => ({ ...settings,
                    machineIdByServerId: { ...settings.machineIdByServerId, [configuration.activeServerId]: machineId } }));
                const machineDependencies = { token, credentials: { token, encryption: null },
                    sessionId: '', mode: 'plain', ctx: null, serverId: configuration.activeServerId, serverHttpBaseUrl: serverUrl,
                    scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] },
                    machineActionDirectTargetTransport: { machineId, invoke: async (method: string) => {
                        if (method !== 'capabilities.detect') throw new Error(`Unexpected Machine transport method: ${method}`);
                        return { protocolVersion: 1, results: { 'tool.executionRuns': { ok: true, data: {
                        available: true, protocolVersion: 2, features: { startAndWait: true, exactInputResults: true, runScopedAgentBindings: true },
                        } } } };
                    } },
                } satisfies Parameters<typeof createCliActionDeps>[0];
                const machineExecutor = credentialedMachine
                    ? createCliActionExecutorFromCredentials({ ...machineDependencies, serverApiUrl: serverUrl,
                        serverIdentityId: 'scm-fixture-home',
                        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }) })
                    : createActionExecutor(createCliActionDeps(machineDependencies));
                const machine = createEncryptedRpcTestClient({ scopePrefix: machineId, callerAuthority: 'account_automation',
                    registerHandlers: rpc => registerScmHandlers(rpc, fixture.rootPath, { machineId,
                        accessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] }, actionExecutor: machineExecutor }) });
                const capturedResponse = await machine.call('scm.diffSummary.capture', {
                    cwd: fixture.rootPath, source: { kind: 'workingTree' }, sessionId,
                });
                expect(capturedResponse).toMatchObject({ success: true });
                const capture = ScmComparisonCaptureOutputSchema.parse(capturedResponse);
                if (!capture.success) throw new Error('Authenticated Machine capture refused the Session scope');
                await writeFile(join(fixture.rootPath, 'surrounding.txt'), 'Later live content\n');
                const captured = { comparison: capture.comparison };
                const aliases = captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.alias));
                const createNativeConversation = () => {
                    const listeners = new Set<(event: AgentExecutionRunConversationEventV1) => void>();
                    const emit = (event: AgentExecutionRunConversationEventV1) => {
                        for (const listener of listeners) listener(event);
                    };
                    const accepted = new Set<string>();
                    const accept = (input: AgentSessionSendRequest) => {
                        if (accepted.has(input.inputIds[0]!)) return;
                        accepted.add(input.inputIds[0]!);
                        emit({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                    };
                    return {
                        accept,
                        watch(listener: (event: AgentExecutionRunConversationEventV1) => void) {
                            listeners.add(listener); emit({ kind: 'provider-session-id', providerSessionId: 'native-model-fixture' });
                            return { dispose() { listeners.delete(listener); } }; },
                        async send(input: AgentSessionSendRequest) {
                            const turnId = input.delivery.turnId;
                            accept(input);
                            emit({ kind: 'turn-start', turnId, startedBy: 'host' });
                            await checkPermissions?.();
                            emit({ kind: 'message-delta', turnId, channel: 'assistant', text: JSON.stringify({
                                walkthrough: { title: 'Pending changes', intro: '',
                                    stops: [{ id: 'stop', title: 'Change', explanationMarkdown: 'Pending edit.', changeRefs: aliases }], otherChangeRefs: [] },
                                commitPlan: { groups: [{ id: 'group', message: 'fix: pending edit', rationale: 'Pending change.', changeRefs: aliases }], leftOutChangeRefs: [] },
                            }) });
                            emit({ kind: 'turn-complete', turnId });
                            return { status: 'admitted' as const };
                        },
                        async cancel({ turnId }: { turnId: string }) { emit({ kind: 'turn-cancelled', turnId, cause: 'user' }); return { status: 'requested' as const, turnId }; },
                        async dispose() { listeners.clear(); },
                    };
                };
                nativeRuntime = { sessions: {
                    async open(request, context) {
                        // Attached Runs retain the actual parent Session's identity.
                        expect(request.sessionId).toBe(sessionId);
                        observedModel = request.configuration?.model.value ?? undefined;
                        if (investigateSurroundingFiles) {
                            observedSnapshots.push({ directory: request.cwd,
                                after: await readFile(join(request.cwd, 'surrounding.txt'), 'utf8').catch(() => null),
                                before: await readFile(join(request.cwd, '..', 'before', 'surrounding.txt'), 'utf8').catch(() => null) });
                        }
                        checkPermissions = async () => {
                            const read = await context.services.interactions.requestApproval({ kind: 'approval', title: 'Read captured context',
                                subject: { kind: 'tool', name: 'Read', input: { file_path: join(request.cwd, 'surrounding.txt') } } });
                            const write = await context.services.interactions.requestApproval({ kind: 'approval', title: 'Edit captured context',
                                subject: { kind: 'tool', name: 'Edit', input: { file_path: join(request.cwd, 'surrounding.txt'), old_string: 'Captured', new_string: 'Changed' } } });
                            if (write.status === 'approved') await writeFile(join(request.cwd, 'surrounding.txt'), 'Changed by approved native tool\n');
                            observedPermissions.push({ read: read.status, write: write.status });
                        };
                        const conversation = createNativeConversation();
                        let sequence = 0;
                        return { ...conversation,
                            async send(input) {
                                notifyNativePromptReservationStarted();
                                // The real Claude SDK reserves its content-free native
                                // user echo before provider transport can accept input.
                                // Keep that host service in this composed production path.
                                let forcedAcceptance = false;
                                // The Session transport here commits synchronously. If
                                // the host waits for provider acceptance, release that
                                // external boundary next cycle so RED can clean up.
                                const release = setImmediate(() => { forcedAcceptance = true; conversation.accept(input); });
                                try {
                                    const reserved = await context.session.services.transcripts.markSourceFactConsumed?.({
                                        localId: `claude-jsonl:main:user:${input.inputIds[0]}`,
                                        reason: 'host_prompt_echo',
                                    });
                                    expect(reserved).toEqual({ status: 'custodied' });
                                    reservedPromptEchoes.push(...input.inputIds);
                                    promptEchoReservedBeforeAcceptance.push(!forcedAcceptance);
                                } finally { clearImmediate(release); }
                                return await conversation.send(input);
                            },
                            async updateConfiguration() { throw new Error('Generation must retain its admitted model configuration'); },
                            watch(listener) {
                                return conversation.watch(event => listener({ ...event, sequence: ++sequence,
                                    sessionId: request.sessionId, emittedAtMs: event.emittedAtMs ?? Date.now() }));
                            } };
                    },
                    executionRunContextV1: { async open(request) {
                        if (request.kind === 'fork') throw new Error('Unexpected fork');
                        return await createExecutionRunHostBackendFromConversationRuntime({ request,
                            openConversation: async () => createNativeConversation() });
                    } },
                } };
                const pendingInputs = new Map<string, ExecutionRunAdmittedPendingInputV1[]>();
                const durableAcceptance = new Map<string, DurableProviderInputAcceptanceV1>();
                const committedMessages: Parameters<MutableApiSessionClientFixture['enqueueAgentMessageCommitted']>[] = [];
                // Pending custody is the parent Session's network/persistence boundary.
                // Its real retained consumer, delivery, native codec and publisher run below.
                const session: MutableApiSessionClientFixture = createMutableApiSessionClientFixture({ sessionId,
                    metadata: createTestMetadata({ path: fixture.rootPath, flavor: 'claude' }), overrides: {
                    // This online Session boundary commits and acknowledges the host's saved-result notice.
                    enqueueAgentMessageCommitted: async (...message) => {
                        committedMessages.push(message);
                        return { persisted: true, delivered: true };
                    },
                    enqueueSessionUserMessageWithDisposition: async input => {
                        if (input.recipient?.kind !== 'execution_run') throw new Error('Expected exact Run recipient');
                        observedPrompts.push(input.text);
                        const inputs = pendingInputs.get(input.recipient.runId) ?? [];
                        // Mirror authenticated Pending settlement at the persistence
                        // boundary; native tool admission consumes its stored authority.
                        const admission = input.inputAdmission ?? buildTrustedHostSessionInputAdmissionV1('ui');
                        const receipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedMachine' });
                        const authority = admission.request.v === 2
                            ? settleSessionInputRequestV2({ request: admission.request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt })
                            : settleSessionInputRequestV1({ request: admission.request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt });
                        inputs.push({ ...UserMessageSchema.parse({ role: 'user', content: { type: 'text', text: input.text }, localId: input.localId,
                            meta: withSessionInputAuthority(input.meta, authority) }),
                            authorAccountId: null, inputAdmissionReceipt: receipt, pendingProviderAction: 'send' });
                        pendingInputs.set(input.recipient.runId, inputs);
                        session.updateMetadata(previous => previous);
                        return { status: 'accepted', localId: input.localId };
                    },
                    bindExecutionRunPendingInput: binding => {
                        const onPendingUpdate = () => binding.wake?.();
                        session.on('metadata-updated', onPendingUpdate);
                        return {
                            getMetadataSnapshot: session.getMetadataSnapshot,
                            waitForMetadataUpdate: session.waitForMetadataUpdate,
                            shouldAttemptPendingMaterialization: () => (pendingInputs.get(binding.recipient.runId)?.length ?? 0) > 0,
                            reconcilePendingProviderInputCustodyBeforeMaterialization: async () => true,
                            materializeNextPendingMessageSafely: async () => {
                                const input = pendingInputs.get(binding.recipient.runId)?.shift();
                                if (!input) return { type: 'no_pending' };
                                durableAcceptance.set(input.localId!, 'unknown');
                                if (!binding.consume(input)) throw new Error('Retained Run refused its admitted input');
                                return { type: 'materialized', localId: input.localId!, seq: null, content: null };
                            },
                            observeProviderInputSettlement: async outcome => {
                                if (outcome.kind === 'accepted') durableAcceptance.set(outcome.localId, 'accepted');
                                if (outcome.kind === 'rejected_before_effect') durableAcceptance.set(outcome.localId, 'not_accepted');
                                return true;
                            },
                            readDurableProviderInputAcceptanceV1: async localId => durableAcceptance.get(localId) ?? 'unknown',
                            dispose: () => { session.off('metadata-updated', onPendingUpdate); },
                        };
                    },
                } });
                const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
                registerExecutionRunHandlers(rpc, { sessionId, cwd: fixture.rootPath,
                        parentProvider: 'claude', sendAcp: async () => {},
                        resolveRunReportPolicy: createSessionRunReportPolicyReader({ serverId: configuration.activeServerId,
                            serverHttpBaseUrl: serverUrl, accountId, readCredentials: async () => ({ token, encryption: null }),
                            isCurrent: () => true }),
                        sessionInteractionHost: { machineId: 'fixture-machine',
                            // The parent Agent model is a native boundary fact;
                            // its route comes from the real scoped daemon reader.
                            readAppliedChildSelection: async () => {
                                if (forbidParentSelectionReads) {
                                    forbiddenParentSelectionReads += 1;
                                    throw new Error('Complete explicit SCM choices must never read parent startup');
                                }
                                const connected = await readAppliedParentConnectedServices({ runnerPid: process.pid,
                                    sessionId, agentId: 'claude' });
                                return connected.status === 'applied' ? { status: 'applied', backendTarget,
                                    modelId, connectedServices: connected.connectedServices } : connected;
                            },
                            session,
                            permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[SCM generation seam]' }) },
                        onManagerCreated: created => { manager = created; } });
                let assertBeforeStart: ((input: unknown) => Promise<void>) | undefined;
                const responses: unknown[] = [];
                const transportFailures: unknown[] = [];
                sockets.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL,
                    (payload: SocketRpcRequestPayload, acknowledge: (result: unknown) => void) => {
                        void (async () => {
                            if (payload.method === `${sessionId}:execution.run.start` && assertBeforeStart) {
                                const check = assertBeforeStart;
                                assertBeforeStart = undefined;
                                await check(payload.params);
                            }
                            return rpc.handleRequest({ method: payload.method, params: payload.params,
                                requestId: payload.requestId, callerAuthority: 'present_user' });
                        })().then(result => { responses.push(result); acknowledge({ ok: true, result }); }, error => {
                            transportFailures.push(error instanceof Error ? error.message : error);
                            acknowledge({ ok: false, error: 'fixture_rpc_failed' });
                        });
                    }));
                const client = { call: <TResponse, TRequest>(method: string, request: TRequest) =>
                    callSessionRpc({ token, sessionId, mode: 'plain', method, request }) as Promise<TResponse> };
                try {
                    // Real profile preparation refuses unavailable saved evidence
                    // before a Run exists. Its typed cause must survive the RPC.
                    const unavailable = await client.call<unknown, unknown>('execution.run.start',
                        ExecutionRunStartRequestSchema.parse({
                            intent: 'scm_diff_summary', kind: 'scm_diff_summary.v1', backendTarget, modelId,
                            modelSelection: { agentTargetKey: buildBackendTargetKeyV2(backendTarget), providerConnectionId: null, modelId },
                            permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
                            intentInput: { cwd: fixture.rootPath, source: { kind: 'workingTree' }, sessionId,
                                comparisonId: captured.comparison.id, resultId: '00000000-0000-0000-0000-000000000000', expectedRevision: 0,
                                outputs: ['walkthrough', 'commitPlan'] },
                        }));
                    expect(unavailable).toMatchObject({ ok: false, errorCode: 'DIFF_UNAVAILABLE', error: expect.any(String),
                        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
                    if (!unavailable || typeof unavailable !== 'object' || !('details' in unavailable)) {
                        throw new Error('Run refusal must carry its canonical start evidence');
                    }
                    expect(ExecutionRunStartFailureDetailsV1Schema.parse(unavailable.details).executionRunStart.runCreation).toBe('noRunCreated');
                    expect(ExecutionRunListResponseSchema.parse(await client.call('execution.run.list', {})).runs).toEqual([]);
                    // Refusal neighbors still reach the real Session transport. The
                    // positive path below starts at the Machine's registered SCM ingress.
                    const assertRunRefusals = async (input: unknown) => {
                        const actionId = 'execution.run.start';
                        const method = getActionSpec(actionId).bindings?.rpcMethod;
                        if (!method) throw new Error('Canonical Run Action RPC binding is unavailable');
                        const startRequest = ExecutionRunStartRequestSchema.parse(input);
                        const intentInput = ExecutionRunScmDiffSummaryInputV1Schema.parse(startRequest.intentInput);
                        // The actual Machine Action is still awaiting its real
                        // Socket.IO Start. No Run exists at this boundary yet.
                        const tracked: TrackedSession = { pid: 4242, startedBy: 'daemon', happySessionId: sessionId,
                            processStartTimeMs: 1, processCommandHash: 'fixture' };
                        const signals: number[] = [];
                        expect(await requestPlannedRunnerRestart({ sessionId, tracked, deferral: { kind: 'none' },
                            restartRequestedPids: new Set(), pidToTrackedSession: new Map([[tracked.pid, tracked]]),
                            isProcessSafeToSignal: async () => true,
                            canSignal: () => resolveTrackedSessionRunnerActivity(tracked, machine.manager.getActiveHandlerExecutions())?.reasonCode ?? true,
                            requestSignal: async request => {
                                if (!await request.shouldSignal()) return { status: 'skipped_stale_owner' };
                                signals.push(tracked.pid);
                                return { status: 'requested' };
                            },
                        })).toMatchObject({ signaled: false, notSignaledReason: 'turn_in_progress' });
                        expect(signals).toEqual([]);
                        if (intentInput.expectedRevision === undefined) throw new Error('Generation must bind its saved revision');
                        if (!intentInput.resultId) throw new Error('Machine generation must save its result before Run admission');
                        expect(await scmDiffSummaryResultStore.readStoredScope({ cwd: fixture.rootPath, sessionId,
                            resultId: intentInput.resultId })).toEqual({ cwd: fixture.rootPath, sessionId });
                        const stale = await client.call<unknown, unknown>(method, { ...startRequest,
                            intentInput: { ...intentInput, expectedRevision: intentInput.expectedRevision + 1 } });
                        expect(stale).toMatchObject({ ok: false, errorCode: 'execution_run_profile_preparation_failed',
                            error: expect.any(String),
                            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
                        expect(ExecutionRunListResponseSchema.parse(await client.call('execution.run.list', {})).runs).toEqual([]);
                        const unsupported = await client.call<unknown, unknown>(method, { ...startRequest,
                            modelId: 'freeform-not-in-native-catalog' });
                        expect(unsupported).toMatchObject({ ok: false, errorCode: 'model_structured_output_unsupported',
                            error: expect.any(String),
                            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
                        expect(ExecutionRunListResponseSchema.parse(await client.call('execution.run.list', {})).runs).toEqual([]);
                        const releaseDrain = admissionDrain.beginTemporaryDrain();
                        try {
                            forbidParentSelectionReads = true;
                            try {
                                const explicitDrained = await client.call<unknown, unknown>(method, { ...startRequest,
                                    modelSelection: { agentTargetKey: buildBackendTargetKeyV2(backendTarget),
                                        providerConnectionId: null, modelId },
                                });
                                expect(explicitDrained).toMatchObject({ ok: false, error: 'daemon_draining',
                                    details: { executionRunStart: { runCreation: 'noRunCreated' } } });
                            } finally { forbidParentSelectionReads = false; }
                            const drained = await client.call<unknown, unknown>(method, startRequest);
                            expect(drained).toMatchObject({ ok: false, errorCode: 'execution_run_failed', error: 'daemon_draining',
                                details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
                            expect(ExecutionRunListResponseSchema.parse(await client.call('execution.run.list', {})).runs).toEqual([]);
                        } finally { releaseDrain(); }
                    };
                    // The machine owner creates the saved result before invoking
                    // the Session's Run. Observe only that genuine network boundary.
                    if (parentAvailable) assertBeforeStart = assertRunRefusals;
                    const savedBefore = await scmDiffSummaryResultStore.list();
                    const generationOperations = createScmDiffSummaryOperations({ actionExecutor: createActionExecutor({
                        ...createUnavailableActionTransportDeps(), isActionApprovalRequired: () => false,
                        // Transport boundary: retain the receiving Machine's
                        // real registration, executor and Run dispatch below it.
                        scmActionExecute: async ({ actionId, input }) => {
                            const method = getActionSpec(actionId).bindings?.rpcMethod;
                            if (!method) throw new Error('SCM Action RPC binding is unavailable');
                            return await machine.call(method, input);
                        },
                    }) });
                    if (disabledOnly) {
                        const previousSettings = getActiveAccountSettingsSnapshot();
                        try {
                            setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({
                                'scm.diffSummary.enabled': false }), settingsVersion: 1, loadedAtMs: Date.now(),
                                settingsSecretsReadKeys: [], scopeKey: 'disabled-generation-seam' });
                            // The client projection deliberately says enabled. The
                            // registered host Action owns the actual admission.
                            const refused = await generationOperations.generateFromUserAction({ sessionId, backendTarget,
                                input: { cwd: fixture.rootPath, source: { kind: 'workingTree' }, comparisonId: captured.comparison.id,
                                    sessionId, modelSelector: { modelId }, outputs: ['walkthrough', 'commitPlan'] },
                                settings: { 'scm.diffSummary.enabled': true } });
                            expect(refused).toMatchObject({ ok: false });
                            expect(ScmDiffSummaryGenerateOutputSchema.parse(generationOperations.getState()
                                .entriesByKey[refused.key]?.latestOutput)).toEqual({ success: false,
                                errorCode: 'SCM_DIFF_SUMMARY_DISABLED', error: expect.any(String) });
                            expect(ExecutionRunListResponseSchema.parse(await client.call('execution.run.list', {})).runs).toEqual([]);
                            expect(await scmDiffSummaryResultStore.list()).toEqual(savedBefore);
                        } finally {
                            if (previousSettings) setActiveAccountSettingsSnapshot(previousSettings); else clearActiveAccountSettingsSnapshot();
                        }
                        return;
                    }
                    const generationResponse = await generationOperations.generateFromUserAction({ sessionId, backendTarget,
                        input: {
                            cwd: fixture.rootPath, source: { kind: 'workingTree' }, comparisonId: captured.comparison.id, sessionId,
                        // Automatic requests carry neither model nor target: the
                        // selected Session's applied backend must resolve them.
                            ...(!automaticModel ? { modelSelector: { modelId, backendTargetKey: buildBackendTargetKeyV2(backendTarget) } } : {}),
                            outputs: ['walkthrough', 'commitPlan'],
                        },
                        settings: { 'scm.diffSummary.outputLanguage': 'fr',
                            'scm.diffSummary.investigateSurroundingFiles': investigateSurroundingFiles },
                    });
                    expect(forbiddenParentSelectionReads).toBe(0);
                    if (automaticModel && !parentAvailable) {
                        expect(generationResponse.ok).toBe(false);
                        const refused = ScmDiffSummaryGenerateOutputSchema.parse(
                            generationOperations.getState().entriesByKey[generationResponse.key]?.latestOutput);
                        expect(refused).toMatchObject({ success: false, errorCode: 'MODEL_UNAVAILABLE' });
                        expect(refused.resultId).toEqual(expect.any(String));
                        expect(refused.runId).toBeUndefined();
                        expect((await scmDiffSummaryResultStore.list()).results).toHaveLength(savedBefore.results.length + 1);
                        expect(ExecutionRunListResponseSchema.parse(await client.call('execution.run.list', {})).runs).toEqual([]);
                        return;
                    }
                    expect(generationResponse.ok, JSON.stringify({ generationResponse, responses, transportFailures })).toBe(true);
                    const generation = ScmDiffSummaryGenerateOutputSchema.safeParse(
                        generationOperations.getState().entriesByKey[generationResponse.key]?.latestOutput);
                    expect(generation.success, JSON.stringify({ generationResponse, responses, transportFailures })).toBe(true);
                    if (!generation.success) throw generation.error;
                    const output = generation.data;
                    expect(output, JSON.stringify({ responses, transportFailures, outputs: output.outputs,
                        nestedStarts: logObservation.mock.calls.filter(([label]) => label === '[scm.diffSummary] nested Start').map(([, event]) => event),
                    })).toMatchObject({ success: true, runId: expect.any(String) });
                    expect(output.comparison).toEqual(capture.comparison);
                    if (!output.success || !output.runId || !output.inputId || !output.resultId || !manager) {
                        throw new Error('Generation did not return exact retained Run input custody');
                    }
                    const retainedManager = manager;
                    const { runId, inputId, resultId } = output;
                    await nativePromptReservationStarted;
                    await vi.waitFor(() => expect(reservedPromptEchoes, JSON.stringify({
                        run: retainedManager.getPublic(runId), promptEchoReservedBeforeAcceptance,
                    })).toContain(inputId));
                    expect(promptEchoReservedBeforeAcceptance).toEqual([true]);
                    const turn = await manager.waitForInputTurn(output.runId, output.inputId);
                    expect(turn, JSON.stringify({ run: manager.getPublic(output.runId), observedModel })).toMatchObject({ turn: { state: 'completed' } });
                    expect(observedPermissions).toEqual([{ read: investigateSurroundingFiles ? 'approved' : 'declined', write: 'declined' }]);
                    if (investigateSurroundingFiles) {
                        expect(observedSnapshots).toEqual([{ directory: expect.any(String),
                            before: 'Captured surrounding context\n', after: 'Captured surrounding context\n' }]);
                        expect(observedSnapshots[0]!.directory).not.toBe(fixture.rootPath);
                        expect(await readFile(join(observedSnapshots[0]!.directory, 'surrounding.txt'), 'utf8'))
                            .toBe('Captured surrounding context\n');
                    }
                    // Exact input completion precedes the host's asynchronous saved-result publication.
                    await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId,
                        resultId })).toMatchObject({ success: true, result: { output: { outputs: {
                            walkthrough: { state: 'complete' }, commitPlan: { state: 'complete' },
                        } } } }));
                    const { ScmDiffSummaryPublicationReceiptSchema } = await import('@happier-dev/protocol/scm/diffSummaryResult');
                    await vi.waitFor(() => expect(committedMessages.some(([, body, options]) => body.type === 'message'
                        && ScmDiffSummaryPublicationReceiptSchema.safeParse(options?.meta?.scmResultUpdate).success)).toBe(true));
                    expect(observedModel).toBe(modelId);
                    const retainedRun = manager.getPublic(output.runId);
                    if (!retainedRun) throw new Error('Missing retained generation Run');
                    expect(retainedRun.resolvedSelection?.source).toBe(
                        automaticModel ? 'inherited' : parentAvailable ? 'explicit' : 'independent');
                    expect(observedPrompts.join('\n')).toContain('Prose language: fr');
                    expect(observedPrompts.join('\n')).toContain('Editorial guidance:');
                    expect(observedPrompts.join('\n')).toContain('Evidence boundary:');
                    expect(await manager.stop(output.runId)).toMatchObject({ ok: true });
                    await manager.dispose();
                    manager = undefined;
                    expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId,
                        resultId: output.resultId })).toMatchObject({ success: true, result: { output: {
                            comparison: capture.comparison, outputs: {
                                walkthrough: { state: 'complete' }, commitPlan: { state: 'complete' },
                            },
                        } } });
                    if (investigateSurroundingFiles) {
                        const retained = await scmDiffSummaryResultStore.prepareInvestigation({ cwd: fixture.rootPath,
                            sessionId, resultId: output.resultId });
                        expect(retained.afterDirectory).toBe(observedSnapshots[0]!.directory);
                        expect(await readFile(join(retained.afterDirectory, 'surrounding.txt'), 'utf8'))
                            .toBe('Captured surrounding context\n');
                    }
                } finally { await manager?.dispose(); await session.close(); }
            } finally {
                try { await new Promise<void>((resolve, reject) => sockets.close(error => error ? reject(error) : resolve())); }
                finally { await daemon.close(); }
            }
        });
    });

    it('joins concurrent clients for one checkpoint and reuses its completed saved output', async () => {
        const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-admission-' });
        directories.push(fixture.rootPath);
        const sessionId = 'same-checkpoint-session';
        const turnId = 'turn-1';
        const scopeId = `${sessionId}:${fixture.rootPath}`;
        const refs = buildRepositoryCheckpointRefs({ scopeId, turnId });
        const context = await resolveGitCheckpointBackendContext({ cwd: fixture.rootPath });
        if (!context || !refs.turnStart || !refs.turnFinal) throw new Error('Checkpoint fixture is unavailable');
        const start = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnStart });
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Checkpoint change\n');
        const final = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal });
        if (!start.success || !final.success) throw new Error('Checkpoint fixture capture failed');
        await retainRepositoryCheckpointTurnEvidence({ cwd: fixture.rootPath, scopeId, turnChangeSet: {
            sessionId, turnId, provider: 'claude', derivedAt: 1, status: 'completed', files: [],
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
            repositoryCheckpoint: { version: 1, scopeId, startRef: refs.turnStart.ref, finalRef: refs.turnFinal.ref,
                baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
                receipts: [...start.receipts, ...final.receipts] },
        } });
        const modelId = getAgentStaticModels('claude', { catalogOnly: true }).find(model => model.id.includes('haiku'))?.id;
        if (!modelId) throw new Error('Native structured model fixture is unavailable');
        const runs = new Map<string, ExecutionRunState>();
        const controllers = new Map<string, ExecutionRunController>();
        const delivered = new Set<string>();
        const deliveredModels = new Map<string, string | undefined>();
        let failProvision = false;
        let loseNextStartResponse = false;
        let pendingStart: unknown;
        let releaseModel = () => {};
        let modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
        const createRuntime: Parameters<typeof startExecutionRun>[0]['createRuntime'] = (options) => {
            const runtime = createTestExecutionRunHostRuntime({
                resumeSupported: true,
                onProvisionRuntime: async () => { if (failProvision) throw new Error('Native model provisioning failed'); },
                onSendPrompt: async () => {
                    deliveredModels.set(options.runId!, options.modelId);
                    delivered.add(options.runId!);
                    await modelGate;
                    const input = ExecutionRunScmDiffSummaryInputV1Schema.parse(options.start?.intentInput);
                    const comparison = ScmComparisonSchema.parse(input.comparison);
                    runtime.emitMessage({ type: 'model-output', fullText: JSON.stringify(input.outputs?.includes('walkthrough')
                        ? { walkthrough: { title: 'Checkpoint', intro: 'Captured change', stops: [{ id: 'stop', title: 'Changed file',
                            explanationMarkdown: 'The captured file changed.', changeRefs: comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.alias)) }],
                            otherChangeRefs: [] } } : { summaryMarkdown: 'Checkpoint summary.' }) });
                },
                onWaitForTurnCompletion: async () => {},
            });
            return runtime;
        };
        const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Unused Voice runtime'); } });
        const finishRun: Parameters<typeof startExecutionRun>[0]['finishRun'] = async (runId, next) => {
            const current = runs.get(runId);
            if (current) runs.set(runId, { ...current, ...next });
        };
        const send: Parameters<typeof startExecutionRun>[0]['send'] = (runId, params) => sendBackendLongLivedRun({
            runId, params, runs, controllers, budgetRegistry: null, createRuntime, maxTurns: null,
            getNowMs: Date.now, finishRun, sendAcp: async () => {}, parentProvider: 'claude',
            streamedTranscriptSession: null, writeActivityMarker: async () => {},
        });
        const execute = (client: string): Parameters<typeof executeScmDiffSummaryAction>[0]['executeCanonicalAction'] => async (_action, input) => {
            const request = ExecutionRunStartRequestSchema.parse(input);
            if (loseNextStartResponse) {
                loseNextStartResponse = false;
                pendingStart = request;
                // The remote Start is still queued. Losing its observation
                // cannot grant generation a new saved-result revision.
                return { ok: false, errorCode: 'execution_run_target_unavailable', error: 'Start acknowledgement unavailable',
                    details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } } };
            }
            const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ request, cwd: fixture.rootPath, sessionId });
            const result = await startExecutionRun({
                params: { ...request, ...prepared, sessionId, cwd: fixture.rootPath,
                    // This fake native runtime emits JSON. Static descriptors
                    // supply model ids, while its native catalog supplies capability evidence.
                    readNativeOfferedModel: async ({ modelId: offeredId }) => {
                        const model = getAgentStaticModels('claude', { catalogOnly: true }).find(model => model.id === offeredId);
                        return model ? { ...model, capabilities: { structuredOutput: 'supported' } } : undefined;
                    },
                    backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, actionRequestId: `client-${client}` },
                parentProvider: 'claude', sendAcp: async () => {}, streamedTranscriptSession: null,
                createRuntime, getNowMs: Date.now, budgetRegistry: null, runs, controllers,
                enqueueMarkerWrite: async (_id, write) => write(), writeActivityMarker: async () => {},
                finishRun, executeBoundedRun: async () => { throw new Error('Unexpected bounded dispatch'); }, send, voiceAgentManager,
            });
            return { ok: true, result };
        };
        const request = { cwd: fixture.rootPath, source: { kind: 'turnCheckpoint' as const }, turnId,
            checkpointReceiptId: 'checkpoint.finalized', modelSelector: { modelId } };
        const generate = (client: string, override: Partial<ScmDiffSummaryGenerateInput> = {}) => executeScmDiffSummaryAction({ request: { ...request, ...override }, sessionId,
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, executeCanonicalAction: execute(client) });
        const waitForOutput = async (generation: Awaited<ReturnType<typeof generate>>, output = 'summary') => {
            await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId, resultId: generation.resultId! }))
                .toMatchObject({ success: true, result: { output: { outputs: { [output]: { state: 'complete' } } } } }));
        };
        try {
            const [left, right] = await Promise.all([generate('a'), generate('b')]);
            expect(right.comparison?.id).toBe(left.comparison?.id);
            await vi.waitFor(() => expect(delivered.size).toBeGreaterThan(0));
            expect({ admittedRuns: runs.size, modelRuns: delivered.size, resultIds: new Set([left.resultId, right.resultId]).size })
                .toEqual({ admittedRuns: 1, modelRuns: 1, resultIds: 1 });
            expect(right.runId).toBe(left.runId);
            expect(deliveredModels.get(left.runId!)).toBe(modelId);
            releaseModel();
            await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId, resultId: left.resultId! }))
                .toMatchObject({ success: true, result: { output: { outputs: { summary: { state: 'complete' } } } } }));
            const cached = await generate('c');
            expect(cached).toMatchObject({ resultId: left.resultId, runId: left.runId, outputs: { summary: { state: 'complete' } } });
            expect(runs.size).toBe(1);
            expect(delivered.size).toBe(1);
            const regenerated = await generate('explicit-regeneration', { cachePolicy: { mode: 'bypass' } });
            expect(regenerated.resultId).not.toBe(left.resultId);
            await vi.waitFor(() => expect(delivered.size).toBe(2));
            await waitForOutput(regenerated);
            const differentModelId = getAgentStaticModels('claude', { catalogOnly: true }).find(model => model.id !== modelId)?.id;
            if (!differentModelId) throw new Error('Second offered structured model fixture is unavailable');
            const differentModel = await generate('new-model', { modelSelector: { modelId: differentModelId } });
            expect(differentModel.resultId).not.toBe(left.resultId);
            await vi.waitFor(() => expect(delivered.size).toBe(3));
            expect(deliveredModels.get(differentModel.runId!)).toBe(differentModelId);
            await waitForOutput(differentModel);
            const differentOutput = await generate('new-output', { outputs: ['walkthrough'] });
            expect(differentOutput.resultId).not.toBe(left.resultId);
            await vi.waitFor(() => expect(delivered.size).toBe(4));
            await waitForOutput(differentOutput, 'walkthrough');
            failProvision = true;
            const failed = await generate('failed-provision', { cachePolicy: { mode: 'bypass' } });
            await vi.waitFor(() => expect(runs.get(failed.runId!)?.status).toBe('failed'));
            const retainedFailure = await generate('observe-failure');
            expect(retainedFailure).toMatchObject({ resultId: failed.resultId, runId: failed.runId });
            expect(delivered.size).toBe(4);
            failProvision = false;
            const retried = await generate('explicit-retry', { cachePolicy: { mode: 'bypass' } });
            expect(retried.runId).not.toBe(failed.runId);
            await vi.waitFor(() => expect(delivered.size).toBe(5));
            await waitForOutput(retried);
            modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
            const cancelled = await generate('cancelled-run', { cachePolicy: { mode: 'bypass' } });
            await vi.waitFor(() => expect(delivered.size).toBe(6));
            expect(await stopExecutionRun({ runId: cancelled.runId!, runs, controllers, voiceAgentManager,
                getNowMs: Date.now, finishRun })).toEqual({ ok: true });
            expect(runs.get(cancelled.runId!)?.status).toBe('cancelled');
            const retainedCancellation = await generate('observe-cancellation');
            expect(retainedCancellation).toMatchObject({ resultId: cancelled.resultId, runId: cancelled.runId });
            expect(delivered.size).toBe(6);
            releaseModel();
            const cancellationRetry = await generate('explicit-cancellation-retry', { cachePolicy: { mode: 'bypass' } });
            expect(cancellationRetry.runId).not.toBe(cancelled.runId);
            await vi.waitFor(() => expect(delivered.size).toBe(7));
            // Native delivery precedes publication. Each sequential regeneration
            // must publish before the next scenario or temporary-home teardown.
            await waitForOutput(cancellationRetry);
            loseNextStartResponse = true;
            const uncertain = await generate('lost-observation', { outputs: ['walkthrough'], cachePolicy: { mode: 'bypass' } });
            const observedAgain = await generate('reconcile-only', { outputs: ['walkthrough'] });
            expect(observedAgain).toMatchObject({ resultId: uncertain.resultId, revision: 0,
                outputs: { walkthrough: { state: 'pending' } } });
            expect(delivered.size).toBe(7);
            // Resume the original physical request through real profile,
            // Run start, initial-input admission and host publication.
            const lateStart = await execute('late-original-request')('execution.run.start', pendingStart);
            if (!lateStart.ok) throw new Error(lateStart.error);
            const lateRun = ExecutionRunStartResponseSchema.parse(lateStart.result);
            await waitForOutput(uncertain, 'walkthrough');
            expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId, resultId: uncertain.resultId! }))
                .toMatchObject({ success: true, result: { output: { runId: lateRun.runId,
                    outputs: { walkthrough: { state: 'complete' } } } } });
            expect(delivered.size).toBe(8);
        } finally {
            releaseModel();
            await Promise.all([...controllers.values()].map(async controller => {
                if (controller.kind === 'backend') { await controller.provisioningPromise; await controller.backend.dispose(); }
            }));
            await voiceAgentManager.dispose();
        }
    });
});
