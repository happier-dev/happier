import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as placement from './service_placement.mjs';
import { writeJsonAtomic } from '../fs/json.mjs';
import { loadDevTargetsConfig } from './config.mjs';
import { resolveRuntimeBuildPlacement } from '../../build/remote_runtime_build.mjs';

import {
  resolveDevTargetServicePlans,
  resolveServicePlansAfterTargetPreflight,
} from './service_placement.mjs';

const targets = [{ name: 'mac' }, { name: 'windows' }];

async function withQaPlacementFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-qa-owner-'));
  const config = {
    version: 3,
    targets: ['builder', 'linux2', 'linux3', 'mac-host', 'mac3-linux'].map(name => ({ name, platform: 'posix', ssh: name, repoDir: `/mirror/${name}`, cliHomeDir: `/state/${name}` })),
    runtimePlacement: { build: { mode: 'prefer-target', targets: ['builder'] }, qa: { mode: 'auto', targets: ['linux2', 'linux3'], fallback: 'local' } },
    commandExecution: { mode: 'auto', targets: ['builder', 'mac-host'] },
  };
  const env = { HAPPIER_STACK_STORAGE_DIR: root, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer' };
  await writeJsonAtomic(join(root, 'producer', 'dev-targets.json'), config);
  try { await run({ root, config, env }); } finally { await rm(root, { recursive: true, force: true }); }
}

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
        assert.equal(await readlink(join(options.env.HAPPIER_EXEC_CONFIG_PATH, '..', 'mutagen')), join(root, 'producer', 'mutagen'));
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
      decisions.push(resolveRuntimeBuildPlacement({ config: producer.config,
        hostTarget: { platform: 'linux', arch: 'x64' },
        observedTarget: { ok: true, runtimeTarget: { platform: 'linux', arch: 'x64' } },
      }));
      assert.deepEqual(await readFile(consumerPath), consumerBefore);
    }
    assert.equal(decisions[0].target.name, 'builder');
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
