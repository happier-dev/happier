import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';

import axios from 'axios';
import { afterAll, describe, expect, it, onTestFailed, vi } from 'vitest';

import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createCodexForegroundConnectedAccountFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.codexConnectedServices.testkit';
import { withRealForegroundAdmissionFixture } from '@/daemon/agentRuntime/foregroundAdmission.testkit';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/utils/logger';
import { withCodexNativeAttachFixture } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';
import { bindNativeAgentLaunchPreparationFixture, createNativeAgentLaunchPreparationFixture, createNativeAgentJourneyTranscriptFixture } from './engineRegistry/nativeAgentSession.testkit';

afterAll(() => pluginReloadController.shutdown());

describe('Codex catalog-to-native Session journey', () => {
    it.skipIf(process.platform === 'win32')('prepares the selected Account, uses the native default, replies, and resumes the exact provider thread', async () => {
        const prompts: string[] = [];
        let nativeHome: string | undefined;
        const phases: unknown[] = [];
        const fileLog = logger.infoFile.bind(logger);
        const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation((message, ...args) => {
            if (message === '[CONNECTED ACCOUNT] Materialization phase') phases.push(args[0]);
            fileLog(message, ...args);
        });
        onTestFailed(() => console.info('Codex materialization phases', phases.slice(-6)));
        try { await withCodexNativeAttachFixture(async native => {
            const account = await createCodexForegroundConnectedAccountFixture();

            const executable = join(native.directory, 'codex.cjs');
            const nativeCapturePath = join(native.directory, 'native-launches.jsonl');
            const nativeErrorPath = join(native.directory, 'native-error.txt');
            const script = `#!/usr/bin/env node
const net = require('node:net');
process.on('uncaughtException', error => {
    require('node:fs').writeFileSync(${JSON.stringify(nativeErrorPath)}, error.stack || String(error));
    process.stderr.write(error.stack || String(error));
    process.exit(1);
});
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.159.2'); process.exit(0); }
if (process.argv[2] === 'login' && process.argv[3] === 'status') process.exit(0);
if (process.argv[2] === 'features' && process.argv[3] === 'list') { process.stdout.write('realtime_conversation experimental false\\n'); process.exit(0); }
const listenIndex = process.argv.indexOf('--listen');
if (listenIndex < 0 || process.argv[listenIndex + 1] === 'stdio://') {
    // Independent native controls use JSON lines; the Session uses its native
    // WebSocket endpoint. Both reach the same vendor-boundary thread store.
    const WebSocket = require(${JSON.stringify(createRequire(import.meta.url).resolve('ws'))});
    const socket = new WebSocket(${JSON.stringify(`ws+unix://${join(native.directory, 's')}:/`)});
    let buffer = '';
    const pending = [];
    socket.on('open', () => { for (const line of pending.splice(0)) socket.send(line); });
    socket.on('message', data => process.stdout.write(data.toString() + '\\n'));
    socket.on('error', error => { throw error; });
    socket.on('close', () => process.exit(0));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (line.trim()) {
                if (socket.readyState === WebSocket.OPEN) socket.send(line);
                else pending.push(line);
            }
        }
    });
    process.stdin.on('end', () => socket.close());
} else {
const endpoint = process.argv[listenIndex + 1];
if (!endpoint || !endpoint.startsWith('unix://')) process.exit(81);
require('node:fs').appendFileSync(${JSON.stringify(nativeCapturePath)}, JSON.stringify({ projectEnvironmentActive: process.env.NATIVE === 'active' }) + '\\n');
const server = net.createServer(socket => {
    const upstream = net.connect(${JSON.stringify(join(native.directory, 's'))});
    socket.pipe(upstream); upstream.pipe(socket);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
});
require('node:fs').mkdirSync(require('node:path').dirname(endpoint.slice('unix://'.length)), { recursive: true, mode: 0o700 });
server.listen(endpoint.slice('unix://'.length));
}
`;
            await writeFile(executable, script);
            await chmod(executable, 0o755);
            const builtIns = resolveBuiltInContributions();
            const runtimeOptions = {
                ...account.runtimeOptions,
                contributes: createResolvedContributionRegistry({
                    ...builtIns,
                    systemTools: builtIns.systemTools?.map(tool => tool.pluginId === 'happier.agent.codex'
                        ? { ...tool, definition: { ...tool.definition, executableNames: [executable] } } : tool),
                }),
                pluginIds: ['happier.agent.codex'],
            };
            let transcript: Awaited<ReturnType<typeof createNativeAgentJourneyTranscriptFixture>> | undefined;
            try {
                await withRealForegroundAdmissionFixture({
                    createRuntime: ({ home, controller }) => createAdmittedPluginRuntimeFixture({
                        happyHomeDir: home, controller, runtimeOptions,
                    }),
                }, async foreground => {
                    const accountGet = vi.mocked(axios.get).getMockImplementation();
                    if (!accountGet) throw new Error('Connected Account HTTP fixture is unavailable');
                    const launchPreparation = await createNativeAgentLaunchPreparationFixture();
                    const directory = launchPreparation.directory;
                    vi.mocked(axios.get).mockImplementation((url, config) => {
                        const path = new URL(String(url)).pathname;
                        return path === '/v1/account/encryption' || path.startsWith('/v4/connect/') || path.startsWith('/v2/connect/')
                            ? accountGet(url, config) : launchPreparation.homeGet(url, config);
                    });
                    const cliEnvironment = createEnvKeyScope([resolveAgentCliOverrideEnvKey('codex')]);
                    cliEnvironment.patch({ [resolveAgentCliOverrideEnvKey('codex')]: executable });
                    try {
                        transcript = await createNativeAgentJourneyTranscriptFixture('codex');
                        const session = transcript.client;
                        const dependencies = await account.dependenciesFor(foreground.runtime.registry, directory);
                        const prepareAndClaim = async (attemptId: string, vendorResumeId?: string) => {
                            const before = account.materializations.length;
                            const admission = await foreground.prepare({
                                attemptId, sessionId: session.sessionId, directory,
                                connectedServices: account.connectedServices,
                                ...(vendorResumeId ? { vendorResumeId } : {}),
                            }, dependencies);
                            if (!admission.ok) throw new Error(`Codex host admission refused: ${admission.error.code}`);
                            expect(account.materializations.length).toBeGreaterThan(before);
                            const claimed = await admission.prepared.claim({
                                canonicalSessionId: session.sessionId, httpPort: 40123,
                                foregroundSatisfiedProfileSecretRequirementNames: [],
                            });
                            if (!claimed.ok) throw new Error(`Codex host claim refused: ${claimed.error.code}`);
                            expect(claimed.environment.CODEX_HOME).toBeTruthy();
                            return { prepared: admission.prepared, claimed };
                        };
                        const initial = await prepareAndClaim('codex-create');
                        nativeHome = initial.claimed.environment.CODEX_HOME;
                        const environmentVariables = { ...native.launchEnvironment.values, ...initial.claimed.environment };
                        expect(native.requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
                        const runtimeRegistry = bindNativeAgentLaunchPreparationFixture(foreground.runtime.registry, launchPreparation);
                        const resolution = await resolveBackendEngineAdapterResolution('codex', { runtimeRegistry });
                        expect(resolution).toMatchObject({
                            backendId: 'codex', agentId: 'codex', selectedSource: 'plugin',
                            runtimeOwner: { selected: { kind: 'plugin_engine', pluginId: 'happier.agent.codex' } },
                            diagnostics: [],
                        });
                        if (!resolution) throw new Error('Bundled Codex runtime is unavailable');
                        const runtimeParams = {
                            directory,
                            metadata: createTestMetadata({ path: directory }),
                            machineId: 'machine-codex-composed', agentTargetKey: 'agent:happier.agent.codex/codex',
                            session, transcriptSession: session,
                            currentSessionPresentation: createCurrentSessionPresentationHost({
                                session, signal: new AbortController().signal,
                            }).bindCurrentSession,
                            messageBuffer: new MessageBuffer(), mcpServers: {},
                            permissionHandler: createProviderEnforcedPermissionHandler({ session, logPrefix: '[Codex composed journey]' }),
                            getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
                            runnerProcessIdentity: null, startupModelSelection: null,
                            runWithTerminalModelSelection: async effect => ({
                                status: 'completed', value: await effect(null, async localEffect => ({
                                    status: 'completed', value: await localEffect(),
                                })),
                            }),
                        } satisfies HostSessionRuntimeFactoryParams;
                        const sessionInput = {
                            credentials: account.credentials,
                            directory,
                            backendTarget: { kind: 'backend' as const, backendId: 'codex' },
                            permissionMode: 'read-only' as const,
                            environmentVariables,
                            unsetEnvironmentVariables: native.launchEnvironment.unset.filter(key => !Object.hasOwn(environmentVariables, key)),
                            resolveLateEnvironment: async () => ({ environmentVariables, unsetEnvironmentVariables: [],
                                sensitiveEnvironmentVariableNames: initial.claimed.sensitiveEnvironmentVariableNames,
                                sessionConnectedAccounts: initial.claimed.sessionConnectedAccounts }),
                        };
                        const plan = await resolution.engineAdapter.runtimeCore.createSessionRuntime(sessionInput);
                        if (!plan.config.createSessionRuntime) throw new Error('Codex host Session factory is unavailable');
                        const created = await plan.config.createSessionRuntime(runtimeParams);
                        const stopPublishing = transcript.observe(created.operations);
                        const events: unknown[] = [];
                        const unsubscribe = created.operations.subscribeRuntimeEvents(event => events.push(event));
                        let providerSessionId: string | null = null;
                        try {
                            await created.operations.sendTurnPrompt('first Codex question', { localId: 'codex-input-1', userMessageSeq: 1 });
                            await created.operations.waitForTurnCompletion({ timeoutMs: 5_000 });
                            providerSessionId = created.operations.readSessionIdentity().sessionId;
                            expect(providerSessionId).toBe('fresh-thread');
                            expect(native.requests.find(request => request.method === 'account/login/start')?.params)
                                .toMatchObject({ type: 'chatgptAuthTokens', chatgptAccountId: 'work-account' });
                            expect(native.requests.findIndex(request => request.method === 'account/login/start'))
                                .toBeLessThan(native.requests.findIndex(request => request.method === 'turn/start'));
                            // No model was supplied by the caller. The native thread's
                            // selected default must become the model of the first turn.
                            expect(native.requests.find(request => request.method === 'turn/start')?.params.model).toBe('fixture-model');
                            expect(events).toEqual(expect.arrayContaining([
                                expect.objectContaining({ kind: 'message-delta', text: 'CODEX_FIRST_REPLY' }),
                                expect.objectContaining({ kind: 'tool-call', toolCallId: 'call_05549126603d410aa7c87203edded7aa' }),
                                expect.objectContaining({ kind: 'tool-result', toolCallId: 'call_05549126603d410aa7c87203edded7aa' }),
                                expect.objectContaining({ kind: 'turn-complete' }),
                            ]));
                            await transcript.drain();
                            expect(await transcript.readTranscript()).toEqual(expect.arrayContaining([
                                expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({ content: expect.objectContaining({
                                    data: expect.objectContaining({ type: 'tool-call', callId: 'call_05549126603d410aa7c87203edded7aa' }),
                                }) }) } }),
                                expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({ content: expect.objectContaining({
                                    data: expect.objectContaining({ type: 'tool-result', callId: 'call_05549126603d410aa7c87203edded7aa' }),
                                }) }) } }),
                            ]));
                            expect(await created.operations.updateSessionRuntimeConfig({ modelId: 'fixture-model-two' }))
                                .toMatchObject({ status: 'applied' });
                            await created.operations.sendTurnPrompt('stop this Codex turn', { localId: 'codex-stop-1', userMessageSeq: 2 });
                            await vi.waitFor(() => expect(native.requests.filter(request => request.method === 'turn/start')).toHaveLength(2));
                            await created.operations.cancelTurn();
                            await created.operations.waitForTurnCompletion({ timeoutMs: 5_000 });
                            expect(native.requests.filter(request => request.method === 'turn/interrupt')).toHaveLength(1);
                            expect(native.requests.filter(request => request.method === 'turn/start')[1]?.params.model).toBe('fixture-model-two');
                            expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'turn-cancelled' })]));
                        } finally {
                            unsubscribe();
                            stopPublishing();
                            await created.operations.resetOrDisposeRuntime();
                        }
                        if (!providerSessionId) throw new Error('Codex did not publish its provider thread');
                        await initial.prepared.cleanup();
                        const resume = await prepareAndClaim('codex-resume', providerSessionId);
                        expect(native.requests.filter(request => request.method === 'turn/start')).toHaveLength(2);
                        const resumedEnvironment = { ...native.launchEnvironment.values, ...resume.claimed.environment };
                        const resumedPlan = await resolution.engineAdapter.runtimeCore.createSessionRuntime({
                            ...sessionInput, resume: providerSessionId,
                            environmentVariables: resumedEnvironment,
                            resolveLateEnvironment: async () => ({ environmentVariables: resumedEnvironment,
                                unsetEnvironmentVariables: resume.claimed.unsetEnvironmentVariableNames,
                                sensitiveEnvironmentVariableNames: resume.claimed.sensitiveEnvironmentVariableNames,
                                sessionConnectedAccounts: resume.claimed.sessionConnectedAccounts }),
                        });
                        if (!resumedPlan.config.createSessionRuntime) throw new Error('Codex resume factory is unavailable');
                        const resumed = await resumedPlan.config.createSessionRuntime(runtimeParams);
                        const stopPublishingResumed = transcript.observe(resumed.operations);
                        const resumedEvents: unknown[] = [];
                        const unsubscribeResumed = resumed.operations.subscribeRuntimeEvents(event => resumedEvents.push(event));
                        try {
                            await resumed.operations.sendTurnPrompt('second Codex question', { localId: 'codex-input-2', userMessageSeq: 3 });
                            await resumed.operations.waitForTurnCompletion({ timeoutMs: 5_000 });
                            expect(resumed.operations.readSessionIdentity().sessionId).toBe(providerSessionId);
                            expect(resumedEvents).toEqual(expect.arrayContaining([
                                expect.objectContaining({ kind: 'message-delta', text: 'CODEX_RESUMED_REPLY:first Codex question|second Codex question' }),
                                expect.objectContaining({ kind: 'turn-complete' }),
                            ]));
                            const launches: unknown[] = (await readFile(nativeCapturePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
                            expect(launches).toEqual([{ projectEnvironmentActive: true }, { projectEnvironmentActive: true }]);
                            expect(native.requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
                            expect(native.requests.filter(request => request.method === 'thread/resume').map(request => request.params.threadId))
                                .toEqual([providerSessionId]);
                            expect(native.requests.filter(request => request.method === 'turn/start').map(request => request.params.threadId))
                                .toEqual([providerSessionId, providerSessionId, providerSessionId]);
                        } finally {
                            unsubscribeResumed();
                            stopPublishingResumed();
                            await resumed.operations.resetOrDisposeRuntime();
                        }
                    } finally { cliEnvironment.restore(); }
                });
            } catch (error) {
                const nativeError = await readFile(nativeErrorPath, 'utf8').catch(() => 'No native process error captured');
                throw new Error(`${error instanceof Error ? error.message : String(error)}; ${nativeError}`, { cause: error });
            } finally {
                await transcript?.close();
                await account.cleanup();
            }
        }, {
            modelListResponse: { data: [
                { id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture Model', isDefault: true },
                { id: 'fixture-model-two', model: 'fixture-model-two', displayName: 'Fixture Model Two', isDefault: false },
            ], nextCursor: null },
            onTurnStart: async ({ socket, params, turnId }) => {
                // Vendor persistence is part of this native-process boundary.
                // Host resume admission still runs the real declared-file hook.
                if (!nativeHome) throw new Error('Host admission did not prepare a native home');
                await mkdir(join(nativeHome, 'sessions'), { recursive: true });
                await writeFile(join(nativeHome, 'sessions', `rollout-2026-11-10T00-00-00-${String(params.threadId)}.jsonl`),
                    `${JSON.stringify({ type: 'session_meta', payload: { id: params.threadId } })}\n`);
                const input = Array.isArray(params.input) ? params.input : [];
                const prompt = input.flatMap((item: unknown) => item && typeof item === 'object'
                    && 'text' in item && typeof item.text === 'string' ? [item.text] : []).join('');
                if (prompt === 'stop this Codex turn') return;
                prompts.push(prompt);
                if (prompts.length === 1) {
                    // Captured Codex 0.162.1 code-mode exec call and result.
                    const callId = 'call_05549126603d410aa7c87203edded7aa';
                    for (const item of [{
                        type: 'custom_tool_call', id: 'ctc_0c52db4d85e61039016ad3fc2889ec81918f3a156ec4635a81',
                        status: 'completed', call_id: callId, name: 'exec',
                        input: 'const r = await tools.exec_command({cmd:"pwd", max_output_tokens:1000});\ntext(JSON.stringify(r));\n',
                        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1', create_time: 1792277544.5442138 },
                    }, {
                        type: 'custom_tool_call_output', id: 'ctco_01a14c10-ff7f-78b1-82ba-7f0e8c706b09',
                        call_id: callId, output: [
                            { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
                            { type: 'input_text', text: '{"chunk_id":"34b657","wall_time_seconds":0,"exit_code":101,"original_token_count":74,"output":"\\nthread \'main\' (1453173) panicked at linux-sandbox/src/launcher.rs:60:13:\\nbubblewrap is unavailable: no system bwrap was found on PATH and no bundled codex-resources/bwrap binary was found next to the Codex executable\\nnote: run with RUST_BACKTRACE=1 environment variable to display a backtrace\\n"}' },
                        ],
                        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1', create_time: 1792277544.831558 },
                    }]) socket.send(JSON.stringify({ method: 'rawResponseItem/completed', params: { threadId: params.threadId, turnId, item } }));
                }
                const delta = prompts.length === 1 ? 'CODEX_FIRST_REPLY' : `CODEX_RESUMED_REPLY:${prompts.join('|')}`;
                socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: {
                    threadId: params.threadId, turnId, itemId: `reply-${turnId}`, delta,
                } }));
                socket.send(JSON.stringify({ method: 'turn/completed', params: {
                    threadId: params.threadId, turn: { id: turnId, status: 'completed' },
                } }));
            },
        }); } finally { diagnostic.mockRestore(); }
    }, 60_000);
});
