import type { SpawnOptions } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { runMemberAgentEffect } from '@/daemon/agentIsolation/runMemberNativeOperation';
import { runWorkspaceEffectChild } from '@/workspaces/activation/workspaceEffectProcess';
import { encodeBackgroundServiceProcessFrame } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessProtocol';
import { createProjectNativeToolchainIoForHost, createStablePluginExecService } from './exec';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { spawnMemberEffectWorker } from '@/daemon/agentIsolation/memberEffectWorker.testkit';
import { prepareNativeFilesystemEffect } from '@/rpc/handlers/fileSystem/prepareNativeFilesystemEffect';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { workspaceCheckoutNativeBoundary } from '@/workspaces/activation/workspaceCheckoutNative.testkit';

const boundary = vi.hoisted(() => ({
    systemdRunPath: '',
    backing: '',
    launches: [] as { command: string; args: readonly string[] }[],
}));

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    const { workspaceCheckoutFilesystemBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
    return workspaceCheckoutFilesystemBoundary(actual);
});

// The user manager and process creation are OS boundaries. Keep scope discovery,
// launch composition, private pipes and physical settlement real beneath them.
vi.mock('@happier-dev/cli-common/process', async importOriginal => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
    return { ...actual, execFileWithDeadline: async (command: string, args: readonly string[], options: Parameters<typeof actual.execFileWithDeadline>[2]) => {
        if (options?.inputBytes) {
            if (args.at(-1) === 'agent-launch') {
                const { runWorkspaceCheckoutCwdBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
                const cwd = await runWorkspaceCheckoutCwdBoundary(options.inputBytes, options.signal);
                if (cwd) return cwd;
            }
            boundary.launches.push({ command, args });
            const { spawn: actualSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
            return actual.execFileWithDeadline(command, args, { ...options,
                spawnChild: (_command, _args, spawnOptions) => spawnMemberEffectWorker({ actualSpawn, options: spawnOptions, backing: boundary.backing }) });
        }
        return { stdout: command === boundary.systemdRunPath ? '--expand-environment='
            : args.includes('--property=ControlGroup') ? 'ControlGroup=/user.slice/user@1001.service\n' : '', stderr: '' };
    } };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
        boundary.launches.push({ command, args });
        if (command === boundary.systemdRunPath) {
            const target = args.indexOf('--') + 1;
            command = args[target]!;
            args = args.slice(target + 1);
        }
        if (command === '/bin/sh' && args[0] === '-c' && args[2] === 'sh') {
            command = args[3]!;
            args = args.slice(4);
        }
        if (command === 'sudo') return spawnMemberEffectWorker({ actualSpawn: actual.spawn, options, backing: boundary.backing });
        return actual.spawn(command, args, options);
    } };
});

afterEach(() => { vi.unstubAllEnvs(); boundary.launches.length = 0; workspaceCheckoutNativeBoundary.reset(); });

it.skipIf(process.platform !== 'linux').each(['workspace', 'member-agent', 'toolchain', 'sdk'] as const)(
    'keeps finite %s work outside the daemon service cgroup', async kind => {
        await withTempDir('member-finite-scope-', async directory => {
            boundary.systemdRunPath = join(directory, 'systemd-run');
            await writeFile(boundary.systemdRunPath, '#!/bin/sh\n', { mode: 0o755 });
            vi.stubEnv('PATH', `${directory}:${process.env.PATH ?? ''}`);
            vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/fixture/user-bus');
            vi.stubEnv('XDG_RUNTIME_DIR', '/fixture/user-runtime');
            const signal = new AbortController().signal;
            const command = process.execPath;
            const output = kind === 'workspace'
                ? encodeBackgroundServiceProcessFrame({ kind: 'settled', id: 'finite' })
                : Buffer.from(kind === 'member-agent' ? '{"done":true}\n' : 'finite-output');
            const emit = `process.stdout.write(Buffer.from(${JSON.stringify(output.toString('base64'))}, 'base64'));`;
            const args = ['-e', kind === 'toolchain' || kind === 'sdk' ? emit : `process.stdin.once('data', () => { ${emit} }); process.stdin.resume();`];
            if (kind === 'workspace') {
                expect(await runWorkspaceEffectChild({ launch: { command, args, env: {}, release() {} }, signal,
                    id: 'finite', effect: {}, services: {}, refusal: code => new Error(code) }))
                    .toEqual({ settled: true, exitedCleanly: true });
            } else if (kind === 'member-agent') {
                expect(await runMemberAgentEffect({ launch: { command, args, env: {}, release() {} }, signal,
                    request: {}, readRecord: record => record })).toEqual({ done: true });
            } else if (kind === 'toolchain') {
                const io = createProjectNativeToolchainIoForHost({ resolveTool: async () => null });
                expect(await io.run({ command, args, cwd: directory, env: {}, signal }))
                    .toMatchObject({ exitCode: 0, stdout: 'finite-output' });
            } else {
                const service = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
                    resolveExecutable: async () => ({ command }), resolvePath: async () => directory });
                const result = await service.run({ executable: { kind: 'systemTool', id: 'finite-fixture' }, args });
                expect(result.termination.observed).toMatchObject({ kind: 'exit', exitCode: 0 });
                expect(Buffer.from(result.stdout).toString()).toBe('finite-output');
            }
            const launch = boundary.launches.find(value => value.args.includes(args[1]!));
            expect(launch?.command).toBe(boundary.systemdRunPath);
            expect(launch?.args).toContain('--slice=happier-jobs.slice');
        });
    },
);

it.skipIf(process.platform !== 'linux').each(['retirement', 'filesystem'] as const)(
    'keeps finite native %s outside the daemon service cgroup through physical settlement', async kind => {
        await withTempDir('member-finite-native-scope-', async directory => {
            boundary.backing = directory;
            boundary.systemdRunPath = join(directory, 'systemd-run');
            await writeFile(boundary.systemdRunPath, '#!/bin/sh\n', { mode: 0o755 });
            vi.stubEnv('PATH', `${directory}:${process.env.PATH ?? ''}`);
            vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/fixture/user-bus');
            vi.stubEnv('XDG_RUNTIME_DIR', '/fixture/user-runtime');
            const signal = new AbortController().signal;
            const identity = { kind: 'isolated' as const, separationRequired: true,
                requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
            const member = { ...deriveAgentIsolationMemberIdentity({ ...identity, homeServerIdentityId: 'home' }), agentUid: 2401, agentGid: 2401 };
            workspaceCheckoutNativeBoundary.mounts = [member.workspaceRoot, member.home].map(path => ({
                path, backing: directory, uid: member.agentUid, gid: member.agentGid, mode: 0o40700,
            }));
            const snapshot = { enabled: true, memberProvisioning: 'linuxUsersV1' as const,
                status: { kind: 'effective' as const, platform: 'linux' as const }, workspaceRoots: [] };
            const prepareNativeOperation = (input: Parameters<typeof prepareRequesterNativeOperation>[0]) => prepareRequesterNativeOperation({ ...input,
                preparedIdentity: { kind: 'member', requesterIdentity: { ...identity, homeServerIdentityId: 'home' }, snapshot, identity: member } }, {
                homeServerIdentityId: 'home', machineId: 'machine', installationId: 'installation',
                machine: { managedHappierBinaryPath: '/opt/happier/cli/current/happier', read: () => snapshot },
            });
            if (kind === 'retirement') {
                const native = await prepareNativeOperation({ requesterIdentity: identity, signal,
                    readMaterial: () => ({ materializationKey: 'finite', environment: {}, selectedMaterials: [] }) });
                const runtimeHome = native.materialTarget.runtimeHome.replace(member.home, directory);
                await mkdir(runtimeHome, { recursive: true });
                await writeFile(join(runtimeHome, 'selected'), 'finite');
                await native.dispose();
                await expect(stat(runtimeHome)).rejects.toMatchObject({ code: 'ENOENT' });
            } else {
                await writeFile(join(directory, 'visible'), 'finite');
                const channel = await prepareNativeFilesystemEffect({ prepareNativeOperation, identity, operationKey: 'finite', signal,
                    configuration: { workingDirectory: directory, accessPolicy: { kind: 'osUser' } } });
                try {
                    expect(await channel.request({ kind: 'filesystem.rpc', method: RPC_METHODS.LIST_DIRECTORY, input: { path: directory } }))
                        .toMatchObject({ success: true, entries: expect.arrayContaining([expect.objectContaining({ name: 'visible' })]) });
                } finally { await channel.dispose(); }
            }
            const launches = boundary.launches.filter(value => value.args.at(-1) === 'agent-launch');
            expect(launches.length).toBeGreaterThan(0);
            for (const launch of launches) {
                expect(launch.command).toBe(boundary.systemdRunPath);
                expect(launch.args).toContain('--slice=happier-jobs.slice');
            }
        });
    },
);
