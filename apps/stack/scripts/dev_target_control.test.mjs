import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseMutagenSyncList } from './utils/dev_targets/mutagen_runtime.mjs';
import { renderMutagenProject } from './utils/dev_targets/mutagen_project.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const controlExecutable = resolve(testDir, '..', 'bin', 'hstack-dev-target-control');

async function removeFixture(root) {
  await rm(root, { recursive: true, force: true });
  if (process.platform !== 'win32') {
    await rm(`/tmp/happier-sync-control-${process.getuid()}${root}`, { recursive: true, force: true });
  }
}

test('sync control uses shared host state when daemon storage is not writable and TMPDIR differs', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-control-sandbox-'));
  t.after(() => removeFixture(root));
  const session = root.split('/').at(-1);
  const daemonDir = `/proc/${session}`;
  const stateDir = `/tmp/happier-sync-control-${process.getuid()}${daemonDir}/hstack-control`;
  t.after(() => rm(`/tmp/happier-sync-control-${process.getuid()}${daemonDir}`, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  await mkdir(binDir);
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nif [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"; fi\n');
  const args = ['--sync-flush', session, '--', 'mutagen', 'sync', 'flush', session];
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
    MUTAGEN_DATA_DIRECTORY: `${daemonDir}/data`, DBUS_SESSION_BUS_ADDRESS: '' };
  for (const TMPDIR of [root, '/tmp']) {
    const result = spawnSync(controlExecutable, args, { env: { ...env, TMPDIR }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(await readFile(join(stateDir, `${session}.flight`), 'utf8'), '2 2\n',
    'both callers must advance the same flight record independently of TMPDIR');
  const otherDaemonDir = `${daemonDir}-other`;
  const otherStateDir = `/tmp/happier-sync-control-${process.getuid()}${otherDaemonDir}`;
  t.after(() => rm(otherStateDir, { recursive: true, force: true }));
  const otherDaemon = spawnSync(controlExecutable, args, {
    env: { ...env, MUTAGEN_DATA_DIRECTORY: `${otherDaemonDir}/data` }, encoding: 'utf8',
  });
  assert.equal(otherDaemon.status, 0, otherDaemon.stderr);
  assert.equal(await readFile(join(otherStateDir, 'hstack-control', `${session}.flight`), 'utf8'), '1 1\n',
    'identically named sessions in separate daemons must not share a flight');
});

async function executable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

test('sync control resolves relative daemon storage before selecting its shared namespace', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-control-relative-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  const dataDir = join(root, 'mutagen', 'data');
  const session = root.split('/').at(-1);
  await mkdir(binDir);
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nif [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"; fi\n');
  for (const configured of [dataDir, relative(binDir, dataDir)]) {
    const result = spawnSync(controlExecutable, ['--sync-flush', session, '--', 'mutagen', 'sync', 'flush', session], {
      cwd: binDir, encoding: 'utf8', env: { ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`, MUTAGEN_DATA_DIRECTORY: configured,
        DBUS_SESSION_BUS_ADDRESS: '',
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const stateDir = `/tmp/happier-sync-control-${process.getuid()}${root}/mutagen/hstack-control`;
  assert.equal(await readFile(join(stateDir, `${session}.flight`), 'utf8'), '2 2\n',
    'relative and absolute spellings of one daemon must advance the same causal record');
});

async function waitForFile(path) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForExit(child) {
  return await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

test('dispatch recovery rescans transient scan problems and rejects persistent or unsafe problems', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-rescan-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  const flushed = join(root, 'flushed');
  await mkdir(binDir);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    `marker=${JSON.stringify(flushed)}`,
    'case "$2" in',
    '  flush) printf cycle >> "$marker"; exit 0 ;;',
    '  list)',
    '    prefix=; case "$5" in *".Path"*) prefix="source|" ;; esac',
    '    scan=1/0; transition=0/0; conflicts=0; scanned=0; cycles=0',
    '    if [ -e "$marker" ] && [ "$PROBLEM_MODE" = transient ]; then scan=0/0; fi',
    '    if [ "$PROBLEM_MODE" = postflush ] && [ ! -e "$marker" ]; then scan=0/0; fi',
    '    if [ "$PROBLEM_MODE" = postflush ] && [ "$(cat "$marker" 2>/dev/null)" = cyclecycle ]; then scan=0/0; fi',
    '    if [ "$PROBLEM_MODE" = excluded ]; then scan=1/1; fi',
    '    if [ -e "$marker" ]; then scanned=1; cycles=2; fi',
    '    if [ "$PROBLEM_MODE" = transition ] || [ "$PROBLEM_MODE" = mixed ]; then transition=1/0; fi',
    '    if [ "$PROBLEM_MODE" = conflict ]; then conflicts=1; fi',
    '    printf "%s|Watching|false|true|%s|%s|%s|true|%s|0/0|0/0|active|%s|ok|%s|0\\n" "$3" "$scanned" "$scan" "$transition" "$scanned" "$cycles" "$conflicts"',
    '    if [ "$PROBLEM_MODE" = transition ]; then printf "%sapply failed\\n" "$prefix"; fi',
    '    if [ "$PROBLEM_MODE" = mixed ]; then printf "%sunable to validate existing file: modification detected\\n" "$prefix"; fi',
    // The Mutagen boundary only emits scan errors if production requests them.
    '    case "$5" in *"{{range .Alpha.ScanProblems}}"*) [ "$scan" = 0/0 ] || printf "%s%s\\n" "$prefix" "$SCAN_ERROR" ;; esac ;;',
    'esac',
  ].join('\n'));
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
    MUTAGEN_DATA_DIRECTORY: join(root, 'mutagen', 'data'), DBUS_SESSION_BUS_ADDRESS: '' };
  const recover = (mode, error = 'hashed size mismatch: 847308 != 28672', flush = false) => spawnSync(controlExecutable, flush
    ? ['--sync-flush', 'happier-linux', '--', 'mutagen', 'sync', 'flush', 'happier-linux']
    : ['--sync-check', 'happier-linux'], {
    env: { ...env, PROBLEM_MODE: mode, SCAN_ERROR: error }, encoding: 'utf8',
  });
  for (const mode of ['transition', 'conflict']) {
    assert.notEqual(recover(mode).status, 0);
    await assert.rejects(readFile(flushed), { code: 'ENOENT' });
  }
  for (const [mode, error] of [
    ['transient', 'unable to open file: permission denied'],
    ['mixed', 'unable to open file: permission denied'],
    ['excluded', 'hashed size mismatch: 1 != 2'],
    ['transient', 'hashed size mismatch: 1 != 2\npermission denied'],
  ]) {
    assert.notEqual(recover(mode, error).status, 0);
    await assert.rejects(readFile(flushed), { code: 'ENOENT' });
  }
  const transient = recover('transient');
  assert.equal(transient.status, 0, transient.stderr);
  await assert.rejects(readFile(flushed), { code: 'ENOENT' });
  const recovered = recover('transient', undefined, true);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(await readFile(flushed, 'utf8'), 'cycle');
  await rm(flushed);
  assert.equal(recover('persistent').status, 0, 'candidate inspection admits classified rescan without performing it');
  const persistent = recover('persistent', undefined, true);
  assert.equal(persistent.status, 1, persistent.stderr);
  assert.equal(await readFile(flushed, 'utf8'), 'cyclecycle', 'a persistent scan problem settles after one rescan');
  await rm(flushed);
  const postflush = spawnSync(controlExecutable, ['--sync-flush', 'happier-linux', '--', 'mutagen', 'sync', 'flush', 'happier-linux'], {
    env: { ...env, PROBLEM_MODE: 'postflush', SCAN_ERROR: 'hashed size mismatch: 1 != 2' }, encoding: 'utf8',
  });
  assert.equal(postflush.status, 0, postflush.stderr);
  assert.equal(await readFile(flushed, 'utf8'), 'cyclecycle', 'a scan race during the causal flush gets the existing fresh retry');
});

test('the causal barrier retries known transient transition problems once and requires clean final evidence', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-transition-recovery-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  const marker = join(root, 'flushes');
  await mkdir(binDir);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    '  flush) printf cycle >> "$FLUSH_MARKER"; exit 0 ;;',
    '  list)',
    '    prefix=; case "$5" in *".Path"*) prefix=".project/plans/audit/lanes/captures/matrix.json|" ;; esac',
    '    transition=1/0',
    '    if [ "$PROBLEM_MODE" = clears ] && [ -e "$FLUSH_MARKER" ]; then transition=0/0; fi',
    '    if [ "$PROBLEM_MODE" = postflush ] && [ ! -e "$FLUSH_MARKER" ]; then transition=0/0; fi',
    '    if [ "$PROBLEM_MODE" = postflush ] && [ "$(cat "$FLUSH_MARKER" 2>/dev/null)" = cyclecycle ]; then transition=0/0; fi',
    '    if [ "$PROBLEM_MODE" = excluded ]; then transition=1/1; fi',
    '    printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|%s|active|2|ok|0|0\\n" "$3" "$transition"',
    '    [ "$transition" = 0/0 ] || printf "%s%s\\n" "$prefix" "$TRANSITION_ERROR" ;;',
    'esac',
  ].join('\n'));
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
    MUTAGEN_DATA_DIRECTORY: join(root, 'mutagen', 'data'), DBUS_SESSION_BUS_ADDRESS: '', FLUSH_MARKER: marker };
  const run = (mode, error, flush = false) => spawnSync(controlExecutable, flush
    ? ['--sync-flush', 'happier-linux', '--', 'mutagen', 'sync', 'flush', 'happier-linux']
    : ['--sync-check', 'happier-linux'], { env: { ...env, PROBLEM_MODE: mode, TRANSITION_ERROR: error }, encoding: 'utf8' });
  const errors = ['unable to validate existing file: modification detected',
    'unable to walk to parent path: leaf name does not exist or has incorrect casing',
    'unable to set staged file permissions: chmod /tmp/staged: no such file or directory',
    'unable to relocate staged file: file exists'];
  const inspect = (error, excludedTransitionProblems = 0) => parseMutagenSyncList(JSON.stringify([{
    name: 'happier-linux', paused: false, status: 'watching', successfulCycles: 2,
    alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true,
      transitionProblems: [{ path: 'source', error }], excludedTransitionProblems },
  }]), 'happier-linux');
  const postflush = run('postflush', errors[2], true);
  assert.equal(postflush.status, 0, postflush.stderr);
  assert.equal(await readFile(marker, 'utf8'), 'cyclecycle', 'a race during the admitted flush gets one fresh cycle');
  await rm(marker);
  for (const error of errors) {
    assert.equal(inspect(error).recovery, 'rescan', 'JSON and native consumers must share the same recovery policy');
    const recovered = run('clears', error);
    assert.equal(recovered.status, 0, recovered.stderr);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    const flushed = run('clears', error, true);
    assert.equal(flushed.status, 0, flushed.stderr);
    assert.equal(await readFile(marker, 'utf8'), 'cycle');
    await rm(marker);
  }
  assert.equal(run('persistent', errors[0]).status, 0);
  assert.notEqual(run('persistent', errors[0], true).status, 0);
  assert.equal(await readFile(marker, 'utf8'), 'cyclecycle', 'persistent problems cannot cause an unbounded retry');
  await rm(marker);
  for (const [mode, error] of [['persistent', 'unable to set staged file permissions: permission denied'], ['excluded', errors[0]], ['persistent', `${errors[0]}\npermission denied`]]) {
    assert.equal(inspect(error, mode === 'excluded' ? 1 : 0).recovery, undefined);
    assert.notEqual(run(mode, error).status, 0);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
});

test('project log churn does not wedge the flush while persistent source transitions still block it', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-log-churn-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  await mkdir(binDir);
  const rendered = renderMutagenProject({ sourceDir: root, targets: [] });
  const ignores = rendered.split('\n').filter(line => line.startsWith('        - '))
    .map(line => JSON.parse(line.slice(10)));
  const git = spawnSync('git', ['init', '--quiet', root]);
  assert.equal(git.status, 0);
  await writeFile(join(root, '.gitignore'), `${ignores.join('\n')}\n`);
  await writeFile(join(root, 'empty-excludes'), '');
  // Mutagen is the external boundary. Reproduce its observed missing-stage
  // result for each included file changed during the flush, using the real
  // generated ignore policy and Git's matcher rather than a second parser.
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'cd "$CHURN_ROOT" || exit 1',
    'case "$2" in',
    '  flush) printf "appended during flush\\n" >> "$CHURN_PATH"; exit 0 ;;',
    '  list)',
    '    transition=1/0',
    '    git -c "core.excludesFile=$CHURN_ROOT/empty-excludes" check-ignore --no-index --quiet -- "$CHURN_PATH" && transition=0/0',
    '    printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|%s|active|2|ok|0|0\\n" "$3" "$transition"',
    '    [ "$transition" = 0/0 ] || printf "%s|unable to swap file: unable to set staged file permissions: chmod /tmp/staged: no such file or directory\\n" "$CHURN_PATH" ;;',
    'esac',
  ].join('\n'));
  const flush = async path => {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), 'initial\n');
    const result = spawnSync(controlExecutable,
      ['--sync-flush', 'happier-churn', '--', 'mutagen', 'sync', 'flush', 'happier-churn'], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
          MUTAGEN_DATA_DIRECTORY: join(root, 'mutagen', 'data'), DBUS_SESSION_BUS_ADDRESS: '',
          CHURN_ROOT: root, CHURN_PATH: path }, encoding: 'utf8',
      });
    assert.match(await readFile(join(root, path), 'utf8'), /appended during flush/);
    return result;
  };
  const timeline = '.project/plans/2026-10-02-changes-walkthrough/lanes/wt-verify/logs/N5-timeline.txt';
  const accepted = await flush(timeline);
  assert.equal(accepted.status, 0, accepted.stderr);
  for (const path of ['apps/stack/source.mjs', '.project/plans/audit/briefs/worker-input.json']) {
    const rejected = await flush(path);
    assert.notEqual(rejected.status, 0, path);
    assert.ok(rejected.stderr.includes(path), rejected.stderr);
  }
});

test('native barrier blocks and names project data, stale mirror links and symlinked parents', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-evidence-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  await mkdir(binDir);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    '[ "$2" != list ] && exit 0',
    'scan=0; transition=1',
    '[ "$PROBLEM_KIND" != scan ] || { scan=1; transition=0; }',
    'printf "%s|Watching|false|true|1|%s/0|0/0|true|1|%s/0|%s/%s|active|%s|ok|%s|0||\\n" "$3" "$SCAN_COUNT" "$scan" "$transition" "$EXCLUDED" "$CYCLES" "$CONFLICTS"',
    'case "$5" in *".Path"*) printf "%s|%s\\n" "$PROBLEM_PATH" "$PROBLEM_ERROR" ;; *) printf "%s\\n" "$PROBLEM_ERROR" ;; esac',
    '[ "$SCAN_COUNT" = 0 ] || printf "source.ts|unreadable\\n"',
  ].join('\n'));
  const capture = '.project/plans/qa/x.json';
  await mkdir(join(root, dirname(capture)), { recursive: true });
  await writeFile(join(root, capture), '{"revision":1}');
  await writeFile(join(root, capture), '{"revision":2}');
  await writeFile(join(root, '.project/command.mjs'), 'console.log("command")');
  await symlink('command.mjs', join(root, '.project/link.json'));
  await mkdir(join(root, '.project/directory.json'));
  await writeFile(join(root, '.project/directory.json/index.js'), 'console.log("command")');
  await writeFile(join(root, '.project/capture.json'), '{}');
  await mkdir(join(root, 'mirror/.project'), { recursive: true });
  await writeFile(join(root, 'mirror/.project/command.mjs'), 'console.log("stale command")');
  await symlink('command.mjs', join(root, 'mirror/.project/capture.json'));
  await mkdir(join(root, 'commands'));
  await writeFile(join(root, 'commands/direct.json'), 'console.log("command through parent")');
  await symlink('../commands', join(root, '.project/parent'));
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
    MUTAGEN_DATA_DIRECTORY: join(root, 'mutagen', 'data'), DBUS_SESSION_BUS_ADDRESS: '',
    SCAN_COUNT: '0', EXCLUDED: '0', CYCLES: '7', CONFLICTS: '0', PROBLEM_PATH: capture,
    PROBLEM_ERROR: 'apply failed' };
  const run = extra => spawnSync(controlExecutable, ['--sync-flush', 'happier-linux', '--', 'mutagen', 'sync', 'flush', 'happier-linux'], {
    env: { ...env, ...extra }, encoding: 'utf8',
  });
  for (const PROBLEM_KIND of ['scan', 'transition']) {
    for (const PROBLEM_ERROR of ['apply failed', PROBLEM_KIND === 'scan'
      ? 'hashed size mismatch: 847308 != 28672' : 'unable to validate existing file: modification detected']) {
      for (const PROBLEM_PATH of [capture, '.project/link.json', '.project/capture.json',
        '.project/parent/direct.json', '.project/directory.json', '.project/missing.json']) {
        const blocked = run({ PROBLEM_KIND, PROBLEM_PATH, PROBLEM_ERROR });
        assert.notEqual(blocked.status, 0, `${PROBLEM_KIND}: ${PROBLEM_PATH}`);
        assert.ok(blocked.stderr.includes(PROBLEM_PATH), blocked.stderr);
      }
    }
  }
  for (const extra of [{ PROBLEM_PATH: '.project/helper.mjs' }, { PROBLEM_PATH: 'source.json' },
    { SCAN_COUNT: '1' }, { EXCLUDED: '1' }, { CYCLES: '0' }, { CONFLICTS: '1' },
    { PROBLEM_PATH: '' }, { PROBLEM_PATH: '.project/../source.json' }]) {
    assert.notEqual(run(extra).status, 0, JSON.stringify(extra));
  }
});

test('no-watch first dispatch is eligible but its barrier still requires a completed clean cycle', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-no-watch-dispatch-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  const marker = join(root, 'flushed');
  await mkdir(binDir);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    '  flush) [ "$FLUSH_MODE" != failure ] || exit 7; : > "$FLUSH_MARKER" ;;',
    '  list)',
    '    scanned=0; cycles=0',
    '    if [ -e "$FLUSH_MARKER" ] && [ "$FLUSH_MODE" != incomplete ]; then scanned=1; cycles=1; fi',
    '    printf "%s|Watching|false|true|%s|0/0|0/0|true|%s|0/0|0/0|active|%s|ok|0|0|WatchModeNoWatch|WatchModeNoWatch\\n" "$3" "$scanned" "$scanned" "$cycles" ;;',
    'esac',
  ].join('\n'));
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
    MUTAGEN_DATA_DIRECTORY: join(root, 'mutagen', 'data'), DBUS_SESSION_BUS_ADDRESS: '', FLUSH_MARKER: marker };
  const check = spawnSync(controlExecutable, ['--sync-check', 'happier-linux'], { env, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const flushArgs = ['--sync-flush', 'happier-linux', '--', 'mutagen', 'sync', 'flush', 'happier-linux'];
  for (const mode of ['failure', 'incomplete']) {
    const result = spawnSync(controlExecutable, flushArgs, { env: { ...env, FLUSH_MODE: mode }, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `unsafe ${mode} flush must not admit a payload`);
  }
  const success = spawnSync(controlExecutable, flushArgs, { env, encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
});

test('queued demands share a later-started flush while a demand during that flush requires another cycle', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-control-causal-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  const dataDir = join(root, 'mutagen', 'data');
  const invocationLog = join(root, 'mutagen-invocations');
  const sourceFile = join(root, 'source.txt');
  const started = join(root, 'flush-started');
  const release = join(root, 'flush-release');
  const secondStarted = join(root, 'second-flush-started');
  const secondRelease = join(root, 'second-flush-release');
  await mkdir(binDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(sourceFile, 'X\n');

  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = "list" ]; then',
    '  printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"',
    '  exit 0',
    'fi',
    `cat -- ${JSON.stringify(sourceFile)} >> ${JSON.stringify(invocationLog)}`,
    `case "$(cat ${JSON.stringify(sourceFile)})" in`,
    `  X) : > ${JSON.stringify(started)}; while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.02; done ;;`,
    `  Y) : > ${JSON.stringify(secondStarted)}; while [ ! -e ${JSON.stringify(secondRelease)} ]; do sleep 0.02; done ;;`,
    'esac',
    '',
  ].join('\n'));

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    MUTAGEN_DATA_DIRECTORY: dataDir,
    DBUS_SESSION_BUS_ADDRESS: '',
  };
  const args = ['--sync-flush', 'happier-linux', '--', 'mutagen', 'sync', 'flush', 'happier-linux'];
  const first = spawn(controlExecutable, args, { env, stdio: 'ignore' });
  const firstResult = waitForExit(first);
  await waitForFile(started);
  await writeFile(sourceFile, 'Y\n');
  const second = spawn(controlExecutable, args, { env, stdio: 'ignore' });
  const third = spawn(controlExecutable, args, { env, stdio: 'ignore' });
  const secondResult = waitForExit(second);
  const thirdResult = waitForExit(third);
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  await writeFile(release, '');
  await waitForFile(secondStarted);
  await writeFile(sourceFile, 'Z\n');
  const fourth = spawn(controlExecutable, args, { env, stdio: 'ignore' });
  const fourthResult = waitForExit(fourth);
  await writeFile(secondRelease, '');
  assert.deepEqual(await Promise.all([firstResult, secondResult, thirdResult, fourthResult]), [
    { code: 0, signal: null },
    { code: 0, signal: null },
    { code: 0, signal: null },
    { code: 0, signal: null },
  ]);
  const invocations = (await readFile(invocationLog, 'utf8')).trim().split('\n');
  assert.equal(invocations.length, 3, 'queued demands share Y; the demand during Y requires another flush');
  assert.equal(invocations[0].trim(), 'X');
  assert.equal(invocations[1].trim(), 'Y', 'second flush must observe bytes written while it waited');
  assert.equal(invocations[2].trim(), 'Z', 'a demand during the shared flush must observe its own newer write');
});

test('failed and canceled flushes cannot satisfy queued demand, and later requests cannot reuse prior success', {
  skip: process.platform !== 'linux',
}, async (t) => {
  for (const mode of ['failure', 'cancellation']) {
    await t.test(mode, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-control-recovery-'));
      const binDir = join(root, 'bin');
      const dataDir = join(root, 'mutagen', 'data');
      const source = join(root, 'source');
      const log = join(root, 'flushes');
      const started = join(root, 'started');
      const release = join(root, 'release');
      const children = [];
      t.after(async () => {
        await writeFile(release, '');
        for (const child of children) {
          if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
        }
        await removeFixture(root);
      });
      await mkdir(binDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeFile(source, 'X\n');
      await executable(join(binDir, 'mutagen'), [
        '#!/bin/sh',
        'if [ "$2" = list ]; then',
        '  printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"',
        '  exit 0',
        'fi',
        `content=$(cat ${JSON.stringify(source)})`,
        `printf '%s\\n' "$content" >> ${JSON.stringify(log)}`,
        'if [ "$content" = X ]; then',
        '  trap "exit 74" TERM',
        `  : > ${JSON.stringify(started)}`,
        `  while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.02; done`,
        '  exit 73',
        'fi',
      ].join('\n'));
      const env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        MUTAGEN_DATA_DIRECTORY: dataDir,
        DBUS_SESSION_BUS_ADDRESS: '',
      };
      const launch = () => {
        const child = spawn(controlExecutable, ['--sync-flush', 'happier-linux', '--', 'mutagen', 'sync', 'flush', 'happier-linux'], {
          env, stdio: 'ignore',
        });
        children.push(child);
        return { child, result: waitForExit(child) };
      };
      const first = launch();
      await waitForFile(started);
      await writeFile(source, 'Y\n');
      const queued = launch();
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      if (mode === 'cancellation') first.child.kill('SIGTERM');
      else await writeFile(release, '');
      assert.equal((await first.result).code, mode === 'cancellation' ? 130 : 73);
      assert.deepEqual(await queued.result, { code: 0, signal: null });
      await writeFile(source, 'Z\n');
      assert.deepEqual(await launch().result, { code: 0, signal: null });
      assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['X', 'Y', 'Z']);
    });
  }
});

test('a waiter joining a successful flush still rejects fresh session problems', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-control-join-health-'));
  const binDir = join(root, 'bin');
  const session = root.split('/').at(-1);
  const stateDir = `/tmp/happier-sync-control-${process.getuid()}${root}/mutagen/hstack-control`;
  const lockStarted = join(root, 'lock-started');
  const lockRelease = join(root, 'lock-release');
  const flushLog = join(root, 'flushes');
  const checks = join(root, 'checks');
  const children = [];
  t.after(async () => {
    await writeFile(lockRelease, '');
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    }
    await removeFixture(root);
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const lockHolder = spawn('/usr/bin/flock', [
    join(stateDir, `${session}.lock`), 'sh', '-c',
    `: > ${JSON.stringify(lockStarted)}; while [ ! -e ${JSON.stringify(lockRelease)} ]; do sleep 0.02; done`,
  ], { stdio: 'ignore' });
  children.push(lockHolder);
  const lockResult = waitForExit(lockHolder);
  await waitForFile(lockStarted);
  // Observe the genuine OS admission boundary after each caller captured demand.
  await executable(join(binDir, 'flock'), `#!/bin/sh\n: > ${JSON.stringify(root)}/ready.$PPID\nexec /usr/bin/flock "$@"\n`);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = flush ]; then',
    `  printf 'flush\\n' >> ${JSON.stringify(flushLog)}`,
    '  exit 0',
    'fi',
    `count=$(cat ${JSON.stringify(checks)} 2>/dev/null || printf 0)`,
    'count=$((count + 1))',
    `printf '%s\\n' "$count" > ${JSON.stringify(checks)}`,
    'problems=0/0; [ "$count" != 2 ] || problems=1/0',
    'printf "%s|Watching|false|true|1|0/0|%s|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3" "$problems"',
    '[ "$problems" = 0/0 ] || printf "source|apply failed\\n"',
  ].join('\n'));
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    MUTAGEN_DATA_DIRECTORY: join(root, 'mutagen', 'data'),
    DBUS_SESSION_BUS_ADDRESS: '',
  };
  const launch = () => {
    const child = spawn(controlExecutable, ['--sync-flush', session, '--', 'mutagen', 'sync', 'flush', session], {
      env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return { child, result: waitForExit(child).then((result) => ({ ...result, stderr })) };
  };
  const first = launch();
  const second = launch();
  await Promise.all([waitForFile(join(root, `ready.${first.child.pid}`)), waitForFile(join(root, `ready.${second.child.pid}`))]);
  await writeFile(lockRelease, '');
  await lockResult;
  const results = await Promise.all([first.result, second.result]);
  assert.deepEqual(results.map(({ code }) => code).sort(), [0, 1]);
  assert.match(results.find(({ code }) => code === 1).stderr, /transition problems/u);
  assert.equal(await readFile(flushLog, 'utf8'), 'flush\n', 'both pre-start demands share one cycle');
  assert.equal((await launch().result).code, 0, 'a new request must recover with another flush');
  assert.equal(await readFile(flushLog, 'utf8'), 'flush\nflush\n');
});

test('paused sync sessions report their project without inspecting absent endpoint state or flushing', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-paused-project-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  const calls = join(root, 'calls');
  await mkdir(binDir);
  // Mutagen 0.18.1 has nil embedded EndpointState on paused sessions.
  // Its template evaluation fails if the active branch is entered; the real
  // paused session replay is also checked at the lane's loaded-runtime gate.
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'printf "%s\\n" "$2" >> "$PAUSED_CALLS"',
    'case "$5" in',
    '  \'{{range .}}{{if .Paused}}\'*)',
    '    printf "%s|Disconnected|true|false|X|X|X|false|X|X|X|paused|0|ok|0|0|||basis-project\\n" "$3" ;;',
    '  *) printf "%s\\n" "reflect: indirection through nil pointer to embedded struct field EndpointState" >&2; exit 1 ;;',
    'esac',
  ].join('\n'));
  const result = spawnSync(controlExecutable, ['--sync-check', 'happier-basis-linux'], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
      MUTAGEN_DATA_DIRECTORY: join(root, 'mutagen', 'data'), PAUSED_CALLS: calls }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sync session paused \(basis-project\)/);
  assert.doesNotMatch(result.stderr, /status inspection failed/);
  assert.equal(await readFile(calls, 'utf8'), 'list\n', 'paused sessions must not trigger recovery or flush');
});

test('sync inspection does not reinterpret partial template output as session health', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-control-template-failure-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  const dataDir = join(root, 'mutagen', 'data');
  await mkdir(binDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    "printf '%s' 'happier-linux|Watching|false'",
    "printf '%s\n' 'template evaluation failed' >&2",
    'exit 1',
    '',
  ].join('\n'));

  const result = spawnSync(controlExecutable, ['--sync-check', 'happier-linux'], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      MUTAGEN_DATA_DIRECTORY: dataDir,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /status inspection failed/i);
  assert.doesNotMatch(result.stderr, /missing.*session/i);
});

test('native sync admission rejects every problem-bearing public-model fact and permits clean post-cycle movement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-control-admission-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  const dataDir = join(root, 'mutagen', 'data');
  await mkdir(binDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_MUTAGEN_STATUS"\n');

  const check = (statusLine) => spawnSync(controlExecutable, ['--sync-check', 'happier-linux'], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      MUTAGEN_DATA_DIRECTORY: dataDir,
      FAKE_MUTAGEN_STATUS: statusLine,
    },
    encoding: 'utf8',
  });

  const rejected = [
    ['happier-linux|Disconnected|true|false|X|X|X|false|X|X|X|paused|0|ok|0|0', /paused/u],
    ['happier-linux|Disconnected|false|false|X|X|X|false|X|X|X|active|2|ok|0|0', /status is not clean/u],
    ['happier-linux|Watching|false|true|0|0\/0|0\/0|true|1|0\/0|0\/0|active|2|ok|0|0', /synchronizing/u],
    ['happier-linux|Watching|false|true|1|1\/0|0\/0|true|1|0\/0|0\/0|active|2|ok|0|0', /scan problems/u],
    ['happier-linux|Watching|false|true|1|0\/2|0\/0|true|1|0\/0|0\/0|active|2|ok|0|0', /scan problems/u],
    ['happier-linux|Watching|false|true|1|0\/0|1\/0|true|1|0\/0|0\/0|active|2|ok|0|0', /transition problems/u],
    ['happier-linux|Watching|false|true|1|0\/0|0\/3|true|1|0\/0|0\/0|active|2|ok|0|0', /transition problems/u],
    ['happier-linux|Watching|false|true|1|0\/0|0\/0|true|1|1\/0|0\/0|active|2|ok|0|0', /scan problems/u],
    ['happier-linux|Watching|false|true|1|0\/0|0\/0|true|1|0\/0|0\/4|active|2|ok|0|0', /transition problems/u],
    ['happier-linux|Watching|false|true|1|0\/0|0\/0|true|1|0\/0|0\/0|active|2|error|0|0', /recorded error/u],
    ['happier-linux|Watching|false|true|1|0\/0|0\/0|true|1|0\/0|0\/0|active|2|ok|1|0', /unresolved conflicts/u],
    ['happier-linux|Watching|false|true|1|0\/0|0\/0|true|1|0\/0|0\/0|active|2|ok|0|2', /unresolved conflicts/u],
  ];
  for (const [statusLine, expectedError] of rejected) {
    const result = check(statusLine);
    assert.equal(result.status, 1, statusLine);
    assert.match(result.stderr, expectedError);
  }

  const moving = check('happier-linux|Scanning|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0');
  assert.equal(moving.status, 0, moving.stderr);
});

test('the no-flock platform path still performs a fresh post-flush health check', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-control-no-flock-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  const dataDir = join(root, 'mutagen', 'data');
  const flushMarker = join(root, 'flush-ran');
  await mkdir(binDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  for (const command of ['mkdir', 'sed', 'id', 'wc', 'tr', 'grep']) {
    await executable(join(binDir, command), `#!/bin/sh\nexec /usr/bin/${command} "$@"\n`);
  }
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = flush ]; then',
    `  : > ${JSON.stringify(flushMarker)}`,
    '  exit 0',
    'fi',
    'printf "%s|Watching|false|true|1|0/0|1/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"',
    '',
  ].join('\n'));

  const result = spawnSync(
    controlExecutable,
    ['--sync-flush', 'happier-linux', '--', 'mutagen', 'sync', 'flush', 'happier-linux'],
    {
      env: {
        PATH: binDir,
        MUTAGEN_DATA_DIRECTORY: dataDir,
        DBUS_SESSION_BUS_ADDRESS: '',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.equal(await readFile(flushMarker, 'utf8'), '');
  assert.match(result.stderr, /transition problems/i);
});

test('critical-slice placement runs the requested flush in the protected slice', {
  skip: process.platform !== 'linux' || !process.env.DBUS_SESSION_BUS_ADDRESS,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-control-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  const dataDir = join(root, 'mutagen', 'data');
  const invocationLog = join(root, 'mutagen-invocations');
  const scopeLog = join(root, 'systemd-scopes');
  const started = join(root, 'flush-started');
  const release = join(root, 'flush-release');
  await mkdir(binDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await chmod(dataDir, 0o500);

  await executable(join(binDir, 'systemctl'), [
    '#!/bin/sh',
    "printf '%s\\n' 'LoadState=loaded' 'MemoryLow=4294967296'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'systemd-run'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(scopeLog)}`,
    'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
    '[ "$1" != "--" ] || shift',
    'exec "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = "list" ]; then',
    '  printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"',
    '  exit 0',
    'fi',
    `printf '%s\\n' "$*" >> ${JSON.stringify(invocationLog)}`,
    '',
  ].join('\n'));

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    MUTAGEN_DATA_DIRECTORY: dataDir,
  };
  const args = ['--sync-flush', 'happier-linux', '--', 'mutagen', 'sync', 'flush', 'happier-linux'];
  const first = spawn(controlExecutable, args, { env, stdio: 'ignore' });
  assert.deepEqual(await waitForExit(first), { code: 0, signal: null });
  assert.match(
    await readFile(invocationLog, 'utf8'),
    /sync flush happier-linux/,
  );
  assert.match(
    await readFile(scopeLog, 'utf8'),
    /(?:--nice=0 )?--slice=happier-critical\.slice .*-- mutagen sync flush happier-linux/,
  );
});

test('falls back to direct execution when the inherited user bus is unavailable', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-control-stale-bus-'));
  t.after(() => removeFixture(root));
  const binDir = join(root, 'bin');
  const scopeLog = join(root, 'systemd-scopes');
  const commandLog = join(root, 'command-ran');
  await mkdir(binDir, { recursive: true });

  await executable(join(binDir, 'cat'), [
    '#!/bin/sh',
    "case \"$1\" in */happier-critical.slice/memory.low) printf '%s\\n' 4294967296 ;; *) exec /bin/cat \"$@\" ;; esac",
    '',
  ].join('\n'));
  await executable(join(binDir, 'systemctl'), [
    '#!/bin/sh',
    'exit 1',
    '',
  ].join('\n'));
  await executable(join(binDir, 'systemd-run'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(scopeLog)}`,
    'exit 91',
    '',
  ].join('\n'));
  await executable(join(binDir, 'work'), [
    '#!/bin/sh',
    `: > ${JSON.stringify(commandLog)}`,
    '',
  ].join('\n'));

  const result = await waitForExit(spawn(controlExecutable, ['--', 'work'], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/does-not-exist/bus',
    },
    stdio: 'ignore',
  }));

  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(await readFile(commandLog, 'utf8'), '');
  await assert.rejects(readFile(scopeLog, 'utf8'), { code: 'ENOENT' });
});
