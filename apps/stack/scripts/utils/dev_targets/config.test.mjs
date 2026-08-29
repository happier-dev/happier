import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDevTargetsConfig,
  resolveDevTargetExecutionPolicy,
  resolveDevTargetsConfigPath,
  upgradeDevTargetsConfigToVersion3,
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
          remotePath: ['/home/dev/.nvm/versions/node/v22/bin', '/opt/homebrew/bin'],
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
          remotePath: ['/home/dev/.nvm/versions/node/v22/bin', '/opt/homebrew/bin'],
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
  assert.throws(
    () => parseDevTargetsConfig({
      version: 1,
      targets: [{
        name: 'linux',
        platform: 'posix',
        ssh: 'host',
        repoDir: '/repo',
        cliHomeDir: '/home',
        remotePath: ['/safe/bin', '../unsafe'],
      }],
    }),
    /remotePath/i,
  );
});

test('version 1 configuration preserves service placement while augmenting commands across configured targets', () => {
  const config = parseDevTargetsConfig({
    version: 1,
    targets: [
      { name: 'mac', platform: 'posix', ssh: 'mac', repoDir: '/repo', cliHomeDir: '/home' },
      { name: 'linux', platform: 'posix', ssh: 'linux', repoDir: '/repo', cliHomeDir: '/home' },
    ],
  });

  assert.deepEqual(resolveDevTargetExecutionPolicy(config), {
    server: { mode: 'local' },
    expo: { mode: 'local' },
    daemons: {
      mode: 'local-and-targets',
      targets: ['mac', 'linux'],
    },
    commands: {
      mode: 'auto',
      targets: ['mac', 'linux'],
      includeLocal: false,
      fallback: 'local',
      loadProbeTtlMs: 15_000,
      unavailableProbeTtlMs: 120_000,
    },
  });
});

test('version 2 configuration normalizes best-effort target placement and command execution', () => {
  const config = parseDevTargetsConfig({
    version: 2,
    targets: [
      { name: 'mac', platform: 'posix', ssh: 'mac', repoDir: '/repo', cliHomeDir: '/home' },
    ],
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'prefer-target', target: 'MAC' },
      daemon: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
    },
    commandExecution: { mode: 'prefer-target', target: 'mac' },
  });

  assert.deepEqual(config.runtimePlacement, {
    server: { mode: 'local' },
    expo: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
    daemon: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
  });
  assert.deepEqual(config.commandExecution, {
    mode: 'prefer-target',
    target: 'mac',
    fallback: 'local',
  });
  assert.deepEqual(resolveDevTargetExecutionPolicy(config), {
    server: { mode: 'local' },
    expo: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
    daemons: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
    commands: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
  });
});

test('version 2 configuration defaults every execution surface to local', () => {
  const config = parseDevTargetsConfig({ version: 2, targets: [] });

  assert.deepEqual(resolveDevTargetExecutionPolicy(config), {
    server: { mode: 'local' },
    expo: { mode: 'local' },
    daemons: { mode: 'local' },
    commands: { mode: 'local' },
  });
});

test('disabled dev targets cannot turn persisted remote server placement into a local server', () => {
  const config = parseDevTargetsConfig({
    version: 2,
    targets: [
      { name: 'mac', platform: 'posix', ssh: 'mac', repoDir: '/repo', cliHomeDir: '/home' },
    ],
    runtimePlacement: {
      server: { mode: 'prefer-target', target: 'mac' },
    },
  });

  assert.throws(
    () => resolveDevTargetExecutionPolicy(config, {
      targetsEnabled: false,
      serverRequested: true,
    }),
    /--no-dev-targets.*remote server placement/i,
  );
  assert.deepEqual(
    resolveDevTargetExecutionPolicy(config, {
      targetsEnabled: false,
      serverRequested: false,
    }),
    {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemons: { mode: 'local' },
      commands: { mode: 'local' },
    },
  );
});

test('remote server placement canonicalizes legacy local fallback to fail closed', () => {
  const config = parseDevTargetsConfig({
    version: 2,
    targets: [
      { name: 'mac', platform: 'posix', ssh: 'mac', repoDir: '/repo', cliHomeDir: '/home' },
    ],
    runtimePlacement: {
      server: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
    },
  });

  assert.deepEqual(config.runtimePlacement.server, {
    mode: 'prefer-target',
    target: 'mac',
    fallback: 'error',
  });
});

test('configured targets default bounded commands to automatic least-load execution', () => {
  const targets = [
    { name: 'mac', platform: 'posix', ssh: 'mac', repoDir: '/repo-mac', cliHomeDir: '/home-mac' },
    { name: 'mac2', platform: 'posix', ssh: 'mac2', repoDir: '/repo-mac2', cliHomeDir: '/home-mac2' },
  ];

  assert.deepEqual(resolveDevTargetExecutionPolicy(parseDevTargetsConfig({
    version: 1,
    targets,
  })).commands, {
    mode: 'auto',
    targets: ['mac', 'mac2'],
    includeLocal: false,
    fallback: 'local',
    loadProbeTtlMs: 15_000,
    unavailableProbeTtlMs: 120_000,
  });

  assert.deepEqual(parseDevTargetsConfig({
    version: 2,
    targets,
  }).commandExecution, {
    mode: 'auto',
    targets: ['mac', 'mac2'],
    includeLocal: false,
    fallback: 'local',
    loadProbeTtlMs: 15_000,
    unavailableProbeTtlMs: 120_000,
  });
});

test('automatic command execution normalizes target selection, local participation, and fallback independently', () => {
  const targets = [
    { name: 'mac', platform: 'posix', ssh: 'mac', repoDir: '/repo-mac', cliHomeDir: '/home-mac' },
    { name: 'mac2', platform: 'posix', ssh: 'mac2', repoDir: '/repo-mac2', cliHomeDir: '/home-mac2' },
  ];
  const config = parseDevTargetsConfig({
    version: 2,
    targets,
    commandExecution: {
      mode: 'auto',
      targets: ['MAC2', 'mac'],
      includeLocal: true,
      fallback: 'error',
      loadProbeTtlMs: 20_000,
      unavailableProbeTtlMs: 300_000,
    },
  });

  assert.deepEqual(config.commandExecution, {
    mode: 'auto',
    targets: ['mac2', 'mac'],
    includeLocal: true,
    fallback: 'error',
    loadProbeTtlMs: 20_000,
    unavailableProbeTtlMs: 300_000,
  });
});

test('version 2 rejects unknown target references and unsupported fallback modes', () => {
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac',
    repoDir: '/repo',
    cliHomeDir: '/home',
  };
  assert.throws(
    () => parseDevTargetsConfig({
      version: 2,
      targets: [target],
      runtimePlacement: { expo: { mode: 'prefer-target', target: 'missing' } },
    }),
    /unknown target/i,
  );
  assert.throws(
    () => parseDevTargetsConfig({
      version: 2,
      targets: [target],
      commandExecution: { mode: 'prefer-target', target: 'mac', fallback: 'error' },
    }),
    /fallback must be "local"/i,
  );
  assert.throws(
    () => parseDevTargetsConfig({
      version: 2,
      targets: [target],
      commandExecution: { mode: 'auto', targets: ['missing'] },
    }),
    /unknown target/i,
  );
});

test('version 3 normalizes local and remote managed Lima runtimes without changing guest execution fields', () => {
  const config = parseDevTargetsConfig({
    version: 3,
    targets: [
      {
        name: 'local-linux',
        platform: 'posix',
        ssh: 'happier-local-linux',
        sshConfigFile: '/controller/guests/local.conf',
        repoDir: '/home/dev/happier',
        cliHomeDir: '/home/dev/.happier',
        managedRuntime: {
          kind: 'lima',
          host: { kind: 'local' },
          instance: 'happier-worker-local',
          limaHome: '/Users/dev/.happier/lima',
          profile: 'worker-balanced',
          architecture: 'aarch64',
        },
      },
      {
        name: 'remote-linux',
        platform: 'posix',
        ssh: 'happier-remote-linux',
        sshConfigFile: '/controller/guests/remote.conf',
        repoDir: '/home/dev/happier',
        cliHomeDir: '/home/dev/.happier',
        managedRuntime: {
          kind: 'lima',
          host: {
            kind: 'ssh',
            ssh: 'outer-mac',
            sshConfigFile: '/controller/outer-hosts.conf',
          },
          instance: 'happier-worker-remote',
          limaHome: '/Users/worker/.happier/lima',
          profile: 'worker-balanced',
          architecture: 'x86_64',
        },
      },
    ],
  });

  assert.equal(config.version, 3);
  assert.deepEqual(config.targets[0].managedRuntime.host, { kind: 'local' });
  assert.deepEqual(config.targets[1].managedRuntime.host, {
    kind: 'ssh',
    ssh: 'outer-mac',
    sshConfigFile: '/controller/outer-hosts.conf',
  });
  assert.equal(config.targets[1].managedRuntime.profile, 'worker-balanced');
  assert.equal(config.targets[1].managedRuntime.architecture, 'x86_64');
  assert.equal(config.targets[1].ssh, 'happier-remote-linux');
});

test('version 3 rejects legacy raw Lima fields and unsafe managed runtime combinations', () => {
  const base = {
    name: 'linux',
    platform: 'posix',
    ssh: 'linux',
    repoDir: '/repo',
    cliHomeDir: '/home',
  };
  assert.throws(() => parseDevTargetsConfig({
    version: 3,
    targets: [{ ...base, limaInstance: 'legacy', limaHome: '/tmp/lima' }],
  }), /legacy Lima fields/i);
  assert.throws(() => parseDevTargetsConfig({
    version: 3,
    targets: [{
      ...base,
      managedRuntime: {
        kind: 'lima', host: { kind: 'local' }, instance: 'worker',
        limaHome: '/tmp/lima', profile: 'worker-balanced', architecture: 'riscv64',
      },
    }],
  }), /architecture/i);
  assert.throws(() => parseDevTargetsConfig({
    version: 3,
    targets: [{
      ...base,
      platform: 'windows',
      repoDir: 'C:/repo',
      cliHomeDir: 'C:/home',
      managedRuntime: {
        kind: 'lima', host: { kind: 'local' }, instance: 'worker',
        limaHome: '/tmp/lima', profile: 'worker-balanced',
      },
    }],
  }), /managed Lima runtimes must use platform "posix"/i);
  assert.throws(() => parseDevTargetsConfig({
    version: 3,
    targets: [{
      ...base,
      managedRuntime: {
        kind: 'lima',
        host: { kind: 'ssh', ssh: 'user@outer', sshConfigFile: 'relative.conf' },
        instance: 'worker', limaHome: '/tmp/lima', profile: 'worker-balanced',
      },
    }],
  }), /outer-host SSH alias|absolute path/i);
});

test('explicit version 3 upgrade converts legacy local Lima ownership at the config boundary', () => {
  const version2 = parseDevTargetsConfig({
    version: 2,
    targets: [{
      name: 'linux',
      platform: 'posix',
      ssh: 'linux',
      sshConfigFile: '/tmp/linux.conf',
      limaInstance: 'hslqa',
      limaHome: '/tmp/lima-happier',
      repoDir: '/repo',
      cliHomeDir: '/home',
    }],
    runtimePlacement: { server: { mode: 'local' } },
    commandExecution: { mode: 'auto' },
  });

  const upgraded = upgradeDevTargetsConfigToVersion3(version2);

  assert.equal(upgraded.version, 3);
  assert.equal('limaInstance' in upgraded.targets[0], false);
  assert.equal('limaHome' in upgraded.targets[0], false);
  assert.deepEqual(upgraded.targets[0].managedRuntime, {
    kind: 'lima',
    host: { kind: 'local' },
    instance: 'hslqa',
    limaHome: '/tmp/lima-happier',
    profile: 'worker-balanced',
    architecture: 'aarch64',
  });
  assert.deepEqual(resolveDevTargetExecutionPolicy(upgraded).commands, version2.commandExecution);
});
