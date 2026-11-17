import { describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createStablePluginExecService } from '../invocation/services/exec';
import { createPtyTerminalHostAdapter } from '@/terminal/pty/hostAdapter';
import type { PtyProcess, PtySpawnParams } from '@/terminal/pty/provider';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { AgentTerminalHostLaunchInput } from '@happier-dev/plugin-sdk/agents/runtime';
import { AGENT_LAUNCH_TERMINAL_READY, AGENT_LAUNCH_TERMINAL_ACCEPTED, readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import type { TerminalHostAdapter } from '@/integrations/terminal/host/_types';
import {
    createPluginTerminalHostService,
    installAgentChildLaunchEnvironmentTransformerForTerminalHost,
} from './terminalHost';

async function withNativeLaunchFixture(run: (fixture: Readonly<{
    root: string;
    exec: ReturnType<typeof createStablePluginExecService>;
    activate: ReturnType<typeof vi.fn>;
    controller: AbortController;
}>) => Promise<void>) {
    await withTempDir('happier native terminal ', async root => {
        await writeFile(join(root, 'mise.toml'), '[env]\nFINAL_NATIVE = "active"\n');
        // Native CLI IO is a genuine external process boundary.
        const activate = vi.fn(async () => ({ exitCode: 0, stdout: 'FINAL_NATIVE=active\0TERM=xterm-256color\0' }));
        const controller = new AbortController();
        const exec = createStablePluginExecService({ signal: controller.signal,
            isOccurrenceCurrent: () => true,
            resolveExecutable: async () => { throw new Error('Agent identity must not be re-resolved'); },
            resolvePath: async () => root,
            prepareAgentNativeLaunch: async () => ({ projectLaunch: {
                status: 'ready', reviewedEffectDigest: 'reviewed-terminal-environment',
                toolchain: { root, selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
                    platform: 'linux', io: {
                        resolveTool: async () => ({ executablePath: '/tools/mise', version: '2026.10.4' }),
                        run: activate,
                    } },
            } }),
        });
        await run({ root, exec, activate, controller });
    });
}

describe('terminal host final native launch', () => {
    it.skipIf(process.platform !== 'linux').each(['pty', 'tmux-frame', 'tmux-plain'] as const)(
        'preserves native frame custody at the terminal boundary: %s', async transport => {
        await withTempDir('terminal-native-frame-', async root => {
            const controller = new AbortController();
            const framed = transport !== 'tmux-plain';
            const source = join(root, 'mcp.json');
            await writeFile(source, '{"mcpServers":{"fixture":{"env":{"TOKEN":"synthetic-frame-secret"}}}}');
            const exec = createStablePluginExecService({ signal: controller.signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async () => { throw new Error('Resolved CLI only'); },
                resolvePath: async () => root, prepareAgentNativeLaunch: async () => undefined,
                ...(framed ? { agentIsolation: {
                    requesterIdentity: { kind: 'isolated' as const, separationRequired: false, requester: {
                        serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } },
                    read: () => ({ enabled: true, status: { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' },
                        workspaceRoots: [root], localTransport: { agentUid: 2402, agentGid: 2402 }, launch: {
                            managedHappierBinaryPath: '/fixture/happier', runtimeHome: join(root, 'runtime'),
                            selectedEnvironmentKeys: [], selectedMaterials: [], environment: {},
                            sessionMcpContext: { v: 1 as const, socketPath: join(root, 'mcp.sock'), bearerToken: 'synthetic-terminal-token' },
                        } }),
                } } : {}),
            });
            const writes: string[] = [];
            let onData: ((data: string) => void) | undefined;
            const pty: PtyProcess = { pid: 1234, write(data) { writes.push(data); }, resize() {}, kill() {},
                onData(listener) { onData = listener; return { dispose() {} }; }, onExit: () => ({ dispose() {} }) };
            const physical = vi.fn(() => pty);
            const ptyAdapter = createPtyTerminalHostAdapter({ sessionTarget: null, ptyProvider: { spawn: physical } });
            const tmuxCreate = vi.fn(async (input: Parameters<TerminalHostAdapter['createOrAttachHost']>[0]) => {
                await input.prepareLaunch?.();
                return { kind: 'tmux', sessionName: input.sessionName, paneId: 'fixture-pane', attachMetadata: {
                    attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required',
                } } satisfies Awaited<ReturnType<TerminalHostAdapter['createOrAttachHost']>>;
            });
            const { nativePreambleTransport: _nativePreambleTransport, ...tmuxBaseAdapter } = ptyAdapter;
            const adapter: TerminalHostAdapter = transport === 'pty' ? ptyAdapter
                : { ...tmuxBaseAdapter, kind: 'tmux', createOrAttachHost: tmuxCreate };
            const service = createPluginTerminalHostService({ hasCapability: () => true,
                resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'windows_console_forced' }),
                resolveAgentCliLaunch: () => ({ command: '/fixture/claude', args: [] }),
                disposeHost: async () => {},
            });
            const binding = installAgentChildLaunchEnvironmentTransformerForTerminalHost(service, env => env, { exec, signal: controller.signal });
            const launch = service.createOrAttachHost({ preference: transport === 'pty' ? 'windows_console' : 'tmux',
                sessionName: 'native-frame', workingDirectory: root, isolatedEnv: true,
                launch: { kind: 'agent-cli', agentId: 'claude', args: ['--mcp-config', source], requiredFiles: [source] } });
            try {
                if (transport === 'tmux-frame') {
                    await expect(launch).rejects.toMatchObject({ code: 'terminal_preamble_transport_unsupported' });
                    expect(physical).not.toHaveBeenCalled();
                } else {
                    const handle = await launch;
                    if (transport === 'pty') {
                        onData!(AGENT_LAUNCH_TERMINAL_READY);
                        expect(writes).toHaveLength(1);
                        const frame = await readAgentLaunchFrame(Readable.from(writes, { objectMode: false }), 'terminal');
                        expect(frame.selectedMaterials.some(file => Buffer.from(file.contentBase64, 'base64').toString().includes('synthetic-frame-secret'))).toBe(true);
                        onData!(AGENT_LAUNCH_TERMINAL_ACCEPTED + 'Agent ready');
                        const control = adapter.createControlPort!(handle);
                        const capture = await control.captureScreen();
                        expect(JSON.stringify(capture)).not.toContain('synthetic-frame-secret');
                        expect(JSON.stringify(capture)).not.toContain(AGENT_LAUNCH_TERMINAL_READY);
                    } else expect(tmuxCreate).toHaveBeenCalledOnce();
                }
            } finally { binding.dispose(); controller.abort(); }
        });
    });

    it.skipIf(process.platform !== 'linux')('refuses an unavailable declared terminal config before native PTY spawn', async () => {
        await withTempDir('required-terminal-config-', async root => {
            const signal = new AbortController().signal;
            const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async () => { throw new Error('Resolved CLI only'); },
                resolvePath: async () => root, prepareAgentNativeLaunch: async () => undefined,
                agentIsolation: { requesterIdentity: { kind: 'isolated', separationRequired: false, requester: {
                    serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } },
                    read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
                        workspaceRoots: [root], localTransport: { agentUid: 2402, agentGid: 2402 }, launch: {
                            managedHappierBinaryPath: '/fixture/happier', runtimeHome: join(root, 'runtime'),
                            selectedEnvironmentKeys: [], selectedMaterials: [], environment: {},
                            sessionMcpContext: { v: 1, socketPath: join(root, 'mcp.sock'), bearerToken: 'synthetic-terminal-token' },
                        } }) },
            });
            const physical: PtySpawnParams[] = [];
            const adapter = createPtyTerminalHostAdapter({ ptyProvider: { spawn(input) {
                physical.push(input); throw new Error('Missing config must fail before PTY spawn');
            } } });
            const service = createPluginTerminalHostService({ hasCapability: () => true,
                resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'windows_console_forced' }),
                resolveAgentCliLaunch: () => ({ command: '/fixture/claude', args: [] }),
                disposeHost: async ({ handle, adapter: owner }) => owner.dispose(handle),
            });
            const binding = installAgentChildLaunchEnvironmentTransformerForTerminalHost(service, env => env, { exec, signal });
            const missing = join(root, 'missing-mcp.json');
            const launch = { kind: 'agent-cli', agentId: 'claude', args: ['--mcp-config', missing],
                requiredFiles: [missing] } satisfies AgentTerminalHostLaunchInput & { requiredFiles: readonly string[] };
            try {
                await expect(service.createOrAttachHost({ preference: 'windows_console', sessionName: 'required-config',
                    workingDirectory: root, isolatedEnv: true, launch })).rejects.toMatchObject({
                    code: 'agent_launch_required_file_unavailable', execLaunch: 'notStarted',
                });
                expect(physical).toEqual([]);
            } finally { binding.dispose(); }
        });
    });

    it('retains the terminal isolation refusal before reaching the PTY boundary', async () => {
        const signal = new AbortController().signal;
        const root = process.cwd();
        const exec = createStablePluginExecService({ signal,
            isOccurrenceCurrent: () => true, resolveExecutable: async () => { throw new Error('Resolved CLI only'); },
            resolvePath: async () => root, prepareAgentNativeLaunch: async () => undefined,
            agentIsolation: { read: () => ({ enabled: true, status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [root] }) },
        });
        const physical: PtySpawnParams[] = [];
        const adapter = createPtyTerminalHostAdapter({ ptyProvider: {
            spawn(input) { physical.push(input); throw new Error('Isolation refusal must precede PTY spawn'); },
        } });
        const service = createPluginTerminalHostService({ hasCapability: () => true,
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'windows_console_forced' }),
            resolveAgentCliLaunch: () => ({ command: process.execPath, args: ['--version'] }),
            disposeHost: async ({ handle, adapter: owner }) => owner.dispose(handle),
        });
        const binding = installAgentChildLaunchEnvironmentTransformerForTerminalHost(service, env => env, { exec, signal });
        try {
            await expect(service.createOrAttachHost({ preference: 'windows_console', sessionName: 'isolation-refused',
                workingDirectory: root, isolatedEnv: true, launch: { kind: 'agent-cli', agentId: 'claude' } }))
                .rejects.toMatchObject({ code: 'agent_isolation_unavailable', execLaunch: 'notStarted', retryable: false,
                    data: { details: { reason: 'isolation_not_ready', launchKind: 'terminal' } } });
            expect(physical).toEqual([]);
        } finally { binding.dispose(); }
    });

    it.each(['failed', 'cancelled'] as const)('never starts a host process after native activation is %s', async outcome => {
        await withNativeLaunchFixture(async ({ root, exec, activate, controller }) => {
            activate.mockImplementationOnce(async () => {
                if (outcome === 'cancelled') controller.abort();
                return { exitCode: outcome === 'failed' ? 1 : 0, stdout: '' };
            });
            const physical: PtySpawnParams[] = [];
            const adapter = createPtyTerminalHostAdapter({ ptyProvider: {
                spawn(input) { physical.push(input); throw new Error('Native failure must not fall back to host'); },
            } });
            const service = createPluginTerminalHostService({
                hasCapability: () => true,
                resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'windows_console_forced' }),
                resolveAgentCliLaunch: () => ({ command: process.execPath, args: ['installed-agent'] }),
                disposeHost: async ({ handle, adapter: owner }) => owner.dispose(handle),
            });
            const binding = installAgentChildLaunchEnvironmentTransformerForTerminalHost(service, env => env, { exec, signal: controller.signal });
            try {
                await expect(service.createOrAttachHost({ preference: 'windows_console', sessionName: 'native-refused',
                    workingDirectory: root, isolatedEnv: true, launch: { kind: 'agent-cli', agentId: 'claude' } }))
                    .rejects.toMatchObject({ code: outcome === 'failed' ? 'native_toolchain_failed' : 'plugin_exec_aborted' });
                expect(physical).toEqual([]);
            } finally { binding.dispose(); }
        });
    });

    it('finalizes the complete cold PTY tuple once and does not reactivate a warm host', () => withNativeLaunchFixture(async ({ root, exec, activate }) => {
        const physical: PtySpawnParams[] = [];
        const pty: PtyProcess = {
            pid: 1234, write() {}, resize() {}, kill() {},
            onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
        };
        // Only the OS PTY boundary is substituted; host, adapter and Exec remain real.
        const adapter = createPtyTerminalHostAdapter({ ptyProvider: {
            spawn(input) { physical.push(input); return pty; },
        } });
        const transform = vi.fn((env: Readonly<Record<string, string>>) => env);
        const service = createPluginTerminalHostService({
            hasCapability: () => true,
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'windows_console_forced' }),
            resolveAgentCliLaunch: () => ({ command: process.execPath, args: ['installed-agent'], env: { REMOVE: 'host' } }),
            disposeHost: async ({ handle, adapter: owner }) => owner.dispose(handle),
        });
        const binding = installAgentChildLaunchEnvironmentTransformerForTerminalHost(service, transform, { exec });
        const request = { preference: 'windows_console' as const, sessionName: 'native-cold',
            workingDirectory: root, isolatedEnv: true,
            launch: { kind: 'agent-cli' as const, agentId: 'claude', args: ['literal $() ; " argument \\'] } };
        try {
            const cold = await service.createOrAttachHost(request);
            expect(physical).toHaveLength(1);
            expect(physical[0]).toMatchObject({ file: process.execPath,
                args: ['installed-agent', 'literal $() ; " argument \\'],
                options: { cwd: root, env: { FINAL_NATIVE: 'active' } } });
            expect(physical[0]!.options.env).not.toHaveProperty('REMOVE');
            expect(transform).toHaveBeenCalledTimes(1);
            expect(activate).toHaveBeenCalledTimes(1);
            const warm = await service.createOrAttachHost(request);
            expect(warm).toBe(cold);
            expect(physical).toHaveLength(1);
            expect(activate).toHaveBeenCalledTimes(1);
            await service.dispose(cold, { kind: 'destroy_owned_host', reason: 'session_closed' });
        } finally { binding.dispose(); }
    }));

    it('uses the same final tuple before a new borrowed-terminal process', () => withNativeLaunchFixture(async ({ root, exec, activate }) => {
        const launches: Parameters<NonNullable<Parameters<typeof createPluginTerminalHostService>[0]['launchCurrentHostProcess']>>[0][] = [];
        const handle = { kind: 'tmux' as const, sessionName: 'current', attachMetadata: {
            attachStrategy: 'terminal_host' as const, topology: 'shared' as const, locality: 'same_machine' as const,
            liveProbe: 'required' as const,
        } };
        const service = createPluginTerminalHostService({
            hasCapability: () => true,
            resolveTerminalHost: () => ({ status: 'resolved', reason: 'tmux_forced', adapter: {
                kind: 'tmux', createOrAttachHost: async () => { throw new Error('Must retain the current host'); },
                injectUserPrompt: async () => { throw new Error('Unused'); }, interruptTurn: async () => {},
                evaluateLiveness: async () => ({ paneAlive: true, observedAt: 0 }), dispose: async () => {},
            } }),
            resolveAgentCliLaunch: () => ({ command: process.execPath, args: ['installed-agent'], providerExitOwnership: 'direct' }),
            resolveCurrentHost: () => ({ handle, lifecycle: 'borrowed' }),
            launchCurrentHostProcess: async input => {
                launches.push(input);
                return { launcherIdentity: null, whenExited: new Promise(() => {}), terminate: async () => {}, signal: async () => {} };
            },
            disposeHost: async () => {},
        });
        const binding = installAgentChildLaunchEnvironmentTransformerForTerminalHost(service, env => env, { exec });
        try {
            const result = await service.createOrAttachHost({ preference: 'tmux', sessionName: 'borrowed',
                workingDirectory: root, isolatedEnv: true,
                launch: { kind: 'agent-cli', agentId: 'claude', args: ['literal argument'] } });
            expect(result).toBe(handle);
            expect(launches).toEqual([expect.objectContaining({
                spawnArgv: [process.execPath, 'installed-agent', 'literal argument'],
                workingDirectory: root, spawnEnv: expect.objectContaining({ FINAL_NATIVE: 'active' }),
            })]);
            expect(activate).toHaveBeenCalledTimes(1);
            await service.dispose(result, { kind: 'destroy_owned_host', reason: 'session_closed' });
        } finally { binding.dispose(); }
    }));
});
