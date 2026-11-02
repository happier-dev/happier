import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { create as createTar } from 'tar';

import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { resolvePlatformFromNodePlatform } from '@happier-dev/cli-common/agents';
import { describe, expect, it, vi } from 'vitest';

import { bindAgentCliLaunchSpec, buildAgentCliLaunchSpecFromResolution } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import { prepareManagedAgentCliLaunch } from '@/packagedRuntime/managedTools/prepareManagedAgentCliLaunch';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createRetainedAgentCliSystemToolService } from './agentCliBinding';
import { createClaudeNativeSdkQueryContext } from '../../../../../../../../packages/plugins/claude/src/agent/sdk/nativeExec.js';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session.js';
import { createEventsFixture, createPluginContextFixture, createTerminalHostFixture } from '../../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit.js';
import { createStablePluginExecService } from '../../../invocation/services/exec';
import { resolvePluginPathWithinRoots } from '../../../invocation/services/filesystem';
import { captureProcessTree, terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { isPidAlive } from '@/testkit/process/spawn';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

const windowsSpawnBoundary = vi.hoisted(() => ({ wrapperPath: null as string | null }));
// Windows command-shell execution is the OS boundary; grant authorization and SDK owners remain real.
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        spawn: (command: string, args: readonly string[], options?: SpawnOptions) =>
            actual.spawn(command, windowsSpawnBoundary.wrapperPath && args[0]?.endsWith('agent_cli_windows_shim_runner.cjs')
                ? [windowsSpawnBoundary.wrapperPath, ...args.slice(2)] : args, options ?? {}),
    };
});


type AgentCliBindingFixture = Readonly<{
    agentId: 'claude' | 'codex' | 'opencode';
    pluginId: string;
    systemToolId: string;
    overrideEnvKey: 'HAPPIER_CLAUDE_PATH' | 'HAPPIER_CODEX_PATH' | 'HAPPIER_OPENCODE_PATH';
    readableJavaScriptOverride: boolean;
    invokeResolvedTool: boolean;
}>;

const fixtures: readonly AgentCliBindingFixture[] = Object.freeze([
    {
        agentId: 'claude',
        pluginId: 'happier.agent.claude',
        systemToolId: 'claude-cli',
        overrideEnvKey: 'HAPPIER_CLAUDE_PATH',
        readableJavaScriptOverride: true,
        invokeResolvedTool: true,
    },
    {
        agentId: 'opencode',
        pluginId: 'happier.agent.opencode',
        systemToolId: 'opencode-cli',
        overrideEnvKey: 'HAPPIER_OPENCODE_PATH',
        readableJavaScriptOverride: false,
        invokeResolvedTool: false,
    },
    {
        agentId: 'codex',
        pluginId: 'happier.agent.codex',
        systemToolId: 'codex-cli',
        overrideEnvKey: 'HAPPIER_CODEX_PATH',
        readableJavaScriptOverride: false,
        invokeResolvedTool: true,
    },
]);

describe('Agent CLI system-tool binding (integration)', () => {
    it.each(['direct', 'wrapped'] as const)('qualifies the actual provider exit through SDK binding (%s)', async mode => {
        if (process.platform === 'win32') return; // Windows shell creation is adapted at the OS boundary on this host.
        const directory = await mkdtemp(join(tmpdir(), 'happier-sdk-exit-qualification-'));
        const pidPath = join(directory, 'native-pids.json');
        const vendorPath = join(directory, 'vendor.js');
        const shimPath = join(directory, 'vendor.cmd');
        const records = [
            { type: 'system', subtype: 'init', session_id: 'native-exit-qualification' },
            { type: 'system', subtype: 'task_started', session_id: 'native-exit-qualification',
                task_id: 'owned-background-task', task_type: 'local_agent', is_backgrounded: true },
        ];
        await writeFile(vendorPath, `
            const fs = require('node:fs');
            process.on('SIGTERM', () => process.exit(0));
            let providerReady = Promise.resolve();
            ${mode === 'wrapped' ? `
            const child = require('node:child_process').spawn(process.execPath, ['-e',
                'process.send(process.pid); setInterval(() => {}, 1000);'],
                { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            providerReady = new Promise(resolve => child.once('message', pid => {
                fs.writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ root: process.pid, provider: pid }));
                resolve();
            }));
            child.unref();` : `fs.writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ root: process.pid, provider: process.pid }));`}
            process.stdin.once('data', () => void providerReady.then(() => process.stdout.write(${JSON.stringify(records.map(record => JSON.stringify(record)).join('\n')+'\n')})));
            setInterval(() => {}, 1000);
        `);
        await writeFile(shimPath, '@echo off\r\n');
        await chmod(shimPath, 0o755);
        const launch = buildAgentCliLaunchSpecFromResolution({ source: 'override', command: mode === 'direct' ? vendorPath : shimPath },
            { platform: mode === 'wrapped' ? 'win32' : process.platform, processEnv: { HAPPIER_JS_RUNTIME_PATH: process.execPath } });
        if (!launch) throw new Error('The canonical Agent CLI launch could not be prepared');
        const systemTools = createRetainedAgentCliSystemToolService({ agentId: 'claude', binding: { toolId: 'claude-cli' },
            definition: { toolId: 'claude-cli', displayName: 'Claude Code CLI', lookupNames: ['claude'] }, launch,
            delegate: { resolve: async () => { throw new Error('Unexpected fallback outside the exact Agent CLI binding'); } } });
        const exec = createStablePluginExecService({
            signal: new AbortController().signal, isOccurrenceCurrent: () => true, systemTools,
            resolveExecutable: async () => { throw new Error('The exact resolution grant was not consumed'); },
            resolvePath: async path => resolvePluginPathWithinRoots({ pluginData: directory, workspace: directory, projects: new Map() }, path),
        });
        windowsSpawnBoundary.wrapperPath = mode === 'wrapped' ? vendorPath : null;
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
            { exec: createClaudeNativeSdkQueryContext(exec) });
        const operations = createClaudeAgentSdkTurnOperations({ ctx, directory, launchEnv: {}, permissionMode: 'default',
            happierSessionId: 'sdk-exit-qualification', publishSdkMessages: true });
        const activity: AgentSessionRuntimeEvent[] = [];
        operations.subscribeCanonicalAgentSessionEvents(event => activity.push(event));
        let captured: Extract<Awaited<ReturnType<typeof captureProcessTree>>, { status: 'ok' }> | undefined;
        try {
            operations.beginProviderTurn('qualification-turn');
            await operations.sendProviderTurnPrompt('launch background work');
            await vi.waitFor(() => expect(activity.at(-1)).toMatchObject({ state: 'active', activeCount: 1 }), { timeout: 10_000 });
            const pids = JSON.parse(await readFile(pidPath, 'utf8')) as { root: number; provider: number };
            const capture = await captureProcessTree({ pid: pids.root });
            if (capture.status !== 'ok') throw new Error('Fixture process generations could not be captured');
            captured = capture;
            process.kill(pids.root, 'SIGTERM');
            await vi.waitFor(() => expect(activity.at(-1)).toMatchObject({ state: mode === 'direct' ? 'idle' : 'unknown', activeCount: 0 }), { timeout: 10_000 });
            expect(isPidAlive(pids.root)).toBe(false);
            expect(isPidAlive(pids.provider)).toBe(mode === 'wrapped');
        } finally {
            if (captured) await terminateProcessTree({ targets: captured.capturedTargets, tree: false });
            await operations.disposeProviderSession();
            windowsSpawnBoundary.wrapperPath = null;
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('uses the retained exact launch only for the bound Agent CLI tool', async () => {
        if (process.platform === 'win32') return;

        const toolRoot = await mkdtemp(join(tmpdir(), 'happier-retained-agent-cli-'));
        const retainedPath = join(toolRoot, 'claude-retained.js');
        const delegatedGrant = Object.freeze({
            grantId: 'system-tool:delegated',
            toolId: 'macos-security',
            displayName: 'macOS Keychain security',
            source: 'system' as const,
            executablePath: '/usr/bin/security',
            launch: Object.freeze({
                kind: 'binary' as const,
                executablePath: '/usr/bin/security',
                cwd: toolRoot,
                args: Object.freeze([]),
                env: Object.freeze({ PATH: '' }),
            }),
        });
        const delegate = Object.freeze({
            resolve: vi.fn(async () => delegatedGrant),
        });

        await writeFile(retainedPath, 'process.stdout.write("retained");\n', 'utf8');
        await chmod(retainedPath, 0o644);
        try {
            const systemTools = createRetainedAgentCliSystemToolService({
                agentId: 'claude',
                binding: { toolId: 'claude-cli' },
                definition: {
                    toolId: 'claude-cli',
                    displayName: 'Claude Code CLI',
                    lookupNames: ['claude'],
                },
                launch: {
                    source: 'override',
                    resolvedPath: retainedPath,
                    command: process.execPath,
                    args: [retainedPath, '--retained-session'],
                },
                delegate,
            });

            await expect(systemTools.resolve({
                toolId: 'claude-cli',
                purpose: 'Run retained Claude Agent runtime',
                cwd: toolRoot,
            })).resolves.toMatchObject({
                executablePath: retainedPath,
                launch: {
                    executablePath: process.execPath,
                    args: [retainedPath, '--retained-session'],
                },
            });
            expect(delegate.resolve).not.toHaveBeenCalled();

            await expect(systemTools.resolve({
                toolId: 'macos-security',
                purpose: 'Run an unrelated declared system tool',
                cwd: toolRoot,
            })).resolves.toBe(delegatedGrant);
            expect(delegate.resolve).toHaveBeenCalledTimes(1);
        } finally {
            await rm(toolRoot, { recursive: true, force: true });
        }
    });

    it('executes the exact managed_only Codex preparation despite a later override', async () => {
        if (process.platform === 'win32') return;
        const platform = resolvePlatformFromNodePlatform(process.platform);
        if (!platform || (process.arch !== 'arm64' && process.arch !== 'x64')) return;
        const runtimeSpec = getAgentCliRuntimeSpec('codex');
        if (!runtimeSpec || runtimeSpec.managedInstall?.kind !== 'github_release_binary') {
            throw new Error('Expected the bundled Codex managed release descriptor');
        }
        const assetName = runtimeSpec.managedInstall.assetNameByPlatform?.[platform][process.arch];
        const archiveEntries = runtimeSpec.managedInstall.archiveEntriesByPlatform?.[platform];
        if (!assetName || !archiveEntries) throw new Error('Expected the Codex package archive layout');

        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-managed-binding-home-'));
        const toolRoot = await mkdtemp(join(tmpdir(), 'happier-runner-managed-binding-tools-'));
        const previousOverride = process.env.HAPPIER_CODEX_PATH;
        try {
            const archiveRoot = join(toolRoot, 'archive');
            for (const entry of archiveEntries) {
                const path = join(archiveRoot, entry.archivePath);
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, '#!/bin/sh\nprintf %s managed-codex\n', 'utf8');
                await chmod(path, 0o755);
            }
            const prepared = await prepareManagedAgentCliLaunch({
                runtimeSpec,
                platform,
                processEnv: { ...process.env, HAPPIER_HOME_DIR: happyHomeDir, PATH: '' },
                // GitHub is the external boundary; install, archive extraction,
                // executable resolution and plugin execution remain real.
                deps: {
                    fetchGitHubLatestRelease: async () => ({
                        tag_name: 'v0.0.0-fixture',
                        assets: [{
                            name: assetName,
                            browser_download_url: `https://example.test/${assetName}`,
                            digest: 'sha256:fixture',
                        }],
                    }),
                    downloadGitHubReleaseAsset: async ({ destinationPath }) => {
                        await createTar({ gzip: true, cwd: archiveRoot, file: destinationPath },
                            archiveEntries.map((entry) => entry.archivePath));
                    },
                },
            });
            expect(prepared.ok).toBe(true);
            if (!prepared.ok) throw new Error(prepared.errorMessage);
            const managedCommand = join(happyHomeDir, 'tools', 'providers', 'codex', 'current', 'bin', 'codex');
            expect(prepared.resolution.command).toBe(managedCommand);

            const overridePath = join(toolRoot, 'codex-override');
            await writeFile(overridePath, '#!/bin/sh\nprintf %s substituted-override\n', 'utf8');
            await chmod(overridePath, 0o755);
            process.env.HAPPIER_CODEX_PATH = overridePath;

            const bound = bindAgentCliLaunchSpec({ localAgentId: 'codex', spec: prepared.launch });
            const systemTools = createRetainedAgentCliSystemToolService({
                agentId: bound.localAgentId,
                binding: { toolId: 'codex-cli' },
                definition: { toolId: 'codex-cli', displayName: 'Codex CLI', lookupNames: ['codex'] },
                launch: bound.spec,
                delegate: { resolve: async () => { throw new Error('Unexpected system fallback'); } },
            });
            const resolved = await systemTools.resolve({
                toolId: 'codex-cli', purpose: 'Run the prepared Agent', cwd: toolRoot,
            });
            const result = spawnSync(resolved.launch.executablePath, [...(resolved.launch.args ?? [])], {
                cwd: resolved.launch.cwd,
                env: resolved.launch.env,
                encoding: 'utf8',
            });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stdout).toBe('managed-codex');
        } finally {
            if (previousOverride === undefined) delete process.env.HAPPIER_CODEX_PATH;
            else process.env.HAPPIER_CODEX_PATH = previousOverride;
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(toolRoot, { recursive: true, force: true });
        }
    });

    it.each(fixtures)(
        'keeps the canonical $agentId override ahead of a different PATH executable through activated runtime services',
        async (fixture) => {
            if (fixture.readableJavaScriptOverride && process.platform === 'win32') {
                return;
            }

            const happyHomeDir = await mkdtemp(join(tmpdir(), `happier-${fixture.agentId}-binding-home-`));
            const toolRoot = await mkdtemp(join(tmpdir(), `happier-${fixture.agentId}-binding-tools-`));
            const overridePath = join(
                toolRoot,
                fixture.readableJavaScriptOverride
                    ? `${fixture.agentId}-override.js`
                    : `${fixture.agentId}-override`,
            );
            const pathExecutable = join(
                toolRoot,
                process.platform === 'win32' ? `${fixture.agentId}.cmd` : fixture.agentId,
            );
            const previousPath = process.env.PATH;
            const previousOverride = process.env[fixture.overrideEnvKey];
            const previousJavaScriptRuntime = process.env.HAPPIER_JS_RUNTIME_PATH;
            const expectedOutput = `override-${fixture.agentId}`;

            await writeFile(
                overridePath,
                fixture.readableJavaScriptOverride
                    ? `process.stdout.write(${JSON.stringify(expectedOutput)});\n`
                    : process.platform === 'win32'
                        ? `@echo off\r\n<nul set /p "=${expectedOutput}"\r\n`
                        : `#!/bin/sh\nprintf %s ${JSON.stringify(expectedOutput)}\n`,
                'utf8',
            );
            await chmod(overridePath, fixture.readableJavaScriptOverride ? 0o644 : 0o755);
            await writeFile(
                pathExecutable,
                process.platform === 'win32'
                    ? '@echo off\r\n<nul set /p "=path-executable"\r\n'
                    : '#!/bin/sh\nprintf %s path-executable\n',
                'utf8',
            );
            await chmod(pathExecutable, 0o755);
            process.env.PATH = `${toolRoot}${delimiter}${previousPath ?? ''}`;
            process.env[fixture.overrideEnvKey] = overridePath;
            process.env.HAPPIER_JS_RUNTIME_PATH = process.execPath;

            const admitted = await createAdmittedPluginRuntimeFixture({
                happyHomeDir,
                runtimeOptions: { pluginIds: [fixture.pluginId] },
            });
            const runtimeRegistry = admitted.registry;
            try {
                await runtimeRegistry.activateContributionsOnDemand([{
                    pluginId: fixture.pluginId,
                    family: 'agents',
                    localId: fixture.agentId,
                }]);
                const occurrenceId = runtimeRegistry.readPluginOccurrenceId?.(fixture.pluginId);
                if (!occurrenceId) throw new Error('Expected admitted Agent plugin occurrence');
                const services = await runtimeRegistry.createAgentInvocationServices({
                    pluginId: fixture.pluginId,
                    pluginVersion: '0.0.0',
                    agentId: fixture.agentId,
                    occurrenceId,
                    correlationId: `${fixture.agentId}-binding`,
                    cwd: toolRoot,
                    signal: new AbortController().signal,
                    isOccurrenceCurrent: () => true,
                });

                const resolved = await services.exec.systemTools.resolve({
                    toolId: fixture.systemToolId,
                    purpose: `Launch ${fixture.agentId}`,
                    cwd: toolRoot,
                });
                expect(resolved).toMatchObject({
                    executablePath: overridePath,
                });
                if (fixture.invokeResolvedTool) {
                    const result = await services.exec.run({
                        executable: resolved.executable,
                        args: [],
                        cwd: { root: 'workspace', relativePath: '' },
                    });
                    expect(result.termination.observed).toMatchObject({
                        kind: 'exit',
                        exitCode: 0,
                    });
                    expect(new TextDecoder().decode(result.stdout)).toBe(expectedOutput);
                }
            } finally {
                await admitted.dispose();
                if (previousPath === undefined) delete process.env.PATH;
                else process.env.PATH = previousPath;
                if (previousOverride === undefined) delete process.env[fixture.overrideEnvKey];
                else process.env[fixture.overrideEnvKey] = previousOverride;
                if (previousJavaScriptRuntime === undefined) delete process.env.HAPPIER_JS_RUNTIME_PATH;
                else process.env.HAPPIER_JS_RUNTIME_PATH = previousJavaScriptRuntime;
                await rm(happyHomeDir, { recursive: true, force: true });
                await rm(toolRoot, { recursive: true, force: true });
            }
        },
    );
});
