import type { SpawnOptions } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { runMemberAgentEffect } from '@/daemon/agentIsolation/runMemberNativeOperation';
import { runWorkspaceEffectChild } from '@/workspaces/activation/workspaceEffectProcess';
import { encodeBackgroundServiceProcessFrame } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessProtocol';
import { createProjectNativeToolchainIoForHost } from './exec';

const boundary = vi.hoisted(() => ({
    systemdRunPath: '',
    launches: [] as { command: string; args: readonly string[] }[],
}));

// The user manager and process creation are OS boundaries. Keep scope discovery,
// launch composition, private pipes and physical settlement real beneath them.
vi.mock('@happier-dev/cli-common/process', async importOriginal => ({
    ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
    execFileWithDeadline: async (command: string, args: readonly string[]) => ({
        stdout: command === boundary.systemdRunPath ? '--expand-environment='
            : args.includes('--property=ControlGroup') ? 'ControlGroup=/user.slice/user@1001.service\n' : '',
        stderr: '',
    }),
}));
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
        boundary.launches.push({ command, args });
        if (command !== boundary.systemdRunPath) return actual.spawn(command, args, options);
        const target = args.indexOf('--') + 1;
        return actual.spawn(args[target]!, args.slice(target + 1), options);
    } };
});

afterEach(() => { vi.unstubAllEnvs(); boundary.launches.length = 0; });

it.skipIf(process.platform !== 'linux').each(['workspace', 'member-agent', 'toolchain'] as const)(
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
            const args = ['-e', kind === 'toolchain' ? emit : `process.stdin.once('data', () => { ${emit} }); process.stdin.resume();`];
            if (kind === 'workspace') {
                expect(await runWorkspaceEffectChild({ launch: { command, args, env: {}, release() {} }, signal,
                    id: 'finite', effect: {}, services: {}, refusal: code => new Error(code) }))
                    .toEqual({ settled: true, exitedCleanly: true });
            } else if (kind === 'member-agent') {
                expect(await runMemberAgentEffect({ launch: { command, args, env: {}, release() {} }, signal,
                    request: {}, readRecord: record => record })).toEqual({ done: true });
            } else {
                const io = createProjectNativeToolchainIoForHost({ resolveTool: async () => null });
                expect(await io.run({ command, args, cwd: directory, env: {}, signal }))
                    .toMatchObject({ exitCode: 0, stdout: 'finite-output' });
            }
            const launch = boundary.launches.find(value => value.args.includes(args[1]!));
            expect(launch?.command).toBe(boundary.systemdRunPath);
            expect(launch?.args).toContain('--slice=happier-jobs.slice');
        });
    },
);
