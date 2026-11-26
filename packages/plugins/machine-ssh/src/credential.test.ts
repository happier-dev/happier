import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { buildOpenSshCommand, SSH_PASSWORD_ENV } from '@happier-dev/cli-common/ssh';
import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { putSshFile, runSshExec, streamSsh, withRemoteHostSsh } from './transport.js';

const secret = 'fixture SSH credential with a space';
const target = 'guest@localhost';

describe('D-f SSH credential custody', () => {
    it.each(['password', 'keyfile'] as const)('uses the invocation lease for %s without putting material in argv', async authMode => {
        const bytes = Buffer.from(JSON.stringify({ v: 1, target, port: 37022, knownHostsPath: '/qa/known_hosts', authMode, credential: secret }));
        let identityPath: string | undefined;
        await withRemoteHostSsh({
            signal: new AbortController().signal,
            materializeBootstrapCredential: async () => ({ kind: 'bytes', bytes, async dispose() { bytes.fill(0); } }),
        }, async connection => {
            const invocation = buildOpenSshCommand({ ...connection, sshBin: 'ssh', remoteCommand: ['uname -s'] });
            expect(invocation.args).toContain(target);
            expect(invocation.args).toContain('StrictHostKeyChecking=yes');
            expect(invocation.args.join(' ')).not.toContain(secret);
            if (authMode === 'password') {
                expect(invocation.env).toHaveProperty(SSH_PASSWORD_ENV, secret);
            } else {
                identityPath = invocation.args[invocation.args.indexOf('-i') + 1];
                expect((await readFile(identityPath, 'utf8')).trim()).toBe(secret);
                if (process.platform !== 'win32') expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
            }
        });
        expect(bytes.every(byte => byte === 0)).toBe(true);
        if (identityPath) await expect(stat(identityPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.skipIf(process.platform !== 'linux').each(['password', 'keyfile'] as const)('keeps %s out of OpenSSH /proc cmdline', async authMode => {
        const listener = createServer();
        const listen = once(listener, 'listening');
        listener.listen(0, '127.0.0.1');
        await listen;
        try {
            const endpoint = listener.address();
            if (!endpoint || typeof endpoint === 'string') throw new Error('Missing test TCP endpoint');
            const bytes = Buffer.from(JSON.stringify({ v: 1, target: 'guest@127.0.0.1', port: endpoint.port,
                knownHostsPath: '/qa/known_hosts', authMode, credential: secret }));
            await withRemoteHostSsh({
                signal: new AbortController().signal,
                materializeBootstrapCredential: async () => ({ kind: 'bytes', bytes, async dispose() { bytes.fill(0); } }),
            }, async connection => {
                const invocation = buildOpenSshCommand({ ...connection, sshBin: 'ssh', tty: false, remoteCommand: ['uname -s'] });
                const accepted = once(listener, 'connection');
                const ssh = spawn(invocation.command, invocation.args, { env: invocation.env, stdio: 'ignore' });
                const exited = once(ssh, 'close');
                try {
                    const [socket] = await Promise.race([accepted,
                        exited.then(() => { throw new Error('OpenSSH did not connect to the test socket'); })]);
                    try {
                        const args = (await readFile(`/proc/${ssh.pid}/cmdline`, 'utf8')).split('\0');
                        expect(args[0]).toBe('ssh');
                        expect(args).toContain('guest@127.0.0.1');
                        expect(args.join(' ')).not.toContain(secret);
                    } finally { socket.destroy(); }
                } finally {
                    ssh.kill();
                    await exited;
                }
            });
        } finally { listener.close(); }
    });

    it.each(['password', 'keyfile'] as const)('keeps %s out of argv across runSshExec, putSshFile (scp) and streamSsh, and disposes on failure', async authMode => {
        const leases: Buffer[] = [];
        const recorded: Array<{ tool: string; args: readonly string[]; env: Record<string, string> | undefined; identityPath?: string }> = [];
        let failNextRun = false;
        const makeContext = () => ({
            signal: new AbortController().signal,
            services: {
                machineProvisioners: {
                    materializeBootstrapCredential: async () => {
                        const bytes = Buffer.from(JSON.stringify({ v: 1, target, port: 37022, knownHostsPath: '/qa/known_hosts', authMode, credential: secret }));
                        leases.push(bytes);
                        return { kind: 'bytes' as const, bytes, async dispose() { bytes.fill(0); } };
                    },
                },
                exec: {
                    systemTools: {
                        resolve: async ({ toolId }: { toolId: string }) => ({ executable: `/usr/bin/${toolId}` }),
                    },
                    run: async (spec: { executable: string; args: readonly string[]; env?: Record<string, string> }) => {
                        const idx = spec.args.indexOf('-i');
                        const identityPath = idx >= 0 ? spec.args[idx + 1] : undefined;
                        if (identityPath) {
                            expect((await readFile(identityPath, 'utf8')).trim()).toBe(secret);
                            if (process.platform !== 'win32') expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
                        }
                        recorded.push({ tool: spec.executable, args: [...spec.args], env: spec.env, identityPath });
                        if (failNextRun) {
                            failNextRun = false;
                            throw new Error('simulated ssh failure');
                        }
                        return {
                            stdout: Buffer.from('ok\n'),
                            stderr: Buffer.alloc(0),
                            stdoutTruncated: false,
                            stderrTruncated: false,
                            termination: { requestedBy: { kind: 'none' as const }, observed: { kind: 'exit' as const, exitCode: 0 } },
                        };
                    },
                    spawn: async (spec: { executable: string; args: readonly string[]; env?: Record<string, string> }) => {
                        const idx = spec.args.indexOf('-i');
                        const identityPath = idx >= 0 ? spec.args[idx + 1] : undefined;
                        if (identityPath) {
                            expect((await readFile(identityPath, 'utf8')).trim()).toBe(secret);
                            if (process.platform !== 'win32') expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
                        }
                        recorded.push({ tool: spec.executable, args: [...spec.args], env: spec.env, identityPath });
                        return {
                            waitForExit: async () => ({ requestedBy: { kind: 'none' as const }, observed: { kind: 'exit' as const, exitCode: 0 } }),
                            dispose: async () => {},
                        };
                    },
                },
            },
        }) as unknown as PluginInvocationContext;

        await runSshExec({ argv: ['uname', '-s'] }, makeContext());
        await expect(putSshFile({ guestPath: '/tmp/probe', bytesBase64: Buffer.from('hi').toString('base64'), mode: 0o600 }, makeContext()))
            .resolves.toEqual({ kind: 'confirmed' });
        await streamSsh({ argv: ['sh', '-c', 'true'] }, makeContext());
        failNextRun = true;
        await expect(runSshExec({ argv: ['uname', '-s'] }, makeContext())).rejects.toThrow('simulated ssh failure');

        expect(recorded).toHaveLength(4);
        expect(recorded.map(entry => entry.tool)).toEqual(['/usr/bin/ssh-client', '/usr/bin/scp', '/usr/bin/ssh-client', '/usr/bin/ssh-client']);
        for (const entry of recorded) {
            expect(entry.args.join(' ')).not.toContain(secret);
            expect(entry.args).toContain('StrictHostKeyChecking=yes');
            expect(entry.args).toContain('UserKnownHostsFile=/qa/known_hosts');
            if (authMode === 'password') {
                expect(entry.env).toHaveProperty(SSH_PASSWORD_ENV, secret);
                expect(entry.env?.SSH_ASKPASS).toBeTruthy();
                expect(entry.env?.SSH_ASKPASS_REQUIRE).toBeTruthy();
                expect(entry.identityPath).toBeUndefined();
            } else {
                expect(entry.args).toContain('IdentitiesOnly=yes');
                expect(entry.identityPath).toBeTruthy();
                await expect(stat(entry.identityPath!)).rejects.toMatchObject({ code: 'ENOENT' });
            }
        }
        expect(leases).toHaveLength(4);
        for (const bytes of leases) expect(bytes.every(byte => byte === 0)).toBe(true);
    });
});
