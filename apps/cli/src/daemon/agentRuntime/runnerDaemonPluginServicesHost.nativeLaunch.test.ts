import { describe, expect, it, vi } from 'vitest';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { RunnerDaemonPluginServiceOperationV1Schema, decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createUnavailableManagedServices } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { authorizeResolvedAgentNativeExecLaunchForHost, createStablePluginExecService, spawnAuthorizedHostExecLaunchForHost,
    issueAgentNativeLaunchQualifierForHost, type HostAgentNativeLaunchPreparation } from '@/plugins/runtime/invocation/services/exec';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { createPublicAcpSession } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createRunnerDaemonPluginServicesHost } from './runnerDaemonPluginServicesHost';

import { buildPiRpcLaunch } from '../../../../../packages/plugins/pi/src/agent/runtime/rpc/args';
import { buildOpenCodeManagedServerSpawnSpec } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/spawnSpec';

const executable = Object.freeze({ kind: 'systemTool', id: 'fixture-node' } as const);

// Replace only RunAs at the OS boundary. The real child reports its physical
// cwd and received frame; this does not simulate cross-UID filesystem access.
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
        if (args[0] !== 'sudo' || !args[1]?.includes('/fixture/happier-private-cwd')) return actual.spawn(...args);
        return actual.spawn(process.execPath, ['-e', `
            const input = [];
            process.stdin.on('data', chunk => input.push(chunk));
            process.stdin.on('end', () => process.stdout.write(JSON.stringify({
                cwd: process.cwd(), frame: Buffer.concat(input).toString('base64'),
            })));
        `], args[2]);
    } };
});

describe('runner native launch authority', () => {
    it.skipIf(process.platform !== 'linux').each(['ordinary', 'custom ACP', 'OpenCode managed service', 'Pi'] as const)(
        'keeps the private payload cwd out of the physical RunAs spawn through %s authorization', async variant => {
        await withTempDir('runner-private-cwd-', async root => {
            const memberHome = join(root, 'member-home');
            await mkdir(memberHome, { mode: 0o700 });
            const cwd = await realpath(memberHome);
            const unavailable = createUnavailablePluginServices();
            const controller = new AbortController();
            const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home',
                requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } }),
                home: cwd, agentUid: 994, agentGid: 994 };
            const runtimeHome = join(cwd, 'runtime');
            const pi = buildPiRpcLaunch({ happierToolsExtension: { extensionPath: join(runtimeHome, 'tools.mjs'), configPath: join(runtimeHome, 'tools.json') } });
            const openCode = buildOpenCodeManagedServerSpawnSpec({ id: 'fixture', dialect: 'v2', systemToolId: 'opencode-cli' });
            if (openCode.mode.kind !== 'spawn') throw new Error('Expected owned OpenCode server');
            const requiredFiles = variant === 'Pi' ? pi.requiredFiles : variant === 'OpenCode managed service' ? openCode.mode.launch.requiredFiles : undefined;
            const args = variant === 'Pi' ? pi.args : variant === 'OpenCode managed service' ? openCode.mode.launch.args ?? [] : ['--version'];
            let selectedMaterials: { relativePath: string; contentBase64: string }[] = [];
            const agentIsolation = { read: () => ({ enabled: true,
                status: { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' },
                workspaceRoots: [cwd], memberIdentity, localTransport: { agentUid: 994, agentGid: 994 },
                launch: { managedHappierBinaryPath: '/fixture/happier-private-cwd',
                    runtimeHome, selectedEnvironmentKeys: [], selectedMaterials,
                    sessionMcpContext: { v: 1 as const, socketPath: join(root, 'mcp.sock'), bearerToken: 'selected-session' } } }) };
            const exec = createStablePluginExecService({ signal: controller.signal,
                isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => cwd });
            const services = { ...unavailable, exec, availability: (id: Parameters<typeof unavailable.availability>[0]) =>
                id === 'exec' ? { status: 'available' as const } : unavailable.availability(id) };
            const host = createRunnerDaemonPluginServicesHost({ createInvocation: async () => ({
                services, agentIsolation, prepareAgentNativeLaunch: async () => undefined, resourceDescriptors: {},
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
            const runnerServices = await prepareRunnerDaemonPluginServices({
                invocationId: 'private-cwd', signal: controller.signal, local: unavailable,
                dispatch: async (operation, options) => {
                    const result = await host.dispatch({ sessionId: 'session-1',
                        runner: { pid: 123, processStartTimeMs: 1, processCommandHash: '4'.repeat(64), snapshotIdentity: 'snapshot-1' },
                        retainedAgent: binding, operation: RunnerDaemonPluginServiceOperationV1Schema.parse(operation), signal: options?.signal });
                    AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: true, result });
                    return decodeRunnerDaemonPluginServiceWireValueV1(result.value);
                },
            });
            try {
                if (variant === 'Pi') {
                    await expect(authorizeResolvedAgentNativeExecLaunchForHost(runnerServices.exec,
                        { command: process.execPath, args, cwd, env: {}, requiredFiles }, undefined, undefined, 'exec'))
                        .rejects.toMatchObject({ code: 'agent_launch_required_file_unavailable' });
                    selectedMaterials = [{ relativePath: 'tools.mjs', contentBase64: '' }, { relativePath: 'tools.json', contentBase64: '' }];
                }
                const result = variant === 'ordinary'
                    ? await runnerServices.exec.run({ executable, args: ['--version'], cwd: { root: 'workspace', relativePath: '' } })
                    : await (async () => {
                        const launch = await authorizeResolvedAgentNativeExecLaunchForHost(runnerServices.exec,
                            { command: process.execPath, args, cwd, env: {}, requiredFiles, stdin: new Uint8Array() },
                            undefined, undefined, 'exec');
                        const supervised = spawnAuthorizedHostExecLaunchForHost(launch);
                        try { return await supervised.handle.wait(); }
                        finally { await supervised.dispose(); await launch.release(); }
                    })();
                expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                const output = JSON.parse(new TextDecoder().decode(result.stdout));
                const frame = await readAgentLaunchFrame(Readable.from([Buffer.from(output.frame, 'base64')], { objectMode: false }));
                expect(frame).toMatchObject({ cwd, executable: process.execPath, args: variant === 'ordinary' ? ['--version'] : [...args],
                    nativeIdentity: { username: memberIdentity.username, home: cwd, agentUid: 994, agentGid: 994 } });
                expect(output.cwd).toBe(process.cwd());
            } finally { controller.abort(); await host.dispose(); }
        });
    });

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
                // Custom ACP supplies an explicit undefined requiredFiles key.
                // Initialize a real ACP subprocess after the runner/daemon hop.
                const script = writeAcpTestAgentScript({ dir: root, fileName: 'custom-acp.mjs', source: `
                    import { createInterface } from 'node:readline';
                    for await (const line of createInterface({ input: process.stdin })) {
                        const r = JSON.parse(line); if (r.id === undefined) continue;
                        const result = r.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
                            : r.method === 'session/new' ? { sessionId: 'custom-ready' } : {};
                        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
                    }
                ` });
                const session = await createPublicAcpSession({ kind: 'create', sessionId: 'custom', cwd: root },
                    { transport: { kind: 'stdio', executable } }, {
                        pluginId: 'fixture.plugin', agentId: 'custom', signal: controller.signal, isCurrent: () => true,
                        exec: runnerServices.exec, nativeLaunch,
                        resolveHostLaunch: () => ({ command: process.execPath, args: [script],
                            env: { KEEP: 'request', REMOVE: 'old' }, unsetEnv: [], timeouts: {}, release() {} }),
                        systemTools: { resolve: async () => { throw new Error('Already resolved'); } },
                        interactions: { async request() { throw new Error('Unexpected interaction'); } },
                        media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
                        models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
                    });
                await session.dispose();
                const redaction = createProviderRedactionLease({ values: [] });
                const managedOwner = createManagedServicesOwner({
                    registerRawForRedaction: (_scope, value) => redaction.add([value]),
                    processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
                    dependencies: createUnavailableManagedServices().dependencies, resolveScope: scope => scope,
                });
                const serverExec = createStablePluginExecService({ signal: controller.signal, isOccurrenceCurrent: () => true,
                    environment: { REMOVE: 'old' }, resolvePath: async () => root,
                    resolveExecutable: async () => ({ command: process.execPath }),
                    authorizeLaunch: (request, options) => authorizeResolvedAgentNativeExecLaunchForHost(runnerServices.exec, {
                        command: process.execPath, args: ['-e', `
                            require('node:http').createServer((req,res)=>res.end('{}')).listen(
                                Number(process.argv[process.argv.indexOf('--port')+1]), '127.0.0.1');
                        `, '--', ...(request.args ?? [])], cwd: root,
                        env: { REMOVE: 'old', ...request.env }, requiredFiles: request.requiredFiles,
                    }, options?.signal, undefined, 'managedService'),
                });
                const managed = managedOwner.bindScope({ occurrenceId: 'opencode-ready', pluginId: 'fixture.plugin',
                    contributionQualifiedId: 'fixture.plugin/agents/opencode', operationId: 'session',
                    signal: controller.signal, isOccurrenceCurrent: () => true }, serverExec);
                try {
                    const service = await managed.supervise(buildOpenCodeManagedServerSpawnSpec({ id: 'opencode-ready',
                        dialect: 'v2', systemToolId: 'opencode-cli', additionalEnv: { KEEP: 'request' } }));
                    try { await service.waitUntilHealthy(); }
                    finally { await service.dispose(); }
                } finally { await managedOwner.dispose(); redaction.close(); }


                isolationEnabled = true;
                await expect(authorizeResolvedAgentNativeExecLaunchForHost(runnerServices.exec, {
                    command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, env: { KEEP: 'request', REMOVE: 'old' },
                }, undefined, nativeLaunch)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
            } finally { controller.abort(); await host.dispose(); }
        });
    });
});
