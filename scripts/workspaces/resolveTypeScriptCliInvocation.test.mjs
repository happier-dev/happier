import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveTypeScriptCliInvocation,
  shouldRouteTypeScriptCliThroughHstack,
} from './resolveTypeScriptCliInvocation.mjs';
import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../apps/stack/scripts/testkit/core/fake_bin_harness.mjs';
import { installNativeAdmissionFixture } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';

test('canonical compiler admission blocks inherited routing markers and preserves native terminal results', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-canonical-compiler-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const memory = fixture.path('memory');
  const compiler = fixture.path('compiler.cjs');
  await writeFile(compiler, `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.COMPILER_STARTED, process.argv.slice(2).join('|'));
    if (process.env.COMPILER_FDS) fs.writeFileSync(process.env.COMPILER_FDS,
      JSON.stringify(fs.readdirSync('/proc/self/fd').flatMap(fd => {
        try { return [fs.readlinkSync('/proc/self/fd/' + fd)]; } catch { return []; }
      })));
    if (process.argv.includes('signal')) process.kill(process.pid, 'SIGTERM');
    else if (process.argv.includes('hold')) setInterval(() => {}, 1000);
    else process.exit(Number(process.env.COMPILER_STATUS ?? 7));
  `);
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`, CI: '',
    FIXTURE_MEMORY: memory, COMPILER_STARTED: fixture.path('started'),
    HAPPIER_HSTACK_EXECUTION: '1', HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_TYPECHECK_DISPATCHED: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const invocation = resolveTypeScriptCliInvocation({
    repoRoot: join(fixture.root, 'native-owner'), env,
    requireResolve: () => fixture.path('package.json'),
    readFileSyncImpl: () => JSON.stringify({ bin: { tsc: './compiler.cjs' } }),
  });
  // Remap only the launcher's physical host state, keeping selector output
  // and the real admission process beneath this OS boundary intact.
  const command = invocation.command.endsWith('/apps/stack/bin/hstack-exec') ? launcher : invocation.command;
  await writeFile(memory, '7340032 73400320\n');
  const project = fixture.path('tsconfig.json');
  await writeFile(project, JSON.stringify({ compilerOptions: { noEmit: true } }));
  const child = spawn(command, [...invocation.argsPrefix, '--project', project], { env });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    for (let attempt = 0; !stderr.includes('waiting for heavyweight admission') && child.exitCode === null && child.signalCode === null; attempt++) {
      assert.ok(attempt < 250, `admission did not decide: ${stderr}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    assert.equal(child.exitCode, null, `compiler bypassed admission: ${stderr}`);
    assert.match(stderr, /waiting for heavyweight admission/);
    await assert.rejects(readFile(env.COMPILER_STARTED), { code: 'ENOENT' });
    await writeFile(memory, '25165824 73400320\n');
    assert.deepEqual(await exited, [7, null], stderr);
    assert.equal(invocation.compilerPath, compiler);
    assert.equal(await readFile(env.COMPILER_STARTED, 'utf8'), `--project|${project}`);
    for (const [args, status, signal] of [[['signal'], null, 'SIGTERM'], [[], 143, null]]) {
      const leaf = spawn(command, [...invocation.argsPrefix, ...args], { env: { ...env, COMPILER_STATUS: '143' } });
      assert.deepEqual(await once(leaf, 'exit'), [status, signal]);
    }
    // Exec retains the admitted process identity. The existing observation
    // ignores/reaps its dead record before admitting the next compiler.
    const probe = spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', '--class=compilation', '--machine=local'], { env, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(await readdir(join(admissionRoot, 'owners')), []);

    await writeFile(memory, '73400320 94371840\n');
    const held = spawn(command, [...invocation.argsPrefix, 'hold'], { env: { ...env, COMPILER_FDS: fixture.path('fds') } });
    const heldExit = once(held, 'exit');
    try {
      for (let attempt = 0; ; attempt++) {
        try { await readFile(fixture.path('fds')); break; } catch (error) {
          if (error.code !== 'ENOENT' || attempt === 250) throw error;
          await new Promise(resolveWait => setTimeout(resolveWait, 20));
        }
      }
      assert.equal(JSON.parse(await readFile(fixture.path('fds'), 'utf8')).some(path => path.startsWith(admissionRoot)), false,
        'exec must not leak the admission lock descriptor into the compiler');
      const liveProbe = spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', '--class=validation', '--machine=local'], { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(liveProbe.status, 0, liveProbe.stderr);
      assert.equal((await readdir(join(admissionRoot, 'owners'))).length, 1, 'exec retains the live admitted identity');
    } finally {
      held.kill('SIGTERM');
      assert.deepEqual(await heldExit, [null, 'SIGTERM']);
    }

    await writeFile(memory, '7340032 73400320\n');
    const cancelled = spawn(command, [...invocation.argsPrefix], { env: { ...env, COMPILER_STARTED: fixture.path('cancelled-started') } });
    const cancelledExit = once(cancelled, 'exit');
    let cancelledStderr = '';
    cancelled.stderr.on('data', chunk => { cancelledStderr += chunk; });
    try {
      for (let attempt = 0; !cancelledStderr.includes('waiting for heavyweight admission'); attempt++) {
        assert.ok(attempt < 250 && cancelled.exitCode === null, cancelledStderr);
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      cancelled.kill('SIGTERM');
      assert.deepEqual(await cancelledExit, [130, null], 'waiting admission preserves its existing cancellation status');
      await assert.rejects(readFile(fixture.path('cancelled-started')), { code: 'ENOENT' });
    } finally {
      if (cancelled.exitCode === null && cancelled.signalCode === null) cancelled.kill('SIGTERM');
      await cancelledExit;
    }

    const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
    const token = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
    const machine = (await readFile('/etc/machine-id', 'utf8')).trim();
    const ancestorOwner = join(admissionRoot, 'owners', `${process.pid}-${token}`);
    await mkdir(ancestorOwner, { recursive: true });
    await Promise.all([
      writeFile(join(ancestorOwner, 'process'), `${process.pid} ${token}\n`),
      writeFile(join(ancestorOwner, 'class'), 'package-dist\n'),
      writeFile(join(ancestorOwner, 'machine'), `${machine}\n`),
    ]);
    await writeFile(memory, '9437184 73400320\n');
    const nested = spawn(command, [...invocation.argsPrefix], { env: { ...env,
      COMPILER_STARTED: fixture.path('nested-started'),
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: `${process.pid}:${token}`,
      HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: admissionRoot,
      HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: machine,
    } });
    const nestedExit = once(nested, 'exit');
    let nestedStderr = '';
    nested.stderr.on('data', chunk => { nestedStderr += chunk; });
    try {
      for (let attempt = 0; !nestedStderr.includes('inherited owner'); attempt++) {
        assert.ok(attempt < 250 && nested.exitCode === null, nestedStderr);
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      await assert.rejects(readFile(fixture.path('nested-started')), { code: 'ENOENT' });
      await writeFile(memory, '25165824 73400320\n');
      assert.deepEqual(await nestedExit, [7, null], nestedStderr);
      assert.equal(await readFile(join(ancestorOwner, 'class'), 'utf8'), 'compilation\n');
      assert.deepEqual(await readdir(join(admissionRoot, 'owners')), [`${process.pid}-${token}`],
        'larger compiler escalates the validated envelope without a second owner');
    } finally {
      if (nested.exitCode === null && nested.signalCode === null) nested.kill('SIGTERM');
      await nestedExit;
    }

    // Model only the systemd OS adapter, whose v255 scope implementation
    // execvpe()s the payload. The real selector/admission/signal path stays live.
    writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\ncase "$*" in *show-environment*) exit 0 ;; *happier-jobs.slice*) printf "loaded\\n" ;; *) exit 1 ;; esac\n' });
    writeFakeBin({ root: fixture.root, name: 'sed', content: '#!/bin/sh\ncase "$*" in */proc/self/cgroup*) printf "/user.slice/fixture.scope\\n" ;; *) exec /usr/bin/sed "$@" ;; esac\n' });
    writeFakeBin({ root: fixture.root, name: 'systemd-run', content: '#!/bin/sh\n: > "$SCOPE_STARTED"\nwhile [ "$#" -gt 0 ]; do case "$1" in --) shift; break ;; esac; shift; done\nexec "$@"\n' });
    await writeFile(memory, '73400320 94371840\n');
    for (const [args, status, signal] of [[['signal'], null, 'SIGTERM'], [[], 143, null]]) {
      const scoped = spawn(command, [...invocation.argsPrefix, ...args], { env: { ...env, COMPILER_STATUS: '143', SCOPE_STARTED: fixture.path('scope-started') } });
      assert.deepEqual(await once(scoped, 'exit'), [status, signal]);
      await readFile(fixture.path('scope-started'));
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});

test('routes direct no-emit compilation through hstack but executes an admitted payload directly', () => {
  assert.equal(shouldRouteTypeScriptCliThroughHstack({
    args: ['--noEmit', '-p', 'tsconfig.json'],
    env: {},
  }), true);
  assert.equal(shouldRouteTypeScriptCliThroughHstack({
    args: ['--noEmit'],
    env: { HAPPIER_DEV_TARGET_EXECUTION: '1' },
  }), false);
  assert.equal(shouldRouteTypeScriptCliThroughHstack({
    args: ['--noEmit'],
    env: { HAPPIER_HSTACK_EXECUTION: '1' },
  }), false);
  assert.equal(shouldRouteTypeScriptCliThroughHstack({
    args: ['--noEmit'],
    env: { HAPPIER_TYPECHECK_DISPATCHED: '1' },
  }), false, 'a dispatched Turbo child must retain its selected host');
  assert.equal(shouldRouteTypeScriptCliThroughHstack({
    args: ['-p', 'tsconfig.json', '--outDir', 'dist'],
    env: {},
  }), false);
});

test('canonical compiler preserves ordinary CI capacity ownership and guards placed CI workers', () => {
  const params = {
    platform: 'linux', processExecPath: '/managed/node',
    requireResolve: () => '/repo/node_modules/@typescript/native/package.json',
    readFileSyncImpl: () => JSON.stringify({ bin: { tsc: './bin/tsc' } }),
  };
  const ordinary = resolveTypeScriptCliInvocation({ ...params, env: { CI: 'true' } });
  assert.equal(ordinary.command, '/managed/node');
  assert.deepEqual(ordinary.argsPrefix, [ordinary.compilerPath]);
  for (const env of [{ CI: 'true', HAPPIER_DEV_TARGET_EXECUTION: '1' }, { CI: 'true', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '1:1' }]) {
    const guarded = resolveTypeScriptCliInvocation({ ...params, env });
    assert.match(guarded.command, /\/apps\/stack\/bin\/hstack-exec$/);
    assert.equal(guarded.argsPrefix[0], '--heavyweight-admission');
  }
});

test('resolves the native TypeScript CLI from its exported package manifest', () => {
  const resolutions = [];
  const invocation = resolveTypeScriptCliInvocation({
    processExecPath: '/managed/node',
    platform: 'darwin',
    requireResolve(specifier) {
      resolutions.push(specifier);
      return '/repo/node_modules/@typescript/native/package.json';
    },
    readFileSyncImpl(path, encoding) {
      assert.equal(path, '/repo/node_modules/@typescript/native/package.json');
      assert.equal(encoding, 'utf8');
      return JSON.stringify({ bin: { tsc: './bin/tsc' } });
    },
  });

  assert.deepEqual(resolutions, ['@typescript/native/package.json']);
  assert.deepEqual(invocation, {
    command: '/managed/node',
    argsPrefix: ['/repo/node_modules/@typescript/native/bin/tsc'],
    compilerPath: '/repo/node_modules/@typescript/native/bin/tsc',
  });
});

test('fails closed when the native package does not declare a tsc entrypoint', () => {
  assert.throws(
    () => resolveTypeScriptCliInvocation({
      requireResolve: () => '/repo/node_modules/@typescript/native/package.json',
      readFileSyncImpl: () => JSON.stringify({ bin: {} }),
    }),
    /does not declare a tsc binary/i,
  );
});

test('checks every requested project sequentially even when source checking fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-typecheck-projects-'));
  try {
    writeFileSync(join(root, 'source.ts'), 'export const sourceValue: number = "wrong";\n');
    writeFileSync(join(root, 'case.test.ts'), 'export const testValue: number = "wrong";\n');
    for (const [name, file] of [['source', 'source.ts'], ['tests', 'case.test.ts']]) {
      writeFileSync(join(root, `${name}.json`), JSON.stringify({
        compilerOptions: { strict: true, types: [], noEmit: true },
        files: [file],
      }));
    }
    const runner = fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      runner,
      '--project', join(root, 'source.json'),
      '--project', join(root, 'tests.json'),
      '--noEmit', '--pretty', 'false',
    ], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /source\.ts\(1,14\): error TS2322/u);
    assert.match(result.stdout, /case\.test\.ts\(1,14\): error TS2322/u);
    assert.ok(result.stdout.indexOf('source.ts(1,14)') < result.stdout.indexOf('case.test.ts(1,14)'));
    writeFileSync(join(root, 'case.test.ts'), 'export const testValue: number = 2;\n');
    const sourceFailure = spawnSync(process.execPath, [
      runner, '--project', join(root, 'source.json'),
      '--project', join(root, 'tests.json'), '--noEmit', '--pretty', 'false',
    ], { encoding: 'utf8' });
    assert.ifError(sourceFailure.error);
    assert.equal(sourceFailure.status, 1, 'a later passing project must not hide an earlier failure');
    assert.match(sourceFailure.stdout, /source\.ts\(1,14\): error TS2322/u);
    assert.doesNotMatch(sourceFailure.stdout, /case\.test\.ts\(1,14\): error TS2322/u);
    writeFileSync(join(root, 'source.ts'), 'export const sourceValue: number = 1;\n');
    const green = spawnSync(process.execPath, [
      runner, `--project=${join(root, 'source.json')}`,
      '-p', join(root, 'tests.json'), '--noEmit',
    ], { encoding: 'utf8' });
    assert.ifError(green.error);
    assert.equal(green.status, 0, `${green.stdout}\n${green.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
