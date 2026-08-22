import { describe, expect, it, vi } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';

import {
    adaptStablePluginExecLegacyProcessHandle,
    authorizePluginExecLaunchForHost,
    createStableRunnerPluginExecService,
    createStablePluginExecService,
    resolvePluginExecManagedDependencyForHost,
    resolvePluginExecSystemToolForHost,
    resolveStablePluginExecInvocation,
} from './exec';
import { spawnSupervisedPluginProcess } from '../../exec/processSupervisor';

const executable = Object.freeze({ kind: 'systemTool', id: 'fixture.node' } as const satisfies ManagedExecutableRef);

function createService(options?: Readonly<{ current?: () => boolean; controller?: AbortController }>) {
    return createStablePluginExecService({
        allowedExecutables: [executable],
        allowedEnvKeys: ['FIXTURE_VALUE'],
        signal: options?.controller?.signal ?? new AbortController().signal,
        isGenerationCurrent: options?.current ?? (() => true),
        async resolveExecutable(ref) {
            expect(ref).toEqual(executable);
            return { command: process.execPath, args: [], env: {} };
        },
        async resolvePath() {
            throw new Error('path resolution was not expected');
        },
    });
}

describe('createStablePluginExecService', () => {
    it('authorizes an exact launch for a runner without spawning in the daemon owner', async () => {
        const release = vi.fn();
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            allowedEnvKeys: ['FIXTURE_VALUE'],
            allowedCwdScopes: [{
                root: 'workspace',
                pathPrefix: 'project',
                access: ['read'],
            }],
            environment: {
                FIXTURE_VALUE: 'host',
                UNDECLARED_VALUE: 'hidden',
            },
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            async resolveExecutable() {
                return {
                    command: '/resolved/tool',
                    args: ['--host-prefix'],
                    env: { RESOLVED_VALUE: 'resolved' },
                    allowedArguments: ['--allowed'],
                    release,
                };
            },
            async resolvePath(path) {
                expect(path).toEqual({
                    root: 'workspace',
                    relativePath: 'project',
                });
                return '/workspace/project';
            },
        });

        const launch = await authorizePluginExecLaunchForHost(
            service,
            {
                executable,
                args: ['--allowed'],
                cwd: {
                    root: 'workspace',
                    relativePath: 'project',
                },
                env: { FIXTURE_VALUE: 'request' },
                stdin: new Uint8Array([1, 2]),
                maxStdoutBytes: 4_096,
            },
        );

        expect(launch).toMatchObject({
            command: '/resolved/tool',
            args: ['--host-prefix', '--allowed'],
            cwd: '/workspace/project',
            env: {
                FIXTURE_VALUE: 'request',
                RESOLVED_VALUE: 'resolved',
            },
            stdin: new Uint8Array([1, 2]),
            maxStdoutBytes: 4_096,
        });
        expect(release).not.toHaveBeenCalled();
        launch.release();
        launch.release();
        expect(release).toHaveBeenCalledOnce();
    });

    it('spawns through the runner process owner only after exact host authorization', async () => {
        const release = vi.fn();
        const authorizeLaunch = vi.fn(async () => ({
            command: process.execPath,
            args: ['-e', 'process.stdout.write("runner")'],
            env: {},
            release,
        }));
        const service = createStableRunnerPluginExecService({
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            agentCli: {
                async checkReadiness(request) {
                    return {
                        launchable: request.candidates.map(
                            (agentId) => ({ agentId }),
                        ),
                    };
                },
            },
            async resolveSystemTool(request) {
                return {
                    resolutionId: 'resolution-1',
                    result: {
                        executable: {
                            kind: 'systemTool',
                            id: request.toolId,
                        },
                        executablePath: '/daemon/resolved/tool',
                    },
                };
            },
            authorizeLaunch,
        });

        const result = await service.run({
            executable,
        });

        expect(Buffer.from(result.stdout).toString('utf8'))
            .toBe('runner');
        expect(authorizeLaunch).toHaveBeenCalledOnce();
        expect(authorizeLaunch).toHaveBeenCalledWith(
            expect.objectContaining({ executable }),
            undefined,
            undefined,
        );
        expect(release).toHaveBeenCalledOnce();
    });

    it('keeps runner probes public and substitutes plain and protocol-client child launches', async () => {
        const placeholder =
            'happier_runner_placeholder_AAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const credential = 'runner-owned-secret';
        const transformAgentChildLaunchEnvironment = vi.fn(
            (environment: Readonly<Record<string, string>>) =>
                Object.freeze({
                    ...environment,
                    PROVIDER_KEY:
                        environment.PROVIDER_KEY === placeholder
                            ? credential
                            : environment.PROVIDER_KEY,
                }),
        );
        const service = createStableRunnerPluginExecService({
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            agentCli: {
                async checkReadiness(request) {
                    return {
                        launchable: request.candidates.map(
                            (agentId) => ({ agentId }),
                        ),
                    };
                },
            },
            async resolveSystemTool(request) {
                return {
                    resolutionId: 'resolution-provider-child',
                    result: {
                        executable: {
                            kind: 'systemTool',
                            id: request.toolId,
                        },
                        executablePath: process.execPath,
                    },
                };
            },
            transformAgentChildLaunchEnvironment,
            async authorizeLaunch(request) {
                return Object.freeze({
                    command: process.execPath,
                    args: Object.freeze([...(request.args ?? [])]),
                    env: Object.freeze({ PROVIDER_KEY: placeholder }),
                    release() {},
                });
            },
        });

        const probe = await service.run({
            executable,
            args: ['-e', 'process.stdout.write(process.env.PROVIDER_KEY ?? "")'],
        });
        expect(Buffer.from(probe.stdout).toString('utf8'))
            .toBe(placeholder);
        expect(transformAgentChildLaunchEnvironment)
            .not.toHaveBeenCalled();

        const plainChild = await service.spawn({
            executable,
            args: ['-e', 'process.exit(process.env.PROVIDER_KEY === "runner-owned-secret" ? 0 : 17)'],
        });
        await expect(plainChild.wait()).resolves.toMatchObject({
            termination: {
                observed: { kind: 'exit', exitCode: 0 },
            },
        });
        expect(transformAgentChildLaunchEnvironment)
            .toHaveBeenCalledTimes(1);

        const child = await service.clients.spawn({
            kind: 'jsonRpc',
            launch: {
                executable,
                args: ['-e', [
                    'const readline = require("node:readline");',
                    'const lines = readline.createInterface({ input: process.stdin });',
                    'lines.on("line", (line) => {',
                    ' const message = JSON.parse(line);',
                    ' process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: process.env.PROVIDER_KEY }) + "\\n");',
                    '});',
                ].join('')],
            },
            framing: 'jsonLines',
            maxFrameBytes: 4_096,
        });
        await expect(child.client.request('credential/read'))
            .resolves.toBe(credential);
        expect(transformAgentChildLaunchEnvironment)
            .toHaveBeenCalledTimes(2);
        await child.dispose();
    });

    it('releases exact runner authorization when child environment substitution fails', async () => {
        const release = vi.fn();
        const service = createStableRunnerPluginExecService({
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            agentCli: {
                async checkReadiness(request) {
                    return {
                        launchable: request.candidates.map(
                            (agentId) => ({ agentId }),
                        ),
                    };
                },
            },
            async resolveSystemTool(request) {
                return {
                    resolutionId: 'resolution-substitution-failure',
                    result: {
                        executable: {
                            kind: 'systemTool',
                            id: request.toolId,
                        },
                        executablePath: process.execPath,
                    },
                };
            },
            transformAgentChildLaunchEnvironment() {
                throw new Error('missing exact Provider placeholder');
            },
            async authorizeLaunch() {
                return Object.freeze({
                    command: process.execPath,
                    args: Object.freeze([]),
                    env: Object.freeze({}),
                    release,
                });
            },
        });

        await expect(service.spawn({ executable }))
            .rejects.toMatchObject({ code: 'plugin_exec_spawn_failed' });
        expect(release).toHaveBeenCalledOnce();
    });

    it('resolves the exact invocation-local system-tool launch for its host composer', async () => {
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            resolveExecutable: async () => {
                throw new Error('host resolution must preserve the invocation-local grant');
            },
            resolvePath: async () => { throw new Error('unexpected path'); },
            systemTools: {
                async resolve(request) {
                    return {
                        grantId: 'fixture-grant',
                        toolId: request.toolId,
                        displayName: 'Fixture tool',
                        source: 'system',
                        executablePath: process.execPath,
                        launch: {
                            kind: 'binary',
                            executablePath: process.execPath,
                            args: ['--resolved-prefix'],
                            env: { FIXTURE_RESOLVED: '1' },
                        },
                    };
                },
            },
        });

        await expect(resolvePluginExecSystemToolForHost(service, {
            toolId: 'fixture.node',
            purpose: 'exercise host ACP composition',
        })).resolves.toMatchObject({
            executable,
            command: process.execPath,
            args: ['--resolved-prefix'],
            env: { FIXTURE_RESOLVED: '1' },
        });
    });

    it('resolves an exactly authorized managed dependency for its host composer', async () => {
        const managedDependency = Object.freeze({
            kind: 'managedDependency',
            id: 'fixture.adapter',
        } as const satisfies ManagedExecutableRef);
        const release = vi.fn();
        const service = createStablePluginExecService({
            allowedExecutables: [managedDependency],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            resolveExecutable: async (ref) => {
                if (
                    ref.kind !== 'managedDependency'
                    || ref.id !== managedDependency.id
                ) {
                    throw new PluginError({
                        code: 'plugin_managed_dependency_undeclared',
                        message: 'Managed dependency is not registered with the host',
                    });
                }
                return {
                    command: process.execPath,
                    args: ['fixture-adapter'],
                    env: { FIXTURE_ADAPTER: '1' },
                    release,
                };
            },
            resolvePath: async () => { throw new Error('unexpected path'); },
        });

        const resolved = await resolvePluginExecManagedDependencyForHost(
            service,
            'fixture.adapter',
        );

        expect(resolved).toMatchObject({
            command: process.execPath,
            args: ['fixture-adapter'],
            env: { FIXTURE_ADAPTER: '1' },
        });
        expect(release).not.toHaveBeenCalled();
        resolved.release?.();
        expect(release).toHaveBeenCalledOnce();
        await expect(resolvePluginExecManagedDependencyForHost(
            service,
            'fixture.other',
        )).rejects.toMatchObject({ code: 'plugin_managed_dependency_undeclared' });
    });

    it('releases a managed-dependency host grant when its generation retires during resolution', async () => {
        const managedDependency = Object.freeze({
            kind: 'managedDependency',
            id: 'fixture.adapter',
        } as const satisfies ManagedExecutableRef);
        let current = true;
        let finishResolution!: (value: {
            command: string;
            release(): void;
        }) => void;
        const resolution = new Promise<{
            command: string;
            release(): void;
        }>((resolve) => {
            finishResolution = resolve;
        });
        const release = vi.fn();
        const service = createStablePluginExecService({
            allowedExecutables: [managedDependency],
            signal: new AbortController().signal,
            isGenerationCurrent: () => current,
            resolveExecutable: async () => await resolution,
            resolvePath: async () => { throw new Error('unexpected path'); },
        });

        const pending = resolvePluginExecManagedDependencyForHost(
            service,
            'fixture.adapter',
        );
        current = false;
        finishResolution({ command: process.execPath, release });

        await expect(pending).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        expect(release).toHaveBeenCalledOnce();
    });

    it('releases a managed-dependency host grant when its caller cancels during resolution', async () => {
        const managedDependency = Object.freeze({
            kind: 'managedDependency',
            id: 'fixture.adapter',
        } as const satisfies ManagedExecutableRef);
        const caller = new AbortController();
        let finishResolution!: (value: {
            command: string;
            release(): void;
        }) => void;
        const resolution = new Promise<{
            command: string;
            release(): void;
        }>((resolve) => {
            finishResolution = resolve;
        });
        const release = vi.fn();
        const service = createStablePluginExecService({
            allowedExecutables: [managedDependency],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            resolveExecutable: async () => await resolution,
            resolvePath: async () => { throw new Error('unexpected path'); },
        });

        const pending = resolvePluginExecManagedDependencyForHost(
            service,
            'fixture.adapter',
            { signal: caller.signal },
        );
        caller.abort();
        finishResolution({ command: process.execPath, release });

        await expect(pending).rejects.toMatchObject({ code: 'plugin_exec_aborted' });
        expect(release).toHaveBeenCalledOnce();
    });

    it('owns a failed legacy process-exit rejection before a consumer observes it', async () => {
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            env: {},
            terminationJoinTimeoutMs: 10,
            terminateProcessTree: async () => undefined,
        });
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
            const processHandle = adaptStablePluginExecLegacyProcessHandle(supervised);
            await supervised.dispose('runtimeRecovery');
            await new Promise<void>((resolve) => setImmediate(resolve));

            expect(unhandled).toEqual([]);
            await expect(processHandle.exit).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_TERMINATION_TIMEOUT',
            });
        } finally {
            process.off('unhandledRejection', onUnhandled);
            supervised.child.kill('SIGKILL');
        }
    });

    it('uses the canonical Windows shim invocation while preserving plain executable launches', async () => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        if (!platformDescriptor) throw new Error('Expected process.platform to be configurable');

        try {
            Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
            const shimInvocation = resolveStablePluginExecInvocation({
                command: 'C:\\tools\\fixture.cmd',
                args: ['--fixture'],
                env: {
                    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
                    PATHEXT: '.CMD;.EXE',
                },
            });
            expect(shimInvocation).toMatchObject({
                command: 'C:\\Windows\\System32\\cmd.exe',
                args: ['/d', '/s', '/c', expect.stringContaining('fixture.cmd')],
                windowsVerbatimArguments: true,
            });

            expect(resolveStablePluginExecInvocation({
                command: 'C:\\tools\\fixture.exe',
                args: ['--plain'],
                env: {
                    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
                    PATHEXT: '.CMD;.EXE',
                },
            })).toEqual({
                command: 'C:\\tools\\fixture.exe',
                args: ['--plain'],
            });
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
        }
    });

    it('runs an allowed managed executable through the sticky binary process owner', async () => {
        const service = createService();

        const result = await service.run({
            executable,
            args: ['-e', 'process.stdout.write(Buffer.from([0, 255, 1]))'],
            maxStdoutBytes: 2,
        });

        expect(result.termination).toEqual({
            observed: { kind: 'exit', exitCode: 0 },
            requestedBy: { kind: 'none' },
        });
        expect([...result.stdout]).toEqual([0, 255]);
        expect(result.stdoutTruncated).toBe(true);
    });

    it('closes stdin for a one-shot run when the caller supplies no input', async () => {
        const service = createService();

        const result = await service.run({
            executable,
            args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("closed"))'],
            timeoutMs: 5_000,
        });

        expect(result.termination).toEqual({
            observed: { kind: 'exit', exitCode: 0 },
            requestedBy: { kind: 'none' },
        });
        expect(Buffer.from(result.stdout).toString('utf8')).toBe('closed');
    });

    it('diagnoses ambient declaration mismatches while preserving executable lookup, cwd resolution, and env validity', async () => {
        const otherExecutable = Object.freeze({
            kind: 'systemTool' as const,
            id: 'fixture.other',
        });
        const mismatches: unknown[] = [];
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            allowedEnvKeys: ['DECLARED_VALUE'],
            allowedCwdScopes: [{
                root: 'workspace',
                pathPrefix: 'declared',
                access: ['read'],
            }],
            environment: { DECLARED_VALUE: 'default', HIDDEN_VALUE: 'hidden' },
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            async resolveExecutable(ref) {
                if (ref.kind === 'systemTool' && ref.id === 'missing') {
                    throw new PluginError({
                        code: 'plugin_system_tool_undeclared',
                        message: 'System tool is not registered with the host',
                    });
                }
                return { command: process.execPath };
            },
            async resolvePath(path) {
                expect(path).toEqual({ root: 'workspace', relativePath: 'outside-disclosure' });
                return '/workspace/outside-disclosure';
            },
            recordDisclosureMismatch(mismatch) {
                mismatches.push(mismatch);
                throw new Error('diagnostic sink failed');
            },
        });

        const launch = await authorizePluginExecLaunchForHost(service, {
            executable: otherExecutable,
            cwd: { root: 'workspace', relativePath: 'outside-disclosure' },
            env: { UNDECLARED_VALUE: 'request' },
        });
        expect(launch).toMatchObject({
            command: process.execPath,
            cwd: '/workspace/outside-disclosure',
            env: {
                DECLARED_VALUE: 'default',
                UNDECLARED_VALUE: 'request',
            },
        });
        expect(launch.env).not.toHaveProperty('HIDDEN_VALUE');
        expect(mismatches).toEqual([
            { capability: 'process', executable: otherExecutable },
            { capability: 'environment', keys: ['UNDECLARED_VALUE'] },
            {
                capability: 'filesystem',
                path: { root: 'workspace', relativePath: 'outside-disclosure' },
                access: 'read',
            },
        ]);
        launch.release();

        await expect(authorizePluginExecLaunchForHost(service, {
            executable: { kind: 'systemTool', id: 'missing' },
        })).rejects.toMatchObject({ code: 'plugin_system_tool_undeclared' });
        await expect(authorizePluginExecLaunchForHost(service, {
            executable: otherExecutable,
            env: { 'INVALID-NAME': 'value' },
        })).rejects.toMatchObject({ code: 'plugin_exec_invalid_environment' });
    });

    it('enforces the declared system-tool argument allowlist before spawning', async () => {
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            resolveExecutable: async () => ({
                command: process.execPath,
                allowedArguments: ['--version'],
            }),
            resolvePath: async () => { throw new Error('unexpected path'); },
        });

        await expect(service.spawn({
            executable,
            args: ['--eval', 'process.exit(0)'],
        })).rejects.toMatchObject({ code: 'plugin_exec_argument_denied' });
    });

    it('preserves argument policy across invocation-local system-tool resolution', async () => {
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            resolveExecutable: async () => {
                throw new Error('pre-resolved system tool must preserve its launch');
            },
            resolvePath: async () => { throw new Error('unexpected path'); },
            systemTools: {
                async resolve(request) {
                    return {
                        grantId: 'fixture-grant',
                        toolId: request.toolId,
                        displayName: 'Fixture tool',
                        source: 'system',
                        executablePath: process.execPath,
                        launch: {
                            kind: 'binary',
                            executablePath: process.execPath,
                            args: [],
                        },
                        allowedArguments: ['--version'],
                    };
                },
            },
        });
        const resolved = await service.systemTools.resolve({
            toolId: 'fixture.node',
            purpose: 'exercise invocation-local launch policy',
        });

        await expect(service.spawn({
            executable: resolved.executable,
            args: ['--eval', 'process.exit(0)'],
        })).rejects.toMatchObject({ code: 'plugin_exec_argument_denied' });
    });

    it('rejects every operation after its plugin generation becomes stale', async () => {
        let current = true;
        const service = createService({ current: () => current });
        current = false;

        await expect(service.run({ executable })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    });

    it('distinguishes timeout from a pre-handle spawn rejection', async () => {
        const service = createService();

        await expect(service.run({
            executable,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            timeoutMs: 10,
        })).resolves.toMatchObject({
            termination: { requestedBy: { kind: 'timeout' } },
        });
        await expect(service.spawn({
            executable,
            args: ['bad\0argument'],
        })).rejects.toMatchObject({ code: 'plugin_exec_spawn_failed' });
    });

    it('attributes generation retirement separately from caller disposal', async () => {
        const controller = new AbortController();
        const service = createService({ controller });
        const handle = await service.spawn({
            executable,
            args: ['-e', 'setInterval(() => {}, 1000)'],
        });

        controller.abort();

        await expect(handle.wait()).resolves.toMatchObject({
            termination: { requestedBy: { kind: 'dispose', reason: 'generationRetired' } },
        });
    });

    it('normalizes resolver failure before a process handle exists', async () => {
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            resolveExecutable: async () => { throw new Error('ambient resolver detail'); },
            resolvePath: async () => { throw new Error('unexpected path'); },
        });

        await expect(service.spawn({ executable })).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_exec_resolve_failed',
        });
    });

    it('holds a managed executable lease until process termination', async () => {
        const release = vi.fn();
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath, release }),
            resolvePath: async () => { throw new Error('unexpected path'); },
        });

        const handle = await service.spawn({
            executable,
            args: ['-e', 'setTimeout(() => {}, 20)'],
        });
        expect(release).not.toHaveBeenCalled();
        await handle.wait();
        await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    });

    it('releases a managed executable lease when spawn rejects before a handle exists', async () => {
        const release = vi.fn();
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath, release }),
            resolvePath: async () => { throw new Error('unexpected path'); },
        });

        await expect(service.spawn({ executable, args: ['bad\0argument'] }))
            .rejects.toMatchObject({ code: 'plugin_exec_spawn_failed' });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid protocol limits before launching a child process', async () => {
        const service = createService();

        await expect(service.clients.spawn({
            kind: 'jsonStream',
            launch: { executable },
            maxFrameBytes: 0,
        })).rejects.toMatchObject({ code: 'plugin_exec_invalid_limit' });
    });

    it('returns the JSON-RPC client selected by the literal protocol spec kind', async () => {
        const service = createService();
        const handle = await service.clients.spawn({
            kind: 'jsonRpc',
            launch: {
                executable,
                args: ['-e', [
                    'const readline = require("node:readline");',
                    'const lines = readline.createInterface({ input: process.stdin });',
                    'lines.on("line", (line) => {',
                    '  const message = JSON.parse(line);',
                    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.params }) + "\\n");',
                    '});',
                ].join('')],
            },
            framing: 'jsonLines',
            maxFrameBytes: 4096,
        });

        await expect(handle.client.request('fixture/echo', { value: 7 })).resolves.toEqual({ value: 7 });
        await handle.dispose();
        expect((await handle.wait()).termination.requestedBy).toEqual({ kind: 'dispose', reason: 'caller' });
    });

    it('terminates a live process when unsolicited malformed JSON framing fails the protocol owner', async () => {
        const service = createService();
        const handle = await service.clients.spawn({
            kind: 'jsonRpc',
            launch: {
                executable,
                args: ['-e', 'process.stdout.write("not-json\\n"); setInterval(() => {}, 1000)'],
            },
            framing: 'jsonLines',
            maxFrameBytes: 4096,
        });
        try {
            const result = await Promise.race([
                handle.wait(),
                new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000)),
            ]);
            expect(result).not.toBe('hung');
            expect(result).toMatchObject({
                termination: { requestedBy: { kind: 'dispose', reason: 'runtimeRecovery' } },
            });
        } finally {
            await handle.dispose();
        }
    });

    it('adapts JSON-stream and length-prefixed byte clients without property probing', async () => {
        const service = createService();
        const json = await service.clients.spawn({
            kind: 'jsonStream',
            launch: {
                executable,
                args: ['-e', 'process.stdin.pipe(process.stdout)'],
            },
            maxFrameBytes: 4096,
        });
        const jsonValues: unknown[] = [];
        json.client.subscribe((value) => {
            jsonValues.push(value);
        });
        await json.client.write({ value: 9 });
        await expect.poll(() => jsonValues).toEqual([{ value: 9 }]);
        await json.dispose();

        const framed = await service.clients.spawn({
            kind: 'framedBytes',
            launch: {
                executable,
                args: ['-e', 'process.stdin.pipe(process.stdout)'],
            },
            framing: 'lengthPrefix',
            maxFrameBytes: 4096,
        });
        const frames: number[][] = [];
        framed.client.subscribe((frame) => {
            frames.push([...frame]);
        });
        await framed.client.writeFrame(new Uint8Array([0, 255, 4]));
        await expect.poll(() => frames).toEqual([[0, 255, 4]]);
        await framed.dispose();
    });

    it('preserves public JSON-stream write rejection while carrying the private write phase', async () => {
        const service = createService();
        const handle = await service.clients.spawn({
            kind: 'jsonStream',
            launch: {
                executable,
                args: ['-e', 'process.stdin.pipe(process.stdout)'],
            },
            maxFrameBytes: 8,
        });
        try {
            await expect(handle.client.write({ tooLarge: true })).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
                details: {
                    jsonStreamWriteOutcome: 'rejected_before_write',
                },
            });
        } finally {
            await handle.dispose();
        }
    });

    it('discovers a loopback WebSocket endpoint through the spawned child handshake', async () => {
        const service = createService();
        const fixtureSource = String.raw`
const { createHash } = require('node:crypto');
const http = require('node:http');
let stdin = Buffer.alloc(0);

function encodeHandshake(payload) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

function acceptKey(key) {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function decodeClientFrame(buffer) {
  if (buffer.length < 6) return null;
  const length = buffer[1] & 0x7f;
  if (length >= 126 || buffer.length < 6 + length) return null;
  const mask = buffer.subarray(2, 6);
  const payload = Buffer.from(buffer.subarray(6, 6 + length));
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] ^= mask[index % 4];
  }
  return payload.toString('utf8');
}

function encodeServerFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function start() {
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    if (request.url !== '/dynamic' || request.headers['x-fixture-key'] !== 'secret') {
      socket.destroy();
      return;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + acceptKey(request.headers['sec-websocket-key']),
      '',
      '',
    ].join('\r\n'));
    socket.on('data', (chunk) => {
      const message = decodeClientFrame(chunk);
      if (message) socket.write(encodeServerFrame(JSON.stringify({ echo: JSON.parse(message) })));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const response = Buffer.from(JSON.stringify({ port }), 'utf8');
    process.stdout.write(encodeHandshake(response));
  });
  process.stdin.on('end', () => server.close(() => process.exit(0)));
}

process.stdin.on('data', (chunk) => {
  stdin = Buffer.concat([stdin, chunk]);
  if (stdin.length < 4) return;
  const length = stdin.readUInt32LE(0);
  if (stdin.length < 4 + length) return;
  if (stdin.subarray(4, 4 + length).toString('utf8') !== 'hello') process.exit(41);
  process.stdin.removeAllListeners('data');
  start();
});
`;

        const handle = await service.clients.spawn({
            kind: 'loopbackWebSocketJson',
            launch: { executable, args: ['-e', fixtureSource] },
            handshake: {
                framing: 'lengthPrefix',
                byteOrder: 'little-endian',
                requestFrames: [new Uint8Array(Buffer.from('hello', 'utf8'))],
                decodeResponse(response) {
                    const decoded = JSON.parse(Buffer.from(response).toString('utf8')) as { port: number };
                    return {
                        host: '127.0.0.1' as const,
                        port: decoded.port,
                        path: '/dynamic',
                        headers: [{ name: 'x-fixture-key', value: 'secret', sensitive: true }],
                    };
                },
            },
            maxFrameBytes: 4096,
        });
        const messages: unknown[] = [];
        handle.client.subscribe((message) => {
            messages.push(message);
        });

        await handle.client.send({ value: 11 });
        await expect.poll(() => messages).toEqual([{ echo: { value: 11 } }]);
        await handle.dispose();
        expect((await handle.wait()).termination.requestedBy).toEqual({ kind: 'dispose', reason: 'caller' });
    });
});
