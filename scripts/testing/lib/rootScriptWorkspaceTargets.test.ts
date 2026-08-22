import assert from 'node:assert/strict';
import test from 'node:test';

import {
  matchesWorkspaceScriptTarget,
  resolveRootScriptWorkspaceTargets,
  scanYarnInvocations,
} from './rootScriptWorkspaceTargets.ts';

test('separates workspace invocations from root script delegation', () => {
  const scan = scanYarnInvocations(
    'yarn workspace privacy-kit test && yarn -s workspace @happier-dev/tests test:core:fast '
    + '&& yarn --cwd packages/relay-server test && yarn --cwd apps/server -s prisma migrate deploy '
    + '&& yarn -s test:integration',
  );

  assert.deepEqual(scan.workspaceTargets, [
    { packageName: 'privacy-kit', workspaceDirectory: null, scriptName: 'test' },
    { packageName: '@happier-dev/tests', workspaceDirectory: null, scriptName: 'test:core:fast' },
    { packageName: null, workspaceDirectory: 'packages/relay-server', scriptName: 'test' },
    { packageName: null, workspaceDirectory: 'apps/server', scriptName: 'prisma' },
  ]);
  assert.deepEqual(scan.rootScriptRefs, ['test:integration']);
});

test('follows the Stack executor and root script delegation to the real workspace set', () => {
  const targets = resolveRootScriptWorkspaceTargets(
    {
      test: 'apps/stack/bin/hstack-exec --script=test:local',
      'test:local': 'yarn -s test:unit:local',
      'test:unit:local': 'yarn workspace privacy-kit test && yarn --cwd apps/stack test:unit',
      'test:integration': 'yarn workspace @happier-dev/app test:integration',
    },
    'test',
  );

  assert.deepEqual(targets, [
    { packageName: 'privacy-kit', workspaceDirectory: null, scriptName: 'test' },
    { packageName: null, workspaceDirectory: 'apps/stack', scriptName: 'test:unit' },
  ]);
});

test('stops instead of looping when root scripts delegate to each other', () => {
  const targets = resolveRootScriptWorkspaceTargets(
    { test: 'yarn -s test:alias', 'test:alias': 'yarn -s test && yarn workspace privacy-kit test' },
    'test',
  );

  assert.deepEqual(targets, [{ packageName: 'privacy-kit', workspaceDirectory: null, scriptName: 'test' }]);
});

test('matches a workspace by package name or by directory', () => {
  const workspace = { packageName: '@happier-dev/relay-server', workspaceDirectory: 'packages/relay-server', scriptName: 'test' };

  assert.equal(
    matchesWorkspaceScriptTarget(workspace, { packageName: null, workspaceDirectory: 'packages/relay-server', scriptName: 'test' }),
    true,
  );
  assert.equal(
    matchesWorkspaceScriptTarget(workspace, { packageName: '@happier-dev/relay-server', workspaceDirectory: null, scriptName: 'test:unit' }),
    true,
  );
  assert.equal(
    matchesWorkspaceScriptTarget(workspace, { packageName: '@happier-dev/other', workspaceDirectory: 'packages/other', scriptName: 'test' }),
    false,
  );
});
