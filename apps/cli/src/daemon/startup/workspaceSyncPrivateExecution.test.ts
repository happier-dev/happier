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

async function networkBoundary(openCarrier: boolean, nativeMachineId?: string) {
  const calls: Readonly<{ credentials: StoredCredentials; machineId: string; method: string }>[] = [];
  let closed = false;
  let network: PrivateProjectSyncNetwork | undefined;
  let configuredMachineId: string | undefined;
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
    ...(nativeMachineId ? { executionIdentity: { kind: 'isolated' as const, separationRequired: true,
      requester: { serverId: 'profile', accountId: 'requester', machineId: nativeMachineId, installationId: 'installation' } } } : {}),
    release: async () => {},
    context: { signal: new AbortController().signal },
    createNativeSync: async request => { network = request.network; configuredMachineId = request.configuration.machineId; throw stopAtNativeBoundary; },
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
  return { network, calls, configuredMachineId, isClosed: () => closed };
}

describe('private Workspace Sync source network boundary', () => {
  it('places the native Sync worker on the admitted requester Machine when it is the source', async () => {
    const boundary = await networkBoundary(true, 'source');
    expect(boundary.configuredMachineId).toBe('source');
  });

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

  it.skipIf(process.platform !== 'linux')('fails closed for isolated Linux members when the published member CLI store lacks a verified mutagen agent', async () => {
    const memberCliExecutablePath = `/opt/happier-member-cli-${'f'.repeat(64)}/current/happier`;
    let passedAgent: unknown;
    await expect(preparePrivateWorkspaceSyncExecution({ credentials,
      input: { operationId: 'open-isolated', sourceMachineId: 'source', targetMachineId: 'target',
        sourceRootPath: '/source', targetRootPath: '/srv/happier/members/member/copy',
        action: { kind: 'copy_once', contentPolicy } },
      accountRowsCustody: { serverId: 'home', accountId: 'requester', serverHttpBaseUrl: 'https://home.invalid', isCurrent: async () => true },
      snapshot: { source: 'network', workspaceRefs: [], relationships: [], organizations: [], rows: [],
        graphRevision: 'absent', loadedAtMs: 0, scopeKey: 'requester' },
      assertTransferCurrent: async () => {},
      executionIdentity: { kind: 'isolated', separationRequired: true,
        requester: { serverId: 'profile', accountId: 'requester', machineId: 'target', installationId: 'installation' } },
      release: async () => {},
      context: { signal: new AbortController().signal },
      createNativeSync: async request => { passedAgent = request.configuration.agent; throw new Error('should not start native sync with inaccessible private home agent'); },
    }, {
      resolveNativeAgent: async () => ({ executablePath: '/home/rwsqa/.happier/mutagen/versions/0.18.1-happier.12/bin/happier-mutagen-agent', sha256: 'e'.repeat(64) }),
      memberCliExecutablePath,
      refreshProjectRows: readProjectAccountRows,
      readChildMachineFacts: async () => [],
      callMachineRpc: async () => ({ success: true }),
    })).rejects.toMatchObject({
      code: 'agent_isolation_unavailable',
      details: expect.objectContaining({ reason: 'payload_not_accessible', readinessCode: 'payload_not_accessible' }),
    });
    expect(passedAgent).toBeUndefined();
  });

  it('preserves the host mutagen agent for non-isolated executions and non-member CLI paths without leaking sha256', async () => {
    const stopAtNativeBoundary = new Error('native boundary captured');
    const capturedAgents: unknown[] = [];
    const baseRequest = { credentials,
      input: { operationId: 'open-isolated', sourceMachineId: 'source', targetMachineId: 'target',
        sourceRootPath: '/source', targetRootPath: '/srv/happier/members/member/copy',
        action: { kind: 'copy_once' as const, contentPolicy } },
      accountRowsCustody: { serverId: 'home', accountId: 'requester', serverHttpBaseUrl: 'https://home.invalid', isCurrent: async () => true },
      snapshot: { source: 'network' as const, workspaceRefs: [], relationships: [], organizations: [], rows: [],
        graphRevision: 'absent' as const, loadedAtMs: 0, scopeKey: 'requester' },
      assertTransferCurrent: async () => {},
      release: async () => {},
      context: { signal: new AbortController().signal },
      createNativeSync: async (request: Readonly<{ configuration: Readonly<{ agent: unknown }> }>) => {
        capturedAgents.push(request.configuration.agent);
        throw stopAtNativeBoundary;
      },
    };
    const hostAgent = {
      executablePath: '/home/rwsqa/.happier/mutagen/versions/0.18.1-happier.12/bin/happier-mutagen-agent',
      sha256: 'd'.repeat(64),
    };
    const baseDeps = {
      resolveNativeAgent: async () => hostAgent,
      refreshProjectRows: readProjectAccountRows,
      readChildMachineFacts: async () => [],
      callMachineRpc: async () => ({ success: true }),
    };

    // Non-isolated execution ignores memberCliExecutablePath even if it points to a missing member store.
    await expect(preparePrivateWorkspaceSyncExecution(baseRequest, {
      ...baseDeps,
      memberCliExecutablePath: `/opt/happier-member-cli-${'f'.repeat(64)}/current/happier`,
    })).rejects.toBe(stopAtNativeBoundary);

    // Isolated execution with a non-member shared CLI path keeps the host agent path.
    await expect(preparePrivateWorkspaceSyncExecution({
      ...baseRequest,
      executionIdentity: { kind: 'isolated', separationRequired: true,
        requester: { serverId: 'profile', accountId: 'requester', machineId: 'target', installationId: 'installation' } },
    }, {
      ...baseDeps,
      memberCliExecutablePath: '/opt/happier/cli/current/happier',
    })).rejects.toBe(stopAtNativeBoundary);

    expect(capturedAgents).toEqual([
      { executablePath: hostAgent.executablePath },
      { executablePath: hostAgent.executablePath },
    ]);
  });
});
