import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
    AgentRuntime, AgentExecutionRunOpenRequest, AgentSessionSendRequest,
    AgentExecutionRunConversationEventV1,
    AgentExecutionRunConversationRuntimeV1,
    AgentExecutionRunRuntimeContextV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createExecutionRunHostBackendFromConversationRuntime } from '../../../../../../../packages/plugin-sdk/src/agentRuntime/executionRun';
import { createNativeAgentExecutionRunContextLeaseFactory, createNativeAgentExecutionRunHostRuntime, type NativeAgentSessionContextLeaseFactory } from './nativeAgentExecutionRun';
import { resolveExecutionRunInputAuthority } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createStablePluginExecService, createStableRunnerPluginExecService, captureAgentNativeLaunchAuthorityForHost, admitAgentNativeMcpPlacementForHost, authorizePluginExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createAgentIsolationOperationContext } from '@/daemon/agentIsolation/agentIsolationSessionContext';
import { projectAgentIsolationOperationMaterial, type AgentLaunchOperationMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { createMuseAgentRuntime } from '../../../../../../../packages/plugins/muse/src/agent/runtime';
import { createMuseMspProcessFixture } from '../../../../../../../packages/plugins/muse/src/agent/testkit/mspProcess';
import { callSessionMcpTool } from '@/cli/commands/toolsSessionMcp';
import { SESSION_MCP_BEARER_ENV, SESSION_MCP_CONTEXT_FILE_ENV, SessionMcpLocalContextSchema } from '@/mcp/runtime/sessionMcpLocalContext';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { createGitScmBackendRuntimeRegistration } from '../../../../../../../packages/plugins/scm-git/src/backend';
import { createScmHostingProviderRuntimeServicesForTest } from '../../../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';

it('publishes admitted detached Run Action discovery without granting hands-off writes', async () => {
    const lifetime = new AbortController();
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-run-actions-' });
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
        definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
        executableDefinition: registration.runtime!, registration,
        hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
    })]);
    const pluginId = 'acme.detached';
    const lease = { pluginId, pluginVersion: '1.0.0', agentId: `${pluginId}/default`, localAgentId: 'default',
        occurrenceId: 'detached-actions', isCurrent: () => !lifetime.signal.aborted };
    const unavailable = createUnavailablePluginServices();
    let directPlacementWithdrawn = false;
    const exec = createStablePluginExecService({ signal: lifetime.signal, isOccurrenceCurrent: lease.isCurrent,
        agentIsolation: { requesterIdentity: { kind: 'isolated', separationRequired: false, accountAutomation: true,
            requester: { serverId: 'home', accountId: 'account', machineId: 'machine-1', installationId: 'installation' } },
            read: () => directPlacementWithdrawn
                ? { enabled: true, status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [] }
                : { enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] } },
        async resolveExecutable() { throw new Error('No provider process is launched by this host boundary fixture'); },
        async resolvePath() { throw new Error('No filesystem Action is used'); },
    });
    const createFactory = (runId: string, rootPath: string, selectedExec = exec) => createNativeAgentExecutionRunContextLeaseFactory({ lease, runId,
        controllerOccurrenceId: 'controller', callId: 'call', sidechainId: 'sidechain', runtimeRegistry: null,
        directory: rootPath, machineId: 'machine-1', accountSettings: null,
        permissionMode: 'read_only', workspaceWrites: 'deny', start: { intent: 'delegate' },
        async createInvocationServices({ signal, readActiveTurnAdmissionWitness }) {
            return { ...unavailable, exec: selectedExec, actions: createPluginInvocationActionsService({
                seed: { plugin: { id: pluginId, version: '1.0.0' },
                    contribution: { id: 'default', qualifiedId: `${pluginId}/agents/default` },
                    ...createPluginActionCallerMaterializationFixture(pluginId),
                    occurrenceId: lease.occurrenceId, surface: 'agent', signal, processOwner: { kind: 'run', runId },
                    isOccurrenceCurrent: lease.isCurrent, readActiveTurnAdmissionWitness },
                actionExecutor: createActionExecutor({ ...createUnavailableActionTransportDeps(),
                    scmActionExecute: async ({ actionId, input, context }) => {
                        expect(context.runtimeRunId).toBe(runId);
                        expect(context).not.toHaveProperty('defaultSessionId');
                        return await executeScmActionOperation({
                        actionId, input, workingDirectory: rootPath,
                        accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] }, registry,
                        ...(context.signal ? { signal: context.signal } : {}),
                    }); },
                }),
                async invokeContributedAction() { throw new Error('No contributed Action is used'); },
            }) };
        },
    });
    const factory = createFactory('detached-actions', repository.rootPath);
    const siblingRepository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-sibling-actions-' });
    const witness = () => ({ turnId: 'turn', inputId: 'input', userMessageSeq: null, userMessageSeqs: [], callerPermissionMode: 'read-only' as const,
        causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const } });
    let bound: Awaited<ReturnType<typeof factory>> | undefined;
    let sibling: Awaited<ReturnType<typeof factory>> | undefined;
    try {
    bound = await factory({ services: unavailable, signal: lifetime.signal,
        readActiveTurnAdmissionWitness: () => ({ turnId: 'turn', inputId: 'input', userMessageSeq: null,
            userMessageSeqs: [], callerPermissionMode: 'read-only',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' } }),
    });
        expect(bound.context).not.toHaveProperty('session');
        expect(bound.mcpServers?.happier).toBeDefined();
        const config = bound.mcpServers!.happier;
        const contextFile = config.env?.[SESSION_MCP_CONTEXT_FILE_ENV];
        expect(contextFile).toBeTypeOf('string');
        const sessionContext = SessionMcpLocalContextSchema.parse({
            ...JSON.parse(await readFile(contextFile!, 'utf8')),
            bearerToken: config.env?.[SESSION_MCP_BEARER_ENV],
        });
        const call = (toolName: string, args: unknown) => callSessionMcpTool({ source: 'happier', toolName, args, sessionContext });
        await expect(call('action_spec_get', { id: 'scm.log.list' })).resolves.toMatchObject({ ok: true });
        await expect(call('action_execute', { actionId: 'scm.log.list', input: { cwd: repository.rootPath, limit: 1, skip: 0 } }))
            .resolves.toMatchObject({ ok: true, result: { success: true, entries: [expect.objectContaining({ sha: repository.headCommit })] } });
        await expect(call('action_execute', { actionId: 'settings.set', input: { anchor: 'voiceConversations.minSpeechMs', value: 1100 } }))
            .resolves.toMatchObject({ ok: false });
        await expect(callSessionMcpTool({ source: 'happier', toolName: 'action_spec_get', args: { id: 'scm.log.list' },
            sessionContext: { ...sessionContext, bearerToken: 'A'.repeat(43) } })).resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
        sibling = await createFactory('sibling-actions', siblingRepository.rootPath)({ services: unavailable,
            signal: lifetime.signal, readActiveTurnAdmissionWitness: witness });
        const siblingConfig = sibling.mcpServers!.happier;
        const siblingContext = SessionMcpLocalContextSchema.parse({
            ...JSON.parse(await readFile(siblingConfig.env![SESSION_MCP_CONTEXT_FILE_ENV]!, 'utf8')),
            bearerToken: siblingConfig.env![SESSION_MCP_BEARER_ENV],
        });
        // A sibling bearer selects sibling authority, even at the shared endpoint.
        await expect(callSessionMcpTool({ source: 'happier', toolName: 'action_execute',
            args: { actionId: 'scm.log.list', input: { cwd: repository.rootPath, limit: 1, skip: 0 } },
            sessionContext: { ...sessionContext, bearerToken: siblingContext.bearerToken } })).resolves.toMatchObject({ ok: true, result: { success: false } });
        const expectedMcpServers: Record<string, JsonValue> = { happier: { transport: 'stdio', command: config.command,
            ...(config.args ? { args: [...config.args] } : {}), ...(config.env ? { env: { ...config.env } } : {}), mode: 'required' } };
        const native = await createMuseMspProcessFixture({ cwd: repository.rootPath, expectedMcpServers,
            recordingPath: fileURLToPath(new URL('../../../../../../../packages/plugins/muse/src/agent/testkit/fixtures/mcp.json', import.meta.url)) });
        const nativeBoundary = createStablePluginExecService({ ...native, signal: lifetime.signal, isOccurrenceCurrent: lease.isCurrent });
        // Substitute only the external native process boundary. Muse's actual MSP
        // initialize/session-start requests consume the produced detached Run descriptor.
        const context = bound.context;
        const conversation = await createMuseAgentRuntime().sessions.executionRunContextV1!.openConversation!({
            kind: 'create', cwd: repository.rootPath, mcpServers: bound.mcpServers,
            configuration: { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
                permissionIntent: { value: 'read-only', updatedAtMs: 0 }, workspaceWrites: 'deny', options: {} },
        }, { ...context, services: { ...context.services, exec: { ...context.services.exec, clients: {
            ...context.services.exec.clients,
            spawn: (spec, options) => nativeBoundary.clients.spawn(spec, { signal: options?.signal }),
        } } } });
        await conversation.dispose();
        directPlacementWithdrawn = true;
        // This Run keeps its admitted direct placement, but still requires
        // Project native preparation; a sibling generic launch is not admitted.
        await expect(authorizePluginExecLaunchForHost(exec, {
            executable: { kind: 'systemTool', id: 'fixture.agent' }, cwd: repository.rootPath,
        }, { signal: lifetime.signal, nativeLaunch: bound.context.executionRun.services.nativeLaunch }))
            .rejects.toMatchObject({ code: 'plugin_exec_native_launch_unavailable' });
        await expect(authorizePluginExecLaunchForHost(exec, {
            executable: { kind: 'systemTool', id: 'fixture.agent' }, cwd: repository.rootPath,
        }, { signal: lifetime.signal })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
        directPlacementWithdrawn = false;
        // Runner/daemon RPC does not transfer endpoint custody. This optional
        // projection adds no RPC admission; native admission still owns refusal.
        let daemonAdmissionDenied = false;
        const runnerExec = createStableRunnerPluginExecService({ signal: lifetime.signal, isOccurrenceCurrent: lease.isCurrent,
            agentCli: unavailable.exec.agentCli,
            async resolveSystemTool() { throw new Error('No runner system tool is resolved'); },
            async resolveExecutable() { throw new Error('No runner executable is resolved'); },
            async authorizeLaunch() { throw new Error('No runner process is launched'); },
            async admitAgentNativeLaunch() {
                if (daemonAdmissionDenied) throw Object.assign(new Error('Requester authority unavailable'), { code: 'agent_isolation_unavailable' });
            },
        });
        const delegated = await createFactory('delegated-run', repository.rootPath, runnerExec)({ services: unavailable,
            signal: lifetime.signal, readActiveTurnAdmissionWitness: witness });
        try {
            expect(delegated.context.executionRun.id).toBe('delegated-run');
            expect(delegated.mcpServers?.happier).toBeUndefined();
            daemonAdmissionDenied = true;
            await expect(admitAgentNativeMcpPlacementForHost(runnerExec)).resolves.toBeNull();
            await expect(captureAgentNativeLaunchAuthorityForHost(runnerExec, 'exec')!.admit())
                .rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
        } finally { await delegated.dispose(); }
        const unavailablePlacement = createStablePluginExecService({ signal: lifetime.signal, isOccurrenceCurrent: lease.isCurrent,
            agentIsolation: { requesterIdentity: { kind: 'isolated', separationRequired: true,
                requester: { serverId: 'home', accountId: 'guest', machineId: 'machine-1', installationId: 'installation' } },
                read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [repository.rootPath] }) },
            async resolveExecutable() { throw new Error('No native effect before placement'); },
            async resolvePath() { throw new Error('No path lookup before placement'); },
        });
        await expect(admitAgentNativeMcpPlacementForHost(unavailablePlacement)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
        if (process.platform === 'linux') {
            // OS identity is a constructed boundary fact; the real operation,
            // Run qualifier, Exec finalizer and native frame remain composed.
            const nativeIdentity = { agentUid: process.getuid!(), agentGid: process.getgid!(), home: repository.rootPath };
            let heldMaterial: AgentLaunchOperationMaterialization | undefined = {
                materializationKey: 'prepared-run', environment: {}, selectedMaterials: [],
            };
            const target = projectAgentIsolationOperationMaterial(nativeIdentity, heldMaterial);
            const operation = createAgentIsolationOperationContext({ signal: lifetime.signal,
                managedHappierBinaryPath: '/fixture/happier', nativeIdentity,
                requesterIdentity: { kind: 'isolated', separationRequired: true, homeServerIdentityId: 'home',
                    requester: { serverId: 'home', accountId: 'guest', machineId: 'machine-1', installationId: 'installation' } },
                machine: { read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
                    workspaceRoots: [repository.rootPath] }) },
                readMaterial: () => heldMaterial, readTarget: () => target,
            });
            const preparedExec = createStablePluginExecService({ signal: lifetime.signal, isOccurrenceCurrent: lease.isCurrent,
                agentIsolation: operation, async resolveExecutable() { return { command: '/fixture/agent' }; },
                async resolvePath() { return repository.rootPath; },
            });
            const prepared = await createFactory('prepared-run', repository.rootPath, preparedExec)({ services: unavailable,
                signal: lifetime.signal, readActiveTurnAdmissionWitness: witness });
            try {
                const preparedConfig = prepared.mcpServers!.happier;
                const exactContext = SessionMcpLocalContextSchema.parse({
                    ...JSON.parse(await readFile(preparedConfig.env![SESSION_MCP_CONTEXT_FILE_ENV]!, 'utf8')),
                    bearerToken: preparedConfig.env![SESSION_MCP_BEARER_ENV],
                });
                if (!('socketPath' in exactContext)) throw new Error('Prepared native placement requires its Unix transport');
                const launch = await authorizePluginExecLaunchForHost(preparedExec, {
                    executable: { kind: 'systemTool', id: 'fixture.agent' }, cwd: repository.rootPath,
                }, { signal: lifetime.signal, agentIsolation: operation, nativeLaunch: prepared.context.executionRun.services.nativeLaunch });
                try {
                    const frame = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble!], { objectMode: false }));
                    expect(frame.executable).toBe('/fixture/agent');
                    expect(frame.selectedMaterials).toContainEqual({ relativePath: '.happier/session-mcp.json',
                        contentBase64: Buffer.from(JSON.stringify({ v: 1, socketPath: exactContext.socketPath })).toString('base64') });
                    expect(frame.environment[SESSION_MCP_CONTEXT_FILE_ENV]).toBe(`${target.runtimeHome}/.happier/session-mcp.json`);
                    expect(JSON.stringify(frame)).not.toContain(exactContext.bearerToken);
                } finally { await launch.release(); }
                heldMaterial = undefined;
                await expect(admitAgentNativeMcpPlacementForHost(preparedExec)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
                await expect(authorizePluginExecLaunchForHost(preparedExec, {
                    executable: { kind: 'systemTool', id: 'fixture.agent' }, cwd: repository.rootPath,
                }, { signal: lifetime.signal, agentIsolation: operation, nativeLaunch: prepared.context.executionRun.services.nativeLaunch }))
                    .rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
            } finally { await prepared.dispose(); }
        }
        await bound.dispose();
        bound = undefined;
        await expect(call('action_spec_get', { id: 'scm.log.list' })).resolves.toMatchObject({ ok: false });
        await expect(callSessionMcpTool({ source: 'happier', toolName: 'action_spec_get', args: { id: 'scm.log.list' },
            sessionContext: siblingContext })).resolves.toMatchObject({ ok: true });
    } finally {
        lifetime.abort();
        await sibling?.dispose();
        await bound?.dispose();
        await rm(repository.rootPath, { recursive: true, force: true });
        await rm(siblingRepository.rootPath, { recursive: true, force: true });
    }
});

it.each([
    { interaction: 'approval', permissionMode: 'default', intent: 'delegate' },
    { interaction: 'question', permissionMode: 'default', intent: 'delegate' },
    { interaction: 'question', permissionMode: 'read_only', intent: 'delegate' },
    { interaction: 'question', permissionMode: 'default', intent: 'review' },
] as const)('fails a finite $intent $permissionMode run whose native $interaction cannot be presented', async ({ interaction, permissionMode, intent }) => {
    const runId = `unsupported-${interaction}-${permissionMode}`;
    const lease = { pluginId: 'acme.detached', pluginVersion: '1.0.0', agentId: 'acme.detached/default',
        localAgentId: 'default', occurrenceId: runId, isCurrent: () => true };
    const factory = {
        async open(request: AgentExecutionRunOpenRequest, context: AgentExecutionRunRuntimeContextV1) {
            if (request.kind === 'fork') throw new Error('No fork');
            // Only the provider-native conversation is a boundary fake. It can
            // finish normally after an unavailable prompt was denied by its SDK.
            return await createExecutionRunHostBackendFromConversationRuntime({ request, openConversation: async () => {
                let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
                return {
                    watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
                    async send(input) {
                        listener?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                        if (interaction === 'approval') await context.services.interactions.requestApproval({
                            kind: 'approval', title: 'Write file',
                            subject: { kind: 'tool', name: 'Write', input: { path: '/repo/a', content: 'changed' } },
                        });
                        else await context.services.interactions.askQuestions({ kind: 'questions', title: 'Choose scope',
                            questions: [{ id: 'scope', prompt: 'Which scope?', type: 'text', required: true }],
                        });
                        listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: 'Partial answer' });
                        listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
                        return { status: 'admitted' as const };
                    },
                    async dispose() {},
                };
            } });
        },
    };
    const start = { intent, runClass: 'bounded', retentionPolicy: 'ephemeral', ioMode: 'request_response' } as const;
    const host = createNativeAgentExecutionRunHostRuntime({
        runtime: { sessions: { async open() { throw new Error('No Session identity'); }, executionRunContextV1: factory } },
        executionRunContextV1: factory, lease, supportsResume: false,
        options: { cwd: '/repo', runId, scope: 'detached', backendId: lease.agentId, permissionMode, start },
        createExecutionRunContext: createNativeAgentExecutionRunContextLeaseFactory({ lease, runId, start, permissionMode,
            controllerOccurrenceId: `${runId}-controller`, callId: `${runId}-call`, sidechainId: `${runId}-sidechain`,
            runtimeRegistry: null, directory: '/repo', machineId: 'machine', accountSettings: null,
        }),
    });
    try {
        await host.provisionRuntime({ initialPrompt: 'Complete the helper task' });
        await expect(host.waitForTurnCompletion?.()).rejects.toMatchObject({ executionRunErrorCode: 'execution_run_interaction_unavailable' });
    } finally { await host.dispose(); }
});

it.each(['public', 'narrowed', 'no_tools'] as const)('keeps detached %s native approvals on the active input authority', async source => {
    const runId = `authority-${source}`;
    const permissionMode = source === 'public' ? 'read_only' : source === 'no_tools' ? 'no_tools' : 'yolo';
    const admitted = resolveExecutionRunInputAuthority({ permissionMode,
        ...(source === 'narrowed' ? {
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
            effectiveCallerPermissionMode: 'read-only',
        } : source === 'no_tools' ? {
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
        } : {}),
    });
    if (!admitted.ok) throw new Error(admitted.error);
    const lease = { pluginId: 'acme.detached', pluginVersion: '1.0.0', agentId: 'acme.detached/default',
        localAgentId: 'default', occurrenceId: 'authority-fixture', isCurrent: () => true };
    let context!: AgentExecutionRunRuntimeContextV1;
    let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
    let readWitness: (() => AgentInvocationTurnAdmissionWitness | null) | undefined;
    let expectedAttribution: ReturnType<typeof materializeActionRequestAttributionV1>;
    let suppliedAttribution: typeof expectedAttribution;
    const approve = (name: string, input: { readonly [key: string]: JsonValue } = { path: '/repo/a' }) => context.services.interactions.requestApproval({ kind: 'approval', title: 'Native tool',
        subject: { kind: 'tool', name, input } });
    const factory = {
        async open(): Promise<never> { throw new Error('Retained input must use the conversation'); },
        async openConversation(_request: AgentExecutionRunOpenRequest, current: AgentExecutionRunRuntimeContextV1): Promise<AgentExecutionRunConversationRuntimeV1> {
            context = current;
            return {
                watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
                async send(input, options) {
                    Object.assign(suppliedAttribution.requester ?? {}, { accountId: 'later-caller' });
                    expect(readWitness?.()?.actionRequestAttributionV1).toEqual(expectedAttribution);
                    expect(Object.isFrozen(readWitness?.()?.actionRequestAttributionV1)).toBe(true);
                    expect(input).not.toHaveProperty('actionRequestAttributionV1');
                    expect(options).not.toHaveProperty('actionRequestAttributionV1');
                    expect(options).not.toHaveProperty('effectiveCallerPermissionMode');
                    expect(options).toMatchObject({ permissionIntent: 'read-only' });
                    expect(input.causalPermissionAuthority).toEqual(admitted.causalPermissionAuthority);
                    listener?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                    await expect(approve('Read')).resolves.toMatchObject({ status: source === 'no_tools' ? 'declined' : 'approved' });
                    await expect(approve('Write')).resolves.toMatchObject({ status: 'declined' });
                    await expect(approve('mcp__happier__settings_get', { anchor: 'voiceConversations.minSpeechMs' }))
                        .resolves.toMatchObject({ status: 'approved' });
                    await expect(approve('mcp__happier__session_stop', { sessionId: 'other-session' }))
                        .resolves.toMatchObject({ status: 'declined' });
                    await expect(approve('mcp__happier__settings_invoke', { anchor: 'voicePrivacy.forgetVoiceAgentMemory' }))
                        .resolves.toMatchObject({ status: 'declined' });
                    await expect(approve('mcp__happier__action_execute', {
                        actionId: 'settings.set', input: { anchor: 'voiceConversations.minSpeechMs', value: 1100 },
                    })).resolves.toMatchObject({ status: 'declined' });
                    listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
                    return { status: 'admitted' };
                },
                async dispose() {},
            };
        },
    };
    const host = createNativeAgentExecutionRunHostRuntime({
        runtime: { sessions: { async open() { throw new Error('No Session identity'); }, executionRunContextV1: factory } },
        executionRunContextV1: factory, retainedConversation: true, lease,
        options: { cwd: '/repo', runId, scope: 'detached', backendId: lease.agentId, permissionMode,
            start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' } },
        supportsResume: false,
        createExecutionRunContext: createNativeAgentExecutionRunContextLeaseFactory({ lease, runId,
            controllerOccurrenceId: 'authority-controller', callId: 'authority-call', sidechainId: 'authority-sidechain',
            runtimeRegistry: null, directory: '/repo', machineId: 'authority-machine', accountSettings: null,
            permissionMode, start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
            createInvocationServices: async ({ readActiveTurnAdmissionWitness }) => {
                readWitness = readActiveTurnAdmissionWitness;
                return createUnavailablePluginServices();
            },
        }),
    });
    try {
        await host.provisionRuntime();
        for (const localId of ['first', 'second']) {
            expectedAttribution = materializeActionRequestAttributionV1({ requestRef: localId,
                requester: localId === 'first' ? { serverId: 'home', accountId: 'bob' } : null,
                persona: { serverId: 'home', sessionId: 'bot-session' }, origin: null });
            suppliedAttribution = structuredClone(expectedAttribution);
            await host.deliverInput(runId, { text: localId }, { localId, causalPermissionAuthority: admitted.causalPermissionAuthority,
                effectiveCallerPermissionMode: admitted.effectiveCallerPermissionMode, actionRequestAttributionV1: suppliedAttribution });
            await host.waitForTurnCompletion?.();
            await expect(approve('Read')).resolves.toMatchObject({ status: 'declined' });
        }
    } finally { await host.dispose(); }
});

describe.each([
    { custody: 'accepted', diagnosticCode: 'provider_capacity', lifetimes: ['finite', 'retained'] },
    { custody: 'custody-unknown', diagnosticCode: 'acp_input_custody_unknown', lifetimes: ['finite', 'retained'] },
    { custody: 'rejected', diagnosticCode: 'acp_input_rejected_before_effect', lifetimes: ['finite', 'retained'] },
    { custody: 'custody-unknown', diagnosticCode: 'codex_send_outcome_unknown', lifetimes: ['retained'] },
    { custody: 'rejected', diagnosticCode: 'provider_capacity', lifetimes: ['retained'] },
] as const)('detached $custody native input ($diagnosticCode)', ({ custody, diagnosticCode, lifetimes }) => {
it.each(lifetimes)('recovers only accepted failure, never an unknown-custody input (%s)', async lifetime => {
    const requests: AgentExecutionRunOpenRequest[] = [];
    const sends: AgentSessionSendRequest[] = [];
    // This provider-native conversation is the sole external fake. The SDK's
    // truthful detached conversation adapter and host lifecycle remain real.
    const openConversation = async (request: AgentExecutionRunOpenRequest): Promise<AgentExecutionRunConversationRuntimeV1> => {
        requests.push(request);
                let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
                return {
                    watch(next) { listener = next; next({ kind: 'provider-session-id', providerSessionId: 'detached-native-original' }); return { dispose() { listener = undefined; } }; },
                    async send(input) {
                        sends.push(input);
                        if (sends.length === 1 && custody !== 'accepted') {
                            if (custody === 'custody-unknown') listener?.({ kind: 'input-custody-unknown', inputIds: input.inputIds,
                                issue: { code: diagnosticCode, severity: 'error', details: { requestErrorCode: 429 } } });
                            else listener?.({ kind: 'input-rejected', inputIds: input.inputIds, retryable: true,
                                diagnostic: { code: diagnosticCode, severity: 'error', details: { requestErrorCode: 429 } } });
                            return { status: 'admitted' as const };
                        }
                        listener?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                        listener?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                        if (sends.length === 1) {
                            listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: 'Partial detached work. ' });
                            listener?.({ kind: 'turn-failed', turnId: input.delivery.turnId,
                                diagnostic: { code: 'provider_capacity', severity: 'error' } });
                            // Native process exit can repeat terminal noise after
                            // the correlated turn failure starts host recovery.
                            listener?.({ kind: 'runtime-ended', cause: 'processExited', retryable: true,
                                diagnostic: { code: 'native_process_exited', severity: 'error' } });
                        } else {
                            listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: 'Detached continuation.' });
                            listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
                        }
                        return { status: 'admitted' as const };
                    },
                    async dispose() {},
                };
    };
    const factory = {
        openConversation,
        async open(request: AgentExecutionRunOpenRequest) {
            if (request.kind === 'fork') throw new Error('Fixture does not offer fork');
            return await createExecutionRunHostBackendFromConversationRuntime({ request,
                readCheckpointId: event => event.kind === 'provider-session-id' ? event.providerSessionId : null,
                openConversation: () => openConversation(request),
            });
        },
    };
    const runtime: AgentRuntime = { sessions: { async open() { throw new Error('Unexpected Session'); }, executionRunContextV1: factory } };
    const recovery = vi.fn<NonNullable<CreateCliExecutionRunBackendParams['prepareRuntimeFailureRecovery']>>(async () => ({
        status: 'continue', input: 'Continue where you left off', async prepareResume() { return undefined; },
    }));
    const host = createNativeAgentExecutionRunHostRuntime({ runtime, executionRunContextV1: factory,
        ...(lifetime === 'retained' ? { retainedConversation: true } : {}),
        lease: { pluginId: 'acme.detached', pluginVersion: '1.0.0', agentId: 'acme.detached/default', localAgentId: 'default', occurrenceId: 'detached-fixture', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'detached-recovery', scope: 'detached', backendId: 'acme.detached/default', permissionMode: 'read_only',
            start: { intent: 'review', runClass: 'bounded', retentionPolicy: 'resumable' }, prepareRuntimeFailureRecovery: recovery },
        supportsResume: true,
    });
    const messages: AgentMessage[] = [];
    host.subscribeMessages(message => messages.push(message));
    try {
        await host.provisionRuntime({ initialPrompt: 'Perform effect once' });
        if (custody !== 'accepted') {
            await expect(host.waitForTurnCompletion?.()).rejects.toThrow(diagnosticCode);
            expect(recovery).not.toHaveBeenCalled();
            expect(requests).toHaveLength(1);
            expect(sends).toHaveLength(1);
            return;
        }
        await host.waitForTurnCompletion?.();
        expect(recovery).toHaveBeenCalledOnce();
        expect(requests).toMatchObject([{ kind: 'create' }, { kind: 'resume', checkpointId: 'detached-native-original' }]);
        expect(sends.map(send => send.input.text)).toEqual(['Perform effect once', 'Continue where you left off']);
        expect(sends[1]?.inputIds).not.toEqual(sends[0]?.inputIds);
        expect(messages.some(message => message.type === 'status' && message.status === 'error')).toBe(false);
        expect(JSON.stringify(messages)).toContain('Partial detached work. ');
        expect(JSON.stringify(messages)).toContain('Detached continuation.');
    } finally { await host.dispose(); }
});
});

it.each(['retained', 'finite'] as const)('keeps detached %s conversation lifetime distinct from turn completion', async kind => {
    const sends: AgentSessionSendRequest[] = [];
    const opens: AgentExecutionRunOpenRequest[] = [];
    let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
    let readWitness: Parameters<NonNullable<NativeAgentSessionContextLeaseFactory['bindInvocationServices']>>[0]['readActiveTurnAdmissionWitness'];
    const dispose = vi.fn(async () => {});
    const conversation: AgentExecutionRunConversationRuntimeV1 = {
        watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
        async send(input, options) {
            sends.push(input);
            expect(options).not.toHaveProperty('effectiveCallerPermissionMode');
            if (kind === 'finite') expect(options).not.toHaveProperty('permissionIntent');
            else expect(options).toMatchObject({ permissionIntent: 'read-only' });
            if (kind === 'retained') expect(readWitness?.()).toMatchObject({
                inputId: input.inputIds[0], turnId: input.delivery.turnId,
                causalPermissionAuthority: input.causalPermissionAuthority,
                callerPermissionMode: 'read-only',
            });
            // A delayed duplicate from the previous turn must not settle this one.
            if (sends.length > 1) listener?.({ kind: 'turn-complete', turnId: sends[0]!.delivery.turnId });
            listener?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
            listener?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
            listener?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: `reply-${sends.length}` });
            listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
            return { status: 'admitted' };
        },
        dispose,
    };
    const factory = {
        async open(request: AgentExecutionRunOpenRequest) {
            opens.push(request);
            if (request.kind === 'fork') throw new Error('No fork');
            return await createExecutionRunHostBackendFromConversationRuntime({ request, openConversation: () => conversation });
        },
        async openConversation(request: AgentExecutionRunOpenRequest, context: AgentExecutionRunRuntimeContextV1) {
            expect(context.scope).toEqual({ kind: 'execution_run', executionRunId: 'detached-lifetime' });
            expect('session' in context).toBe(false);
            opens.push(request); return conversation;
        },
    };
    const host = createNativeAgentExecutionRunHostRuntime({
        async bindInvocationServices(input) { readWitness = input.readActiveTurnAdmissionWitness; return input.services; },
        runtime: { sessions: { async open() { throw new Error('Detached Run must not open a Happier Session'); }, executionRunContextV1: factory } },
        executionRunContextV1: factory,
        ...(kind === 'retained' ? { retainedConversation: true as const } : {}),
        lease: { pluginId: 'acme.detached', pluginVersion: '1.0.0', agentId: 'acme.detached/default', localAgentId: 'default', occurrenceId: 'retained-fixture', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'detached-lifetime', scope: 'detached', backendId: 'acme.detached/default', permissionMode: 'read_only',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
            start: { intent: 'delegate', runClass: kind === 'retained' ? 'long_lived' : 'bounded', retentionPolicy: 'resumable' } },
        supportsResume: false,
    });
    const messages: AgentMessage[] = [];
    host.subscribeMessages(message => messages.push(message));
    try {
        await host.provisionRuntime({ initialPrompt: 'first' });
        await host.waitForTurnCompletion?.();
        if (kind === 'finite') {
            await expect(host.deliverInput('detached-lifetime', { text: 'second' }, { localId: 'second' })).rejects.toThrow('already terminated');
            expect(sends.map(send => send.input.text)).toEqual(['first']);
        } else {
            for (const text of ['second', 'third']) {
                await host.deliverInput('detached-lifetime', { text }, { localId: text,
                    effectiveCallerPermissionMode: 'read-only',
                    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: text === 'second' ? 'read-only' : 'yolo' } });
                await host.waitForTurnCompletion?.();
            }
            expect(sends.map(send => send.input.text)).toEqual(['first', 'second', 'third']);
            expect(new Set(sends.map(send => send.delivery.turnId)).size).toBe(3);
            expect(dispose).not.toHaveBeenCalled();
            expect(readWitness?.()).toBeNull();
            expect(messages.filter(message => message.type === 'model-output').map(message => message.textDelta)).toEqual(['reply-1', 'reply-2', 'reply-3']);
        }
        expect(opens).toHaveLength(1);
    } finally { await host.dispose(); }
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
});

it.each(['unsupported', 'supported', 'pending-custody'] as const)('preserves an idle retained native failure without replaying a completed input (resume=%s)', async resume => {
    let listener: ((event: AgentExecutionRunConversationEventV1) => void) | undefined;
    const send = vi.fn<AgentExecutionRunConversationRuntimeV1['send']>(async input => {
        listener?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
        return { status: 'admitted' };
    });
    const dispose = vi.fn(async () => {});
    const openConversation = vi.fn(async (): Promise<AgentExecutionRunConversationRuntimeV1> => ({
        watch(next) { listener = next; next({ kind: 'provider-session-id', providerSessionId: 'idle-native-original' });
            return { dispose() { listener = undefined; } }; }, send, dispose,
    }));
    const recovery = vi.fn<NonNullable<CreateCliExecutionRunBackendParams['prepareRuntimeFailureRecovery']>>(async () => ({
        status: 'continue', input: 'must not replay completed work', async prepareResume() { return undefined; },
    }));
    const factory = { async open(): Promise<never> { throw new Error('Finite open is not retained'); }, openConversation };
    const lease = { pluginId: 'acme.detached', pluginVersion: '1.0.0', agentId: 'acme.detached/default',
        localAgentId: 'default', occurrenceId: 'idle-fixture', isCurrent: () => true };
    let acknowledgeCustody!: () => void;
    // Durable host persistence is an external boundary; hold its acknowledgement.
    const custody = new Promise<void>(resolve => { acknowledgeCustody = resolve; });
    const contextFactory = Object.assign(createNativeAgentExecutionRunContextLeaseFactory({ lease, runId: 'detached-idle',
        controllerOccurrenceId: 'idle-controller', callId: 'idle-call', sidechainId: 'idle-sidechain',
        runtimeRegistry: null, directory: '/repo', machineId: 'idle-machine', accountSettings: null,
        permissionMode: 'read_only', start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' },
    }), { onTurnTerminal: () => custody });
    const host = createNativeAgentExecutionRunHostRuntime({
        runtime: { sessions: { async open() { throw new Error('No Session identity'); }, executionRunContextV1: factory } },
        executionRunContextV1: factory, retainedConversation: true,
        lease,
        ...(resume === 'pending-custody' ? { createExecutionRunContext: contextFactory } : {}),
        options: { cwd: '/repo', runId: 'detached-idle', scope: 'detached', backendId: 'acme.detached/default', permissionMode: 'read_only',
            start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable' }, prepareRuntimeFailureRecovery: recovery },
        supportsResume: resume !== 'unsupported',
    });
    try {
        await host.provisionRuntime({ initialPrompt: 'first' });
        const completedTurn = host.waitForTurnCompletion?.();
        void completedTurn?.catch(() => undefined);
        if (resume !== 'pending-custody') await completedTurn;
        listener?.({ kind: 'runtime-ended', cause: 'processExited', retryable: true,
            diagnostic: { code: 'native_process_exited', severity: 'error' } });
        expect(recovery).not.toHaveBeenCalled();
        acknowledgeCustody();
        await expect(completedTurn).resolves.toBeUndefined();
        await vi.waitFor(async () => {
            await expect(host.waitForTurnCompletion?.()).rejects.toThrow('native_process_exited');
        });
        await expect(host.deliverInput('detached-idle', { text: 'must not run' }, { localId: 'second' })).rejects.toThrow('already terminated');
        expect(openConversation).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledOnce();
    } finally { await host.dispose(); }
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
});
