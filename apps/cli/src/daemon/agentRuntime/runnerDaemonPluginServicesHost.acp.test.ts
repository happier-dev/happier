import { join } from 'node:path';
import { expect, it } from 'vitest';

import { createPublicAcpSession } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import {
    decodeRunnerDaemonPluginServiceWireValueV1,
    RunnerDaemonPluginServiceOperationV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createRunnerDaemonPluginServicesHost } from './runnerDaemonPluginServicesHost';

it('starts an ACP agent and releases its launch through source-custody runner services', async () => {
    await withTempDir('runner-source-acp-', async dir => {
        const script = writeAcpTestAgentScript({ dir, fileName: 'agent.mjs', source: `
            import { createInterface } from 'node:readline';
            for await (const line of createInterface({ input: process.stdin })) {
                const request = JSON.parse(line);
                if (request.id === undefined) continue;
                const result = request.method === 'initialize'
                    ? { protocolVersion: 1, agentCapabilities: {} }
                    : request.method === 'session/new'
                        ? { sessionId: 'source-native-session' }
                        : { stopReason: 'end_turn' };
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
            }
        ` });
        const retainedAgent = createAgentSessionRunnerFactoryBinding({
            v: 1, pluginId: 'fixture.plugin', pluginVersion: '1.0.0',
            agentId: 'fixture.agent', localAgentId: 'agent',
            sourceCustody: { kind: 'development', registeredRootId: dir },
            locator: { module: './agent.ts', export: 'createRuntime', runtimeApiVersion: 1 },
            normalizedModulePath: join(dir, 'agent.ts'), loadMode: 'source-ts',
        });
        const signal = new AbortController().signal;
        const unavailable = createUnavailablePluginServices();
        const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
            prepareAgentNativeLaunch: async () => undefined,
            resolveExecutable: async () => { throw new Error('Resolved ACP launch only'); },
            resolvePath: async () => dir,
        });
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services: { ...unavailable, exec,
                        availability: id => id === 'exec' ? { status: 'available' } : unavailable.availability(id) },
                    prepareAgentNativeLaunch: async () => undefined,
                    resourceDescriptors: {},
                    subscriptionCapabilities: { settingsWatch: false, eventSubscriptions: [], resourceWatches: [], notificationPreferencesWatch: false },
                    dispose() {}, authorizeOperation: () => true,
                    executeCurrentGlobalAction: unavailable.actions.execute,
                    currentGlobalMcp: unavailable.mcp, currentGlobalExternalSessions: unavailable.sessions.external,
                };
            },
        });
        const releases: Promise<unknown>[] = [];
        const runnerServices = await prepareRunnerDaemonPluginServices({
            invocationId: 'source-acp-invocation', signal, local: unavailable,
            dispatch(operation, options) {
                const pending = host.dispatch({ sessionId: 'session-1', retainedAgent,
                    runner: { pid: 123, processStartTimeMs: 1, processCommandHash: '4'.repeat(64), snapshotIdentity: 'source-snapshot' },
                    operation: RunnerDaemonPluginServiceOperationV1Schema.parse(operation), signal: options?.signal,
                }).then(result => decodeRunnerDaemonPluginServiceWireValueV1(result.value));
                if (operation.kind === 'plugin_exec.launch.release_v1') releases.push(pending);
                return pending;
            },
        });
        try {
            const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'session-1', cwd: dir },
                { transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } } }, {
                    pluginId: 'fixture.plugin', agentId: 'agent', signal, isCurrent: () => true, exec: runnerServices.exec,
                    resolveHostLaunch: () => ({ command: process.execPath, args: [script], env: {}, unsetEnv: [], timeouts: {} }),
                    systemTools: { resolve: async () => { throw new Error('Resolved ACP launch only'); } },
                    interactions: { async request() { throw new Error('Unexpected interaction'); } },
                    media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
                    models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
                });
            try {
                expect(await runtime.send({ inputIds: ['input-1'], input: { text: 'Continue' },
                    delivery: { kind: 'newTurn', turnId: 'turn-1' } })).toEqual({ status: 'admitted' });
            } finally { await runtime.dispose(); }
            expect(releases).toHaveLength(1);
            await expect(releases[0]).resolves.toBeNull();
        } finally { await host.dispose(); }
    });
});
