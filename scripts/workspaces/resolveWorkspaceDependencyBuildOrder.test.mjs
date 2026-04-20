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

test('resolveBundledWorkspaceDependencyBuildOrder resolves extension workspaces from packages/extensions/<extensionId>', async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-workspace-build-order-extensions-'));
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await writeJson(join(repoRoot, 'apps', 'cli', 'package.json'), {
    bundledDependencies: [
      '@happier-dev/extensions-acme',
    ],
  });

  await mkdir(join(repoRoot, 'packages', 'protocol'), { recursive: true });
  await writeJson(join(repoRoot, 'packages', 'protocol', 'package.json'), {
    name: '@happier-dev/protocol',
  });

  await mkdir(join(repoRoot, 'packages', 'extensions', 'acme'), { recursive: true });
  await writeJson(join(repoRoot, 'packages', 'extensions', 'acme', 'package.json'), {
    name: '@happier-dev/extensions-acme',
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });

  const ordered = resolveBundledWorkspaceDependencyBuildOrder({
    repoRoot,
    hostPackageDir: join(repoRoot, 'apps', 'cli'),
  });

  assert.deepEqual(ordered, ['protocol', 'extensions-acme']);
});
