import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MachineAgentIsolationPreviewResultV1Schema } from '@happier-dev/protocol';
import { MachineUpdateStateRequestSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { ApiMachineClient } from '@/api/apiMachine';
import type { Machine } from '@/api/types';
import type { RpcHandlerContext, RpcHandlerMap } from '@/api/rpc/types';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';

it.skipIf(process.platform !== 'linux').each([
  'workspace_census', 'workspace_paths', 'daemon_identity', 'session_inventory', 'known_empty_census',
] as const)('publishes the preparation prerequisite without applying changes: %s', async requiredFact => {
  const directory = await mkdtemp(join(tmpdir(), 'isolation-prerequisite-'));
  const machine: Machine = { id: 'preparation-refusal', encryptionMode: 'plain', metadataVersion: 1, daemonStateVersion: 1,
    metadata: { host: 'fixture', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/happier',
      happyHomeDir: '/home/happier/.happier' }, daemonState: { status: 'running', runtimeId: 'daemon' } };
  let publications = 0;
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    if (event !== 'machine-update-state') throw new Error(`Read-only preview attempted ${event}`);
    const write = MachineUpdateStateRequestSchema.parse(payload);
    publications++;
    return { result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState };
  } });
  const client = new ApiMachineClient('token', machine, { runtimeId: 'daemon' });
  Reflect.set(client, 'socket', socket);
  const target = { serverId: 'home', machineId: machine.id, installationId: 'installation', custodianAccountId: 'account' };
  const native = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
    installedCli: '/opt/happier/cli/current/happier',
    readRoots: () => requiredFact === 'workspace_census' ? null : requiredFact === 'workspace_paths'
      ? [{ rootId: 'missing', path: join(directory, 'PRIVATE_MISSING_WORKSPACE') }] : [],
    readSessionsToReplace: () => requiredFact === 'session_inventory' ? NaN : 0,
    publishStatus: status => client.publishAgentIsolationStatus(status) });
  const handlers: RpcHandlerMap = new Map();
  registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
    target: () => target, read: () => client.getAgentIsolationSnapshot(),
    // Daemon identity observation is an OS adapter; all preparation stays real.
    effects: requiredFact === 'daemon_identity' ? { ...native.effects, elevation: { ...native.effects.elevation,
      observe: async () => ({ version: 1, observedAt: 0, daemonUid: null, daemonUsername: null, daemonIdentity: 'unknown',
        rootEquivalentGroups: [], passwordlessSudoToRoot: 'unknown', managedDropIn: 'unknown',
        tailscaledOperator: { authorization: 'unknown' } }),
    } } : native.effects,
    captureMetadataPort: () => ({ read: async () => client.getMachineMetadataSnapshot(),
      compareAndSwap: async () => { throw new Error('Read-only preview attempted metadata mutation'); } }),
  });
  const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user', transportRequestId: 'preview',
    machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: machine.id,
      installationId: target.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
  try {
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await handlers.get('machines.agentIsolation.preview')!(
      { machineId: machine.id, enabled: true }, context));
    if (requiredFact === 'known_empty_census') {
      expect(preview.kind).toBe('ready');
      expect(publications).toBe(0);
    } else {
      expect(preview).toMatchObject({ kind: 'unavailable', status: { prerequisite: {
        reason: 'required_fact_unavailable', requiredFact, remedy: expect.any(String),
      } } });
      if (preview.kind !== 'unavailable') throw new Error('Expected the missing prerequisite');
      expect(preview.status).toHaveProperty('prerequisite.remedy', expect.stringMatching(/\S/));
      expect(client.getAgentIsolationSnapshot().status).toEqual(preview.status);
      expect(publications).toBe(1);
      expect(JSON.stringify(preview)).not.toContain('PRIVATE_MISSING_WORKSPACE');
    }
    expect(native.mutations).toEqual([]);
    expect(machine.metadata).not.toHaveProperty('agentIsolation');
  } finally { await client.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
