import { describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { RunnerDaemonPluginServiceOperationV1Schema, decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { authorizeResolvedAgentNativeExecLaunchForHost, createStablePluginExecService,
    issueAgentNativeLaunchQualifierForHost, type HostAgentNativeLaunchPreparation } from '@/plugins/runtime/invocation/services/exec';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createRunnerDaemonPluginServicesHost } from './runnerDaemonPluginServicesHost';

const executable = Object.freeze({ kind: 'systemTool', id: 'fixture-node' } as const);

describe('runner native launch authority', () => {
    it('transports only host-recognized native purpose and captures the final tuple through the strict daemon protocol', async () => {
        await withTempDir('runner native qualifier ', async root => {
            await writeFile(join(root, 'mise.toml'), '[env]\nKEEP = "native"\n');
            const unavailable = createUnavailablePluginServices();
            let isolationEnabled = false;
            const agentIsolation = { read: () => ({ enabled: isolationEnabled,
                status: { kind: 'unavailable' as const, code: 'launch_probe_failed' as const }, workspaceRoots: [root] }) };
            const resolvedRelease = vi.fn();
            const nativeRun = vi.fn(async () => ({ exitCode: 0, stdout: 'KEEP=native\0NATIVE=ready\0' }));
            const prepareAgentNativeLaunch = vi.fn<HostAgentNativeLaunchPreparation>(async (_signal, cwd, environment) => {
                expect(cwd).toBe(root);
                expect(environment).toMatchObject({ KEEP: 'request', REMOVE: 'old' });
                return { projectLaunch: { status: 'ready', reviewedEffectDigest: 'effect-current', toolchain: {
                    selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, platform: 'linux',
                    io: { resolveTool: async () => ({ executablePath: '/native/mise', version: '2026.10.4' }), run: nativeRun },
                } } };
            });
            const exec = createStablePluginExecService({ environment: { REMOVE: 'old' },
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async () => ({ command: process.execPath, release: resolvedRelease }), resolvePath: async () => root,
            });
            const services = { ...unavailable, exec, availability: (id: Parameters<typeof unavailable.availability>[0]) =>
                id === 'exec' ? { status: 'available' as const } : unavailable.availability(id) };
            const host = createRunnerDaemonPluginServicesHost({ createInvocation: async () => ({
                services, prepareAgentNativeLaunch, agentIsolation, resourceDescriptors: {},
                subscriptionCapabilities: { settingsWatch: false, eventSubscriptions: [], resourceWatches: [], notificationPreferencesWatch: false },
                dispose() {}, authorizeOperation: () => true, executeCurrentGlobalAction: async () => null,
                currentGlobalMcp: services.mcp, currentGlobalExternalSessions: services.sessions.external,
            }) });
            const binding = createAgentSessionRunnerFactoryBinding({
                v: 1, pluginId: 'fixture.plugin', pluginVersion: '1.0.0', agentId: 'fixture.agent', localAgentId: 'agent',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'localPath' },
                locator: { module: './agent.js', export: 'createRuntime', runtimeApiVersion: 1 },
                normalizedModulePath: '/plugins/fixture/agent.js', loadMode: 'immutable-js',
            });
            const controller = new AbortController();
            const runnerServices = await prepareRunnerDaemonPluginServices({
                invocationId: 'native-launch', signal: controller.signal,
                dispatch: async (operation, options) => {
                    const result = await host.dispatch({ sessionId: 'session-1',
                        runner: { pid: 123, processStartTimeMs: 1, processCommandHash: '4'.repeat(64), snapshotIdentity: 'snapshot-1' },
                        retainedAgent: binding, operation: RunnerDaemonPluginServiceOperationV1Schema.parse(operation), signal: options?.signal });
                    AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: true, result });
                    return decodeRunnerDaemonPluginServiceWireValueV1(result.value);
                },
                local: { availability: unavailable.availability, logger: unavailable.logger, sessions: unavailable.sessions,
                    managedServices: unavailable.managedServices, machineProvisioners: unavailable.machineProvisioners,
                    exec: unavailable.exec, interactions: unavailable.interactions, targetedContributions: unavailable.targetedContributions,
                    composerContent: unavailable.composerContent, backgroundServices: unavailable.backgroundServices },
            });
            try {
                const request = { executable, cwd: root, env: { KEEP: 'request' }, args: ['-e',
                    'process.stdout.write(JSON.stringify({keep:process.env.KEEP,native:process.env.NATIVE,remove:process.env.REMOVE}))'] };
                const forgedOptions = { signal: controller.signal, agentNativeLaunch: true };
                const generic = await runnerServices.exec.run(request, forgedOptions);
                expect(JSON.parse(new TextDecoder().decode(generic.stdout))).toEqual({ keep: 'request', remove: 'old' });
                expect(prepareAgentNativeLaunch).not.toHaveBeenCalled();
                const nativeLaunch = issueAgentNativeLaunchQualifierForHost(runnerServices.exec);
                const native = await runnerServices.exec.run(request, { nativeLaunch });
                expect(JSON.parse(new TextDecoder().decode(native.stdout))).toEqual({ keep: 'native', native: 'ready' });
                const release = vi.fn();
                // Binary launch input is valid above the generic response's former base64 string ceiling.
                const providerInput = new Uint8Array(50_000).fill(7);
                const final = await authorizeResolvedAgentNativeExecLaunchForHost(runnerServices.exec, {
                    command: process.execPath, args: ['--opaque', 'spaces "quotes" \\'], cwd: root,
                    env: { KEEP: 'request', REMOVE: 'old' }, stdin: providerInput,
                    timeoutMs: 999, maxStdoutBytes: 1000, maxStderrBytes: 2000, release,
                }, undefined, nativeLaunch);
                expect(final).toMatchObject({ command: process.execPath, args: ['--opaque', 'spaces "quotes" \\'], cwd: root,
                    env: { KEEP: 'native', NATIVE: 'ready' }, stdin: providerInput, timeoutMs: 999,
                    maxStdoutBytes: 1000, maxStderrBytes: 2000 });
                expect(final.env).not.toHaveProperty('REMOVE');
                await final.release(); await final.release();
                expect(release).toHaveBeenCalledOnce();
                expect(nativeRun).toHaveBeenCalledTimes(2);
                isolationEnabled = true;
                await expect(authorizeResolvedAgentNativeExecLaunchForHost(runnerServices.exec, {
                    command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, env: { KEEP: 'request', REMOVE: 'old' },
                }, undefined, nativeLaunch)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
            } finally { controller.abort(); await host.dispose(); }
        });
    });
});
