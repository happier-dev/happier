import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, lstat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as placement from './service_placement.mjs';
import { writeJsonAtomic } from '../fs/json.mjs';
import { loadDevTargetsConfig } from './config.mjs';

import {
  resolveDevTargetServicePlans,
  resolveServicePlansAfterTargetPreflight,
} from './service_placement.mjs';

const targets = [{ name: 'mac' }, { name: 'windows' }];

async function withQaPlacementFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-qa-owner-'));
  const config = {
    version: 3,
    targets: ['builder', 'linux1', 'linux2', 'linux3', 'nl1', 'nl2', 'mac-host', 'mac3-linux'].map(name => ({ name, platform: 'posix', ssh: name, repoDir: `/mirror/${name}`, cliHomeDir: `/state/${name}` })),
    runtimePlacement: { build: { mode: 'prefer-target', targets: ['builder'] }, qa: { mode: 'auto', targets: ['linux2', 'linux3'], fallback: 'local' } },
    commandExecution: { mode: 'auto', targets: ['builder', 'mac-host'] },
  };
  const env = { HAPPIER_STACK_STORAGE_DIR: root, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer' };
  await writeJsonAtomic(join(root, 'producer', 'dev-targets.json'), config);
  try { await run({ root, config, env }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('local QA daemon browser selects the most unreserved QA pool host without writing any placement', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    const path = join(root, 'qa', 'dev-targets.json');
    for (const explicitDaemon of [true, false]) {
      await writeJsonAtomic(path, { ...config, runtimePlacement: {
        ...config.runtimePlacement, ...(explicitDaemon ? { daemon: { mode: 'local' } } : {}),
      } });
      const before = await readFile(path);
      const probes = [];
      const result = await placement.resolveControlledQaBrowserTarget({ stackName: 'qa', sourceDir: '/repo',
        env: explicitDaemon ? { ...env, HAPPIER_STACK_QA_DAEMON_TARGETS: 'linux3,linux2,linux1' } : env }, {
        runCaptureResult: async (_command, args) => {
          const target = args.find(arg => arg.startsWith('--target='));
          probes.push(target);
          const memory = target === '--target=linux1' ? [24900000, 3500000]
            : target === '--target=linux2' ? [10900000, 9000000] : [3800000, 3700000];
          return { ok: true, out: `HSTACK_QA_HOST=${JSON.stringify({ platform: 'linux', arch: 'x64', remote: true,
            availableMemoryKiB: memory[0], unreservedMemoryKiB: memory[1] })}\n`, err: '' };
        }, logger: { warn() {} },
      });
      assert.equal(result?.target?.name, 'linux2', 'browser must rank native unreserved memory, not raw free memory or the first host');
      assert.deepEqual(probes, [...(!explicitDaemon ? ['--target=nl1', '--target=nl2'] : []), '--target=linux3', '--target=linux2', '--target=linux1']);
      assert.deepEqual(await readFile(path), before, 'browser selection cannot move or initialize a daemon pin');
    }
  });
});

test('remote QA daemon browser ranks the pool without moving its fixed Machine', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    const path = join(root, 'qa', 'dev-targets.json');
    for (const [daemonHostUnavailable, registeredHosts] of [[false, ['nl1', 'nl2']], [true, ['nl1', 'nl2']], [false, ['nl1']], [false, []]]) {
      await writeJsonAtomic(path, { ...config, targets: config.targets.filter(target => !['nl1', 'nl2'].includes(target.name) || registeredHosts.includes(target.name)),
        runtimePlacement: { daemon: { mode: 'prefer-target', target: 'linux3' } } });
      const before = await readFile(path);
      const probes = [];
      const result = await placement.resolveControlledQaBrowserTarget({ stackName: 'qa', sourceDir: '/repo', env }, {
        runCaptureResult: async (_command, args) => {
          const target = args.find(arg => arg.startsWith('--target='));
          probes.push(target);
          if (target === '--target=linux3' && daemonHostUnavailable) return { ok: false, exitCode: 255, err: 'unavailable' };
          const available = target === '--target=nl2' ? 180000000 : target === '--target=nl1' ? 90000000 : target === '--target=linux1' ? 30000000 : target === '--target=linux2' ? 8500000 : 700000;
          return { ok: true, out: `HSTACK_QA_HOST=${JSON.stringify({ platform: 'linux', arch: 'x64', remote: true,
            availableMemoryKiB: available, unreservedMemoryKiB: available })}\n`, err: '' };
        }, logger: { warn() {} },
      });
      assert.equal(result.target.name, registeredHosts.at(-1) ?? 'linux1');
      assert.deepEqual(probes, [...registeredHosts.map(name => `--target=${name}`), '--target=linux3', '--target=linux2', '--target=linux1']);
      assert.deepEqual(await readFile(path), before);
    }
  });
});

test('local QA daemon browser never falls back to the controller when no pool host is usable', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    const path = join(root, 'qa', 'dev-targets.json');
    await writeJsonAtomic(path, { ...config, runtimePlacement: { daemon: { mode: 'local' } } });
    const before = await readFile(path);
    await assert.rejects(placement.resolveControlledQaBrowserTarget({ stackName: 'qa', sourceDir: '/repo', env }, {
      runCaptureResult: async () => ({ ok: false, exitCode: 255, err: 'unavailable' }), logger: { warn() {} },
    }), /no QA browser host.*available-memory/);
    assert.deepEqual(await readFile(path), before);
    await writeJsonAtomic(path, { ...config, targets: config.targets.filter(target => target.name === 'builder'),
      runtimePlacement: { daemon: { mode: 'local' } }, commandExecution: { mode: 'local' } });
    const withoutDefaultHosts = await readFile(path);
    const noProbe = { runCaptureResult: async () => assert.fail('an empty or invalid pool must not execute on another host'), logger: { warn() {} } };
    await assert.rejects(placement.resolveControlledQaBrowserTarget({ stackName: 'qa', sourceDir: '/repo', env }, noProbe),
      /no QA browser host.*available-memory/);
    await assert.rejects(placement.resolveControlledQaBrowserTarget({ stackName: 'qa', sourceDir: '/repo',
      env: { ...env, HAPPIER_STACK_QA_DAEMON_TARGETS: 'linux3' } }, noProbe), /QA browser hosts must be configured targets/);
    assert.deepEqual(await readFile(path), withoutDefaultHosts);
  });
});

test('explicit fresh controlled QA uses the native automatic selector over its own pool', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), { ...config,
      runtimePlacement: { ...config.runtimePlacement, daemon: { mode: 'local' } } });
    const result = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', stackBaseDir: join(root, 'qa'), sourceDir: '/repo', env }, {
      runCaptureResult: async (command, args, options) => {
        assert.ok(command.endsWith('/apps/stack/bin/hstack-exec'));
        const projection = JSON.parse(await readFile(options.env.HAPPIER_EXEC_CONFIG_PATH, 'utf8'));
        assert.deepEqual(projection.commandExecution.targets, ['linux2', 'linux3']);
        assert.equal(projection.commandExecution.includeLocal, false);
        await assert.rejects(lstat(join(options.env.HAPPIER_EXEC_CONFIG_PATH, '..', 'mutagen')), { code: 'ENOENT' });
        return { ok: true, out: `\rForcing synchronization cycle\r     \rHSTACK_QA_HOST=${JSON.stringify({ platform: 'linux', arch: 'x64', remote: true })}\n`, err: '[preferred-execution] selected linux3 (load=0.1, active=0, effective=0.1, fresh)\n' };
      },
    });
    assert.equal(result.target.name, 'linux3');
    assert.deepEqual(result.runtimeTarget, { platform: 'linux', arch: 'x64' });
    assert.equal(result.targetPlans.length, 1);
    assert.deepEqual(result.targetPlans[0].services, { server: true, daemon: false, expo: false });
    assert.equal(result.policy.daemons.mode, 'local');
    assert.equal(result.config.runtimePlacement.build, undefined);
  });
});

test('consumer target registries never borrow producer build placement or override its decision', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    const producerBefore = await readFile(join(root, 'producer', 'dev-targets.json'));
    const decisions = [];
    for (const [stackName, targetName, build] of [
      ['qa-one', 'linux2', undefined],
      ['qa-two', 'linux3', { mode: 'prefer-target', targets: ['linux3'] }],
      ['qa-stale', 'linux2', { mode: 'prefer-target', targets: ['builder'] }],
    ]) {
      const consumerPath = join(root, stackName, 'dev-targets.json');
      await writeJsonAtomic(consumerPath, { version: 3,
        targets: config.targets.filter(target => target.name === targetName),
        runtimePlacement: { qa: { mode: 'prefer-target', targets: [targetName] }, ...(build ? { build } : {}) },
        commandExecution: { mode: 'local' },
      });
      const consumerBefore = await readFile(consumerPath);
      const warnings = [];
      const loaded = await placement.loadControlledRuntimeConfig({ stackName, sourceDir: '/repo', env },
        { logger: { warn: message => warnings.push(message) } });
      assert.deepEqual(loaded.config.targets.map(target => target.name), [targetName]);
      assert.equal(loaded.config.runtimePlacement.build, undefined);
      if (build) assert.ok(warnings.some(message => message.includes('ignored')
        && message.includes('runtimePlacement.build') && message.includes(join(root, 'producer', 'dev-targets.json'))));
      else assert.deepEqual(warnings, []);
      const producer = await loadDevTargetsConfig({ path: join(loaded.authority.producerStackBaseDir, 'dev-targets.json'), env });
      decisions.push(producer.config.runtimePlacement.build);
      assert.deepEqual(await readFile(consumerPath), consumerBefore);
    }
    assert.deepEqual(decisions[0].targets, ['builder']);
    assert.deepEqual(decisions[1], decisions[0]);
    assert.deepEqual(decisions[2], decisions[0]);
    await writeJsonAtomic(join(root, 'qa-local', 'dev-targets.json'), { version: 3,
      targets: config.targets.filter(target => target.name === 'linux2'),
      runtimePlacement: { qa: { mode: 'local' }, build: { mode: 'prefer-target', targets: ['builder'] } },
      commandExecution: { mode: 'local' },
    });
    const warnings = [];
    const local = await placement.loadControlledRuntimeConfig({ stackName: 'qa-local', sourceDir: '/repo',
      preserveLocalPlacement: true, env }, { logger: { warn: message => warnings.push(message) } });
    assert.equal(local.localPlacementReason, 'explicit-local');
    assert.equal(local.config.runtimePlacement.build, undefined);
    assert.equal(warnings.length, 1);
    const producer = await placement.loadControlledRuntimeConfig({ stackName: 'producer', sourceDir: '/repo', env });
    assert.deepEqual(producer.config.runtimePlacement.build.targets, ['builder']);
    assert.deepEqual(await readFile(join(root, 'producer', 'dev-targets.json')), producerBefore);
  });
});

test('shared database QA places only its server on the source host and keeps its daemon local', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), { ...config, runtimePlacement: {
      server: { mode: 'prefer-target', target: 'mac-host', fallback: 'error' }, daemon: { mode: 'local' } } });
    env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK = 'producer';
    const probes = [];
    const result = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, {
      runCaptureResult: async (command, args) => {
        probes.push(args.find(arg => arg.startsWith('--target=')) ?? 'pool');
        return { ok: true, out: 'HSTACK_QA_HOST={"platform":"darwin","arch":"arm64","remote":true}\n', err: '' };
      },
    });
    assert.deepEqual(probes, ['--target=mac-host'], 'an explicit local daemon must not probe the command pool');
    assert.deepEqual(result.targetPlans[0].services, { server: true, daemon: false, expo: false });
    assert.equal(result.policy.daemons.mode, 'local');
  });
});

test('fresh QA keeps its Machine local regardless of producer QA or command pools', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    await writeJsonAtomic(join(root, 'producer', 'dev-targets.json'), { ...config,
      runtimePlacement: { ...config.runtimePlacement, qa: { mode: 'auto', targets: ['mac3-linux', 'linux3'] } },
      commandExecution: { mode: 'auto', targets: ['mac3-linux', 'linux3'], includeLocal: true },
    });
    const result = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, {
      runCaptureResult: async () => { assert.fail('an unpinned Machine must not probe a pool'); }, logger: { warn() {} },
    });
    assert.equal(result.target, null);
    assert.equal(result.policy.daemons.mode, 'local');
  });
});

test('new opted-in QA pins the most unreserved available memory once and never follows changing capacity', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    env.HAPPIER_STACK_QA_DAEMON_TARGETS = 'linux3,linux2,linux1';
    const probes = [];
    const dependencies = {
      runCaptureResult: async (_command, args) => {
        const target = args.find(arg => arg.startsWith('--target='));
        probes.push(target);
        const memory = target === '--target=linux3' ? [14000000, 8000000]
          : target === '--target=linux2' ? [10000000, 9000000] : [22000000, 7000000];
        return { ok: true, out: `HSTACK_QA_HOST=${JSON.stringify({ platform: 'linux', arch: 'x64', remote: true,
          availableMemoryKiB: memory[0], unreservedMemoryKiB: memory[1] })}\n`, err: '' };
      }, logger: { warn() {} },
    };
    const initial = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, dependencies);
    assert.equal(initial.daemonTarget?.name, 'linux2');
    const saved = JSON.parse(await readFile(join(root, 'qa', 'dev-targets.json'), 'utf8'));
    assert.deepEqual(saved.runtimePlacement.daemon, { mode: 'prefer-target', target: 'linux2', fallback: 'local' });
    assert.deepEqual(probes, ['--target=linux3', '--target=linux2', '--target=linux1']);
    await writeJsonAtomic(join(root, 'producer', 'dev-targets.json'), { ...config, commandExecution: { mode: 'auto', targets: ['linux3'] } });
    probes.length = 0;
    await assert.rejects(placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, {
      ...dependencies, runCaptureResult: async (_command, args) => {
        probes.push(args.find(arg => arg.startsWith('--target=')));
        return { ok: false, exitCode: 255, err: 'unavailable' };
      },
    }), /daemon placement.*linux2.*unavailable/);
    assert.deepEqual(probes, ['--target=linux2']);
    assert.equal(JSON.parse(await readFile(join(root, 'qa', 'dev-targets.json'), 'utf8')).runtimePlacement.daemon.target, 'linux2');
  });
});

test('new QA ranks every initial host without imposing a validation admission floor on Machine placement', async () => {
  await withQaPlacementFixture(async ({ root, env }) => {
    env.HAPPIER_STACK_QA_DAEMON_TARGETS = 'linux3,linux2';
    const probes = [];
    const result = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, {
      runCaptureResult: async (_command, args) => {
        const target = args.find(arg => arg.startsWith('--target='));
        probes.push(target);
        return { ok: true, out: `HSTACK_QA_HOST=${JSON.stringify({ platform: 'linux', arch: 'x64', remote: true,
          availableMemoryKiB: target === '--target=linux3' ? 1 : 1000000,
          unreservedMemoryKiB: target === '--target=linux3' ? 1 : 1000000 })}\n`, err: '' };
      }, logger: { warn() {} },
    });
    assert.equal(result.daemonTarget?.name, 'linux2');
    assert.deepEqual(probes, ['--target=linux3', '--target=linux2']);
    assert.equal(JSON.parse(await readFile(join(root, 'qa', 'dev-targets.json'), 'utf8')).runtimePlacement.daemon.target, 'linux2');
  });
});

test('QA creation policy never overrides an explicit Machine or the producer and writes no pin without capacity', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    env.HAPPIER_STACK_QA_DAEMON_TARGETS = 'linux3,linux2';
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), { ...config,
      runtimePlacement: { daemon: { mode: 'local' } } });
    const noProbe = { runCaptureResult: async () => assert.fail('existing explicit Machine must not be selected again'), logger: { warn() {} } };
    assert.equal((await placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, noProbe)).daemonTarget, null);
    assert.equal((await placement.resolveControlledRuntimePlacement({ stackName: 'producer', sourceDir: '/repo', env }, noProbe)).daemonTarget, undefined);
    await assert.rejects(placement.resolveControlledRuntimePlacement({ stackName: 'no-capacity', sourceDir: '/repo', env }, {
      runCaptureResult: async () => ({ ok: true, out: 'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true}\n', err: '' }), logger: { warn() {} },
    }), /no QA daemon host.*no Machine pin was written/);
    await assert.rejects(readFile(join(root, 'no-capacity', 'dev-targets.json')), { code: 'ENOENT' });
  });
});

test('automatic QA placement cannot infer outer Windows disk health from a configured WSL guest', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    const wsl = { ...config.targets[0], name: 'windows1-linux', managedRuntime: {
      kind: 'wsl', instance: 'Happier', user: 'happier',
      host: { kind: 'ssh', ssh: 'windows1', sshConfigFile: '/configured/windows1' },
      capacity: { mode: 'shared', shared: { cpus: 12, memoryGiB: 12 }, dedicated: { cpus: 12, memoryGiB: 12 } },
    } };
    await writeJsonAtomic(join(root, 'producer', 'dev-targets.json'), { ...config, targets: [...config.targets, wsl] });
    env.HAPPIER_STACK_QA_DAEMON_TARGETS = 'windows1-linux,linux3';
    await assert.rejects(placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, {
      runCaptureResult: async () => ({ ok: true, out: 'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true,"unreservedMemoryKiB":14000000}\n', err: '' }),
      logger: { warn() {} },
    }), /outer Windows disk health.*no Machine pin was written/);
    await assert.rejects(placement.resolveControlledQaBrowserTarget({ stackName: 'qa', sourceDir: '/repo', env }, {
      runCaptureResult: async () => assert.fail('WSL guest capacity cannot establish outer Windows disk health'),
      logger: { warn() {} },
    }), /outer Windows disk health.*no browser host was selected/);
    await assert.rejects(readFile(join(root, 'qa', 'dev-targets.json')), { code: 'ENOENT' });
  });
});

test('shared database QA pins its Machine to one named host independently of changing pools', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    await writeJsonAtomic(join(root, 'producer', 'dev-targets.json'), { ...config,
      runtimePlacement: { ...config.runtimePlacement, qa: { mode: 'local' } },
      commandExecution: { mode: 'auto', targets: ['mac3-linux', 'linux3'] },
    });
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), { ...config, runtimePlacement: {
      server: { mode: 'prefer-target', target: 'mac-host', fallback: 'error' },
      qa: { mode: 'auto', targets: ['linux2', 'linux3'] },
      daemon: { mode: 'prefer-target', target: 'mac3-linux' } } });
    const result = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo',
      env: { ...env, HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'producer' } }, {
      runCaptureResult: async (command, args, options) => {
        const server = args.includes('--target=mac-host');
        if (!server) {
          const projection = JSON.parse(await readFile(options.env.HAPPIER_EXEC_CONFIG_PATH, 'utf8'));
          assert.ok(args.includes('--target=mac3-linux'), 'Machine placement must use the exact pin');
          assert.equal(projection.commandExecution.target, 'mac3-linux');
        }
        return { ok: true, out: `HSTACK_QA_HOST=${JSON.stringify({ platform: server ? 'darwin' : 'linux', arch: server ? 'arm64' : 'x64', remote: true })}\n`,
          err: server ? '' : '[preferred-execution] selected mac3-linux (load=0.1)\n' };
      }, logger: { warn() {} },
    });
    assert.equal(result.target.name, 'mac-host');
    assert.equal(result.daemonTarget.name, 'mac3-linux');
    assert.deepEqual(result.daemonRuntimeTarget, { platform: 'linux', arch: 'x64' });
    assert.equal(result.policy.daemons.target, 'mac3-linux');
    assert.deepEqual(result.targetPlans.map(plan => [plan.target.name, plan.services]), [
      ['mac-host', { server: true, daemon: false, expo: false }],
      ['mac3-linux', { server: false, daemon: true, expo: false }],
    ]);
    await assert.rejects(placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo',
      env: { ...env, HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'producer' } }, {
      runCaptureResult: async (_command, args) => args.includes('--target=mac-host')
        ? { ok: true, out: 'HSTACK_QA_HOST={"platform":"darwin","arch":"arm64","remote":true}\n', err: '' }
        : { ok: false, exitCode: 255, err: 'offline' }, logger: { warn() {} },
    }), /daemon placement.*mac3-linux.*unavailable/);
  });
});

test('explicit local QA ignores even an invalid inherited QA policy without probing', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), { ...config, runtimePlacement: { qa: { mode: 'local' } } });
    const warnings = [];
    const result = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', stackBaseDir: join(root, 'qa'), sourceDir: '/repo', env }, {
      runCaptureResult: async () => { throw new Error('an existing stack must not probe inherited placement'); },
      logger: { warn: message => warnings.push(message) },
    });
    assert.equal(result.target, null);
    await writeJsonAtomic(join(root, 'producer', 'dev-targets.json'), { ...config, runtimePlacement: { qa: { mode: 'auto', targets: ['invalid-default-target'] } } });
    const unchanged = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, {
      runCaptureResult: async () => { throw new Error('invalid producer default must not affect local activation'); },
      logger: { warn: message => warnings.push(message) },
    });
    assert.equal(unchanged.target, null);
  });
});

test('existing local retained server data stays local even with an explicit QA policy until handoff', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), config);
    await mkdir(join(root, 'qa', 'server-light'), { recursive: true });
    await writeFile(join(root, 'qa', 'server-light', 'retained.db'), 'retained bytes');
    const result = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', stackBaseDir: join(root, 'qa'), sourceDir: '/repo', env }, {
      runCaptureResult: async () => { throw new Error('local data must not be implicitly moved'); },
      logger: { warn() {} },
    });
    assert.equal(result.target, null);
  });
});

test('malformed QA probe falls back locally with redacted stdout and stderr; explicit server authority fails closed', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), config);
    env.K = 'private-development-account-key';
    const warnings = [];
    const dependencies = { runCaptureResult: async () => ({ ok: true,
      out: 'private-development-account-key\n\rForcing synchronization\rHSTACK_QA_HOST=invalid token=qa-secret\n',
      err: '[preferred-execution] selected linux3 (load=0) password=private-password\n',
    }), logger: { warn: message => warnings.push(message) } };
    const result = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, dependencies);
    assert.equal(result.target, null);
    const diagnostic = warnings.join('\n');
    assert.match(diagnostic, /malformed.*stdout=.*Forcing synchronization.*stderr=/s);
    assert.doesNotMatch(diagnostic, /qa-secret|private-password|private-development-account-key/);
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), { ...config, runtimePlacement: { ...config.runtimePlacement, server: { mode: 'prefer-target', target: 'linux3' } } });
    await assert.rejects(placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, dependencies), error => {
      assert.match(error.message, /authoritative.*malformed.*stdout=.*stderr=/s);
      assert.doesNotMatch(error.message, /qa-secret|private-password|private-development-account-key/);
      return true;
    });
  });
});

test('controlled QA ordered placement skips unavailable workers and uses local only after all fail', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), { ...config, runtimePlacement: { qa: { mode: 'prefer-target', targets: ['linux2', 'linux3'] } } });
    const attempted = [];
    const diagnostics = [];
    const result = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', stackBaseDir: join(root, 'qa'), sourceDir: '/repo', env }, {
      runCaptureResult: async (command, args) => { attempted.push(args.find(arg => arg.startsWith('--target='))); return { ok: false, exitCode: 255, err: 'offline' }; },
      logger: { warn: message => diagnostics.push(message) },
    });
    assert.deepEqual(attempted, ['--target=linux2', '--target=linux3']);
    assert.equal(result.target, null);
    assert.deepEqual(result.runtimeTarget, { platform: process.platform, arch: process.arch });
    assert.ok(diagnostics.some(message => message.includes('linux2') && message.includes('offline')));
    assert.ok(diagnostics.some(message => message.includes('linux3') && message.includes('offline')));
    const next = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, {
      runCaptureResult: async (command, args) => ({ ok: true,
        out: `HSTACK_QA_HOST=${JSON.stringify({ platform: 'linux', arch: 'x64', remote: args.includes('--target=linux3') })}\n`,
        err: args.includes('--target=linux2') ? '[preferred-execution] linux2 unavailable; using local fallback\n' : '',
      }), logger: { warn: message => diagnostics.push(message) },
    });
    assert.equal(next.target?.name, 'linux3', 'an exact-target local fallback must not skip the next ordered worker');
  });
});

test('controlled QA per-stack local override avoids target probes; retained remote authority fails closed', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), { ...config, runtimePlacement: { qa: { mode: 'local' } } });
    const local = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', stackBaseDir: join(root, 'qa'), sourceDir: '/repo', env }, {
      runCaptureResult: async () => { throw new Error('local override must not probe'); },
    });
    assert.equal(local.target, null);
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), { ...config, runtimePlacement: { qa: { mode: 'local' }, server: { mode: 'prefer-target', target: 'linux2' } } });
    await assert.rejects(placement.resolveControlledRuntimePlacement({ stackName: 'qa', stackBaseDir: join(root, 'qa'), sourceDir: '/repo', env }, {
      runCaptureResult: async () => ({ ok: false, exitCode: 255, err: 'offline' }),
    }), /persisted server placement.*linux2.*unavailable/);
    await assert.rejects(placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env }, {
      runCaptureResult: async () => ({ ok: true,
        out: `HSTACK_QA_HOST=${JSON.stringify({ platform: process.platform, arch: process.arch, remote: false })}\n`,
        err: '[preferred-execution] using local fallback\n',
      }), logger: { warn() {} },
    }), /authoritative.*linux2.*local/);
  });
});

test('ready remote QA persists server authority without changing the producer build policy', async () => {
  await withQaPlacementFixture(async ({ root, env }) => {
    await placement.persistControlledServerPlacement({ stackName: 'qa', sourceDir: '/repo', targetName: 'linux3', env });
    const own = JSON.parse(await readFile(join(root, 'qa', 'dev-targets.json'), 'utf8'));
    assert.equal(own.runtimePlacement.server.target, 'linux3');
    assert.equal(own.runtimePlacement.build, undefined);
    assert.equal(own.runtimePlacement.daemon, undefined, 'persisting server authority must not manufacture a local daemon pin');
    assert.equal(own.runtimePlacement.qa.mode, 'local');
    const producer = JSON.parse(await readFile(join(root, 'producer', 'dev-targets.json'), 'utf8'));
    assert.deepEqual(producer.runtimePlacement.build.targets, ['builder']);
    await assert.rejects(placement.persistControlledServerPlacement({ stackName: 'qa', sourceDir: '/repo', targetName: 'linux2', env }), /authoritative.*linux3/);
  });
});

test('controlled QA failover excludes only failed workers and never excludes retained server authority', async () => {
  await withQaPlacementFixture(async ({ root, config, env }) => {
    await writeJsonAtomic(join(root, 'qa', 'dev-targets.json'), config);
    const result = await placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env, excludeTargetNames: ['linux2'] }, {
      runCaptureResult: async (command, args, options) => {
        const projection = JSON.parse(await readFile(options.env.HAPPIER_EXEC_CONFIG_PATH, 'utf8'));
        assert.deepEqual(projection.commandExecution.targets, ['linux3']);
        return { ok: true, out: `HSTACK_QA_HOST=${JSON.stringify({ platform: 'linux', arch: 'x64', remote: true })}\n`, err: '[preferred-execution] selected linux3 (load=0.1)\n' };
      },
    });
    assert.equal(result.target.name, 'linux3');
    await placement.persistControlledServerPlacement({ stackName: 'qa', sourceDir: '/repo', targetName: 'linux2', env });
    await assert.rejects(placement.resolveControlledRuntimePlacement({ stackName: 'qa', sourceDir: '/repo', env, excludeTargetNames: ['linux2'] }, {
      runCaptureResult: async () => ({ ok: false, exitCode: 255, err: 'offline' }),
    }), /authoritative.*linux2.*unavailable/);
  });
});

test('v2 placement assigns server, Expo, and daemon services without starting local duplicates', () => {
  const plans = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
      daemons: { mode: 'prefer-target', target: 'windows', fallback: 'local' },
      commands: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
    },
    requested: { server: true, expo: true, daemon: true },
  });

  assert.deepEqual(plans.local, { server: true, expo: false, daemon: false });
  assert.deepEqual(plans.targets, [
    { target: targets[0], commands: true, services: { server: false, expo: true, daemon: false } },
    { target: targets[1], commands: false, services: { server: false, expo: false, daemon: true } },
  ]);
});

test('command execution alone owns synchronization for its target without adding a runtime service', () => {
  const plans = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemons: { mode: 'local' },
      commands: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
    },
    requested: { server: true, expo: true, daemon: true },
  });

  assert.deepEqual(plans.local, { server: true, expo: true, daemon: true });
  assert.deepEqual(plans.targets, [
    { target: targets[0], commands: true, services: { server: false, expo: false, daemon: false } },
  ]);
});

test('automatic command execution keeps every selected target synchronized without adding services', () => {
  const plans = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemons: { mode: 'local' },
      commands: {
        mode: 'auto',
        targets: ['mac', 'windows'],
        includeLocal: false,
        fallback: 'local',
        loadProbeTtlMs: 15_000,
        unavailableProbeTtlMs: 120_000,
      },
    },
    requested: { server: true, expo: true, daemon: true },
  });

  assert.deepEqual(plans.local, { server: true, expo: true, daemon: true });
  assert.deepEqual(plans.targets, [
    { target: targets[0], commands: true, services: { server: false, expo: false, daemon: false } },
    { target: targets[1], commands: true, services: { server: false, expo: false, daemon: false } },
  ]);
});

test('version 1 compatibility runs local services plus a daemon on every target', () => {
  const plans = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemons: { mode: 'local-and-targets', targets: ['mac', 'windows'] },
      commands: { mode: 'local' },
    },
    requested: { server: true, expo: true, daemon: true },
  });
  assert.deepEqual(plans.local, { server: true, expo: true, daemon: true });
  assert.ok(plans.targets.every((plan) => plan.services.daemon));
});

test('host preflight failure selects local fallback without removing reachable or locally-backed target services', () => {
  const configured = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
      daemons: { mode: 'local-and-targets', targets: ['mac', 'windows'] },
      commands: { mode: 'local' },
    },
    requested: { server: true, expo: true, daemon: true },
  });
  const resolved = resolveServicePlansAfterTargetPreflight({
    configured,
    mutagenAvailable: true,
    reachableTargets: new Set(['windows']),
  });

  assert.deepEqual(resolved.local, { server: true, expo: true, daemon: true });
  assert.deepEqual(resolved.targets, [
    { target: targets[0], commands: false, services: { server: false, expo: false, daemon: true } },
    { target: targets[1], commands: false, services: { server: false, expo: false, daemon: true } },
  ]);
  assert.deepEqual(resolved.fallbacks, [
    { target: 'mac', services: ['expo'], reason: 'target-unreachable' },
  ]);
});

test('host preflight fails closed when persisted server authority is unavailable', () => {
  const configured = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
      expo: { mode: 'local' },
      daemons: { mode: 'local' },
      commands: { mode: 'local' },
    },
    requested: { server: true, expo: true, daemon: true },
  });

  assert.throws(
    () => resolveServicePlansAfterTargetPreflight({
      configured,
      mutagenAvailable: false,
      reachableTargets: new Set(),
    }),
    /server placement.*authoritative.*mac/i,
  );
});

test('host preflight fallback retains command synchronization while moving unavailable services local', () => {
  const configured = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
      daemons: { mode: 'local' },
      commands: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
    },
    requested: { server: true, expo: true, daemon: true },
  });
  const resolved = resolveServicePlansAfterTargetPreflight({
    configured,
    mutagenAvailable: true,
    reachableTargets: new Set(),
  });

  assert.deepEqual(resolved.local, { server: true, expo: true, daemon: true });
  assert.deepEqual(resolved.targets, [
    { target: targets[0], commands: true, services: { server: false, expo: false, daemon: false } },
  ]);
});
