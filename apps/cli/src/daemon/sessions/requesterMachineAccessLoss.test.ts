import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { registerMachineAccessLossReceiver } from '../externalActions/registerMachineAccessLossReceiver';

import { readProcessIdentityByPid } from '../processIdentity';
import type { TrackedSession } from '../types';
import { createStopSession } from './stopSession';
import { createRequesterMachineSessionAccessLossCleanup } from './requesterMachineAccessLoss';
import { createRequesterSessionCredentialCustody, retireRequesterSessionCredentialCustody } from '../sessionEncryption/requesterSessionCredentials';

describe('requester Machine access-loss Session custody', () => {
  it('settles only the exact admitted requester process and retains other requester work', async () => {
    // These are real OS processes; selection, PID safety and stop/exit lifecycle execute unchanged.
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-requester-retirement-'));
    const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']));
    try {
      await Promise.all(children.map(child => once(child, 'spawn')));
      const tracked = new Map<number, TrackedSession>();
      for (const [index, child] of children.entries()) {
        if (!child.pid) throw new Error('Process did not start');
        const identity = await readProcessIdentityByPid(child.pid);
        if (!identity || typeof identity.processStartTimeMs !== 'number') throw new Error('Process identity unavailable');
        tracked.set(child.pid, { pid: child.pid, startedBy: 'daemon', childProcess: child,
          happySessionId: randomUUID(), processStartTimeMs: identity.processStartTimeMs,
          requesterWorkAttributionV1: { serverId: index === 2 ? 'other-home' : 'home', accountId: index === 1 ? 'other' : 'revoked',
            machineId: 'machine', installationId: index === 3 ? 'old-installation' : 'installation' } });
      }
      let refuseSignal = false;
      let stopOwnerObserved = false;
      const stopSession = createStopSession({ pidToTrackedSession: tracked,
        // Filesystem attachment absence is the genuine persistence boundary for these plain child fixtures.
        readHostAttachmentState: async () => ({ status: 'absent' }),
        readTerminalAttachmentInfo: async () => null,
        areTrackedRunnersExited: async ({ trackedPids }) => {
          stopOwnerObserved = true;
          return trackedPids.every(pid => {
            const child = tracked.get(pid)?.childProcess;
            return child?.exitCode !== null || child?.signalCode !== null;
          });
        },
        waitForTrackedRunnersExit: async ({ trackedPids }) => {
          await Promise.all(trackedPids.map(async pid => {
            const child = tracked.get(pid)?.childProcess;
            if (child && child.exitCode === null && child.signalCode === null) await once(child, 'exit');
            tracked.delete(pid);
          }));
          return true;
        },
      });
      const witnesses = [children[0], children[1]].map(child => child?.pid && tracked.get(child.pid));
      const custody = await Promise.all(witnesses.map(async witness => {
        if (!witness || !witness.happySessionId || !witness.requesterWorkAttributionV1) throw new Error('Missing exact witness');
        return await createRequesterSessionCredentialCustody({ happyHomeDir, sessionId: witness.happySessionId,
          attribution: witness.requesterWorkAttributionV1, credentials: { token: 'fixture-token', encryption: null } });
      }));
      const cleanup = createRequesterMachineSessionAccessLossCleanup({ serverId: 'home', machineId: 'machine',
        pidToTrackedSession: tracked, stopSession,
        retireRequesterCredentials: input => retireRequesterSessionCredentialCustody({ happyHomeDir, ...input }),
      });
      let lossCurrent = false;
      const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
        authorizeRequest: request => authorizeMachineRpcRequest(request, {
          machineId: 'machine', resolveCustodianAccountId: async () => 'custodian',
          resolveInstallationId: () => 'installation',
          // Only authenticated Home verification is replaced at its network boundary.
          verifyMachineAdmission: async input => {
            return lossCurrent && input.custodySubjectAccountId === 'revoked' && (!refuseSignal || !stopOwnerObserved);
          },
        }) });
      registerMachineAccessLossReceiver(rpc, { machineId: 'machine', resolveInstallationId: () => 'installation',
        cleanupRequesterMachineSessions: cleanup });
      const request = { method: `machine:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
        params: { v: 1, subjectAccountId: 'revoked' }, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
        machineAdmission: { actorAccountId: 'custodian', custodianAccountId: 'custodian', machineId: 'machine',
          installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const } };
      // A delayed notification after restored admission cannot signal fresh work.
      expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(children[0]?.signalCode).toBeNull();
      expect(await readFile(custody[0]!.path, 'utf8')).toContain('fixture-token');
      lossCurrent = true;
      refuseSignal = true;
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'incomplete' });
      expect(children[0]?.exitCode).toBeNull();
      expect(children[0]?.signalCode).toBeNull();
      expect(await readFile(custody[0]!.path, 'utf8')).toContain('fixture-token');
      refuseSignal = false;
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'settled' });
      expect(children[0]?.exitCode !== null || children[0]?.signalCode !== null).toBe(true);
      await expect(readFile(custody[0]!.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(custody[1]!.path, 'utf8')).toContain('fixture-token');
      for (const child of children.slice(1)) {
        expect(child.signalCode).toBeNull();
        expect(child.pid && tracked.has(child.pid)).toBe(true);
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await once(child, 'exit');
        }
      }
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not reinterpret legacy attribution or another Home/installation as requester custody', async () => {
    const tracked = new Map<number, TrackedSession>([
      [1, { pid: 1, startedBy: 'daemon', happySessionId: 'legacy' }],
      [2, { pid: 2, startedBy: 'daemon', happySessionId: 'other-home', requesterWorkAttributionV1:
        { serverId: 'other', accountId: 'revoked', machineId: 'machine', installationId: 'installation' } }],
      [3, { pid: 3, startedBy: 'daemon', happySessionId: 'old-installation', requesterWorkAttributionV1:
        { serverId: 'home', accountId: 'revoked', machineId: 'machine', installationId: 'old' } }],
    ]);
    const cleanup = createRequesterMachineSessionAccessLossCleanup({ serverId: 'home', machineId: 'machine',
      pidToTrackedSession: tracked, stopSession: createStopSession({ pidToTrackedSession: tracked }) });
    expect(await cleanup({ requesterAccountId: 'revoked', machineId: 'machine', installationId: 'installation',
      verifyCurrentMachineAdmission: async () => true }))
      .toEqual({ kind: 'incomplete' });
    expect([...tracked.keys()]).toEqual([1, 2, 3]);
  });
});
