import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import { parseProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createProductionDaemonWorkspaceSyncRuntime } from './createProductionDaemonWorkspaceSyncRuntime';

function resolveAclBinary(name: 'setfacl' | 'getfacl'): string {
  const dirs = [...String(process.env.PATH ?? '').split(delimiter).filter(Boolean), '/usr/bin', '/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try next standard location.
    }
  }
  return name;
}

const setfaclBin = resolveAclBinary('setfacl');
const getfaclBin = resolveAclBinary('getfacl');
const aclToolsAvailable = process.platform === 'linux'
  && [setfaclBin, getfaclBin].every(cmd => spawnSync(cmd, ['--version']).status === 0);

function readAclLines(path: string): string[] {
  return execFileSync(getfaclBin, ['-n', '-c', '-p', path], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function jwtForAccount(accountId: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url'),
    'fixture-signature',
  ].join('.');
}

const contentPolicyInput = {
  v: 1 as const,
  selection: 'all_files' as const,
  extraIgnorePatterns: [],
  extraIncludePatterns: [],
};
const contentPolicy = {
  ...contentPolicyInput,
  policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicyInput),
};

describe.skipIf(!aclToolsAvailable)(
  'createProductionDaemonWorkspaceSyncRuntime isolated worker copy access reconciliation',
  () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      while (cleanups.length > 0) {
        await cleanups.pop()?.();
      }
    });

    it('reconciles custodian linuxUsersV1 worker copy ACLs after remote prepareBetween and denies guest callers', async () => {
      const root = await mkdtemp(join(tmpdir(), 'happier-w3b-prod-runtime-'));
      cleanups.push(() => rm(root, { recursive: true, force: true }));

      const happyHomeDir = join(root, 'home');
      const activeServerDir = join(happyHomeDir, 'servers', 'server-1');
      const workerCopyRoot = join(root, 'worker-copy');
      await mkdir(activeServerDir, { recursive: true });
      await mkdir(workerCopyRoot, { mode: 0o700 });
      await writeFile(join(workerCopyRoot, 'public.txt'), 'RWS-CUT48-WORKER-PUBLIC\n', { mode: 0o600 });

      const installation = readOrCreateInstallationIdentitySync();

      const ownerAccountId = 'e660281d-owner';
      const guestAccountId = 'd1b02bcf-guest';
      const ownerMemberUid = 65534;
      const serverId = 'server-1';
      const sourceMachineId = 'machine-primary';
      const workerMachineId = 'machine-worker';

      const relationship: WorkspaceSyncRelationshipV1 = {
        v: 1,
        relationshipId: 'rel-worker-copy-1',
        controllerMachineId: sourceMachineId,
        alphaWorkspaceRefId: 'ws-source',
        betaWorkspaceRefId: 'ws-worker',
        mode: 'keep_synced',
        contentPolicy,
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        committedAtMs: 2,
        provenance: {
          kind: 'worker_clean_copy',
          sourceWorkspaceRefId: 'ws-source',
          targetWorkspaceRefId: 'ws-worker',
        },
      };

      const snapshot: ActiveProjectAccountRowsSnapshot = {
        source: 'network',
        accountMode: 'plain',
        organizations: [],
        rows: [],
        graphRevision: 1,
        loadedAtMs: 1,
        scopeKey: `plain:${serverId}`,
        ...parseProjectAccountSnapshotV1({
          workspaceRefs: [
            {
              id: 'ws-source',
              serverId,
              machineId: sourceMachineId,
              rootPath: '/tmp/primary-source',
              createdAtMs: 1,
            },
            {
              id: 'ws-worker',
              serverId,
              machineId: workerMachineId,
              rootPath: workerCopyRoot,
              createdAtMs: 1,
            },
          ],
          relationships: [relationship],
        }),
      };

      const readMember = vi.fn(async ({ requesterIdentity }) => {
        const derived = deriveAgentIsolationMemberIdentity(requesterIdentity);
        return {
          identity: { ...derived, agentUid: ownerMemberUid, agentGid: ownerMemberUid },
          daemonObservation: {
            daemonIdentity: 'nonRoot' as const,
            daemonUid: process.getuid!(),
            daemonUsername: 'rwsqa',
            daemonPrimaryGroup: 'rwsqa',
          },
        };
      });

      const agentIsolation: HostAgentIsolationLaunchContext = {
        read: () => ({
          enabled: true,
          memberProvisioning: 'linuxUsersV1',
          status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
          workspaceRoots: [workerCopyRoot],
        }),
        readMember,
      };

      const server = createServer((req, res) => {
        if (req.url === '/v1/account/encryption/currentness') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            mode: 'plain',
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
          }));
          return;
        }
        const match = /^\/v1\/machines\/([^/?#]+)$/u.exec(req.url ?? '');
        if (match) {
          const machineId = decodeURIComponent(match[1]!);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            machine: {
              id: machineId,
              managedMachineRef: null,
              metadata: null,
              metadataVersion: 1,
              daemonState: null,
              daemonStateVersion: 0,
              storageMode: 'plain',
              dataEncryptionKey: null,
              revokedAt: null,
            },
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
      const serverHttpBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      let flushCallCount = 0;
      const runtime = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createProductionDaemonWorkspaceSyncRuntime(
        {
          credentials: { token: jwtForAccount(ownerAccountId), encryption: null },
          happyHomeDir,
          activeServerDir,
          activeServerId: serverId,
          localMachineId: workerMachineId,
          releaseChannel: 'preview',
          agentIsolation,
        },
        {
          getProjectSnapshot: () => snapshot,
          refreshProjectRows: async () => snapshot,
          subscribeProjectSnapshot: () => () => {},
          resolveRootOwnershipDirectory: () => join(activeServerDir, 'locks'),
          callMachineRpc: async call => {
            if (call.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN) {
              flushCallCount += 1;
              if (flushCallCount === 2) {
                // Simulate Mutagen syncing a brand-new 0600 file on the second flush!
                await writeFile(join(workerCopyRoot, 'q2-sync-barrier-probe.txt'), 'probe-ok', { mode: 0o600 });
              }
              return {
                ok: true,
                traversed: [
                  {
                    relationshipId: relationship.relationshipId,
                    policyDigest: contentPolicy.policyDigest,
                    status: {
                      relationshipId: relationship.relationshipId,
                      controllerMachineId: sourceMachineId,
                      state: 'watching',
                      alphaPath: '/tmp/primary-source',
                      betaPath: workerCopyRoot,
                      mode: 'keep_synced',
                      endpointStates: {
                        alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                      },
                      conflictCount: 0,
                      lastCycleObservedAtMs: Date.now(),
                      lastCleanSyncAtMs: Date.now(),
                    },
                  },
                ],
              };
            }
            throw new Error(`Unexpected RPC method: ${call.method}`);
          },
        },
      ));
      cleanups.push(() => runtime.stop());

      await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
        // Verified guest caller MUST NOT trigger daemon-owned file ACL grants.
        const guestContext: RpcHandlerContext = {
          signal: new AbortController().signal,
          callerAuthority: 'present_user',
          verifyMachineAdmissionCurrent: async () => true,
          machineAdmission: {
            actorAccountId: guestAccountId,
            custodianAccountId: ownerAccountId,
            machineId: workerMachineId,
            installationId: installation.installationId,
            role: 'use',
            encryptionMode: 'plain',
          },
        };
        const guestPrepared = await runtime.handoffAdapter.prepareBetween(
          { sourceWorkspaceRefId: 'ws-source', targetWorkspaceRefId: 'ws-worker' },
          new AbortController().signal,
          guestContext,
        );
        expect(guestPrepared.ok).toBe(true);
        expect(readMember).not.toHaveBeenCalled();
        expect(readAclLines(join(workerCopyRoot, 'public.txt')).some(l => l.startsWith(`user:${ownerMemberUid}:`))).toBe(false);

        // Reset flush counter so the custodian's first run is flushCallCount = 1 and second is flushCallCount = 2.
        flushCallCount = 0;

        // Custodian agent Session requester (verified RPC context) ALSO reconciles exact-UID ACL for hpm-<owner>.
        const ownerAgentContext: RpcHandlerContext = {
          signal: new AbortController().signal,
          callerAuthority: 'account_automation',
          verifyMachineAdmissionCurrent: async () => true,
          machineAdmission: {
            actorAccountId: ownerAccountId,
            custodianAccountId: ownerAccountId,
            machineId: workerMachineId,
            installationId: installation.installationId,
            role: 'use',
            encryptionMode: 'plain',
          },
          localActionContext: {
            surface: 'agent',
            authority: 'account_automation',
            requesterWorkAttributionV1: {
              serverId,
              accountId: ownerAccountId,
              machineId: workerMachineId,
              installationId: installation.installationId,
            },
          },
        };
        const firstPrepared = await runtime.handoffAdapter.prepareBetween(
          { sourceWorkspaceRefId: 'ws-source', targetWorkspaceRefId: 'ws-worker' },
          new AbortController().signal,
          ownerAgentContext,
        );
        expect(firstPrepared.ok).toBe(true);
        expect(readMember).toHaveBeenCalledTimes(1);
        expect(readMember.mock.calls[0]![0].requesterIdentity.requester.accountId).toBe(ownerAccountId);
        expect(readAclLines(join(workerCopyRoot, 'public.txt'))).toContain(`user:${ownerMemberUid}:rw-`);
        expect(readAclLines(join(workerCopyRoot, 'public.txt'))).toContain('other::---');

        // Second flush (present-user / internal custodian) brings a freshly synced 0600 file and reconciles it incrementally!
        const secondPrepared = await runtime.handoffAdapter.prepareBetween(
          { sourceWorkspaceRefId: 'ws-source', targetWorkspaceRefId: 'ws-worker' },
          new AbortController().signal,
        );
        expect(secondPrepared.ok).toBe(true);
        expect(readAclLines(join(workerCopyRoot, 'q2-sync-barrier-probe.txt'))).toContain(`user:${ownerMemberUid}:rw-`);
      });

      await chmod(workerCopyRoot, 0o700);
    });
  },
);
