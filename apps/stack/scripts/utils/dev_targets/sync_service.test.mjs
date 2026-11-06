import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

import { parseDevTargetsConfig } from './config.mjs';
import { resolveDevTargetMutagenRuntime } from './mutagen_runtime.mjs';
import { DEV_TARGET_SYNC_EXECUTOR_REPO, renderMutagenProject, resolveMutagenSessionName } from './mutagen_project.mjs';
import {
  ensureDevTargetSyncProject,
  INDEPENDENT_DEV_TARGET_SYNC_OWNER,
} from './sync_project.mjs';
import {
  inspectDevTargetSyncService,
  prepareDevTargetCommandSync,
  repairRecoverableDevTargetSyncConflicts,
  startDevTargetSyncService,
  stopDevTargetSyncService,
  waitForDevTargetSyncMonitor,
} from './sync_service.mjs';


const envFor = root => ({ HAPPIER_STACK_STORAGE_DIR: root });
const runtimeFor = (root, sourceDir = DEV_TARGET_SYNC_EXECUTOR_REPO) => resolveDevTargetMutagenRuntime({ stackBaseDir: root, sourceDir, env: envFor(root) });

async function installCommandReplicaExecutor(fixture, bin) {
  await symlink(fileURLToPath(new URL('../../../../../', import.meta.url)), fixture.path('primary'), 'dir');
  // The fixture links its executor; physical worker checkouts need no override.
  await writeFile(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' --preserve-symlinks-main "$@"\n`);
  await chmod(join(bin, 'node'), 0o700);
}

const targets = [
  { name: 'mac' },
  { name: 'mac2' },
];

test('sync startup seeds an unscanned no-watch session once through the canonical flush barrier', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-no-watch-start-' });
  const bin = fixture.path('bin');
  await mkdir(bin);
  // Only external Mutagen/SSH are replaced. Setup, public-model parsing,
  // native flush admission and persisted startup observations stay real.
  await writeFile(fixture.path('mutagen.mjs'), [
    'import fs from "node:fs";',
    'const args = process.argv.slice(2);',
    'const [family,action] = args;',
    'const name = args[2] === "--template" ? "happier-worker" : args[2];',
    'const template = args[args.indexOf("--template") + 1];',
    'const marker = process.env.HSTACK_TEST_SYNC_STATE;',
    'const emptyReplica = process.env.HSTACK_TEST_SYNC_EMPTY_REPLICA;',
    'if (family === "sync" && action === "reset" && emptyReplica) {',
    '  if (args[2] !== process.env.HSTACK_TEST_SYNC_EXPECTED_RESET_NAME) throw new Error("reset must select the retired command replica only");',
    '  fs.rmSync(emptyReplica, {force:true});',
    '}',
    'if (family === "sync" && action === "flush") {',
    '  if (emptyReplica && fs.existsSync(emptyReplica)) throw new Error("replica root emptying requires history reset");',
    '  if (process.env.HSTACK_TEST_SYNC_FLUSH_FAILED === "1") process.exit(7);',
    '  fs.writeFileSync(marker, String(Number(fs.existsSync(marker) ? fs.readFileSync(marker,"utf8") : 0) + 1));',
    '  if (process.env.HSTACK_TEST_SYNC_REPLICA_ROOT) fs.writeFileSync(process.env.HSTACK_TEST_SYNC_REPLICA_ROOT + "/package.json", JSON.stringify({private:true}));',
    '}',
    'if (family === "sync" && action === "list") {',
    '  const seeded = fs.existsSync(marker);',
    '  const race = !seeded && process.env.HSTACK_TEST_SYNC_SCAN_RACE === "1";',
    '  const session = {name,paused:false,status:race?"waiting-for-rescan":"watching",successfulCycles:seeded?1:0,alpha:{connected:true,scanned:seeded,watch:{mode:"no-watch"},scanProblems:race?[{path:"source.ts",error:"hashed size mismatch: 1 != 2"}]:[]},beta:{connected:true,scanned:seeded,watch:{mode:"no-watch"}}};',
    '  if (template === "{{json .}}") console.log(JSON.stringify([session]));',
    '  else console.log(`${name}|Watching|false|true|${seeded?1:0}|0/0|0/0|true|${seeded?1:0}|0/0|0/0|active|${seeded?1:0}|ok|0|0`);',
    '}',
  ].join('\n'));
  await writeFile(join(bin, 'mutagen'), `#!/bin/sh\nexec "${process.execPath}" "${fixture.path('mutagen.mjs')}" "$@"\n`);
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nexit 0\n');
  await Promise.all(['mutagen', 'ssh'].map(name => chmod(join(bin, name), 0o700)));
  const marker = fixture.path('seeded');
  const env = { ...process.env, ...envFor(fixture.root), PATH: `${bin}:${process.env.PATH}`, DBUS_SESSION_BUS_ADDRESS: '', HSTACK_TEST_SYNC_STATE: marker };
  const target = { name: 'worker', platform: 'windows', ssh: 'worker', repoDir: 'C:/repo', cliHomeDir: 'C:/home' };
  await assert.rejects(startDevTargetSyncService({ stackBaseDir: fixture.path('agent-qa-test'), sourceDir: '/repo', targets: [target], detached: true, env }));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const start = () => startDevTargetSyncService({ stackBaseDir: fixture.path('stack'), sourceDir: '/repo', targets: [target], detached: true, env });
  assert.equal((await start()).statuses[0].status.state, 'ready');
  assert.equal(await readFile(marker, 'utf8'), '1');
  assert.equal((await start()).statuses[0].status.state, 'ready');
  assert.equal(await readFile(marker, 'utf8'), '1', 'resuming an already seeded session must not scan again');
  env.HSTACK_TEST_SYNC_STATE = fixture.path('scan-race-seed');
  env.HSTACK_TEST_SYNC_SCAN_RACE = '1';
  assert.equal((await start()).statuses[0].status.state, 'ready');
  assert.equal(await readFile(env.HSTACK_TEST_SYNC_STATE, 'utf8'), '1', 'an initial scan race must seed through the canonical flush');
  delete env.HSTACK_TEST_SYNC_SCAN_RACE;
  env.HSTACK_TEST_SYNC_STATE = fixture.path('failed-seed');
  env.HSTACK_TEST_SYNC_FLUSH_FAILED = '1';
  await assert.rejects(start(), /Mutagen initial flush failed/);
  assert.equal((await inspectDevTargetSyncService({ stackBaseDir: fixture.path('stack'), sourceDir: '/repo', targets: [target], env })).preparation.state, 'failed');
  env.HSTACK_TEST_SYNC_STATE = fixture.path('sibling-seed');
  delete env.HSTACK_TEST_SYNC_FLUSH_FAILED;
  const stackBaseDir = fixture.path('command-stack');
  await mkdir(stackBaseDir);
  // Execute directory setup at the real OS boundary while Mutagen stays external.
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nfor command; do :; done\nexec /bin/sh -c "$command"\n');
  await installCommandReplicaExecutor(fixture, bin);
  const sourceDir = fixture.path('source');
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, 'package.json'), '{}');
  const commandTarget = { name: 'worker', platform: 'posix', ssh: 'worker', repoDir: fixture.path('command-mirror'),
    executorRepoDir: fixture.path('primary'), cliHomeDir: fixture.path('worker-home'), remotePath: [bin, ...process.env.PATH.split(':')] };
  env.HSTACK_TEST_SYNC_REPLICA_ROOT = commandTarget.repoDir;
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({
    version: 3, targets: [commandTarget],
    runtimePlacement: { server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' } },
    commandExecution: { mode: 'auto', targets: ['worker'], fallback: 'local' },
  }));
  const prepare = () => prepareDevTargetCommandSync({ stackBaseDir, sourceDir, targets: [commandTarget], env });
  await prepare();
  assert.equal(await readFile(env.HSTACK_TEST_SYNC_STATE, 'utf8'), '1');
  const oldUse = new Date(Date.now() - 48 * 3600000);
  await utimes(commandTarget.repoDir, oldUse, oldUse);
  const legacySession = join(stackBaseDir, 'mutagen/data/sessions/sync_existing');
  await mkdir(dirname(legacySession), { recursive: true });
  await writeFile(legacySession, 'opaque legacy session');
  await prepare();
  assert.equal(await readFile(env.HSTACK_TEST_SYNC_STATE, 'utf8'), '1', 'remaining legacy sessions must not refuse live dispatch through an already prepared shared replica');
  assert.ok((await stat(commandTarget.repoDir)).mtimeMs > oldUse.getTime(), 'dispatch refreshes mirror last use without another Mutagen scan');
  await rm(commandTarget.repoDir, { recursive: true });
  await mkdir(commandTarget.repoDir); // A prior recovery can stop after mkdir, before reset/flush.
  // Mutagen 0.18.1 halts on root deletion/emptying until its history is reset.
  // This mock is the external Mutagen boundary; directory preparation stays real.
  env.HSTACK_TEST_SYNC_EMPTY_REPLICA = fixture.path('empty-replica-history');
  env.HSTACK_TEST_SYNC_EXPECTED_RESET_NAME = resolveMutagenSessionName(commandTarget.name, sourceDir);
  await writeFile(env.HSTACK_TEST_SYNC_EMPTY_REPLICA, 'previous replica contained source');
  await prepare();
  assert.ok((await stat(commandTarget.repoDir)).isDirectory(), 'a retired mirror can be recreated before the selected flush');
  assert.equal(await readFile(env.HSTACK_TEST_SYNC_STATE, 'utf8'), '2', 'only retired-replica recovery needs a new seed flush');
  await assert.rejects(readFile(env.HSTACK_TEST_SYNC_EMPTY_REPLICA), { code: 'ENOENT' });
  const project = await readFile(resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, env }).projectFile, 'utf8');
  assert.doesNotMatch(project, /portable|pollingInterval/);
  const runtimeConfig = JSON.parse(await readFile(join(stackBaseDir, 'dev-targets.json'), 'utf8'));
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ ...runtimeConfig,
    runtimePlacement: { ...runtimeConfig.runtimePlacement, daemon: { mode: 'prefer-target', target: commandTarget.name } } }));
  await prepare();
  await assert.rejects(readFile(join(commandTarget.repoDir, '.happier/command-replica.json')), { code: 'ENOENT' },
    'an explicitly placed runtime repository must lose disposable command-replica ownership');
});

test('detached sync start recreates requested sessions missing from its canonical project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-service-missing-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectFile = runtimeFor(root).projectFile;
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac',
    repoDir: '/remote/happier',
  };
  await writeFile(join(root, 'dev-targets.json'), JSON.stringify({
    version: 1, targets: [{ ...target, cliHomeDir: '/remote/cli' }],
  }));
  await mkdir(dirname(runtimeFor(root).projectFile), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const mutagenCalls = [];
  const syncListCalls = [];

  const result = await startDevTargetSyncService({
    stackBaseDir: root,
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    detached: true,
    env: envFor(root),
  }, {
    startTargetRuntime: async () => {},
    ensureReplicaRoots: async () => {},
    ensureProject: async (options) => ensureDevTargetSyncProject(options, {
      runProcess: async ({ command, args }) => {
        if (command === 'mutagen') mutagenCalls.push(args.slice(0, 2));
        if (args[0] === 'sync' && args[1] === 'list') {
          syncListCalls.push(args);
          return args[2] === 'happier-mac'
            ? { code: 1, err: 'specification happier-mac did not match any sessions' }
            : { code: 0, out: '[]' };
        }
        return { code: 0 };
      },
    }),
    resumeSync: async () => {},
    inspectSync: async () => ({ state: 'ready', sessionName: 'happier-mac' }),
    writePreparationState: async () => {},
  });

  assert.equal(result.project.projectCreated, true);
  assert.deepEqual(syncListCalls.map((args) => args.slice(0, 3)), [
    ['sync', 'list', '--template'],
  ]);
  assert.deepEqual(mutagenCalls, [
    ['version'],
    ['sync', 'list'],
    ['project', 'resume'],
    ['project', 'terminate'],
    ['project', 'start'],
    ['project', 'list'],
  ]);
});

test('detached sync start resumes the canonical project and reports every session without a resident wrapper or dependency bootstrap', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  const calls = [];
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets,
    detached: true,
    env: envFor(root),
  }, {
    ensureReplicaRoots: async () => {},
    ensureProject: async (options) => {
      calls.push({ kind: 'ensure', options });
      return { ownership: 'owned', env: { MUTAGEN_DATA_DIRECTORY: '/stack/mutagen/data' } };
    },
    inspectSync: async ({ target }) => ({ state: 'ready', sessionName: `happier-${target.name}` }),
    resumeSync: async ({ target }) => { calls.push({ kind: 'resume', target: target.name }); },
    prepareTarget: async ({ target }) => { calls.push({ kind: 'unexpected-prepare', target: target.name }); },
    spawnMonitor: () => {
      throw new Error('detached start must not leave an hstack monitor process behind');
    },
    writePreparationState: async ({ state }) => { calls.push({ kind: 'state', state }); },
  });

  assert.equal(calls[0].options.ownerId, 'dev-target-sync-service');
  assert.equal(calls[0].options.allowIndependentBorrow, false);
  assert.equal(calls[1].kind, 'state');
  assert.equal(calls[1].state.state, 'preparing');
  assert.deepEqual(calls.slice(2, 4), [
    { kind: 'resume', target: 'mac' },
    { kind: 'resume', target: 'mac2' },
  ]);
  assert.equal(calls.some((call) => call.kind === 'unexpected-prepare'), false);
  assert.equal(calls[4].kind, 'state');
  assert.equal(calls[4].state.state, 'ready');
  assert.deepEqual(result.statuses.map((entry) => entry.status.state), ['ready', 'ready']);
  assert.equal(result.monitor, null);
});

test('sync startup makes configured Lima transports ready before Mutagen project startup', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  const calls = [];
  const configuredTargets = [
    { name: 'mac', platform: 'posix' },
    {
      name: 'linux',
      platform: 'posix',
      limaInstance: 'happier-dev-bench',
      limaHome: '/tmp/lima',
    },
  ];

  await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets: configuredTargets,
    detached: true,
    env: envFor(root),
  }, {
    startTargetRuntime: async ({ target }) => {
      calls.push({ kind: 'runtime', target: target.name });
    },
    ensureReplicaRoots: async ({ targets: preparedTargets }) => {
      calls.push({ kind: 'roots', targets: preparedTargets.map((target) => target.name) });
    },
    ensureProject: async () => {
      calls.push({ kind: 'ensure' });
      return { ownership: 'owned', env: envFor(root) };
    },
    resumeSync: async ({ target }) => { calls.push({ kind: 'resume', target: target.name }); },
    inspectSync: async ({ target }) => ({ state: 'ready', sessionName: `happier-${target.name}` }),
    writePreparationState: async () => {},
  });

  assert.deepEqual(calls.slice(0, 5), [
    { kind: 'runtime', target: 'mac' },
    { kind: 'runtime', target: 'linux' },
    { kind: 'roots', targets: ['mac'] },
    { kind: 'roots', targets: ['linux'] },
    { kind: 'ensure' },
  ]);
});

test('sync startup reports a failed WSL target while healthy targets repair and remain monitored', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-sync-partial-start-' });
  const bin = fixture.path('bin');
  const sourceDir = fixture.path('source');
  await mkdir(bin);
  await mkdir(sourceDir);
  const callsPath = fixture.path('calls.jsonl');
  // Replace only external SSH/PowerShell and Mutagen. Runtime preparation,
  // project safety/setup, conflict repair and persisted target statuses stay real.
  await writeFile(fixture.path('boundary.mjs'), [
    'import fs from "node:fs";',
    'const [command, ...args] = process.argv.slice(2);',
    'fs.appendFileSync(process.env.HSTACK_TEST_CALLS, JSON.stringify({command,args}) + "\\n");',
    'if (command === "ssh" && (args.includes("windows-host") || args.includes("windows1-linux"))) {',
    '  console.error("user not found"); process.exit(1);',
    '}',
    'if (command === "mutagen" && args[0] === "sync" && args[1] === "list") {',
    '  const name = args[2];',
    '  if (name === "--template") console.log("[]");',
    '  else console.log(JSON.stringify([{name,paused:false,status:"watching",successfulCycles:1,mode:"one-way-replica",alpha:{connected:true,scanned:true},beta:{connected:true,scanned:true},conflicts:[{root:"apps/ui/stale-repair",alphaChanges:[{path:"apps/ui/stale-repair",old:{kind:"directory"},new:null}],betaChanges:[{path:"apps/ui/stale-repair/node_modules",old:null,new:{kind:"untracked"}}]}]}]));',
    '}',
  ].join('\n'));
  for (const command of ['ssh', 'mutagen']) {
    await writeFile(join(bin, command), `#!/bin/sh\nexec "${process.execPath}" "${fixture.path('boundary.mjs')}" ${command} "$@"\n`);
    await chmod(join(bin, command), 0o700);
  }
  const env = { ...process.env, ...envFor(fixture.root), PATH: `${bin}:${process.env.PATH}`, HSTACK_TEST_CALLS: callsPath };
  const configuredTargets = [
    { name: 'windows1-linux', platform: 'posix', ssh: 'windows1-linux', repoDir: '/replica/broken', cliHomeDir: '/home/worker',
      managedRuntime: { kind: 'wsl', instance: 'worker', user: 'missing', host: { ssh: 'windows-host', sshConfigFile: fixture.path('ssh.config') },
        capacity: { mode: 'dedicated', shared: { cpus: 8, memoryGiB: 8 }, dedicated: { cpus: 12, memoryGiB: 12 } } } },
    { name: 'healthy', platform: 'posix', ssh: 'healthy', repoDir: '/replica/healthy', cliHomeDir: '/home/worker' },
  ];
  const monitors = [];
  const result = await startDevTargetSyncService({
    stackBaseDir: fixture.path('stack'), sourceDir, targets: configuredTargets, env,
  }, {
    // The foreground child is also an external process boundary.
    spawnMonitor: options => { monitors.push(options); return { completion: Promise.resolve({ code: 0 }) }; },
  });
  assert.equal(result.statuses[0].target, 'windows1-linux');
  assert.equal(result.statuses[0].status.state, 'unhealthy');
  assert.match(result.statuses[0].status.error, /user not found/);
  assert.equal(result.statuses[1].target, 'healthy');
  assert.equal(result.statuses[1].status.state, 'synchronizing');
  assert.deepEqual(result.statuses[1].status.repairedRoots, ['apps/ui/stale-repair']);
  const preparation = JSON.parse(await readFile(resolveDevTargetMutagenRuntime({ stackBaseDir: fixture.path('stack'), sourceDir, env }).syncServiceStateFile, 'utf8'));
  assert.equal(preparation.state, 'failed');
  assert.equal(preparation.targets['windows1-linux'].state, 'failed');
  assert.match(preparation.targets['windows1-linux'].error, /user not found/);
  assert.equal(preparation.targets.healthy.state, 'ready');
  const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const healthySession = resolveMutagenSessionName('healthy', sourceDir);
  assert.deepEqual(calls.filter(call => call.command === 'mutagen' && ['reset', 'flush'].includes(call.args[1])).map(call => call.args), [
    ['sync', 'reset', healthySession], ['sync', 'flush', healthySession],
  ]);
  assert.equal(calls.some(call => call.command === 'ssh' && call.args.includes('windows1-linux')), false, 'a failed runtime must not block later project preparation through its guest SSH');
  assert.equal(monitors[0].args.length, 4);
  assert.ok(monitors[0].args[3].includes(`(eq .Name ${JSON.stringify(healthySession)})`));
});

test('sync startup accepts an unpaused reconnecting session when Mutagen resume reports an offline endpoint', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  const states = [];
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets: [{ name: 'mac', platform: 'posix' }],
    detached: true,
    env: envFor(root),
  }, {
    startTargetRuntime: async () => {},
    ensureReplicaRoots: async () => {},
    ensureProject: async () => ({ ownership: 'owned', env: envFor(root) }),
    resumeSync: async () => { throw new Error('endpoint offline'); },
    inspectSync: async () => ({ state: 'synchronizing', sessionName: 'happier-mac' }),
    writePreparationState: async ({ state }) => { states.push(state); },
  });

  assert.equal(states.at(-1).state, 'ready');
  assert.equal(result.statuses[0].status.state, 'synchronizing');
});

test('detached sync start never owns dependency preparation on any sync target', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  const prepared = [];
  const configuredTargets = [
    { name: 'windows', platform: 'windows' },
    { name: 'mac', platform: 'posix' },
  ];
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets: configuredTargets,
    detached: true,
    env: envFor(root),
  }, {
    ensureReplicaRoots: async () => {},
    ensureProject: async () => ({ ownership: 'owned', env: envFor(root) }),
    resumeSync: async () => {},
    prepareTarget: async ({ target }) => { prepared.push(target.name); },
    inspectSync: async ({ target }) => ({ state: 'ready', sessionName: `happier-${target.name}` }),
    writePreparationState: async () => {},
  });

  assert.deepEqual(prepared, []);
  assert.deepEqual(result.statuses.map((entry) => entry.target), ['windows', 'mac']);
});

test('POSIX sync startup does not flush or bootstrap the remote checkout', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  const calls = [];
  const target = {
    name: 'mac',
    platform: 'posix',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets: [target],
    detached: true,
    env: envFor(root),
  }, {
    ensureReplicaRoots: async () => {},
    ensureProject: async () => ({ ownership: 'owned', env: { TEST_ENV: 'project' } }),
    resumeSync: async () => {},
    syncTarget: async (options) => { calls.push({ kind: 'unexpected-sync', options }); },
    runRemoteCommand: async (options) => { calls.push({ kind: 'unexpected-remote', options }); },
    inspectSync: async () => ({ state: 'ready', sessionName: 'happier-mac' }),
    writePreparationState: async () => {},
  });

  assert.deepEqual(calls, []);
});

test('foreground sync start streams the canonical Mutagen monitor until it exits', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  const spawned = [];
  const completion = Promise.resolve({ code: 0, signal: null });
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets,
    detached: false,
    env: envFor(root),
  }, {
    ensureReplicaRoots: async () => {},
    ensureProject: async () => ({ ownership: 'owned', env: { MUTAGEN_DATA_DIRECTORY: '/stack/mutagen/data' } }),
    resumeSync: async () => {},
    prepareTarget: async () => {},
    inspectSync: async ({ target }) => ({ state: 'synchronizing', sessionName: `happier-${target.name}` }),
    spawnMonitor: ({ command, args, env, lineFilter }) => {
      spawned.push({ command, args, env, lineFilter });
      return { completion };
    },
    writePreparationState: async () => {},
  });

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'mutagen');
  assert.deepEqual(spawned[0].args.slice(0, 3), ['sync', 'monitor', '--template']);
  assert.match(spawned[0].args[3], /SuccessfulCycles/);
  assert.match(
    spawned[0].args[3],
    /if (?:and )?\.SessionState/,
    'the monitor must skip transient Mutagen entries whose embedded session state is nil',
  );
  assert.equal(spawned[0].args.length, 4);
  for (const target of targets) {
    const name = resolveMutagenSessionName(target.name, '/repo');
    assert.ok(spawned[0].args[3].includes(`(eq .Name ${JSON.stringify(name)})`));
  }
  assert.deepEqual(spawned[0].env, { MUTAGEN_DATA_DIRECTORY: '/stack/mutagen/data' });
  assert.equal(spawned[0].lineFilter({ stream: 'stdout', line: 'happier-mac|Watching|1||false|0' }), true);
  assert.equal(spawned[0].lineFilter({ stream: 'stdout', line: 'happier-mac|Watching|1||false|0' }), false);
  assert.equal(
    spawned[0].lineFilter({ stream: 'stdout', line: 'happier-mac|Watching|2||false|0' }),
    false,
    'a successful-cycle counter change alone must not redraw or persist another healthy status',
  );
  assert.equal(spawned[0].lineFilter({ stream: 'stdout', line: 'happier-mac|Scanning|2||false|0' }), true);
  assert.equal(await result.monitor.completion, await completion);
});

test('foreground monitor Ctrl-C stops only the monitor process and detaches with shell status 130', async () => {
  const signals = new EventEmitter();
  let resolveCompletion;
  const monitor = {
    completion: new Promise((resolvePromise) => { resolveCompletion = resolvePromise; }),
  };
  const stopped = [];
  const waiting = waitForDevTargetSyncMonitor(monitor, {
    signalSource: signals,
    stopMonitor: async (child, signal) => {
      stopped.push({ child, signal });
      resolveCompletion({ code: null, signal: 'SIGTERM' });
    },
  });

  signals.emit('SIGINT');
  assert.deepEqual(await waiting, { code: 130, signal: 'SIGINT' });
  assert.deepEqual(stopped, [{ child: monitor, signal: 'SIGTERM' }]);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('sync stop delegates lifecycle release to the independent project owner', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  const calls = [];
  const result = await stopDevTargetSyncService({ stackBaseDir: '/stack', env: envFor(root) }, {
    releaseProject: async (options) => {
      calls.push(options);
      return true;
    },
  });
  assert.equal(result.released, true);
  assert.deepEqual(calls, [{ stackBaseDir: '/stack', env: envFor(root) }]);
});

test('sync status reports ownership and every target session without changing lifecycle', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  const result = await inspectDevTargetSyncService({
    stackBaseDir: '/stack',
    targets,
    env: envFor(root),
  }, {
    readProject: async () => '# hstack-owner: "dev-target-sync-service"\n',
    readPreparationState: async () => ({
      version: 1,
      state: 'ready',
      targets: { mac: { state: 'ready' }, mac2: { state: 'ready' } },
    }),
    inspectSync: async ({ target }) => ({ state: 'ready', sessionName: `happier-${target.name}` }),
  });
  assert.equal(result.independent, true);
  assert.equal(result.state, 'ready');
  assert.equal(result.preparation.state, 'ready');
  assert.deepEqual(result.statuses.map((entry) => entry.status.state), ['ready', 'ready']);
});

test('recovered sync status uses current sessions and retains failed startup as history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-recovered-sync-status-'));
  try {
    const binDir = join(root, 'bin');
    await mkdir(binDir);
    // Only the external Mutagen/SSH executables are replaced; project setup,
    // exact-session inspection, recovery and persisted preparation stay real.
    await writeFile(join(binDir, 'mutagen'), [
      '#!/bin/sh',
      'if [ "$1 $2" = "sync list" ]; then',
      '  error=""',
      '  if [ "${HSTACK_TEST_SYNC_UNHEALTHY:-}" = "1" ]; then error="transient beta transition"; fi',
      '  printf \'[{"name":"%s","paused":false,"status":"watching","successfulCycles":2,"lastError":"%s","alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\' "$3" "$error"',
      'fi',
      'exit 0',
      '',
    ].join('\n'));
    await writeFile(join(binDir, 'ssh'), '#!/bin/sh\nexit 0\n');
    await Promise.all(['mutagen', 'ssh'].map((name) => chmod(join(binDir, name), 0o700)));
    const recoveryTargets = targets.map(({ name }) => ({
      name, platform: 'windows', ssh: name, repoDir: 'C:/repo', cliHomeDir: 'C:/home',
    }));
    const env = { ...process.env, ...envFor(root), PATH: `${binDir}:${process.env.PATH}`, HSTACK_TEST_SYNC_UNHEALTHY: '1' };
    await assert.rejects(startDevTargetSyncService({
      stackBaseDir: root, sourceDir: '/repo', targets: recoveryTargets, detached: true, env,
    }), /transient beta transition/);
    env.HSTACK_TEST_SYNC_UNHEALTHY = '0';
    const inspect = () => inspectDevTargetSyncService({
      stackBaseDir: root, sourceDir: '/repo', targets: recoveryTargets, env,
    });
    const healthy = await inspect();
    assert.equal(healthy.state, 'ready');
    assert.equal(healthy.preparation.state, 'failed');
    assert.match(healthy.preparation.targets.mac.error, /transient beta transition/);
    env.HSTACK_TEST_SYNC_UNHEALTHY = '1';
    assert.equal((await inspect()).state, 'failed', 'current failures remain visible after recovery');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detached sync start reports an unavailable target alongside healthy synchronization observations', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  const states = [];
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets,
    detached: true,
    env: envFor(root),
  }, {
    ensureReplicaRoots: async () => {},
    ensureProject: async () => ({ ownership: 'owned', env: envFor(root) }),
    resumeSync: async () => {},
    prepareTarget: async () => { throw new Error('dependency bootstrap must not run'); },
    inspectSync: async ({ target }) => target.name === 'mac'
      ? { state: 'unavailable', error: 'mac session unavailable' }
      : { state: 'ready' },
    writePreparationState: async ({ state }) => { states.push(state); },
  });

  assert.equal(states.at(-1).state, 'failed');
  assert.deepEqual(states.at(-1).targets, {
    mac: { state: 'failed', error: '[dev-targets] mac synchronization is unavailable: mac session unavailable' },
    mac2: { state: 'ready' },
  });
  assert.equal(result.statuses[0].status.state, 'unhealthy');
  assert.match(result.statuses[0].status.error, /mac session unavailable/);
  assert.equal(result.statuses[1].status.state, 'ready');
});

test('sync service repairs a deleted source root blocked only by ignored beta artifacts', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  const repaired = [];
  const conflictStatus = {
    state: 'unhealthy',
    sessionName: 'happier-mac',
    session: {
      mode: 'one-way-replica',
      conflicts: [{
        root: 'packages/plugins/retired-plugin',
        alphaChanges: [{
          path: 'packages/plugins/retired-plugin',
          old: { kind: 'directory' },
          new: null,
        }],
        betaChanges: [
          {
            path: 'packages/plugins/retired-plugin/node_modules',
            old: null,
            new: { kind: 'untracked' },
          },
          {
            path: 'packages/plugins/retired-plugin/dist/runtime.js',
            old: null,
            new: { kind: 'untracked' },
          },
          {
            path: 'packages/plugins/retired-plugin/.happier',
            old: null,
            new: { kind: 'untracked' },
          },
          {
            path: 'packages/plugins/retired-plugin/.tsbuildinfo',
            old: null,
            new: { kind: 'untracked' },
          },
        ],
      }],
    },
  };
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets: [{ name: 'mac', platform: 'posix', repoDir: '/remote/repo' }],
    detached: true,
    env: envFor(root),
  }, {
    ensureReplicaRoots: async () => {},
    ensureProject: async () => ({ ownership: 'owned', env: envFor(root) }),
    resumeSync: async () => {},
    inspectSync: async () => conflictStatus,
    repairSync: async (options) => {
      repaired.push(options);
      return { repaired: true, roots: ['packages/plugins/retired-plugin'] };
    },
    writePreparationState: async () => {},
  });

  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].status, conflictStatus);
  assert.equal(result.statuses[0].status.state, 'synchronizing');
  assert.deepEqual(result.statuses[0].status.repairedRoots, ['packages/plugins/retired-plugin']);
});

test('recoverable conflict repair deletes only the exact managed replica root after source absence is rechecked', async () => {
  const calls = [];
  const target = {
    name: 'mac',
    platform: 'posix',
    repoDir: '/remote/repo',
  };
  const status = {
    session: {
      mode: 'one-way-replica',
      conflicts: [{
        root: 'packages/plugins/retired-plugin',
        alphaChanges: [{
          path: 'packages/plugins/retired-plugin',
          old: { kind: 'directory' },
          new: null,
        }],
        betaChanges: [{
          path: 'packages/plugins/retired-plugin/node_modules',
          old: null,
          new: { kind: 'untracked' },
        }],
      }],
    },
  };
  const result = await repairRecoverableDevTargetSyncConflicts({
    target,
    status,
    sourceDir: '/source/repo',
    stackBaseDir: '/stack',
    env: { TEST_ENV: '1' },
  }, {
    pathExists: (path) => {
      calls.push({ kind: 'exists', path });
      return false;
    },
    runCommand: async (options) => {
      calls.push({ kind: 'run', options });
      return { code: 0 };
    },
    runControl: async (options) => {
      calls.push({ kind: 'control', options });
      return { code: 0 };
    },
  });

  assert.deepEqual(result, {
    repaired: true,
    roots: ['packages/plugins/retired-plugin'],
  });
  assert.deepEqual(calls[0], {
    kind: 'exists',
    path: '/source/repo/packages/plugins/retired-plugin',
  });
  assert.equal(calls[1].options.syncAlreadyVerified, true);
  assert.equal(calls[1].options.dependencyAdmission, 'skip');
  assert.deepEqual(calls[1].options.commandArgs.slice(-9), [
    'hstack-sync-repair',
    '/remote/repo',
    'packages/plugins/retired-plugin',
    'node_modules',
    'dist',
    '.happier',
    '.tsbuildinfo',
    '.turbo',
    '.example-builds',
  ]);
  assert.match(calls[1].options.commandArgs[2], /rm -rf -- "\$candidate"/);
  assert.match(calls[1].options.commandArgs[2], /"\$candidate\/\$marker"/);
  assert.match(calls[1].options.commandArgs[2], /"\$candidate_name" = "\$marker"/);
  assert.deepEqual(calls.slice(2).map((call) => call.options.args.slice(0, 2)), [
    ['sync', 'reset'],
    ['sync', 'flush'],
  ]);
});

test('recoverable conflict repair rescans an already absent replica root and preserves unrelated replacements', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-sync-absent-root-' });
  const repoDir = fixture.path('replica');
  const sourceDir = fixture.path('source');
  const relativeRoot = 'apps/ui/stale-repair';
  const candidate = join(repoDir, relativeRoot);
  await mkdir(dirname(candidate), { recursive: true });
  const controls = [];
  const repair = () => repairRecoverableDevTargetSyncConflicts({
    target: { name: 'worker', platform: 'posix', repoDir },
    status: { session: { mode: 'one-way-replica', conflicts: [{
      root: relativeRoot,
      alphaChanges: [{ path: relativeRoot, old: { kind: 'directory' }, new: null }],
      betaChanges: [{ path: `${relativeRoot}/node_modules`, old: null, new: { kind: 'untracked' } }],
    }] } },
    sourceDir, stackBaseDir: fixture.path('stack'), env: envFor(fixture.root),
  }, {
    // Execute the actual remote repair shell against disposable fixture paths.
    runCommand: async ({ commandArgs }) => {
      const result = spawnSync(commandArgs[0], commandArgs.slice(1), { encoding: 'utf8' });
      assert.ifError(result.error);
      return { code: result.status };
    },
    runControl: async ({ args }) => { controls.push(args.slice(0, 2)); return { code: 0 }; },
  });
  assert.deepEqual(await repair(), { repaired: true, roots: [relativeRoot] });
  assert.deepEqual(controls, [['sync', 'reset'], ['sync', 'flush']]);
  controls.length = 0;
  await writeFile(candidate, 'unrelated replacement');
  await assert.rejects(repair(), /refused stale replica artifact repair/);
  assert.equal(await readFile(candidate, 'utf8'), 'unrelated replacement');
  assert.deepEqual(controls, [], 'refused repair must not reset or flush');
  await rm(candidate);
  await symlink(fixture.path('missing-destination'), candidate);
  await assert.rejects(repair(), /refused stale replica artifact repair/);
  assert.deepEqual(controls, [], 'a dangling symlink is not an absent root');
  await rm(candidate);
  await mkdir(candidate);
  await assert.rejects(repair(), /refused stale replica artifact repair/);
  assert.deepEqual(controls, [], 'an unmarked directory must be preserved');
  await mkdir(join(candidate, 'node_modules'));
  assert.deepEqual(await repair(), { repaired: true, roots: [relativeRoot] });
  await assert.rejects(readFile(candidate), { code: 'ENOENT' });
  assert.deepEqual(controls, [['sync', 'reset'], ['sync', 'flush']]);
});

test('recoverable conflict repair refuses when the alpha source root exists again', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  let ran = false;
  const result = await repairRecoverableDevTargetSyncConflicts({
    target: { name: 'mac', platform: 'posix', repoDir: '/remote/repo' },
    status: {
      session: {
        mode: 'one-way-replica',
        conflicts: [{
          root: 'packages/plugins/retired-plugin',
          alphaChanges: [{
            path: 'packages/plugins/retired-plugin',
            old: { kind: 'directory' },
            new: null,
          }],
          betaChanges: [{
            path: 'packages/plugins/retired-plugin/node_modules',
            old: null,
            new: { kind: 'untracked' },
          }],
        }],
      },
    },
    sourceDir: '/source/repo',
    stackBaseDir: '/stack',
    env: envFor(root),
  }, {
    pathExists: () => true,
    runCommand: async () => { ran = true; return { code: 0 }; },
    runControl: async () => { ran = true; return { code: 0 }; },
  });

  assert.deepEqual(result, { repaired: false, roots: [] });
  assert.equal(ran, false);
});

test('recoverable conflict repair skips a root that reappeared without blocking other safe roots', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-service-' });
  const repairedRoots = [];
  const result = await repairRecoverableDevTargetSyncConflicts({
    target: { name: 'mac', platform: 'posix', repoDir: '/remote/repo' },
    status: {
      session: {
        mode: 'one-way-replica',
        conflicts: [
          {
            root: 'packages/plugins/reappeared-plugin',
            alphaChanges: [{
              path: 'packages/plugins/reappeared-plugin',
              old: { kind: 'directory' },
              new: null,
            }],
            betaChanges: [{
              path: 'packages/plugins/reappeared-plugin/node_modules',
              old: null,
              new: { kind: 'untracked' },
            }],
          },
          {
            root: 'packages/plugins/retired-plugin',
            alphaChanges: [{
              path: 'packages/plugins/retired-plugin',
              old: { kind: 'directory' },
              new: null,
            }],
            betaChanges: [{
              path: 'packages/plugins/retired-plugin/dist',
              old: null,
              new: { kind: 'untracked' },
            }],
          },
        ],
      },
    },
    sourceDir: '/source/repo',
    stackBaseDir: '/stack',
    env: envFor(root),
  }, {
    pathExists: (path) => path.endsWith('/reappeared-plugin'),
    runCommand: async ({ commandArgs }) => {
      repairedRoots.push(commandArgs[5]);
      return { code: 0 };
    },
    runControl: async () => ({ code: 0 }),
  });

  assert.deepEqual(result, {
    repaired: true,
    roots: ['packages/plugins/retired-plugin'],
  });
  assert.deepEqual(repairedRoots, ['packages/plugins/retired-plugin']);
});

test('sibling command sync skips an unreachable worker and prepares the reachable ones', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-command-sync-unreachable-' });
  const bin = fixture.path('bin');
  await mkdir(bin);
  await installCommandReplicaExecutor(fixture, bin);
  // External boundaries only: SSH (one host refuses, as sshd does when it is
  // down or out of disk) and Mutagen. Directory setup and replica safety
  // observations run their real shell commands on this host.
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nfor arg; do [ "$arg" = dead-host ] && exit 255; done\nfor command; do :; done\nexec /bin/sh -c "$command"\n');
  await writeFile(fixture.path('mutagen.mjs'), [
    'import fs from "node:fs";',
    'const [family, action, name] = process.argv.slice(2);',
    'if (family === "sync" && action === "flush") fs.appendFileSync(process.env.HSTACK_TEST_FLUSHED, name + "\\n");',
    'if (family === "sync" && action === "list") console.log("[]");',
  ].join('\n'));
  await writeFile(join(bin, 'mutagen'), `#!/bin/sh\nexec "${process.execPath}" "${fixture.path('mutagen.mjs')}" "$@"\n`);
  await Promise.all(['mutagen', 'ssh'].map(name => chmod(join(bin, name), 0o700)));
  const flushed = fixture.path('flushed');
  const env = { ...process.env, ...envFor(fixture.root), PATH: `${bin}:${process.env.PATH}`, DBUS_SESSION_BUS_ADDRESS: '', HSTACK_TEST_FLUSHED: flushed };
  const target = name => ({ name, platform: 'posix', ssh: `${name}-host`, repoDir: fixture.path(`mirror-${name}`),
    executorRepoDir: fixture.path('primary'), cliHomeDir: fixture.path(`home-${name}`), remotePath: [bin, ...process.env.PATH.split(':')] });
  const [dead, live] = [target('dead'), target('live')];
  const stackBaseDir = fixture.path('command-stack');
  await mkdir(stackBaseDir);
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({
    version: 3, targets: [dead, live],
    runtimePlacement: { server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' } },
    commandExecution: { mode: 'auto', targets: ['dead', 'live'], fallback: 'local' },
  }));
  const sourceDir = fixture.path('basis');
  await mkdir(sourceDir);
  await prepareDevTargetCommandSync({ stackBaseDir, sourceDir, targets: [dead, live], env });
  assert.deepEqual((await readFile(flushed, 'utf8')).trim().split('\n'), [resolveMutagenSessionName('live', sourceDir)]);
  // With no reachable worker there is nothing to prepare: fail closed.
  await assert.rejects(prepareDevTargetCommandSync({ stackBaseDir, sourceDir, targets: [dead], env }), error => {
    assert.equal(error.code, 'DEV_TARGET_REPLICA_BOOTSTRAP_FAILED');
    assert.deepEqual(error.targets, ['dead']);
    assert.ok(error instanceof AggregateError);
    return true;
  });
});

async function reconnectFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-sync-reconnect-' });
  const sourceDir = fixture.path('source');
  const stackBaseDir = fixture.path('stack');
  const bin = fixture.path('bin');
  await Promise.all([mkdir(sourceDir), mkdir(stackBaseDir), mkdir(bin)]);
  await writeFile(join(sourceDir, 'package.json'), '{}');
  const targets = ['offline', 'live', 'cold'].map(name => ({
    name, platform: 'posix', ssh: `${name}-host`, repoDir: fixture.path(`mirror-${name}`),
    cliHomeDir: fixture.path(`home-${name}`), remotePath: [bin, ...process.env.PATH.split(':')],
    executorRepoDir: fileURLToPath(new URL('../../../../../', import.meta.url)),
  }));
  const config = parseDevTargetsConfig({ version: 3, targets,
    commandExecution: { mode: 'auto', targets: targets.map(target => target.name), fallback: 'local' } });
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify(config));
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: fixture.root, PATH: `${bin}:${process.env.PATH}`,
    DBUS_SESSION_BUS_ADDRESS: '', HSTACK_TEST_SESSIONS: fixture.path('sessions.json'),
    HSTACK_TEST_CATALOG: fixture.path('catalog.json'), HSTACK_TEST_CALLS: fixture.path('calls.jsonl') };
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, env });
  env.HSTACK_TEST_PROJECT = runtime.projectFile;
  await mkdir(dirname(runtime.projectFile), { recursive: true });
  const project = renderMutagenProject({ sourceDir, targets: config.targets.slice(0, 2), config,
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER });
  await writeFile(runtime.projectFile, project);
  await writeFile(`${runtime.projectFile}.lock`, 'proj_current');
  await writeFile(runtime.syncServiceStateFile, JSON.stringify({ version: 1, state: 'ready',
    targets: Object.fromEntries(targets.slice(0, 2).map(target => [target.name, { state: 'ready' }])) }));
  for (const target of targets.slice(0, 2)) {
    await mkdir(target.repoDir);
    await writeFile(join(target.repoDir, 'package.json'), '{}');
  }
  const sessions = targets.map(target => ({
    identifier: `sync_${target.name}`, name: resolveMutagenSessionName(target.name, sourceDir),
    labels: { 'io.mutagen.project': 'proj_current' }, mode: 'one-way-replica', paused: false,
    status: target.name === 'live' ? 'watching' : 'connecting-beta', successfulCycles: 1,
    alpha: { protocol: 'local', path: sourceDir, connected: true, scanned: true },
    beta: { protocol: 'ssh', host: target.ssh, path: target.repoDir, connected: target.name === 'live', scanned: true },
  }));
  await writeFile(env.HSTACK_TEST_SESSIONS, JSON.stringify(sessions.slice(0, 2)));
  await writeFile(env.HSTACK_TEST_CATALOG, JSON.stringify(sessions));
  // Only external processes are replaced. Real preparation, admission,
  // membership reconciliation and Mutagen public-model parsing stay composed.
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nfor arg; do case "$arg" in offline-host|cold-host) exit 255;; esac; done\nfor command; do :; done\nexec /bin/sh -c "$command"\n');
  await writeFile(fixture.path('mutagen.mjs'), [
    'import fs from "node:fs";',
    'const args = process.argv.slice(2); const [family, action] = args;',
    'fs.appendFileSync(process.env.HSTACK_TEST_CALLS, JSON.stringify(args) + "\\n");',
    'const state = process.env.HSTACK_TEST_SESSIONS;',
    'let sessions = JSON.parse(fs.readFileSync(state, "utf8"));',
    'if (family === "project" && action === "terminate") sessions = [];',
    'if (family === "project" && action === "start") {',
    '  const project = fs.readFileSync(process.env.HSTACK_TEST_PROJECT, "utf8");',
    '  sessions = JSON.parse(fs.readFileSync(process.env.HSTACK_TEST_CATALOG, "utf8")).filter(s => project.includes("  " + s.name + ":\\n"));',
    '}',
    'fs.writeFileSync(state, JSON.stringify(sessions));',
    'if (family === "sync" && action === "list") {',
    '  const selected = args[2] === "--template" ? sessions : sessions.filter(s => s.name === args[2]);',
    '  if (args[args.indexOf("--template") + 1] === "{{json .}}") console.log(JSON.stringify(selected));',
    '  else for (const s of selected) console.log(`${s.name}|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|1|ok|0|0`);',
    '}',
  ].join('\n'));
  await writeFile(join(bin, 'mutagen'), `#!/bin/sh\nexec '${process.execPath}' '${fixture.path('mutagen.mjs')}' "$@"\n`);
  await Promise.all(['ssh', 'mutagen'].map(name => chmod(join(bin, name), 0o700)));
  return { stackBaseDir, sourceDir, targets: config.targets, env, runtime, project };
}

for (const entry of ['service start', 'command preparation']) {
  test(`${entry} keeps admitted disconnected sessions and excludes an unprepared new target`, { skip: process.platform === 'win32' }, async t => {
    const input = await reconnectFixture(t);
    if (entry === 'service start') {
      const result = await startDevTargetSyncService({ ...input, detached: true });
      assert.equal(result.statuses.find(status => status.target === 'offline').status.state, 'unhealthy');
    } else {
      const result = await prepareDevTargetCommandSync(input);
      assert.deepEqual(result.excludedTargets, ['offline', 'cold']);
    }
    assert.equal(await readFile(input.runtime.projectFile, 'utf8'), input.project,
      'an SSH preparation failure must not withdraw an unchanged admitted mirror');
    const sessions = JSON.parse(await readFile(input.env.HSTACK_TEST_SESSIONS, 'utf8'));
    assert.deepEqual(sessions.map(session => session.identifier), ['sync_offline', 'sync_live']);
    const calls = (await readFile(input.env.HSTACK_TEST_CALLS, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(args => args[1] === 'terminate' || args[1] === 'start').length, 0,
      'unchanged admitted endpoints must reconnect without project replacement');
  });
}
