import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDevTargetsConfig,
  resolveDevTargetsConfigPath,
} from './config.mjs';

test('resolveDevTargetsConfigPath keeps dev target state inside the selected stack', () => {
  assert.equal(
    resolveDevTargetsConfigPath({
      stackName: 'repo-dev-123',
      env: { HAPPIER_STACK_STORAGE_DIR: '/tmp/happier-stacks' },
    }),
    '/tmp/happier-stacks/repo-dev-123/dev-targets.json',
  );
});

test('resolveDevTargetsConfigPath keeps repo-local target state inside its selected stack', () => {
  assert.equal(
    resolveDevTargetsConfigPath({
      stackName: 'repo-dev-123',
      env: {
        HAPPIER_STACK_STORAGE_DIR: '/tmp/happier-stacks',
        HAPPIER_STACK_REPO_DIR: '/workspace/happier',
      },
    }),
    '/tmp/happier-stacks/repo-dev-123/dev-targets.json',
  );
});

test('parseDevTargetsConfig accepts the minimal POSIX and Windows target contract', () => {
  assert.deepEqual(
    parseDevTargetsConfig({
      version: 1,
      targets: [
        {
          name: 'linux',
          platform: 'posix',
          ssh: 'happier-stack-linux',
          sshConfigFile: '/tmp/lima-happier-stack-linux.conf',
          limaInstance: 'hslqa',
          limaHome: '/tmp/lima-happier',
          repoDir: '/home/dev/happier',
          cliHomeDir: '/home/dev/.happier-stack/dev-targets/linux',
        },
        {
          name: 'windows',
          platform: 'windows',
          ssh: 'happier-stack-windows',
          repoDir: 'C:/Users/test_qa/happier',
          cliHomeDir: 'C:/Users/test_qa/.happier-stack/dev-targets/windows',
          remoteServerPort: 43105,
        },
      ],
    }),
    {
      version: 1,
      targets: [
        {
          name: 'linux',
          platform: 'posix',
          ssh: 'happier-stack-linux',
          sshConfigFile: '/tmp/lima-happier-stack-linux.conf',
          limaInstance: 'hslqa',
          limaHome: '/tmp/lima-happier',
          repoDir: '/home/dev/happier',
          cliHomeDir: '/home/dev/.happier-stack/dev-targets/linux',
          remoteServerPort: null,
        },
        {
          name: 'windows',
          platform: 'windows',
          ssh: 'happier-stack-windows',
          repoDir: 'C:/Users/test_qa/happier',
          cliHomeDir: 'C:/Users/test_qa/.happier-stack/dev-targets/windows',
          remoteServerPort: 43105,
        },
      ],
    },
  );
});

test('parseDevTargetsConfig rejects duplicate targets and unsafe SSH/path input', () => {
  assert.throws(
    () =>
      parseDevTargetsConfig({
        version: 1,
        targets: [
          { name: 'linux', platform: 'posix', ssh: 'host', repoDir: '/repo', cliHomeDir: '/home' },
          { name: 'linux', platform: 'posix', ssh: 'host2', repoDir: '/repo2', cliHomeDir: '/home2' },
        ],
      }),
    /duplicate target name/i,
  );
  assert.throws(
    () =>
      parseDevTargetsConfig({
        version: 1,
        targets: [
          { name: 'linux', platform: 'posix', ssh: 'host; shutdown', repoDir: '/repo', cliHomeDir: '/home' },
        ],
      }),
    /invalid ssh target/i,
  );
  assert.throws(
    () =>
      parseDevTargetsConfig({
        version: 1,
        targets: [
          { name: 'linux', platform: 'posix', ssh: 'host', repoDir: '/', cliHomeDir: '/home' },
        ],
      }),
    /unsafe repoDir/i,
  );
  assert.throws(
    () =>
      parseDevTargetsConfig({
        version: 1,
        targets: [
          {
            name: 'linux',
            platform: 'posix',
            ssh: 'host',
            limaInstance: 'hslqa',
            repoDir: '/repo',
            cliHomeDir: '/home',
          },
        ],
      }),
    /limaInstance and limaHome must be configured together/i,
  );
});
