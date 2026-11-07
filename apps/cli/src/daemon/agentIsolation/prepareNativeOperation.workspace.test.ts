import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { prepareRequesterNativeOperation } from './prepareNativeOperation';
import { createAgentIsolationOperationContext } from './agentIsolationSessionContext';

const native = vi.hoisted(() => ({ home: '' }));
// Only the public OS account lookup and RunAs retirement are substituted.
vi.mock('@happier-dev/cli-common/process', async importOriginal => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...request: Parameters<typeof actual.execFileWithDeadline>) => {
    if (request[0] === 'getent' && request[1]?.at(-1) === 'happier-agent') return {
      stdout: `happier-agent:x:99998:99998::${native.home}:/usr/sbin/nologin\n`, stderr: '',
    };
    if (request[0] === 'sudo') return { stdout: '', stderr: '' };
    return actual.execFileWithDeadline(...request);
  } };
});
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform !== 'linux')('admits a finite native filesystem worker before any Project workspace exists', async () => {
  await withTempDir('native-operation-no-project-', async home => {
    native.home = home;
    const requesterIdentity = { kind: 'isolated' as const, separationRequired: false,
      requester: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' } };
    const material = { materializationKey: 'directory-preflight', environment: {}, selectedMaterials: [] };
    const operation = await prepareRequesterNativeOperation({ requesterIdentity,
      readMaterial: () => material,
      signal: new AbortController().signal }, {
      machine: { managedHappierBinaryPath: '/managed/happier', read: () => ({ enabled: true,
        status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [] }) },
      homeServerIdentityId: 'home', machineId: 'machine', installationId: 'installation',
      reloadController: createPluginReloadController(),
    });
    try {
      const launch = await authorizeResolvedProjectExecLaunchForHost({
        launch: { command: '/managed/happier', args: ['filesystem-effect'], cwd: operation.workingDirectory, env: {} },
        agentIsolation: operation.agentIsolation, requesterIdentity, agentLaunchKind: 'exec',
        signal: new AbortController().signal, assertCurrent() {},
      });
      try {
        expect(operation.workingDirectory).toBe(home);
        expect(launch).toMatchObject({ command: 'sudo', args: ['-n', '-u', 'happier-agent', '--', '/managed/happier', 'agent-launch'] });
      } finally { await launch.release(); }
    } finally { await operation.dispose(); }
  });
});

it('refuses material outside the selected native home before admitting an operation', () => {
  const home = '/var/lib/happier-agent';
  expect(() => createAgentIsolationOperationContext({
    machine: { read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [] }) },
    managedHappierBinaryPath: '/managed/happier',
    requesterIdentity: { kind: 'isolated', separationRequired: false, homeServerIdentityId: 'home',
      requester: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' } },
    nativeIdentity: { agentUid: 2401, agentGid: 2401, home }, signal: new AbortController().signal,
    readMaterial: () => ({ materializationKey: 'operation', environment: {}, selectedMaterials: [] }),
    readTarget: () => ({ runtimeHome: join(home, '..', 'other-member', 'runtime'), environment: {}, selectedMaterials: [] }),
  })).toThrowError(expect.objectContaining({ code: 'agent_isolation_unavailable' }));
});
