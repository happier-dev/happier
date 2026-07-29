import assert from 'node:assert/strict';
import test from 'node:test';

import { disableInstalledStackServicesBeforeArchive } from './archive_service_lifecycle.mjs';

test('archive selects only modes with canonical definition or registration evidence', async () => {
  const calls = [];
  const result = await disableInstalledStackServicesBeforeArchive({
    rootDir: '/repo/apps/stack',
    stackName: 'exp',
    platform: 'linux',
    homeDir: '/home/alice',
    modes: ['user', 'system'],
    resolveDefinitionPath: ({ mode }) => `/definitions/${mode}`,
    definitionExists: (path) => path.endsWith('/user'),
    inspectRegistration: async ({ mode }) => mode === 'system' ? 'absent' : 'registered',
    uninstallStackService: async (params) => calls.push(params),
  });

  assert.deepEqual(calls, [{ rootDir: '/repo/apps/stack', stackName: 'exp', svcCmd: 'uninstall', args: ['--mode=user'] }]);
  assert.deepEqual(result, { removedModes: ['user'] });
});

test('archive removes a registered missing-definition orphan through canonical uninstall', async () => {
  const calls = [];
  await disableInstalledStackServicesBeforeArchive({
    rootDir: '/repo/apps/stack',
    stackName: 'exp',
    platform: 'darwin',
    homeDir: '/home/alice',
    modes: ['user'],
    resolveDefinitionPath: () => '/missing/plist',
    definitionExists: () => false,
    inspectRegistration: async () => 'registered',
    uninstallStackService: async (params) => calls.push(params),
  });

  assert.equal(calls.length, 1);
});

test('archive propagates inspection and uninstall failures before rename authority can move', async () => {
  await assert.rejects(
    disableInstalledStackServicesBeforeArchive({
      rootDir: '/repo/apps/stack',
      stackName: 'exp',
      platform: 'darwin',
      homeDir: '/home/alice',
      modes: ['user'],
      resolveDefinitionPath: () => '/definition/plist',
      definitionExists: () => true,
      inspectRegistration: async () => { throw new Error('inspection denied'); },
      uninstallStackService: async () => {},
    }),
    /inspection denied/,
  );
  await assert.rejects(
    disableInstalledStackServicesBeforeArchive({
      rootDir: '/repo/apps/stack',
      stackName: 'exp',
      platform: 'darwin',
      homeDir: '/home/alice',
      modes: ['user'],
      resolveDefinitionPath: () => '/definition/plist',
      definitionExists: () => true,
      inspectRegistration: async () => 'registered',
      uninstallStackService: async () => { throw new Error('teardown denied'); },
    }),
    /teardown denied/,
  );
});
