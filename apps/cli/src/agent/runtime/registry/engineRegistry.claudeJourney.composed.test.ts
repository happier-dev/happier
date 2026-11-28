import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import { readConnectedAccountRequestAuthCapabilityFile } from '@happier-dev/agents/request-auth';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '@happier-dev/plugin-sdk/connected-accounts';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { AgentSessionModelsSource, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createClaudeForegroundConnectedAccountFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.codexConnectedServices.testkit';
import { withRealForegroundAdmissionFixture } from '@/daemon/agentRuntime/foregroundAdmission.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CLAUDE_SDK_SESSION_HOOK_CALLBACK_ID } from '../../../../../../packages/plugins/claude/src/agent/hooks/settings';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';
import {
    bindNativeAgentLaunchPreparationFixture,
    createNativeAgentLaunchPreparationFixture,
} from './engineRegistry/nativeAgentSession.composed.testkit';

it.skipIf(process.platform === 'win32')('prepares the catalog-selected Claude Session, replies, and reopens the native conversation', async () => {
    await withTempDir('claude-catalog-session-journey-', async directory => {
        const nativeSessionId = '44444444-4444-4444-8444-444444444444';
        const capturePath = join(directory, 'launches.jsonl');
        const conversationPath = join(directory, 'conversation.json');
        const nativeErrorPath = join(directory, 'native-error.txt');
        const executablePath = join(directory, 'claude-fixture');
        // The vendor executable is the process boundary. Catalog admission,
        // native launch preparation, SDK transport, and Session owners stay real.
        await writeFile(executablePath, `#!${process.execPath}
const fs = require('node:fs');
process.on('uncaughtException', error => {
    fs.writeFileSync(${JSON.stringify(nativeErrorPath)}, error.stack || String(error));
    process.stderr.write(error.stack || String(error));
    process.exit(1);
});
if (process.argv.includes('--version')) { console.log('2.1.287 (Claude Code)'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--effort --system-prompt-snapshot'); process.exit(0); }
const sessionId = ${JSON.stringify(nativeSessionId)};
const conversationPath = ${JSON.stringify(conversationPath)};
const path = require('node:path');
const transcriptPath = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replaceAll('/', '-'), sessionId + '.jsonl');
fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
if (!fs.existsSync(transcriptPath)) fs.writeFileSync(transcriptPath, '');
const hooks = JSON.parse(fs.readFileSync(path.join(process.argv[process.argv.indexOf('--plugin-dir') + 1], 'hooks/hooks.json'), 'utf8')).hooks;
const emitHook = (name, payload) => require('node:child_process').execSync(hooks[name][0].hooks[0].command, {
    input: JSON.stringify({ hook_event_name: name, session_id: sessionId, cwd: process.cwd(), ...payload }),
});
const resumed = process.argv.includes('--resume');
if (resumed && process.argv[process.argv.indexOf('--resume') + 1] !== sessionId) process.exit(81);
if (resumed && !fs.existsSync(conversationPath)) process.exit(82);
const conversation = resumed ? JSON.parse(fs.readFileSync(conversationPath, 'utf8')) : [];
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), resumed, projectEnvironmentActive: process.env.NATIVE === 'active',
    requestAuthPath: process.env[${JSON.stringify(CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV)}] }) + '\\n');
const send = row => process.stdout.write(JSON.stringify(row) + '\\n');
const pendingHooks = new Map();
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.type === 'control_request') {
            send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {} } });
        } else if (request.type === 'control_response') {
            const completeHook = pendingHooks.get(request.response.request_id);
            pendingHooks.delete(request.response.request_id);
            if (request.response.subtype !== 'success') throw new Error('Native SDK hook was refused');
            completeHook?.();
        } else if (request.type === 'user') {
            const content = request.message.content;
            const prompt = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('');
            conversation.push(prompt);
            fs.writeFileSync(conversationPath, JSON.stringify(conversation));
            send({ ...request, isReplay: true, parent_tool_use_id: null });
            emitHook('SessionStart', { source: resumed ? 'resume' : 'startup', transcript_path: transcriptPath });
            send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-4-6', tools: [], mcp_servers: [], slash_commands: [] });
            const hookRequestId = 'prompt-submit-' + conversation.length;
            pendingHooks.set(hookRequestId, () => {
                fs.appendFileSync(transcriptPath, JSON.stringify({ type: 'user', uuid: request.uuid, sessionId,
                    timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }) + '\\n');
                const text = resumed ? 'CLAUDE_RESUMED:' + conversation.join('|') : 'CLAUDE_NATIVE_OK';
                send({ type: 'assistant', uuid: 'answer-' + conversation.length, session_id: sessionId, parent_tool_use_id: null,
                    message: { id: 'message-' + conversation.length, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
                send({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: text, num_turns: 1,
                    total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {} });
            });
            send({ type: 'control_request', request_id: hookRequestId, request: { subtype: 'hook_callback',
                callback_id: ${JSON.stringify(CLAUDE_SDK_SESSION_HOOK_CALLBACK_ID)},
                input: { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: process.cwd(), prompt } } });
        }
    }
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });

        const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH', 'CLAUDE_CONFIG_DIR']);
        env.patch({ HAPPIER_CLAUDE_PATH: executablePath, CLAUDE_CONFIG_DIR: join(directory, 'claude-home') });
        onTestFinished(() => env.restore());
        const account = await createClaudeForegroundConnectedAccountFixture();
        try {
            await withRealForegroundAdmissionFixture({
                createRuntime: ({ home, controller }) => createAdmittedPluginRuntimeFixture({
                    happyHomeDir: home,
                    controller,
                    runtimeOptions: {
                        ...account.runtimeOptions,
                        // Account persistence is the boundary; real declaration defaults
                        // and the production settings host resolve the empty record.
                        accountSettingsRecordAdapter: {
                            async bindOperation() {
                                return {
                                    async readRecord() { return { status: 'present' as const, revision: 1, values: {} }; },
                                    async writeRecord() { throw new Error('The journey must not write Account settings'); },
                                };
                            },
                        },
                    },
                }),
            }, async foreground => {
                const accountGet = vi.mocked(axios.get).getMockImplementation();
                if (!accountGet) throw new Error('Connected Account HTTP fixture is unavailable');
                const preparation = await createNativeAgentLaunchPreparationFixture();
                vi.mocked(axios.get).mockImplementation((url, config) => {
                    const path = new URL(String(url)).pathname;
                    return path === '/v1/account/encryption' || path.startsWith('/v4/connect/') || path.startsWith('/v2/connect/')
                        ? accountGet(url, config) : preparation.homeGet(url, config);
                });
                env.patch({ HAPPIER_CLAUDE_PATH: executablePath });
                const sessionDirectory = preparation.directory;
                const session = createMutableApiSessionClientFixture({
                    sessionId: 'claude-composed-session',
                    metadata: createTestMetadata({ flavor: 'claude', path: sessionDirectory }),
                });
                const signal = new AbortController().signal;
                const descriptor = { v: 1, agentId: 'claude', agent: { backendMode: 'agentSdk' } } as const;
                try {
                    const dependencies = await account.dependenciesFor(foreground.runtime.registry, sessionDirectory);
                    const resolution = await resolveBackendEngineAdapterResolution('claude', {
                        runtimeRegistry: bindNativeAgentLaunchPreparationFixture(foreground.runtime.registry, preparation),
                        startupRuntimeDescriptorV1: descriptor,
                    });
                    expect(resolution?.agent.identity).toEqual({ pluginId: 'happier.agent.claude', localId: 'claude' });
                    if (!resolution) throw new Error('Bundled Claude runtime was not admitted');
                    const params = {
                        directory: sessionDirectory,
                        metadata: session.getMetadataSnapshot()!,
                        machineId: 'claude-journey-machine',
                        agentTargetKey: 'backend:claude',
                        session,
                        transcriptSession: session,
                        currentSessionPresentation: createCurrentSessionPresentationHost({ session, signal }).bindCurrentSession,
                        messageBuffer: new MessageBuffer(),
                        mcpServers: {},
                        permissionHandler: createProviderEnforcedPermissionHandler({ session, logPrefix: '[Claude composed journey]' }),
                        getPermissionMode: () => 'default',
                        memoryRecallGuidanceEnabled: false,
                        runnerProcessIdentity: null,
                        startupModelSelection: null,
                        async runWithTerminalModelSelection(effect) {
                            return { status: 'completed', value: await effect(null, async localEffect => ({ status: 'completed', value: await localEffect() })) };
                        },
                    } satisfies HostSessionRuntimeFactoryParams;

                    const open = async (resume?: string) => {
                        const admission = await foreground.prepare({
                            attemptId: resume ? 'claude-resume' : 'claude-create', sessionId: session.sessionId,
                            agentId: 'claude', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                            runtimeDescriptorV1: descriptor,
                            connectedServices: account.connectedServices,
                            ...(resume ? { vendorResumeId: resume } : {}),
                        }, dependencies);
                        if (!admission.ok) throw new Error(`Claude host admission refused: ${admission.error.code}`);
                        const claimed = await admission.prepared.claim({
                            canonicalSessionId: session.sessionId, httpPort: 40123,
                            foregroundSatisfiedProfileSecretRequirementNames: [],
                        });
                        if (!claimed.ok) throw new Error(`Claude host claim refused: ${claimed.error.code}`);
                        expect(claimed.environment.CLAUDE_CONFIG_DIR).toBeTruthy();
                        const capabilityPath = claimed.environment[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV];
                        expect(capabilityPath).toBeTruthy();
                        const capability = await readConnectedAccountRequestAuthCapabilityFile(capabilityPath!);
                        const subject = account.requestAuthRegistry.authenticate(capability?.capability);
                        expect(subject?.resolvePurposeUse(account.purpose)?.binding.target).toEqual({
                            kind: 'account', account: { service: account.service, accountId: 'work' },
                        });
                        const environmentVariables = claimed.environment;
                        const plan = await resolution.engineAdapter.runtimeCore.createSessionRuntime({
                            credentials: account.credentials, directory: sessionDirectory, backendTarget: { kind: 'backend', backendId: 'claude' },
                            startingMode: 'remote', permissionMode: 'default',
                            environmentVariables,
                            resolveLateEnvironment: async () => ({ environmentVariables,
                                unsetEnvironmentVariables: claimed.unsetEnvironmentVariableNames,
                                sensitiveEnvironmentVariableNames: claimed.sensitiveEnvironmentVariableNames,
                                sessionConnectedAccounts: claimed.sessionConnectedAccounts }),
                            ...(resume ? { resume } : {}),
                        });
                        if (!plan.config.createSessionRuntime) throw new Error('Claude Session factory is unavailable');
                        return { ...await plan.config.createSessionRuntime(params), admission: admission.prepared };
                    };

                    const first = await open();
                    const firstEvents: AgentSessionRuntimeEvent[] = [];
                    const stopFirst = first.operations.subscribeRuntimeEvents(event => firstEvents.push(event));
                    try {
                        await first.operations.sendTurnPrompt('Remember the first turn', { localId: 'claude-input-1', userMessageSeq: 1 });
                        await first.operations.waitForTurnCompletion();
                        expect(first.operations.readSessionIdentity(), JSON.stringify(firstEvents)).toEqual({ sessionId: nativeSessionId });
                        // With no explicit model request, native response evidence owns
                        // the selected default; the host must publish that exact model.
                        const native = first.nativeRuntime as typeof first.nativeRuntime & { models?: AgentSessionModelsSource };
                        expect(native.models?.read().currentModelId).toBe('claude-sonnet-4-6');
                        expect(firstEvents).toEqual(expect.arrayContaining([
                            expect.objectContaining({ kind: 'provider-session-id', providerSessionId: nativeSessionId }),
                            expect.objectContaining({ kind: 'transcript-message-committed', text: 'CLAUDE_NATIVE_OK' }),
                            expect.objectContaining({ kind: 'turn-complete' }),
                        ]));
                    } finally {
                        stopFirst();
                        await first.operations.resetOrDisposeRuntime();
                        await first.admission.cleanup();
                    }

                    const resumed = await open(nativeSessionId);
                    const resumedEvents: AgentSessionRuntimeEvent[] = [];
                    const stopResumed = resumed.operations.subscribeRuntimeEvents(event => resumedEvents.push(event));
                    try {
                        await resumed.operations.sendTurnPrompt('Continue the conversation', { localId: 'claude-input-2', userMessageSeq: 2 });
                        await resumed.operations.waitForTurnCompletion();
                        expect(resumed.operations.readSessionIdentity()).toEqual({ sessionId: nativeSessionId });
                        const native = resumed.nativeRuntime as typeof resumed.nativeRuntime & { models?: AgentSessionModelsSource };
                        expect(native.models?.read().currentModelId).toBe('claude-sonnet-4-6');
                        expect(resumedEvents).toEqual(expect.arrayContaining([
                            expect.objectContaining({ kind: 'transcript-message-committed', text: 'CLAUDE_RESUMED:Remember the first turn|Continue the conversation' }),
                            expect.objectContaining({ kind: 'turn-complete' }),
                        ]));
                        const launches: unknown[] = (await readFile(capturePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
                        expect(launches).toEqual([
                            expect.objectContaining({ resumed: false, projectEnvironmentActive: true, requestAuthPath: expect.any(String), args: expect.not.arrayContaining(['--model']) }),
                            expect.objectContaining({ resumed: true, projectEnvironmentActive: true, requestAuthPath: expect.any(String), args: expect.arrayContaining(['--resume', nativeSessionId]) }),
                        ]);
                    } finally {
                        stopResumed();
                        await resumed.operations.resetOrDisposeRuntime();
                    }
                } finally {
                    await session.close();
                }
            });
        } catch (error) {
            const nativeError = await readFile(nativeErrorPath, 'utf8').catch(() => 'No native process error captured');
            throw new Error(`${error instanceof Error ? error.message : String(error)}; ${nativeError}`, { cause: error });
        } finally {
            await account.cleanup();
            env.restore();
        }
    });
});
