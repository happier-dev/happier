import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveNamedWorkspaceConfiguration } from './workspace_config.mjs';

test('workspace flags derive explicit source, mirror, and guest paths without changing the default mode', () => {
  assert.deepEqual(resolveNamedWorkspaceConfiguration({
    argv: [
      '--workspace=0.2=/Users/dev/happier/remote-dev',
      '--workspace', '0.3=/Users/dev/happier/dev',
    ],
    guestWorkspaceDir: '/home/dev/.happier-stack/workspace',
    mirrorWorkspaceDir: '/Users/dev/.happier-stack/workspace-mirror',
  }), [
    {
      id: '0.2',
      hostSourceDir: '/Users/dev/happier/remote-dev',
      hostMirrorDir: '/Users/dev/.happier-stack/workspace-mirror/0.2',
      guestDir: '/home/dev/.happier-stack/workspace/0.2',
    },
    {
      id: '0.3',
      hostSourceDir: '/Users/dev/happier/dev',
      hostMirrorDir: '/Users/dev/.happier-stack/workspace-mirror/0.3',
      guestDir: '/home/dev/.happier-stack/workspace/0.3',
    },
  ]);
  assert.deepEqual(resolveNamedWorkspaceConfiguration({
    argv: [],
    guestWorkspaceDir: '/guest',
    mirrorWorkspaceDir: '/mirror',
  }), []);
});

test('workspace flags reject malformed declarations before VM setup', () => {
  assert.throws(() => resolveNamedWorkspaceConfiguration({
    argv: ['--workspace=missing-source'],
    guestWorkspaceDir: '/guest',
    mirrorWorkspaceDir: '/mirror',
  }), /ID=ABSOLUTE_SOURCE_DIR/);
  assert.throws(() => resolveNamedWorkspaceConfiguration({
    argv: ['--workspace=0.2=relative'],
    guestWorkspaceDir: '/guest',
    mirrorWorkspaceDir: '/mirror',
  }), /absolute source directory/);
});
