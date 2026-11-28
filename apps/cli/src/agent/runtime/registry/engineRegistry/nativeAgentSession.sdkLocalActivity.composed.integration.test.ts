import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeEvent, ParsedPluginManifestV2 } from '@happier-dev/protocol';
import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { PluginManifestV2Schema, PluginSettingsContributionV2Schema } from '@happier-dev/protocol';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { withTempDir } from '@/testkit/fs/tempDir';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createNativeAgentRuntimeSessionPlanFixture, createExternalContributionFixtures } from './nativeAgentSession.composed.testkit';
import type { NativeAgentRuntimeSessionFixtureParams } from './nativeAgentSession.composed.testkit';
import { createNativeAgentSessionHostServiceOwners } from './nativeAgentSessionHostServiceOwners';
import { resolveBackendExecutionSurfacesFromNativeAgentRuntime } from '../backendEngineSurfaceBindings';
import { createAgentExternalSessionsExecutionSurface } from '../agentExternalSessionsExecutionSurface';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { runTerminalRemoteSessionModeLoop } from '@/agent/runtime/session/loop/runTerminalRemoteSessionModeLoop';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { PermissionModeQueuedPrompt, PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { buildTerminalMetadataFromHostHandle } from '@/terminal/runtime/terminalMetadata';
import { createStablePluginSettingsHost, createAccountSettingsBackedSettingsRecordStore } from '@/plugins/runtime/invocation/services/settings';
import { createStablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
import { createStablePluginStorageService } from '@/plugins/runtime/context/storage';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginInvocationLogger, type PluginInvocationLogRecord } from '@/plugins/runtime/invocation/services/logger';
import { logger } from '@/ui/logger';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import { createExternalSessionFollowHostOperation } from '@/session/external/followHostOperation';
import { createExternalSessionFollowTargetHostOperation } from '@/session/external/followTargetHostOperation';
import { createExternalSessionFollowLeaseManager } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { getActiveAccountSettingsSnapshot, resolveActiveAccountConfiguredExternalSessionSourceRevision } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const network = vi.hoisted(() => ({
    readCredentials: vi.fn(), fetchSessionById: vi.fn(), fetchAccountEncryptionCurrentness: vi.fn(),
    fetchAccountProfile: vi.fn(),
}));
// These are credential/persistence and remote-server boundaries. Registry,
// admission, reader, observation projection, query and Activity owners stay real.
vi.mock('@/persistence', async original => ({
    ...await original<typeof import('@/persistence')>(),
    readCredentials: network.readCredentials, readStoredCredentials: network.readCredentials,
}));
vi.mock('@/session/transport/http/sessionsHttp', async original => ({
    ...await original<typeof import('@/session/transport/http/sessionsHttp')>(),
    fetchSessionById: network.fetchSessionById,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async original => ({
    ...await original<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: network.fetchAccountEncryptionCurrentness,
}));
vi.mock('@/api/accountProfile', async original => ({
    ...await original<typeof import('@/api/accountProfile')>(), fetchAccountProfile: network.fetchAccountProfile,
}));

describe('captured Claude SDK local Activity through the public host', () => {
    let createClaudeAgentRuntime: AgentRuntimeFactory;
    let manifest: ParsedPluginManifestV2;
    beforeAll(async () => {
        // Existing source-integration variable-path imports use Vite's current
        // source resolver without adding provider source to the CLI compiler graph.
        const runtimePath = '../../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime.ts';
        const runtimeModule: Readonly<Record<string, unknown>> = await import(runtimePath);
        const factory = runtimeModule.createClaudeAgentRuntime;
        if (typeof factory !== 'function') throw new Error('Claude source runtime factory is unavailable');
        // The separately owned plugin module exports the public SDK factory contract.
        createClaudeAgentRuntime = factory as AgentRuntimeFactory;
        const manifestPath = '../../../../../../../packages/plugins/claude/src/manifest.ts';
        const manifestModule: Readonly<Record<string, unknown>> = await import(manifestPath);
        manifest = PluginManifestV2Schema.parse(manifestModule.PLUGIN_MANIFEST);
    });
    it.skipIf(process.platform === 'win32')('resumes the SDK task through an authenticated native hook and settles only after native exit', async () => {
        await withTempDir('claude-sdk-local-activity-', async directory => await withHerdrApi(async api => {
            api.setServerVersion('0.9.3');
            const pluginId = 'happier.agent.claude';
            const machineId = 'local-activity-machine';
            const sessionId = 'local-activity-happier';
            const nativeSessionId = '33333333-3333-4333-8333-333333333333';
            const taskId = 'same-native-background-task';
            const credentials = { token: 'fixture-token', encryption: null };
            const configDir = join(directory, 'claude-home');
            const projectDir = join(configDir, 'projects', directory.replaceAll('/', '-'));
            const sessionFilePath = join(projectDir, `${nativeSessionId}.jsonl`);
            await mkdir(projectDir, { recursive: true });
            await writeFile(sessionFilePath, [
                { type: 'user', uuid: 'history-user', timestamp: '2026-08-18T08:00:00.000Z', cwd: directory, message: { content: 'historical turn' } },
                { type: 'assistant', uuid: 'history-answer', timestamp: '2026-08-18T08:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'historical answer' }] } },
            ].map(row => JSON.stringify(row) + '\n').join(''));
            const nativeRecord = join(directory, 'native.jsonl');
            const sdkRecord = join(directory, 'sdk.jsonl');
            const nativePath = join(directory, 'claude-fixture');
            const herdrPath = join(directory, 'herdr-fixture');
            // Genuine third-party CLI boundary: execute the generated, authenticated
            // forwarder and record its completion from a real owned OS process.
            await writeFile(nativePath, `#!${process.execPath}\nconst fs=require('node:fs');
if(process.argv.includes('--version')){console.log('2.1.287 (Claude Code)');process.exit(0)}
if(process.argv.includes('--help')){console.log('--effort --system-prompt-snapshot');process.exit(0)}
process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
if(process.argv.includes('--input-format')){
fs.appendFileSync(${JSON.stringify(sdkRecord)},JSON.stringify({pid:process.pid,sessionId:${JSON.stringify(nativeSessionId)},taskId:${JSON.stringify(taskId)}})+'\\n');
const sdkHooks=JSON.parse(fs.readFileSync(require('node:path').join(process.argv[process.argv.indexOf('--plugin-dir')+1],'hooks/hooks.json'),'utf8')).hooks;
const emitHook=(name,payload)=>require('node:child_process').execSync(sdkHooks[name][0].hooks[0].command,{input:JSON.stringify({hook_event_name:name,session_id:${JSON.stringify(nativeSessionId)},...payload})});
const send=row=>process.stdout.write(JSON.stringify(row)+'\\n');let pending='';
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\\n'))!==-1){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim())continue;const request=JSON.parse(line);
if(request.type==='control_request'){send({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{}}});}
else if(request.type==='user'){
const content=request.message.content;const prompt=typeof content==='string'?content:content.filter(part=>part.type==='text').map(part=>part.text).join('');
emitHook('SessionStart',{source:'resume',transcript_path:${JSON.stringify(sessionFilePath)}});
emitHook('UserPromptSubmit',{prompt});
fs.appendFileSync(${JSON.stringify(sessionFilePath)},JSON.stringify({type:'user',uuid:'accepted-sdk-user',sessionId:${JSON.stringify(nativeSessionId)},timestamp:new Date().toISOString(),message:{role:'user',content:prompt}})+'\\n');
send({type:'system',subtype:'init',session_id:${JSON.stringify(nativeSessionId)}});send({type:'system',subtype:'task_started',session_id:${JSON.stringify(nativeSessionId)},task_id:${JSON.stringify(taskId)},task_type:'local_agent',is_backgrounded:true});send({type:'result',subtype:'success',is_error:false,session_id:${JSON.stringify(nativeSessionId)},result:'Foreground finished',queued_turn_count:0,usage:{},modelUsage:{}});}
}});setInterval(()=>{},1000);
}else{
const i=process.argv.indexOf('--plugin-dir');const hooks=JSON.parse(fs.readFileSync(require('node:path').join(process.argv[i+1],'hooks/hooks.json'),'utf8'));
require('node:child_process').execSync(hooks.hooks.SubagentStart[0].hooks[0].command,{input:JSON.stringify({hook_event_name:'SubagentStart',session_id:process.argv[process.argv.indexOf('--resume')+1],agent_id:${JSON.stringify(taskId)}})});
fs.appendFileSync(${JSON.stringify(nativeRecord)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2),sessionId:process.argv[process.argv.indexOf('--resume')+1],taskId:${JSON.stringify(taskId)},hookCompleted:true})+'\\n');setInterval(()=>{},1000);}\n`, { mode: 0o755 });
            await writeFile(herdrPath, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('herdr 0.9.3');else console.log(${JSON.stringify(JSON.stringify({ sessions: [{ name: 'activity-test', socket_path: api.socketPath, running: true }] }))});\n`, { mode: 0o755 });
            const env = { HAPPIER_CLAUDE_PATH: nativePath, HERDR_BIN_PATH: herdrPath, CLAUDE_CONFIG_DIR: configDir,
                HAPPIER_FEATURE_AGENTS_CLAUDE_UNIFIED_TERMINAL__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_DIRECT__ENABLED: '1' };
            const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
            Object.assign(process.env, env);
            network.readCredentials.mockResolvedValue(credentials);
            network.fetchAccountProfile.mockResolvedValue({ id: 'fixture-account', timestamp: 0, firstName: null,
                lastName: null, username: null, avatar: null, linkedProviders: [], connectedServices: [],
                connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [], connectedAccountsV4: [], connectedAccountGroupsV4: [] });
            network.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            const generation = new AbortController();
            const developmentRoots = createDaemonPluginDevelopmentRootsOwner({ happyHomeDir: directory,
                async submitObservation() { throw new Error('Bundled source selection must not prepare unrelated development roots'); } });
            const externalOwner = createExternalSessionHostOperationOwner();
            const followLeases = createExternalSessionFollowLeaseManager({ writeFollowStatus: async () => {} });
            const observation = createExternalSessionObservationDaemonProjection({
                publishField: async () => {},
                requestTranscriptRefresh: async input => await followLeases.requestTranscriptRefresh(input),
                isTranscriptRefreshDemanded: input => followLeases.hasTranscriptDemand(input),
            });
            let created: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof createNativeAgentRuntimeSessionPlanFixture>>['config']['createSessionRuntime']>>> | null = null;
            let nativePid: number | null = null;
            let sdkPid: number | null = null;
            let nativeExitObserved = false;
            let sdkExitObserved = false;
            let loopRun: Promise<void> | null = null;
            let loopFailure: unknown;
            let unsubscribe = () => {};
            let closeSession = async () => {};
            let releaseRegistry = async () => {};
            try {
                await externalOwner.install({
                    followOperation: createExternalSessionFollowHostOperation({ machineId,
                        followLeaseManager: followLeases, observationProjection: observation }),
                    followTargetOperation: createExternalSessionFollowTargetHostOperation({ machineId }),
                });
                const registryLease = await pluginReloadController.acquireRuntimeRegistry({
                    resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ happyHomeDir: directory, pluginIds: [pluginId],
                        resolveDevelopmentSourceAuthority: developmentRoots.resolveDevelopmentSourceAuthority,
                        externalSessionHostOperationOwner: externalOwner,
                        currentGlobalExternalSessionsRouter: pluginReloadController.currentGlobalExternalSessions,
                        resolveExternalSessionCurrentMachineId: () => machineId }),
                });
                const registry = registryLease.registry;
                releaseRegistry = registryLease.release;
                await registry.activateContributionsOnDemand([{ pluginId, family: 'agents', localId: 'claude' }]);
                const lease = registry.agentRuntimesByAgentId.get('claude');
                const agent = registry.contributes.agentDefinitionsById.get('claude');
                if (!lease?.hasPrimaryRuntime || !agent) throw new Error('The daemon-applied Claude runtime did not activate');
                const backend = { ...createExternalContributionFixtures('claude').backend, pluginId, provenance: 'first_party' as const, source: { kind: 'bundled' as const } };
                const runtime = await createClaudeAgentRuntime({ plugin: { id: pluginId, version: '0.0.0' }, agent: { id: 'claude' }, signal: generation.signal });
                const seed = { plugin: { id: pluginId, version: '0.0.0' }, contribution: { id: 'claude', qualifiedId: `${pluginId}/agents/claude` }, occurrenceId: lease.occurrenceId, correlationId: 'local-activity', surface: 'agent' as const, signal: generation.signal, isOccurrenceCurrent: lease.isCurrent };
                const settingsHost = createStablePluginSettingsHost({ declarations: (manifest.contributes.settings ?? []).map(contribution => ({ pluginId, contribution: PluginSettingsContributionV2Schema.parse(contribution) })), broker: createStablePluginEventsBroker(),
                    recordStore: createAccountSettingsBackedSettingsRecordStore({ async bindOperation() { return { async readRecord() { return { status: 'present' as const, revision: 1, values: { claudeUnifiedTerminalEnabled: false } }; }, async writeRecord() { throw new Error('Fixture must not write Account settings'); } }; } }) });
                const settings = settingsHost.bind(seed);
                if (!settings) throw new Error('Claude settings did not bind');
                const storage = createStablePluginStorageService({ pluginId, paths: resolvePluginStorePaths({ happyHomeDir: directory }), sessionId, occurrenceId: lease.occurrenceId, signal: generation.signal, isOccurrenceCurrent: lease.isCurrent });
                const warnings: PluginInvocationLogRecord[] = [];
                const invocationLogger = createPluginInvocationLogger({ seed, sink: { write(record) {
                    if (record.level === 'warn' || record.level === 'error') warnings.push(record);
                    logger.infoFile('Claude local Activity fixture', record);
                } } });
                const attachment = await writeTerminalHostAttachmentInfo({ happyHomeDir: directory, sessionId, lifecycle: 'borrowed', handle: { kind: 'herdr', sessionName: 'activity-test', socketPath: api.socketPath, terminalId: 'p1', paneId: 'p1', attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } } });
                const terminal = buildTerminalMetadataFromHostHandle(attachment.handle);
                const baseMetadata = createTestMetadata({ flavor: 'claude', path: directory, happyHomeDir: directory, terminal, startedBy: 'terminal', machineId });
                if (!lease.externalSessions) throw new Error('Claude transcript reader did not activate');
                const externalSession = createAgentExternalSessionsExecutionSurface(lease.externalSessions,
                    agent.richDefinition?.definition.surfaces?.externalSession.externalLinkedTakeover?.writerSafety ?? 'unsupported', false);
                if (!externalSession.resolveLinkIdentity) throw new Error('Claude linked identity producer is unavailable');
                const linkedIdentity = await externalSession.resolveLinkIdentity({
                    source: { kind: 'claudeConfig', configDir }, remoteSessionId: nativeSessionId });
                const linkedMetadata = buildLinkedExternalSessionMetadataV1(baseMetadata, { v: 1, agentId: 'claude', machineId, remoteSessionId: linkedIdentity.remoteSessionId, source: linkedIdentity.source, ...linkedIdentity.externalSessionMetadata, linkedAtMs: 1000,
                    qualifiedIdentity: { v: 1, agent: { pluginId, localId: 'claude' }, source: { kind: 'claudeConfig', contractVersion: 1 } } });
                const linkedSession = V2SessionRecordSchema.parse({ id: sessionId, seq: 1, createdAt: 1,
                    updatedAt: 1, active: true, activeAt: 1, encryptionMode: 'plain',
                    metadata: JSON.stringify(linkedMetadata), metadataVersion: 1,
                    agentState: null, agentStateVersion: 1, dataEncryptionKey: null, share: null });
                network.fetchSessionById.mockResolvedValue(linkedSession);
                // Remote persistence starts with the admitted Queue input. Real
                // projector writes update the same complete committed-ID baseline.
                const committedLocalIds = new Set<string>(['local-activity-input']);
                const session = createMutableApiSessionClientFixture({ sessionId, metadata: baseMetadata,
                    agentState: { controlledByUser: false }, overrides: {
                        async fetchCommittedTranscriptLocalIdBaseline() {
                            return { localIds: new Set(committedLocalIds), complete: true };
                        },
                        async enqueueUserTextMessageCommitted(_text, options) {
                            if (options?.localId) committedLocalIds.add(options.localId);
                            return { persisted: true, delivered: true };
                        },
                        async enqueueAgentMessageCommitted(_provider, _message, options) {
                            if (options?.localId) committedLocalIds.add(options.localId);
                            return { persisted: true, delivered: true };
                        },
                    } });
                closeSession = () => session.close();
                api.panes.add('p1');
                const permissionHandler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[local-activity]' });
                const owners = createNativeAgentSessionHostServiceOwners({ runtimeRegistry: registry, runtimeAuthority: { runtimeCapabilities: ['sessionHooks', 'terminalHost'] }, identity: { pluginId, agentId: 'claude', occurrenceId: lease.occurrenceId, isCurrent: lease.isCurrent }, backend, agent, hostSession: { session, machineId, permissionHandler }, sessionId, directory, happyHomeDir: directory, signal: generation.signal, currentTerminalMetadata: baseMetadata });
                const selected = await runtime.sessions!.resolveTerminalPresentation!({ cwd: directory }, { settings, features: owners.features });
                expect(selected).toMatchObject({ startingMode: 'remote', runtimeDescriptorV1: { agent: { backendMode: 'agentSdk' } } });
                const metadata = { ...baseMetadata, runtimeDescriptorV1: selected.runtimeDescriptorV1 };
                session.__setMetadata(metadata);
                const executionSurfaces = {
                    ...resolveBackendExecutionSurfacesFromNativeAgentRuntime({ backend, runtime, agentId: 'claude', isCurrent: lease.isCurrent, declaredAgentSurfaceFamilies: new Set(['terminalRuntime']), diagnostics: [] }),
                    externalSession,
                };
                const binding = buildPluginSessionBindingInput({ credentials, directory, startedBy: 'terminal', startingMode: 'remote', resume: nativeSessionId, environmentVariables: env, backendTarget: { kind: 'backend', backendId: 'claude' } });
                const bindExternalSession = (id: string) => externalOwner.bind({ pluginId, agentId: 'claude', occurrenceId: lease.occurrenceId, sessionId: id, machineId, readAccountRevision: () => resolveActiveAccountConfiguredExternalSessionSourceRevision(getActiveAccountSettingsSnapshot()), sessionSignal: generation.signal, occurrenceRetirementSignal: lease.retirementSignal, isOccurrenceCurrent: lease.isCurrent, agentContribution: agent });
                const plan = await createNativeAgentRuntimeSessionPlanFixture({ runtime, lease, backend, agent, sessionInput: { ...binding, bootstrap: { ...binding.bootstrap, runtimeDescriptorV1: selected.runtimeDescriptorV1 } }, executionSurfaces, generationSignal: generation.signal,
                    externalSessionHostOperations: { bindSession: bindExternalSession },
                    createInvocationServices: async () => {
                        const invocation = await lease.createAgentRuntimeSurfaceInvocationContext({ cwd: directory, happierSessionId: sessionId });
                        return { ...invocation.services, settings, storage, logger: invocationLogger };
                    }, createSessionHostServiceOwners: () => owners });
                const params: NativeAgentRuntimeSessionFixtureParams = { directory, metadata, currentTerminalMetadata: metadata, machineId, agentTargetKey: 'backend:claude', session, transcriptSession: session, messageQueue: new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => mode.permissionMode), messageBuffer: new MessageBuffer(), mcpServers: {}, permissionHandler, getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false, runnerProcessIdentity: null, startupModelSelection: null,
                    async runWithTerminalModelSelection(effect) { return { status: 'completed', value: await effect(null, async localEffect => ({ status: 'completed', value: await localEffect() })) }; } };
                created = await plan.config.createSessionRuntime!(params);
                const activity: AgentSessionRuntimeEvent[] = [];
                unsubscribe = created.operations.subscribeRuntimeEvents(event => { if (event.kind === 'runtime-activity-snapshot') activity.push(event); });
                created.operations.beginTurnLifecycle();
                await created.operations.sendTurnPrompt('Start a background task', { localId: 'local-activity-input', turnId: 'local-activity-turn' });
                await created.operations.waitForTurnCompletion();
                await vi.waitFor(() => expect(activity.at(-1)).toMatchObject({ state: 'active', activeCount: 1 }));
                await vi.waitFor(() => expect(created!.operations.readSessionIdentity()).toEqual({ sessionId: nativeSessionId }));
                expect(warnings).toEqual([]);
                const sdkProcess: unknown = JSON.parse((await readFile(sdkRecord, 'utf8')).trim());
                if (!sdkProcess || typeof sdkProcess !== 'object' || !('pid' in sdkProcess) || typeof sdkProcess.pid !== 'number') throw new Error('SDK vendor process did not record its PID');
                sdkPid = sdkProcess.pid;
                expect(sdkProcess).toMatchObject({ sessionId: nativeSessionId, taskId });
                process.kill(sdkPid, 'SIGTERM');
                const stoppedSdkPid = sdkPid;
                await vi.waitFor(() => expect(() => process.kill(stoppedSdkPid, 0)).toThrow());
                sdkExitObserved = true;
                // The same stopped task tuple must accept a proved new native owner.
                await vi.waitFor(() => expect(activity.at(-1)).toMatchObject({ state: 'idle', activeCount: 0 }));
                const startup = await created.prepareStartupPresentation!();
                if (!startup.terminalRemoteModeLoop) throw new Error('SDK local/remote loop unavailable');
                loopRun = runTerminalRemoteSessionModeLoop(startup.terminalRemoteModeLoop).then(() => undefined).catch(error => { loopFailure = error; });
                await vi.waitFor(() => expect(session.rpcHandlerManager.hasHandler('switch')).toBe(true));
                await expect(session.rpcHandlerManager.invokeLocal('switch', { to: 'local' })).resolves.toBe(true);
                await vi.waitFor(async () => {
                    if (loopFailure) throw loopFailure;
                    expect((await readFile(nativeRecord, 'utf8').catch(() => '')).trim()).not.toBe('');
                });
                const record: unknown = JSON.parse((await readFile(nativeRecord, 'utf8')).trim());
                if (!record || typeof record !== 'object' || !('pid' in record) || typeof record.pid !== 'number') throw new Error('Native fixture did not record its PID');
                nativePid = record.pid;
                expect(record).toMatchObject({ hookCompleted: true, sessionId: nativeSessionId, taskId,
                    argv: expect.arrayContaining(['--resume', nativeSessionId, '--plugin-dir']) });
                process.kill(nativePid, 0);
                await vi.waitFor(() => expect(activity.at(-1)).toMatchObject({ state: 'active', activeCount: 1 }));
                await expect(session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' })).resolves.toBe(true);
                const stoppedPid = nativePid;
                await vi.waitFor(() => expect(() => process.kill(stoppedPid, 0)).toThrow());
                nativeExitObserved = true;
                await vi.waitFor(() => expect(activity.at(-1)).toMatchObject({ state: 'idle', activeCount: 0 }));
                expect(loopFailure).toBeUndefined();
                expect(warnings).toEqual([]);
            } finally {
                unsubscribe();
                try { await created?.operations.resetOrDisposeRuntime(); }
                finally {
                    generation.abort();
                    await loopRun;
                    await closeSession();
                    if (!nativeExitObserved && !nativePid) {
                        const records = await readFile(nativeRecord, 'utf8').catch(() => '');
                        if (records.trim()) { const record: unknown = JSON.parse(records.trim().split('\n')[0]!); if (record && typeof record === 'object' && 'pid' in record && typeof record.pid === 'number') nativePid = record.pid; }
                    }
                    if (!nativeExitObserved && nativePid) { try { process.kill(nativePid, 'SIGKILL'); } catch {} }
                    if (!sdkExitObserved && !sdkPid) {
                        const record = await readFile(sdkRecord, 'utf8').catch(() => '');
                        if (record.trim()) { const parsed: unknown = JSON.parse(record.trim().split('\n')[0]!); if (parsed && typeof parsed === 'object' && 'pid' in parsed && typeof parsed.pid === 'number') sdkPid = parsed.pid; }
                    }
                    if (!sdkExitObserved && sdkPid) { try { process.kill(sdkPid, 'SIGKILL'); } catch {} }
                    await externalOwner.retire();
                    await observation.dispose();
                    await followLeases.dispose();
                    await releaseRegistry();
                    await pluginReloadController.shutdown();
                    await developmentRoots.stop();
                    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
                }
            }
        }));
    });
});
