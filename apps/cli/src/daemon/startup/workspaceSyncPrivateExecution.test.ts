import { describe, expect, it } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import type { PrivateProjectSyncNetwork } from '@/workspaces/activation/privateProjectSyncEffect';
import type { StoredCredentials } from '@/persistence';
import type { WorkspaceSyncMachineTunnelOpenInput, FiniteTransferMachineTunnel, WorkspaceSyncMachineTunnel } from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import { preparePrivateWorkspaceSyncExecution } from './workspaceSyncPrivateExecution';

const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
const contentPolicy = { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) };
const credentials = { token: 'requester-bearer', encryption: null };

async function networkBoundary(openCarrier: boolean) {
  const calls: Readonly<{ credentials: StoredCredentials; machineId: string; method: string }>[] = [];
  let closed = false;
  let network: PrivateProjectSyncNetwork | undefined;
  async function openTunnel(request: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'file_transfer' }>): Promise<FiniteTransferMachineTunnel>;
  async function openTunnel(request: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'workspace_sync' }>): Promise<WorkspaceSyncMachineTunnel>;
  async function openTunnel(request: WorkspaceSyncMachineTunnelOpenInput): Promise<FiniteTransferMachineTunnel | WorkspaceSyncMachineTunnel> {
    const tunnel = { localPort: 43210, observedPath: 'direct' as const, close: async () => { closed = true; } };
    return request.flow === 'file_transfer' ? tunnel : { ...tunnel, localCapability: 'carrier-capability' };
  }
  const stopAtNativeBoundary = new Error('native boundary captured');
  await expect(preparePrivateWorkspaceSyncExecution({ credentials,
    input: { operationId: 'open-private', sourceMachineId: 'source', targetMachineId: 'target',
      sourceRootPath: '/source', targetRootPath: '/member/checkouts/target',
      action: { kind: 'relationship', relationshipId: 'relationship', flushBeforeCommit: false } },
    accountRowsCustody: { serverId: 'home', accountId: 'requester', serverHttpBaseUrl: 'https://home.invalid', isCurrent: async () => true },
    snapshot: { source: 'network', workspaceRefs: [], relationships: [], organizations: [], rows: [],
      graphRevision: 'absent', loadedAtMs: 0, scopeKey: 'requester' },
    assertTransferCurrent: async () => {},
    release: async () => {},
    context: { signal: new AbortController().signal },
    createNativeSync: async request => { network = request.network; throw stopAtNativeBoundary; },
  }, {
    resolveNativeAgent: async () => ({ executablePath: '/verified/agent' }),
    refreshProjectRows: readProjectAccountRows,
    readChildMachineFacts: async () => [],
    callMachineRpc: async request => {
      calls.push({ credentials: request.credentials, machineId: request.machineId, method: request.method });
      return { success: true };
    },
    callWorkspaceSeedExport: async request => {
      calls.push({ credentials, machineId: request.machineId, method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE });
      return { success: true, transferId: 'seed', sizeBytes: 12, manifestHash: 'manifest',
        endpointCandidates: [{ kind: 'http', url: 'http://exporter.invalid:1/old', authorizationToken: 'seed-token', expiresAt: Date.now() + 60_000 }] };
    },
    ...(openCarrier ? { openMachineCarrierTunnel: openTunnel } : {}),
  })).rejects.toBe(stopAtNativeBoundary);
  if (!network) throw new Error('Native network was not produced');
  return { network, calls, isClosed: () => closed };
}

describe('private Workspace Sync source network boundary', () => {
  it('refuses an unavailable requester carrier before allocating a source export', async () => {
    const boundary = await networkBoundary(false);
    await expect(boundary.network.prepareSourceSeed({ operationId: 'seed', sourceMachineId: 'source',
      sourceWorkspaceRefId: 'source-ref', contentPolicy })).rejects.toMatchObject({ code: 'target_bootstrap_offline' });
    expect(boundary.calls).toEqual([]);
  });

  it('exposes only the requester tunnel endpoint and releases both native transfer handles', async () => {
    const boundary = await networkBoundary(true);
    const seed = await boundary.network.prepareSourceSeed({ operationId: 'seed', sourceMachineId: 'source',
      sourceWorkspaceRefId: 'source-ref', contentPolicy });
    const payload = await seed.openPayload({ transferId: 'seed' });
    expect(new URL(payload.endpointCandidates[0]!.url).origin).toBe('http://127.0.0.1:43210');
    expect(boundary.calls).toEqual([{ credentials, machineId: 'source', method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE }]);
    await payload.dispose();
    await seed.dispose();
    expect(boundary.isClosed()).toBe(true);
    expect(boundary.calls.at(-1)).toEqual({ credentials, machineId: 'source', method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE });
  });
});
