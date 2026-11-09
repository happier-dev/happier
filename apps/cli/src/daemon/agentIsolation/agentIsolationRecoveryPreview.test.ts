import { afterEach, expect, it, vi } from 'vitest';
import previews from '../../../../../packages/tests/fixtures/machines/agentIsolationRecoveryPreviews.json';
import { MachineAgentIsolationPreviewResultV1Schema, type MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import type { RpcHandlerContext, RpcHandlerMap } from '@/api/rpc/types';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { readAgentIsolationSnapshot } from './agentIsolationPolicy';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';

// Fixed native filesystem observations make the registered CHECK's wire fixture portable.
// The policy, native setup interpreter, preview producer and RPC registration stay real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: async (path: string) => path,
    lstat: async (path: string) => Object.assign(await actual.lstat('.'), { mode: 0o040000 | (path === '/srv/happier' ? 0o700 : 0o755) }) };
});
afterEach(() => vi.restoreAllMocks());

it.each(['qualificationPending', 'effective'] as const)('produces the %s recovery fixture through the registered preview, without effects', async name => {
  vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(1001);
  let writes = 0;
  const native = createAgentIsolationEffectsBoundary({ installationId: 'installation',
    installedCli: '/opt/happier/cli/current/happier',
    readRoots: () => [{ rootId: 'checkout', path: '/srv/happier/checkout' }], readSessionsToReplace: () => 0,
    publishStatus: async () => { writes++; },
    backend: { observe: async step => ({ stepId: step.id, status: 'satisfied', facts: {} }),
      apply: async () => { writes++; } },
  });
  const metadata = { status: 'ready' as const, metadataVersion: 5, metadata: { agentIsolation: { enabled: true } } };
  const effective: MachineAgentIsolationStatusV1 = { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' };
  const handlers: RpcHandlerMap = new Map();
  registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
    target: () => ({ serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' }),
    read: () => readAgentIsolationSnapshot({ metadata, runtimeId: 'successor', platform: 'linux',
      daemonState: { runtimeId: 'successor', ...(name === 'effective' ? { agentIsolation: effective } : {}) } }),
    effects: native.effects,
    captureMetadataPort: () => ({ read: async () => metadata, compareAndSwap: async () => { writes++; return { status: 'unavailable' }; } }),
  });
  const context: RpcHandlerContext = { signal: new AbortController().signal, transportRequestId: 'fresh-check',
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
  const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await handlers.get('machines.agentIsolation.preview')!(
    { machineId: 'machine', enabled: true }, context));
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw new Error('Registered preview could not CHECK the native plan');
  expect(preview.plan.planDigest).not.toHaveLength(0);
  // Only the opaque digest is redacted in the shared wire capture. UI replays these exact settled facts.
  expect({ ...preview, plan: { ...preview.plan, planDigest: 'native-check-digest-redacted' } }).toEqual(previews[name]);
  expect(writes).toBe(0);
  expect(native.mutations).toEqual([]);
  expect(native.launches).toEqual([]);
});
