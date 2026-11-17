import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { readWorktreeChangeFingerprint } from '@/scm/readWorktreeChangeFingerprint';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { spawnSessionHolderChild } from '@/subprocess/supervision/sessionHolder';
import { serveSessionTargetRelay, SESSION_TARGET_PLACEMENT_ENV_KEY } from '@/subprocess/supervision/sessionTargetRelay';

import { bindPlacedSessionWorkspaceSource } from './placedSessionWorkspaceSource';
import { currentWorkspaceSource } from './workspaceSource';

const holderPath = resolveSessionHolderExecutablePath();
const helperPath = resolveProcessCustodySupportExecutable('linux');

/**
 * The Session runner stays on this Machine while a placed Session's workspace
 * lives in its target. Runner-side workspace work (checkpoints, review
 * fingerprints, media) must reach the target through the primary holder, never
 * this Machine's path of the same name. The provider boundary is a local shell.
 */
describe.skipIf(process.platform !== 'linux' || !holderPath || !helperPath)('placed Session runner workspace source', () => {
    let directory: string;
    beforeAll(async () => { directory = await mkdtemp('/tmp/placed-runner-source-'); });
    afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

    it('reads and runs Git in the target for the Session path, and stays local for an unplaced Session', async () => {
        const guestRoot = join(directory, 'guest');
        const hostRoot = '/host/placed-runner-workspace';
        execFileSync('sh', ['-c', `mkdir -p "${guestRoot}" && cd "${guestRoot}" && git init -q && printf 'guest only\\n' > guest.txt`]);
        const lifetime = new AbortController();
        const socketPath = join(directory, 'primary.sock');
        const target = {
            id: 'target:runner', holderPath: holderPath!, socketDirectory: directory,
            exec: (command: string) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
                const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
                let stdout = '';
                child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
                child.once('error', reject);
                child.once('close', status => resolve({ status: status ?? 1, stdout, stderr: '' }));
            }),
            openChannel(argv: readonly string[]) {
                const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
                const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
                child.once('close', () => channel.destroy());
                return channel;
            },
        };
        const agent = spawnSessionHolderChild({ executablePath: holderPath!, socketPath, command: '/bin/sleep', args: ['600'], cwd: guestRoot, target });
        await new Promise<void>((resolve, reject) => { agent.once('spawn', resolve); agent.once('error', reject); });
        try {
            const relay = await serveSessionTargetRelay({ lifetime: lifetime.signal, socketPath: join(directory, 'relay.sock'),
                operations: target, readTrustedCallerPid: () => process.pid,
                observePeer: async () => ({ pid: process.pid, uid: process.getuid!() }) });
            const placement = { id: target.id, holderPath, helperPath, socketDirectory: directory, relaySocketPath: relay.socketPath,
                primarySocketPath: socketPath, launch: { executables: {}, env: {}, workspace: { hostRoot, targetRoot: guestRoot } } };
            await runAddedHostedSession({ workingDirectory: hostRoot, end: () => {},
                environment: { ...process.env, [SESSION_TARGET_PLACEMENT_ENV_KEY]: JSON.stringify(placement) } }, async () => {
                bindPlacedSessionWorkspaceSource();
                expect(currentWorkspaceSource().kind).toBe('target');
                expect((await currentWorkspaceSource().readFile(join(hostRoot, 'guest.txt'))).toString('utf8')).toBe('guest only\n');
                expect(await readWorktreeChangeFingerprint(hostRoot)).toMatchObject({ kind: 'available' });
            });
            await runAddedHostedSession({ workingDirectory: directory, end: () => {}, environment: { ...process.env } }, async () => {
                bindPlacedSessionWorkspaceSource();
                expect(currentWorkspaceSource().kind).toBe('local');
            });
        } finally {
            lifetime.abort();
            await agent.terminateGroup({ graceMs: 100 });
        }
    }, 60_000);
});
