import { describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';

import {
    adaptStablePluginExecLegacyProcessHandle,
    authorizePluginExecLaunchForHost,
    authorizeResolvedProjectExecLaunchForHost,
    createStableRunnerPluginExecService,
    createStablePluginExecService,
    installManagedProcessCustodyForHost,
    createProjectNativeEnvironmentIoForHost,
    produceProjectLaunchEnvironmentForHost,
    resolvePluginExecManagedDependencyForHost,
    resolvePluginExecSystemToolForHost,
    resolveStablePluginExecInvocation,
} from './exec';
import { readSupervisedPluginProcessIdForHost, spawnSupervisedPluginProcess } from '../../exec/processSupervisor';
import { withTempDir } from '@/testkit/fs/tempDir';
import { resolveProjectNativeCommand } from '@/workspaces/projectSetup/projectNativeResolution';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { ProjectNativeEnvironmentUncertainError } from '@/workspaces/environment/produceProjectNativeEnvironment';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { resolvePluginPathWithinRoots } from './filesystem';
import type { PluginFileSystemRoots } from './types';

const executable = Object.freeze({ kind: 'systemTool', id: 'fixture.node' } as const satisfies ManagedExecutableRef);

function createService(options?: Readonly<{ current?: () => boolean; controller?: AbortController;
    recordDisclosureMismatch?: Parameters<typeof createStablePluginExecService>[0]['recordDisclosureMismatch'];
    filesystemRoots?: PluginFileSystemRoots }>) {
    return createStablePluginExecService({
        allowedExecutables: [executable],
        allowedEnvKeys: ['FIXTURE_VALUE'],
        signal: options?.controller?.signal ?? new AbortController().signal,
        isOccurrenceCurrent: options?.current ?? (() => true),
        ...(options?.recordDisclosureMismatch ? { recordDisclosureMismatch: options.recordDisclosureMismatch } : {}),
        async resolveExecutable(ref) {
            expect(ref).toEqual(executable);
            return { command: process.execPath, args: [], env: {} };
        },
        async resolvePath(path) {
            return resolvePluginPathWithinRoots(options?.filesystemRoots ?? {
                pluginData: process.cwd(), workspace: process.cwd(), projects: new Map(),
            }, path);
        },
    });
}

describe('createStablePluginExecService', () => {
    it('executes a selected absolute process cwd outside plugin filesystem roots through the canonical owner', async () => {
        await withTempDir('happier selected machine cwd ünicode ', async root => {
            const mismatches: unknown[] = [];
            const pluginData = join(root, 'admitted-plugin-root');
            await mkdir(pluginData);
            const request = { executable, cwd: root, args: ['-e', 'process.stdout.write(process.cwd())'] };
            const observed = await createService({ recordDisclosureMismatch: mismatch => mismatches.push(mismatch),
                filesystemRoots: { pluginData, workspace: pluginData, projects: new Map() } }).run(request);
            expect(observed.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            expect(new TextDecoder().decode(observed.stdout)).toBe(await realpath(root));
            expect(mismatches).toContainEqual({ capability: 'filesystem', path: root, access: 'read' });
        });
    });

    it('refuses relative and NUL-bearing process cwd before native effects', async () => {
        await withTempDir('happier invalid selected cwd ', async root => {
            for (const cwd of ['.', `${root}\u0000suffix`]) {
                const request = { executable, cwd, args: ['-e', 'process.stdout.write("unreviewed-effect")'] };
                await expect(createService({ filesystemRoots: { pluginData: root, workspace: root, projects: new Map() } }).run(request))
                    .rejects.toMatchObject({ code: 'plugin_exec_invalid_cwd' });
            }
        });
    });

    it('preserves unconfirmed native custody through final authorization even after cancellation', async () => {
        await withTempDir('happier uncertain native launch ', async root => {
            await writeFile(join(root, 'mise.toml'), '[env]\nNATIVE = "active"\n');
            const controller = new AbortController();
            let releases = 0;
            const projectLaunch = {
                status: 'ready' as const, reviewedEffectDigest: 'current-native-effect',
                environment: {
                    root, selection: { kind: 'toolchain' as const, tool: 'mise' as const, configPath: 'mise.toml' },
                    platform: 'linux' as const, io: {
                        resolveTool: async () => ({ executablePath: '/tools/mise', version: '2026.10.4' }),
                        // The process owner reports unconfirmed cleanup; final admission
                        // must not relabel it as a settled cancellation or no-launch.
                        run: async () => {
                            controller.abort();
                            throw new PluginError({ code: 'plugin_exec_termination_incomplete', message: 'private native output' });
                        },
                    },
                },
            };
            const outcome = await authorizeResolvedProjectExecLaunchForHost({
                launch: { command: process.execPath, args: [], cwd: root, env: {}, release: () => { releases += 1; } },
                projectLaunch, signal: controller.signal, assertCurrent: () => undefined,
            }).then(() => null, (error: unknown) => error);
            expect(outcome).toBeInstanceOf(ProjectNativeEnvironmentUncertainError);
            expect(outcome).toMatchObject({ kind: 'outcome_uncertain', code: 'native_environment_termination_incomplete' });
            expect(String(outcome)).not.toContain('private native output');
            expect(releases).toBe(1);
            await expect(produceProjectLaunchEnvironmentForHost({
                cwd: root, env: {}, projectLaunch, signal: new AbortController().signal, assertCurrent: () => undefined,
            })).rejects.toBeInstanceOf(ProjectNativeEnvironmentUncertainError);
        });
    });
    it('prepares the admitted complete environment without inventing an executable for environment-only setup', async () => {
        await withTempDir('happier environment only setup ', async root => {
            await writeFile(join(root, 'mise.toml'), '[env]\nNATIVE = "active"\n');
            const input = {
                cwd: root, env: { REMOVE: 'host' }, signal: new AbortController().signal, assertCurrent: () => undefined,
                projectLaunch: { status: 'ready' as const, reviewedEffectDigest: 'environment-only-current-effect',
                    environment: { root, selection: { kind: 'toolchain' as const, tool: 'mise' as const, configPath: 'mise.toml' },
                        platform: 'linux' as const, io: {
                            resolveTool: async () => ({ executablePath: '/tools/mise', version: '2026.10.4' }),
                            run: async (request: { cwd: string }) => {
                                expect(request.cwd).toBe(root);
                                return { exitCode: 0, stdout: 'NATIVE=active\0' };
                            },
                        } },
                },
            };
            await expect(produceProjectLaunchEnvironmentForHost(input)).resolves.toEqual({ NATIVE: 'active' });
            await expect(produceProjectLaunchEnvironmentForHost({ ...input,
                projectLaunch: { status: 'refused', kind: 'approval_pending', code: 'project_setup_consent_required' },
            })).rejects.toMatchObject({ code: 'project_setup_consent_required' });
            await expect(produceProjectLaunchEnvironmentForHost({ ...input, signal: AbortSignal.abort() }))
                .rejects.toMatchObject({ code: 'plugin_exec_aborted' });
        });
    });
    it.runIf(process.platform === 'linux' && Boolean(process.env.B3_NATIVE_MISE_PATH))('runs the final admitted tuple with installed Mise, nested cwd and native removals', async ({ onTestFinished }) => {
        const controller = new AbortController();
        // The containing test deadline must cancel its actual native capture,
        // even when a timeout interrupts preparation before a launch is returned.
        onTestFinished(() => controller.abort());
        await withTempDir('happier installed native tuple ', async (root) => {
            const cwd = join(root, 'nested cwd');
            await mkdir(cwd);
            await writeFile(join(root, 'mise.toml'), '[env]\nB4_NATIVE = "active"\nB4_REMOVE = false\n');
            const nativeTool = process.env.B3_NATIVE_MISE_PATH;
            if (!nativeTool) throw new Error('The native lane requires its verified Mise binary');
            // Installed-file/PATH boundary only. The real passive resolver and
            // admitted version producer must reach this binary themselves.
            vi.stubEnv('PATH', [dirname(nativeTool), process.env.PATH ?? ''].filter(Boolean).join(delimiter));
            try {
                const signal = controller.signal;
                const launch = await authorizeResolvedProjectExecLaunchForHost({
                    launch: {
                        command: process.execPath, cwd,
                        args: ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),value:process.env.B4_NATIVE,removed:process.env.B4_REMOVE}))', '--', 'literal $() ; " argument \\'],
                        env: {
                            ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
                            B4_REMOVE: 'host', MISE_TRUSTED_CONFIG_PATHS: root,
                            MISE_DATA_DIR: join(root, 'data'), MISE_CACHE_DIR: join(root, 'cache'),
                            MISE_STATE_DIR: join(root, 'state'), MISE_CONFIG_DIR: join(root, 'config'),
                        },
                    }, signal, assertCurrent: () => signal.throwIfAborted(),
                    projectLaunch: {
                        status: 'ready', reviewedEffectDigest: 'native-lane-reviewed-effect',
                        environment: {
                            root, selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, platform: 'linux',
                            io: createProjectNativeIo().environmentIo,
                        },
                    },
                });
                expect(launch.command).toBe(process.execPath);
                expect(launch.env).not.toHaveProperty('B4_REMOVE');
                const owned = spawnSupervisedPluginProcess(launch);
                try {
                    const result = await owned.handle.wait();
                    expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                    expect(JSON.parse(Buffer.from(result.stdout).toString('utf8'))).toEqual({
                        cwd, args: ['literal $() ; " argument \\'], value: 'active',
                    });
                } finally {
                    await owned.dispose();
                    launch.release();
                }
            } finally {
                controller.abort();
                vi.unstubAllEnvs();
            }
        });
    });

    it('retires actual native-effect descendants that leave the launcher process group', async () => {
        if (process.platform !== 'linux') return; // The characterized native boundary is Linux.
        await withTempDir('happier native effect custody ', async (root) => {
            const pidFile = join(root, 'owned-pids.json');
            const controller = new AbortController();
            const io = createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null });
            const pending = io.run({
                command: process.execPath, cwd: root,
                env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
                signal: controller.signal,
                args: ['-e', [
                    'const cp=require("node:child_process"),fs=require("node:fs");',
                    'const child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});',
                    'process.on("SIGTERM",()=>{});child.once("exit",()=>process.exit(0));',
                    'fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);',
                ].join(''), pidFile],
            }).then(() => null, (error: unknown) => error);
            let pids: number[] = [];
            try {
                await vi.waitFor(async () => {
                    pids = JSON.parse(await readFile(pidFile, 'utf8'));
                    expect(pids).toHaveLength(2);
                });
                controller.abort();
                expect(await pending).toMatchObject({ code: 'plugin_exec_aborted' });
                for (const pid of pids) await expect(waitForProcessExit(pid, { timeoutMs: 3000 })).resolves.toBe(true);
            } finally {
                controller.abort();
                await pending;
                for (const pid of pids) {
                    try { process.kill(pid, 'SIGKILL'); } catch { /* Already proven absent on success. */ }
                }
            }
        });
    });

    it.skipIf(process.platform === 'win32')('does not complete built-in native IO from launcher exit while its owned descendant remains live', async () => {
        await withTempDir('happier builtin native root exit ', async root => {
            const pidsPath = join(root, 'owned-pids.json');
            const io = createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null });
            const pending = io.run({ command: process.execPath, cwd: root, env: {}, args: ['-e', [
                'const cp=require("node:child_process"),fs=require("node:fs");',
                'const child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});child.unref();',
                'fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));process.stdout.write("{}");',
            ].join(''), pidsPath] });
            // Observe rejection even when an earlier assertion fails, without
            // changing the real IO/process owner outcome.
            void pending.catch(() => undefined);
            let pids: number[] = [];
            try {
                await vi.waitFor(async () => {
                    pids = JSON.parse(await readFile(pidsPath, 'utf8'));
                    expect(pids).toHaveLength(2);
                });
                await expect(waitForProcessExit(pids[0]!)).resolves.toBe(true);
                const result = await pending;
                expect(result).toEqual({ exitCode: 0, stdout: '{}' });
                // A successful native result must follow full owned-resource
                // cleanup; an already-dead launcher is not its proof.
                if (process.platform === 'linux') {
                    const stat = await readFile(`/proc/${pids[1]!}/stat`, 'utf8').catch(error => {
                        if (error.code === 'ENOENT') return null;
                        throw error;
                    });
                    // An orphaned zombie cannot execute, even if init has not
                    // yet reaped its numeric PID (the existing native IO rule).
                    expect(stat === null || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')).toBe(true);
                } else {
                    expect(() => process.kill(pids[1]!, 0)).toThrow();
                }
            } finally {
                for (const pid of pids) {
                    try { process.kill(pid, 'SIGKILL'); } catch { /* Already absent on success. */ }
                }
                await pending.catch(() => undefined);
            }
        });
    });

    it('authorizes an admitted already-resolved host command through the same final environment owner', async () => {
        await withTempDir('happier resolved Project launch ', async (root) => {
            const cwd = join(root, 'nested cwd');
            await mkdir(cwd);
            await writeFile(join(root, 'mise.toml'), '[env]\nNATIVE = "active"\n');
            let releases = 0;
            const input = {
                launch: { command: process.execPath, args: ['-e', 'process.stdout.write("exact")'], cwd,
                    env: { REMOVE: 'host' }, stdin: new Uint8Array([255]), maxStdoutBytes: 1024,
                    release: () => { releases += 1; } },
                signal: new AbortController().signal, assertCurrent: () => undefined,
                projectLaunch: {
                    status: 'ready' as const, reviewedEffectDigest: 'current-reviewed-effect',
                    environment: { root, selection: { kind: 'toolchain' as const, tool: 'mise' as const, configPath: 'mise.toml' },
                        platform: 'linux' as const, io: {
                            resolveTool: async () => ({ executablePath: '/tools/mise', version: '2026.10.4' }),
                            run: async (request: { cwd: string; env: Readonly<Record<string, string>> }) => {
                                expect(request.cwd).toBe(cwd);
                                expect(request.env.MISE_OVERRIDE_CONFIG_FILENAMES).toBe(join(root, 'mise.toml'));
                                return { exitCode: 0, stdout: 'NATIVE=active\0' };
                            },
                        } },
                },
            };
            const final = await authorizeResolvedProjectExecLaunchForHost(input);
            expect(final).toMatchObject({ command: process.execPath, args: input.launch.args, cwd,
                env: { NATIVE: 'active' }, stdin: new Uint8Array([255]), maxStdoutBytes: 1024 });
            final.release(); final.release();
            expect(releases).toBe(1);
            await expect(authorizeResolvedProjectExecLaunchForHost({ ...input,
                projectLaunch: { status: 'refused', kind: 'child_required', code: 'project_environment_child_required' },
            })).rejects.toMatchObject({ code: 'project_environment_child_required' });
        });
    });

    it('captures the full native environment before authorization without reviving native unsets or changing installed executable identity', async () => {
        await withTempDir('happier admitted native project ', async (root) => {
            await writeFile(join(root, 'mise.toml'), '[env]\nNATIVE = "active"\n');
            let released = 0;
            const installedArgs = ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),env:process.env}))', '--'];
            const service = createStablePluginExecService({
                allowedExecutables: [executable],
                allowedEnvKeys: ['REMOVE', 'KEEP'],
                environment: { REMOVE: 'host', KEEP: 'host' },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
                resolveExecutable: async () => ({
                    command: process.execPath, args: installedArgs,
                    release: () => { released += 1; },
                }),
                resolvePath: async () => root,
            });
            const launch = await authorizePluginExecLaunchForHost(service, {
                executable, args: ['--session', 'opaque "resume" \\'],
                cwd: { root: 'workspace', relativePath: '' },
                stdin: new Uint8Array([0, 255]), maxStdoutBytes: 1024,
            }, {
                projectLaunch: {
                    status: 'ready', reviewedEffectDigest: 'reviewed-current-effect',
                    environment: {
                        selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
                        platform: 'linux',
                        // Tool resolution/native execution are genuine OS boundaries;
                        // native parsing, file checks and final authorization remain real.
                        io: {
                            resolveTool: async () => ({ executablePath: '/tools/mise', version: '2026.10.4' }),
                            run: async (request) => {
                                expect(request.cwd).toBe(root);
                                expect(request.env.REMOVE).toBe('host');
                                return { exitCode: 0, stdout: 'KEEP=native\0NATIVE=active\0PROJECT_KEY=native\0' };
                            },
                        },
                    },
                    secretReferences: {
                        requirements: [{ name: 'PROJECT_KEY', required: true }],
                        accountSettings: {}, settingsSecretsReadKeys: [],
                        secretReferenceOverlay: { v: 1, bindings: {
                            PROJECT_KEY: { ref: 'happier:shared-secret:v1:project-key', revision: 2 },
                        } },
                        savedSecretResources: [{
                            resourceId: 'project-key', ownerAccountId: 'requester', displayName: 'Project key',
                            kind: 'apiKey', encryptionMode: 'plain', revision: 2, materialStatus: 'ready',
                            storedContent: sealSavedSecretResourceStoredContentV1({
                                resourceId: 'project-key', mode: 'plain',
                                content: { v: 1, name: 'Project key', kind: 'apiKey', value: 'exact-project-key' },
                            }),
                        }],
                    },
                },
            });
            expect(launch).toMatchObject({
                command: process.execPath,
                args: [...installedArgs, '--session', 'opaque "resume" \\'],
                cwd: root, env: { KEEP: 'native', NATIVE: 'active', PROJECT_KEY: 'exact-project-key' },
                stdin: new Uint8Array([0, 255]), maxStdoutBytes: 1024,
            });
            expect(launch.env).not.toHaveProperty('REMOVE');
            const processOwner = spawnSupervisedPluginProcess(launch);
            try {
                const observed = await processOwner.handle.wait();
                expect(observed.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                expect(JSON.parse(Buffer.from(observed.stdout).toString('utf8'))).toEqual({
                    cwd: root, args: ['--session', 'opaque "resume" \\'],
                    env: { KEEP: 'native', NATIVE: 'active', PROJECT_KEY: 'exact-project-key' },
                });
            } finally {
                await processOwner.dispose();
                launch.release(); launch.release();
            }
            expect(released).toBe(1);
        });
    });

    it('keeps plugin-supplied project purpose/options nonactivating and refuses host preparation holds before resolving a process', async () => {
        let resolutions = 0;
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
            resolveExecutable: async () => { resolutions += 1; return { command: process.execPath }; },
            resolvePath: async () => { throw new Error('cwd must not be resolved'); },
        });
        // Extra JS properties are not host authority. Generic Exec must ignore them.
        const genericOptions = {
            signal: new AbortController().signal,
            projectLaunch: { status: 'refused' as const, kind: 'approval_pending' as const, code: 'project_setup_consent_required' },
        };
        const genericRequest = { executable, args: ['-e', 'process.stdout.write("ordinary")'], purpose: 'cold Agent launch' };
        const result = await service.run(genericRequest, genericOptions);
        expect(Buffer.from(result.stdout).toString('utf8')).toBe('ordinary');
        expect(resolutions).toBe(1);
        for (const failure of [
            { status: 'refused' as const, kind: 'approval_pending' as const, code: 'project_setup_consent_required' },
            { status: 'refused' as const, kind: 'child_required' as const, code: 'project_environment_child_required' },
        ]) {
            await expect(authorizePluginExecLaunchForHost(service, { executable }, { projectLaunch: failure }))
                .rejects.toMatchObject({ code: failure.code });
        }
        expect(resolutions).toBe(1);
    });

    it('consumes the native command owner fact without double evaluating that command environment', async () => {
        await withTempDir('happier native command root ', async (root) => {
            await writeFile(join(root, 'mise.toml'), '[tasks.build]\nrun = "echo build"\n');
            const command = await resolveProjectNativeCommand({
                root, source: { kind: 'native', tool: 'mise', file: 'mise.toml', target: 'build' },
                usage: 'script', io: { resolveTool: async () => ({ executablePath: '/tools/mise', version: '2026.10.4' }) },
            });
            expect(command.kind).toBe('resolved');
            if (command.kind !== 'resolved') throw new Error('Expected the real native command owner to resolve');
            const service = createStablePluginExecService({
                allowedExecutables: [executable], signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
                resolveExecutable: async () => ({ command: command.command, args: command.args, env: command.environmentOverlay }),
                resolvePath: async () => command.cwd,
            });
            const launch = await authorizePluginExecLaunchForHost(service, {
                executable, cwd: { root: 'workspace', relativePath: '' },
            }, {
                projectLaunch: {
                    status: 'ready', reviewedEffectDigest: 'current-reviewed-native-command',
                    environment: {
                        selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
                        nativeCommandEnvironment: command.nativeCommandEnvironment,
                        platform: 'linux', io: {
                            resolveTool: async () => { throw new Error('A native command must not be re-probed for wrapping'); },
                            run: async () => { throw new Error('A native command must not evaluate its environment twice'); },
                        },
                    },
                },
            });
            expect(launch).toMatchObject({
                command: '/tools/mise', args: ['run', 'build'], cwd: root,
                env: { MISE_OVERRIDE_CONFIG_FILENAMES: join(root, 'mise.toml') },
            });
            launch.release();
        });
    });

    it('releases the installed executable when native production fails or the invocation retires during evaluation', async () => {
        await withTempDir('happier refused native project ', async (root) => {
            await writeFile(join(root, 'mise.toml'), '[env]\nKEY = "native"\n');
            for (const outcome of ['failed', 'retired'] as const) {
                const controller = new AbortController();
                let releases = 0;
                const service = createStablePluginExecService({
                    allowedExecutables: [executable],
                    signal: controller.signal, isOccurrenceCurrent: () => true,
                    resolveExecutable: async () => ({ command: process.execPath, release: () => { releases += 1; } }),
                    resolvePath: async () => root,
                });
                await expect(authorizePluginExecLaunchForHost(service, {
                    executable, cwd: { root: 'workspace', relativePath: '' },
                }, {
                    signal: new AbortController().signal,
                    projectLaunch: {
                        status: 'ready', reviewedEffectDigest: 'reviewed-current-effect',
                        environment: {
                            selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, platform: 'linux',
                            io: {
                                resolveTool: async () => ({ executablePath: '/tools/mise', version: '2026.10.4' }),
                                run: async (request) => {
                                    if (outcome === 'retired') {
                                        controller.abort();
                                        expect(request.signal?.aborted).toBe(true);
                                    }
                                    return { exitCode: 1, stdout: 'private native diagnostic' };
                                },
                            },
                        },
                    },
                })).rejects.toMatchObject({ code: outcome === 'failed' ? 'native_environment_failed' : 'plugin_exec_aborted' });
                expect(releases).toBe(1);
            }
        });
    });

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
            isOccurrenceCurrent: () => true,
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
            isOccurrenceCurrent: () => true,
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
            isOccurrenceCurrent: () => true,
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
            isOccurrenceCurrent: () => true,
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
            isOccurrenceCurrent: () => true,
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
            isOccurrenceCurrent: () => true,
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

    it('releases a managed-dependency host grant when its occurrenceId retires during resolution', async () => {
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
            isOccurrenceCurrent: () => current,
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
            isOccurrenceCurrent: () => true,
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
        // A real OS spawn error supplies a failed terminal fact; incomplete
        // termination leaves exit pending and is covered by the supervisor owner.
        const supervised = spawnSupervisedPluginProcess({
            command: `${process.execPath}.missing-executable`,
            args: [],
            env: {},
        });
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
            const processHandle = adaptStablePluginExecLegacyProcessHandle(supervised);
            await supervised.handle.wait();
            await new Promise<void>((resolve) => setImmediate(resolve));

            expect(unhandled).toEqual([]);
            await expect(processHandle.exit).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_PROCESS_FAILED',
            });
        } finally {
            process.off('unhandledRejection', onUnhandled);
            await supervised.dispose('runtimeRecovery');
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

            const nativeArguments = ['--plain', 'C:/project root\\bin\\input', 'a "quoted" value', 'C:\\trailing path\\'];
            expect(resolveStablePluginExecInvocation({
                command: 'C:\\native tools\\fixture.exe',
                args: nativeArguments,
                env: {
                    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
                    PATHEXT: '.CMD;.EXE',
                },
            })).toEqual({
                command: 'C:\\native tools\\fixture.exe',
                args: nativeArguments,
            });
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
        }
    });

    it.skipIf(process.platform === 'win32')('executes the resolved tuple with spaced executable/root paths and literal mixed-separator argv', async () => {
        await withTempDir('happier-exec-final-tuple-', async (root) => {
            const cwd = join(root, 'native project root');
            const command = join(root, 'native tool');
            await mkdir(cwd);
            await symlink(process.execPath, command);
            const args = ['value with spaces', 'folder\\mixed/path', 'literal "quotes"', '$HOME;$(echo should-not-run)'];
            const service = createStablePluginExecService({
                allowedExecutables: [executable],
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
                // Executable and filesystem resolution are the OS boundaries;
                // authorization, argv composition and supervision remain real.
                resolveExecutable: async () => ({ command, env: { FINAL_TUPLE_VALUE: 'native value' } }),
                resolvePath: async () => cwd,
            });
            const result = await service.run({
                executable,
                cwd: { root: 'workspace', relativePath: 'native project root' },
                args: ['-e', 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1), value: process.env.FINAL_TUPLE_VALUE }))', ...args],
            });
            expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            expect(JSON.parse(Buffer.from(result.stdout).toString('utf8'))).toEqual({
                cwd: await realpath(cwd), args, value: 'native value',
            });
        });
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
            isOccurrenceCurrent: () => true,
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
            isOccurrenceCurrent: () => true,
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
            isOccurrenceCurrent: () => true,
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

    it('rejects every operation after its plugin occurrenceId becomes stale', async () => {
        let current = true;
        const service = createService({ current: () => current });
        current = false;

        await expect(service.run({ executable })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    });

    it.each(['source', 'supervisor'] as const)('rechecks the physical %s authority after managed executable resolution before spawning', async retired => {
        let current = true;
        const supervisor = new AbortController();
        let proceed!: () => void;
        let entered!: () => void;
        const resolutionEntered = new Promise<void>(resolve => { entered = resolve; });
        const continuation = new Promise<void>(resolve => { proceed = resolve; });
        const release = vi.fn();
        const resolver = async () => {
            entered();
            await continuation;
            return { command: process.execPath, release };
        };
        const service = createStablePluginExecService({
            allowedExecutables: [executable], signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, resolveExecutable: resolver,
            resolveManagedExecutable: resolver,
            resolvePath: async () => { throw new Error('Unexpected path'); },
        });
        const request = { executable, args: ['-e', 'process.exit(0)'] };
        const installation = installManagedProcessCustodyForHost(service, request, null, {
            signal: supervisor.signal, isOccurrenceCurrent: () => current,
        });
        const launch = service.spawn(request, { signal: supervisor.signal });
        try {
            await resolutionEntered;
            if (retired === 'source') current = false;
            else supervisor.abort();
            proceed();
            await expect(launch).rejects.toMatchObject({
                code: retired === 'source' ? 'plugin_generation_stale' : 'plugin_exec_aborted',
            });
            expect(release).toHaveBeenCalledOnce();
        } finally {
            proceed();
            installation.dispose();
            await launch.then(handle => handle.dispose(), () => undefined);
        }
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

    it('attributes occurrenceId retirement separately from caller disposal', async () => {
        const controller = new AbortController();
        const release = vi.fn();
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: controller.signal,
            isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath, release }),
            resolvePath: async () => { throw new Error('unexpected path'); },
        });
        const handle = await service.spawn({
            executable,
            args: ['-e', 'setInterval(() => {}, 1000)'],
        });

        try {
            const pid = readSupervisedPluginProcessIdForHost(handle);
            if (pid === null) throw new Error('Expected a real owned child');
            expect(process.kill(pid, 0)).toBe(true);
            expect(release).not.toHaveBeenCalled();
            controller.abort();

            await expect(handle.wait()).resolves.toMatchObject({
                termination: { requestedBy: { kind: 'dispose', reason: 'generationRetired' } },
            });
            await vi.waitFor(() => {
                expect(() => process.kill(pid, 0)).toThrow();
                expect(release).toHaveBeenCalledOnce();
            });
        } finally {
            await handle.dispose();
        }
    });

    it('normalizes resolver failure before a process handle exists', async () => {
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
            resolveExecutable: async () => { throw new Error('ambient resolver detail'); },
            resolvePath: async () => { throw new Error('unexpected path'); },
        });

        await expect(service.spawn({ executable })).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_exec_resolve_failed',
        });
    });

    it('holds a managed executable lease after root exit until owned tree settlement', async () => {
        await withTempDir('happier managed executable custody ', async root => {
        const release = vi.fn();
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath, release }),
            resolvePath: async () => { throw new Error('unexpected path'); },
        });

        const childPidPath = join(root, 'child.pid');
        const source = process.platform === 'win32' ? 'process.stdout.write("root output");' : [
            'const {spawn}=require("node:child_process"),fs=require("node:fs");',
            'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});child.unref();',
            `fs.writeFileSync(${JSON.stringify(childPidPath)},String(child.pid));`,
            'process.stdout.write("root output");',
        ].join('');
        const handle = await service.spawn({
            executable,
            args: ['-e', source],
        });
        try {
            expect(release).not.toHaveBeenCalled();
            const result = await handle.wait();
            expect(new TextDecoder().decode(result.stdout)).toBe('root output');
            expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            const childPid = process.platform === 'win32' ? undefined : Number(await readFile(childPidPath, 'utf8'));
            if (childPid !== undefined) {
                expect(Number.isSafeInteger(childPid)).toBe(true);
                expect(process.kill(childPid, 0)).toBe(true);
            }
            expect(release).not.toHaveBeenCalled();
            await handle.dispose();
            if (childPid !== undefined) await expect(waitForProcessExit(childPid)).resolves.toBe(true);
            await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
            // Output/terminal facts stay usable after resource settlement.
            expect(await handle.wait()).toBe(result);
        } finally { await handle.dispose(); }
        });
    });

    it('releases a managed executable lease when spawn rejects before a handle exists', async () => {
        const release = vi.fn();
        const service = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
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

    it('discovers a loopback WebSocket endpoint after the former handshake and listener readiness deadlines', async () => {
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
    server.close(() => {
      setTimeout(() => {
        process.stdout.write(encodeHandshake(response));
        setTimeout(() => server.listen(port, '127.0.0.1'), 1_200);
      }, 5_200);
    });
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

    it.each(['handshake', 'connection'] as const)('settles a loopback client when its child exits before %s readiness', async (phase) => {
        const service = createService();
        await expect(service.clients.spawn({
            kind: 'loopbackWebSocketJson',
            launch: { executable, args: ['-e', 'process.exit(42)'] },
            ...(phase === 'handshake' ? {
                handshake: {
                    framing: 'lengthPrefix' as const,
                    byteOrder: 'little-endian' as const,
                    requestFrames: [],
                    decodeResponse: () => ({ host: '127.0.0.1' as const, port: 12_345 }),
                },
            } : { endpoint: { host: '127.0.0.1' as const, port: 12_345 } }),
            maxFrameBytes: 4096,
        })).rejects.toMatchObject({ code: 'PLUGIN_EXEC_CLIENT_EXITED' });
    });

    it.each(['handshake', 'connection'] as const)('cancels a loopback client during %s readiness', async (phase) => {
        await withTempDir('happier-loopback-cancel-', async root => {
            const marker = join(root, 'started');
            const controller = new AbortController();
            const service = createService();
            const pending = service.clients.spawn({
                kind: 'loopbackWebSocketJson',
                launch: { executable, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000)`] },
                ...(phase === 'handshake' ? {
                    handshake: {
                        framing: 'lengthPrefix' as const,
                        byteOrder: 'little-endian' as const,
                        requestFrames: [],
                        decodeResponse: () => ({ host: '127.0.0.1' as const, port: 12_345 }),
                    },
                } : { endpoint: { host: '127.0.0.1' as const, port: 12_345 } }),
                maxFrameBytes: 4096,
            }, { signal: controller.signal });
            const rejected = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_EXEC_CLIENT_ABORTED' });
            try {
                await expect.poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('ready');
                controller.abort();
                await rejected;
            } finally {
                controller.abort();
                await pending.catch(() => undefined);
            }
        });
    });
});
