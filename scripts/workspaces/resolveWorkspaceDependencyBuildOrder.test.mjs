import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveBundledWorkspaceDependencyBuildOrder,
  resolveWorkspaceDependencyBuildOrder,
} from './resolveWorkspaceDependencyBuildOrder.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('resolveBundledWorkspaceDependencyBuildOrder walks internal workspace dependencies before dependents', async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-workspace-build-order-'));
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await writeJson(join(repoRoot, 'apps', 'cli', 'package.json'), {
    bundledDependencies: [
      '@happier-dev/cli-common',
      '@happier-dev/release-runtime',
      '@happier-dev/agents',
      '@happier-dev/protocol',
    ],
  });

  const packages = {
    protocol: {
      name: '@happier-dev/protocol',
    },
    agents: {
      name: '@happier-dev/agents',
      dependencies: {
        '@happier-dev/protocol': '0.0.0',
      },
    },
    'release-runtime': {
      name: '@happier-dev/release-runtime',
    },
    'cli-common': {
      name: '@happier-dev/cli-common',
      dependencies: {
        '@happier-dev/agents': '0.0.0',
        '@happier-dev/release-runtime': '0.0.0',
      },
      devDependencies: {
        '@happier-dev/tests': '0.0.0',
      },
    },
    tests: {
      name: '@happier-dev/tests',
      private: true,
    },
  };

  for (const [workspaceName, packageJson] of Object.entries(packages)) {
    await mkdir(join(repoRoot, 'packages', workspaceName), { recursive: true });
    await writeJson(join(repoRoot, 'packages', workspaceName, 'package.json'), packageJson);
  }

  const ordered = resolveBundledWorkspaceDependencyBuildOrder({
    repoRoot,
    hostPackageDir: join(repoRoot, 'apps', 'cli'),
  });

  assert.ok(ordered.indexOf('protocol') < ordered.indexOf('agents'));
  assert.ok(ordered.indexOf('agents') < ordered.indexOf('cli-common'));
  assert.ok(ordered.indexOf('release-runtime') < ordered.indexOf('cli-common'));
  assert.equal(ordered.includes('tests'), false);
});

test('resolveBundledWorkspaceDependencyBuildOrder orders admitted workspace peers before their consumers', async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-workspace-build-order-admitted-peers-'));
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await writeJson(join(repoRoot, 'apps', 'cli', 'package.json'), {
    bundledDependencies: [
      '@happier-dev/channels-protocol',
      '@happier-dev/plugin-sdk',
    ],
  });

  await mkdir(join(repoRoot, 'packages', 'channels-protocol'), { recursive: true });
  await writeJson(join(repoRoot, 'packages', 'channels-protocol', 'package.json'), {
    name: '@happier-dev/channels-protocol',
    peerDependencies: {
      '@happier-dev/plugin-sdk': '>=0.0.0 <1.0.0',
    },
  });

  await mkdir(join(repoRoot, 'packages', 'plugin-sdk'), { recursive: true });
  await writeJson(join(repoRoot, 'packages', 'plugin-sdk', 'package.json'), {
    name: '@happier-dev/plugin-sdk',
  });

  const ordered = resolveBundledWorkspaceDependencyBuildOrder({
    repoRoot,
    hostPackageDir: join(repoRoot, 'apps', 'cli'),
  });

  assert.deepEqual(ordered, ['plugin-sdk', 'channels-protocol']);
});

test('resolveWorkspaceDependencyBuildOrder deduplicates shared internal dependencies', async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-workspace-build-order-dedupe-'));
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const packages = {
    protocol: {
      name: '@happier-dev/protocol',
    },
    agents: {
      name: '@happier-dev/agents',
      dependencies: {
        '@happier-dev/protocol': '0.0.0',
      },
    },
    'release-runtime': {
      name: '@happier-dev/release-runtime',
    },
    'cli-common': {
      name: '@happier-dev/cli-common',
      dependencies: {
        '@happier-dev/agents': '0.0.0',
        '@happier-dev/release-runtime': '0.0.0',
      },
    },
  };

  for (const [workspaceName, packageJson] of Object.entries(packages)) {
    await mkdir(join(repoRoot, 'packages', workspaceName), { recursive: true });
    await writeJson(join(repoRoot, 'packages', workspaceName, 'package.json'), packageJson);
  }

  const ordered = resolveWorkspaceDependencyBuildOrder({
    repoRoot,
    seedPackageNames: ['@happier-dev/agents', '@happier-dev/cli-common'],
  });

  assert.deepEqual(ordered, ['protocol', 'agents', 'release-runtime', 'cli-common']);
});

test('resolveWorkspaceDependencyBuildOrder includes dev dependencies by default and supports runtime-only closure', async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-workspace-build-order-runtime-only-'));
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await mkdir(join(repoRoot, 'packages', 'plugins', 'pi'), { recursive: true });
  await writeJson(join(repoRoot, 'packages', 'plugins', 'pi', 'package.json'), {
    name: '@happier-dev/plugins-pi',
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
    optionalDependencies: {
      '@happier-dev/release-runtime': '0.0.0',
    },
    peerDependencies: {
      '@happier-dev/peer-mediation': '0.0.0',
    },
    devDependencies: {
      '@happier-dev/tests': '0.0.0',
    },
  });

  for (const [workspaceName, packageJson] of Object.entries({
    protocol: {
      name: '@happier-dev/protocol',
      dependencies: {
        '@happier-dev/plugins-pi': '0.0.0',
      },
    },
    'release-runtime': { name: '@happier-dev/release-runtime' },
    'peer-mediation': { name: '@happier-dev/peer-mediation' },
    tests: { name: '@happier-dev/tests', private: true },
  })) {
    await mkdir(join(repoRoot, 'packages', workspaceName), { recursive: true });
    await writeJson(join(repoRoot, 'packages', workspaceName, 'package.json'), packageJson);
  }

  const sourceDevOrdered = resolveWorkspaceDependencyBuildOrder({
    repoRoot,
    seedPackageNames: ['@happier-dev/plugins-pi'],
  });
  const runtimeOrdered = resolveWorkspaceDependencyBuildOrder({
    repoRoot,
    seedPackageNames: ['@happier-dev/plugins-pi'],
    includeDevDependencies: false,
  });

  assert.deepEqual(sourceDevOrdered, [
    'protocol',
    'release-runtime',
    'tests',
    'plugins-pi',
  ]);
  assert.deepEqual(runtimeOrdered, [
    'protocol',
    'release-runtime',
    'plugins-pi',
  ]);
  assert.equal(sourceDevOrdered.includes('peer-mediation'), false);
  assert.equal(runtimeOrdered.includes('peer-mediation'), false);
});

test('resolveBundledWorkspaceDependencyBuildOrder resolves plugin workspaces from packages/plugins/<pluginId>', async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-workspace-build-order-plugins-'));
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await writeJson(join(repoRoot, 'apps', 'cli', 'package.json'), {
    bundledDependencies: [
      '@happier-dev/plugins-acme',
    ],
  });

  await mkdir(join(repoRoot, 'packages', 'protocol'), { recursive: true });
  await writeJson(join(repoRoot, 'packages', 'protocol', 'package.json'), {
    name: '@happier-dev/protocol',
  });

  await mkdir(join(repoRoot, 'packages', 'plugins', 'acme'), { recursive: true });
  await writeJson(join(repoRoot, 'packages', 'plugins', 'acme', 'package.json'), {
    name: '@happier-dev/plugins-acme',
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });

  const ordered = resolveBundledWorkspaceDependencyBuildOrder({
    repoRoot,
    hostPackageDir: join(repoRoot, 'apps', 'cli'),
  });

  assert.deepEqual(ordered, ['protocol', 'plugins-acme']);
});
