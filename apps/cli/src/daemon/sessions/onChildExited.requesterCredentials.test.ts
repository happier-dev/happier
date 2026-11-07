import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createRequesterSessionCredentialCustody } from '../sessionEncryption/requesterSessionCredentials';
import type { TrackedSession } from '../types';
import { createOnChildExited } from './onChildExited';

it.each(['clean', 'stop', 'crash', 'replacement', 'other-requester'] as const)(
    'retains resumable requester custody after physical exit: %s', async scenario => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-requester-exit-'));
        const environment = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        environment.patch({ HAPPIER_HOME_DIR: directory });
        reloadConfiguration();
        const attribution = { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' };
        const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: directory, sessionId: 'requester-session',
            attribution, credentials: { token: 'requester-fixture', encryption: null } });
        const child = spawn(process.execPath, ['-e', `process.exitCode = ${scenario === 'crash' ? 1 : 0}`], { stdio: 'ignore' });
        const pid = child.pid;
        if (pid === undefined) throw new Error('Missing exited process fixture');
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        const tracked: TrackedSession = { pid, happySessionId: 'requester-session', startedBy: 'daemon',
            ...(scenario === 'stop' ? { stopRequestedAtMs: Date.now() } : {}),
            requesterWorkAttributionV1: scenario === 'other-requester' ? { ...attribution, accountId: 'cara' } : attribution };
        const sessions = new Map([[pid, tracked]]);
        if (scenario === 'replacement') sessions.set(process.pid, { ...tracked, pid: process.pid });
        const exited = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(), getApiMachineForSessions: () => null });
        try {
            await exited(pid, { reason: 'process-exited', ...exit });
            await expect(access(custody.path)).resolves.toBeUndefined();
        } finally {
            environment.restore();
            reloadConfiguration();
            await rm(directory, { recursive: true, force: true });
        }
    },
);
