import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPluginWorkspaceTestInvocations,
  collectPluginWorkspaceTestPackageReport,
} from './pluginWorkspaceTestPackages.ts';

function workspaceManifest(
  packageDirectory: string,
  packageJson: Readonly<Record<string, unknown>>,
): Readonly<{ packageJsonPath: string; packageJsonText: string }> {
  return {
    packageJsonPath: `/repo/${packageDirectory}/package.json`,
    packageJsonText: JSON.stringify(packageJson),
  };
}

test('derives every tested plugin workspace from workspace metadata rather than a maintained package list', () => {
  const report = collectPluginWorkspaceTestPackageReport({
    rootDir: '/repo',
    workspacePackageManifests: [
      workspaceManifest('packages/plugins/alpha', {
        name: '@happier-dev/plugins-alpha',
        scripts: { test: 'yarn test:local', typecheck: 'yarn typecheck:local' },
      }),
      workspaceManifest('packages/plugins/beta', {
        name: '@happier-dev/plugins-beta',
        scripts: { test: 'yarn test:local', typecheck: 'yarn typecheck:local' },
      }),
      workspaceManifest('packages/plugin-sdk', {
        name: '@happier-dev/plugin-sdk',
        scripts: { test: 'yarn test:local', typecheck: 'yarn typecheck:local' },
      }),
    ],
  });

  assert.deepEqual(report.packages, [
    {
      packageName: '@happier-dev/plugins-alpha',
      workspaceDirectory: 'packages/plugins/alpha',
    },
    {
      packageName: '@happier-dev/plugins-beta',
      workspaceDirectory: 'packages/plugins/beta',
    },
  ]);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(buildPluginWorkspaceTestInvocations(report.packages), [
    {
      args: ['workspace', '@happier-dev/plugins-alpha', 'test'],
      packageName: '@happier-dev/plugins-alpha',
    },
    {
      args: ['workspace', '@happier-dev/plugins-beta', 'test'],
      packageName: '@happier-dev/plugins-beta',
    },
  ]);
});

test('fails wiring when a plugin workspace has no executable test script', () => {
  const report = collectPluginWorkspaceTestPackageReport({
    rootDir: '/repo',
    workspacePackageManifests: [
      workspaceManifest('packages/plugins/alpha', {
        name: '@happier-dev/plugins-alpha',
        scripts: { test: 'yarn test:local', typecheck: 'yarn typecheck:local' },
      }),
      workspaceManifest('packages/plugins/missing-test', {
        name: '@happier-dev/plugins-missing-test',
        scripts: {},
      }),
    ],
  });

  assert.deepEqual(report.packages, [
    {
      packageName: '@happier-dev/plugins-alpha',
      workspaceDirectory: 'packages/plugins/alpha',
    },
  ]);
  assert.deepEqual(report.issues, [
    'Plugin workspace packages/plugins/missing-test must define a non-empty test script.',
  ]);
});

test('fails wiring when a plugin workspace has no executable typecheck script', () => {
  const report = collectPluginWorkspaceTestPackageReport({
    rootDir: '/repo',
    workspacePackageManifests: [
      workspaceManifest('packages/plugins/missing-typecheck', {
        name: '@happier-dev/plugins-missing-typecheck',
        scripts: { test: 'yarn test:local' },
      }),
    ],
  });

  assert.deepEqual(report.packages, []);
  assert.deepEqual(report.issues, [
    'Plugin workspace packages/plugins/missing-typecheck must define a non-empty typecheck script.',
  ]);
});

test('does not allow an empty plugin workspace selection to pass', () => {
  const report = collectPluginWorkspaceTestPackageReport({
    rootDir: '/repo',
    workspacePackageManifests: [
      workspaceManifest('packages/plugin-sdk', {
        name: '@happier-dev/plugin-sdk',
        scripts: { test: 'yarn test:local', typecheck: 'yarn typecheck:local' },
      }),
    ],
  });

  assert.deepEqual(report.packages, []);
  assert.deepEqual(report.issues, [
    'No plugin workspace packages were found from root workspace metadata.',
  ]);
});
