import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { buildOpenSshCommand, SSH_PASSWORD_ENV } from '@happier-dev/cli-common/ssh';
import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { withRemoteHostSsh } from './transport.js';

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
});
