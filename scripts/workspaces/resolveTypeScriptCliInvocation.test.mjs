import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveTypeScriptCliInvocation,
  shouldRouteTypeScriptCliThroughHstack,
} from './resolveTypeScriptCliInvocation.mjs';
import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../apps/stack/scripts/testkit/core/fake_bin_harness.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';

test('selects tsrs for supported typechecks including declaration partitions and CI, preserving Microsoft builds and tooling', () => {
  const select = (args, options = {}) => resolveTypeScriptCliInvocation({
    args, platform: 'linux', arch: 'x64', env: {},
    requireResolve: specifier => `/repo/node_modules/${specifier}`,
    readFileSyncImpl: path => JSON.stringify({ bin: path.includes('/tsrs/') ? { tsrs: './bin/tsrs' } : { tsc: './bin/tsc' } }),
    ...options,
  });
  for (const arch of ['x64', 'arm64']) {
    assert.match(select(['--noEmit'], { arch }).compilerPath, /\/tsrs\/bin\/tsrs$/);
  }
  for (const [args, options] of [
    [['--emitDeclarationOnly'], {}],
    [['--noEmit'], { platform: 'darwin', arch: 'arm64' }],
    [['--noEmit'], { env: { CI: 'true' } }],
    [['--emitDeclarationOnly'], { env: { HAPPIER_TYPESCRIPT_COMPILER: 'tsrs' } }],
  ]) assert.match(select(args, options).compilerPath, /\/tsrs\/bin\/tsrs$/);
  for (const [args, options] of [
    [[], {}], [['--noEmit', 'false'], {}], [['--declaration'], {}],
    [['--build'], {}], [['--build', '--noEmit'], {}], [['--watch', '--noEmit'], {}],
    [['--noEmit'], { platform: 'darwin', arch: 'x64' }], [['--noEmit'], { platform: 'win32' }],
    [['--noEmit'], { arch: 'ia32' }],
    [['--noEmit'], { invocationKind: 'build' }],
    [['--emitDeclarationOnly'], { invocationKind: 'build', env: { HAPPIER_TYPESCRIPT_COMPILER: 'tsrs' } }],
    [['--noEmit'], { env: { HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' } }],
  ]) assert.match(select(args, options).compilerPath, /\/@typescript\/native\/bin\/tsc$/);
  assert.throws(() => select(['--noEmit'], { env: { HAPPIER_TYPESCRIPT_COMPILER: 'typo' } }), /HAPPIER_TYPESCRIPT_COMPILER/);
  assert.throws(() => select(['--noEmit'], { requireResolve: () => { throw new Error('missing tsrs'); } }), /missing tsrs/,
    'a missing selected compiler must not silently fall back');
});

test('inherits project noEmit and isolates tsrs incremental state without changing Microsoft reference caches', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-compiler-selection-' });
  await writeFile(fixture.path('base.json'), JSON.stringify({ compilerOptions: {
    noEmit: true, incremental: true, tsBuildInfoFile: './cache/check.tsbuildinfo',
  } }));
  await writeFile(fixture.path('tsconfig.json'), JSON.stringify({ extends: './base.json', files: [] }));
  const select = (args, env = {}) => resolveTypeScriptCliInvocation({
    args, env, platform: 'linux', arch: 'x64', workspaceDir: fixture.root,
    requireResolve: specifier => `/repo/node_modules/${specifier}`,
    readFileSyncImpl: path => JSON.stringify({ bin: path.includes('/tsrs/') ? { tsrs: './bin/tsrs' } : { tsc: './bin/tsc' } }),
  });
  const args = ['-p', 'tsconfig.json'];
  assert.match(select(undefined).compilerPath, /\/@typescript\/native\//,
    'an unspecified future argument list cannot establish a check-only invocation');
  assert.match(select(args).compilerPath, /\/tsrs\//);
  assert.deepEqual(select(args).argsSuffix, ['--tsBuildInfoFile', fixture.path('cache/check.tsbuildinfo.tsrs')]);
  assert.equal(select(args, { HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' }).argsSuffix, undefined);
  assert.match(select([...args, '--noEmit', 'false', '--emitDeclarationOnly']).compilerPath, /\/tsrs\//);
  assert.deepEqual(select([...args, '--tsBuildInfoFile', 'custom.tsbuildinfo']).argsSuffix,
    ['--tsBuildInfoFile', fixture.path('custom.tsbuildinfo.tsrs')]);
  await writeFile(fixture.path('tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, incremental: true }, files: [] }));
  assert.deepEqual(select(args).argsSuffix, ['--tsBuildInfoFile', fixture.path('tsconfig.tsbuildinfo.tsrs')]);
});

test('runner checks, recovers incrementally and switches to Microsoft without sharing compiler snapshots', {
  skip: process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch),
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-compiler-cache-' });
  await writeFile(fixture.path('source.ts'), 'export const value: number = "wrong";\n');
  await writeFile(fixture.path('tsconfig.json'), JSON.stringify({
    compilerOptions: { noEmit: true, incremental: true, strict: true, types: [], tsBuildInfoFile: './check.tsbuildinfo' },
    files: ['source.ts'],
  }));
  const runner = fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url));
  const check = compiler => spawnSync(process.execPath, [runner, '-p', 'tsconfig.json', '--pretty', 'false'], {
    cwd: fixture.root, encoding: 'utf8',
    env: { ...process.env, CI: '', HAPPIER_TYPESCRIPT_COMPILER: compiler },
  });
  const red = check('auto');
  assert.ifError(red.error);
  assert.equal(red.status, 2, `${red.stdout}\n${red.stderr}`);
  assert.match(red.stdout, /source\.ts\(1,14\): error TS2322/);
  assert.ok(existsSync(fixture.path('check.tsbuildinfo.tsrs')));
  assert.equal(existsSync(fixture.path('check.tsbuildinfo')), false);
  await writeFile(fixture.path('source.ts'), 'export const value: number = 1;\n');
  const green = check('auto');
  assert.equal(green.status, 0, `${green.stdout}\n${green.stderr}`);
  const microsoft = check('microsoft');
  assert.equal(microsoft.status, 0, `${microsoft.stdout}\n${microsoft.stderr}`);
  assert.ok(existsSync(fixture.path('check.tsbuildinfo')));
});

test('public typecheck refreshes stale workspace declarations once and performs zero fresh builds', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-typecheck-prerequisites-' });
  const runner = fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url));
  const buildRunner = fileURLToPath(new URL('./buildTypeScriptPackageDist.mjs', import.meta.url));
  const packageManager = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).packageManager;
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, packageManager }));
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - apps/*\n');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  for (const app of ['ui', 'cli', 'server', 'consumer']) {
    await mkdir(fixture.path('apps', app), { recursive: true });
    await writeFile(fixture.path('apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
      ...(app === 'consumer' ? { dependencies: { '@happier-dev/example': 'workspace:*' } } : {}) }));
  }
  const producer = fixture.path('packages/example');
  await mkdir(join(producer, 'src'), { recursive: true });
  await mkdir(join(producer, 'dist'));
  await writeFile(join(producer, 'package.json'), JSON.stringify({
    name: '@happier-dev/example', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
    scripts: { build: `node ${JSON.stringify(buildRunner)} && node -e "require('node:fs').appendFileSync(process.env.HAPPIER_TEST_PACKAGE_BUILD_LOG, 'build\\n')"` },
  }));
  await writeFile(join(producer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', declaration: true,
    rootDir: 'src', outDir: 'dist', types: [], skipLibCheck: true,
  }, include: ['src/**/*.ts'] }));
  await writeFile(join(producer, 'src/index.ts'), 'export const value = false;\n');
  await writeFile(join(producer, 'dist/index.js'), 'export const value = true;\n');
  await writeFile(join(producer, 'dist/index.d.ts'), 'export declare const value = true;\n');
  const consumer = fixture.path('apps/consumer');
  await writeFile(join(consumer, 'source.ts'), 'import { value } from "@happier-dev/example";\nconst wanted: true = value;\n');
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    noEmit: true, types: [], strict: true, skipLibCheck: true,
    paths: { '@happier-dev/example': ['../../packages/example/dist/index.d.ts'] },
  }, files: ['source.ts'] }));
  const check = () => {
    const started = performance.now();
    const result = spawnSync(process.execPath, [runner, '-p', 'tsconfig.json', '--pretty', 'false'], {
      cwd: consumer, encoding: 'utf8', env: { ...process.env,
        HAPPIER_TEST_PACKAGE_BUILD_LOG: fixture.path('package-builds.log') },
    });
    assert.ifError(result.error);
    return { ...result, elapsedMs: Math.round(performance.now() - started) };
  };
  const cold = check();
  assert.equal(cold.status, 2, cold.stdout + cold.stderr);
  assert.match(cold.stdout, /source\.ts\(2,7\): error TS2322/);
  assert.doesNotMatch(cold.stderr, /declarations are older than its source/,
    'fresh source-dev declarations must not be reported as stale merely because producer semantics were not checked');
  assert.match(await readFile(join(producer, 'dist/index.d.ts'), 'utf8'), /value = false/);
  assert.equal(await readFile(fixture.path('package-builds.log'), 'utf8'), 'build\n');
  const warm = check();
  assert.equal(warm.status, 2, warm.stdout + warm.stderr);
  assert.match(warm.stdout, /source\.ts\(2,7\): error TS2322/);
  assert.equal(await readFile(fixture.path('package-builds.log'), 'utf8'), 'build\n',
    'a fresh prepare must execute zero build processes');
  assert.match(warm.stderr, /\[typecheck-preparation\].*"built":\[\]/,
    'fresh inputs must start zero package builds');
  await writeFile(join(producer, 'src/index.ts'), 'export const value = true;\n');
  const changed = check();
  assert.equal(changed.status, 0, changed.stdout + changed.stderr);
  assert.equal(await readFile(fixture.path('package-builds.log'), 'utf8'), 'build\nbuild\n');
  assert.match(changed.stderr, /\[typecheck-preparation\].*"built":\["@happier-dev\/example"\]/);
  const preparationTiming = result => JSON.parse(result.stderr.split('\n')
    .find(line => line.startsWith('[typecheck-preparation] ')).slice('[typecheck-preparation] '.length));
  t.diagnostic(JSON.stringify({ coldMs: cold.elapsedMs, noOpMs: warm.elapsedMs, changedMs: changed.elapsedMs,
    preparation: { cold: preparationTiming(cold), noOp: preparationTiming(warm) } }));
});

test('first-party plugin typechecks reject existing undeclared package subpaths before shipping', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-plugin-export-boundary-' });
  const runner = fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url));
  const packageName = '@happier-dev/devplug-export-contract';
  const dependency = fixture.path('node_modules', packageName);
  await mkdir(join(dependency, 'src'), { recursive: true });
  await writeFile(join(dependency, 'package.json'), JSON.stringify({
    name: packageName, type: 'module',
    exports: { './public': { types: './src/public.ts', default: './src/public.ts' } },
  }));
  await writeFile(join(dependency, 'src/public.ts'), 'export const value: number = 1;\n');
  await writeFile(join(dependency, 'src/private.ts'), 'export const value: number = 2;\n');
  await mkdir(fixture.path('src'));
  for (const plugin of ['channels', 'channel-email']) {
    const authored = JSON.parse(await readFile(new URL(`../../packages/plugins/${plugin}/tsconfig.json`, import.meta.url), 'utf8'));
    const config = {
      ...authored,
      compilerOptions: { ...authored.compilerOptions, types: [], incremental: false,
        rootDir: './src', outDir: './dist', tsBuildInfoFile: undefined },
      files: ['src/index.ts'], include: [], exclude: [],
    };
    assert.equal(config.compilerOptions.moduleResolution, 'Bundler');
    await writeFile(fixture.path('tsconfig.json'), JSON.stringify(config));
    for (const compiler of ['auto', 'microsoft']) {
      const check = () => spawnSync(process.execPath, [runner, '--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'], {
        cwd: fixture.root, encoding: 'utf8',
        env: { ...process.env, HAPPIER_TYPESCRIPT_COMPILER: compiler },
      });
      await writeFile(fixture.path('src/index.ts'), `export { value } from '${packageName}/public';\n`);
      const declared = check();
      assert.ifError(declared.error);
      assert.equal(declared.status, 0, `${plugin}/${compiler}: ${declared.stdout}\n${declared.stderr}`);
      await writeFile(fixture.path('src/index.ts'), `export { value } from '${packageName}/private';\n`);
      const undeclared = check();
      assert.ifError(undeclared.error);
      assert.equal(undeclared.status, 2, `${plugin}/${compiler}: ${undeclared.stdout}\n${undeclared.stderr}`);
      assert.match(undeclared.stdout, /src\/index\.ts\(1,23\): error TS2307/);
      assert.match(undeclared.stdout, new RegExp(`${packageName}/private`));
    }
  }
});

test('compiler leaf uses the package admission policy instead of escalating CLI to the UI envelope', () => {
  const workspaceDir = fileURLToPath(new URL('../../', import.meta.url));
  for (const component of ['cli', 'ui', 'server']) {
    for (const config of ['tsconfig.json', 'node_modules/.cache/tsc/tsconfig.source.json']) {
      const invocation = resolveTypeScriptCliInvocation({
        workspaceDir, args: ['--noEmit', '-p', `apps/${component}/${config}`],
        platform: 'linux', env: {},
        requireResolve: () => '/repo/node_modules/@typescript/native/package.json',
        readFileSyncImpl: () => JSON.stringify({ bin: { tsc: './bin/tsc', tsrs: './bin/tsrs' } }),
      });
      assert.ok(invocation.argsPrefix.includes(`--class=compilation-${component}`), invocation.argsPrefix.join(' '));
    }
  }
});

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
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, CI: '',
    HAPPIER_STACK_PM_CACHE_BASE_DIR: '',
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
    await writeFile(memory, '41943040 73400320\n');
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
      assert.deepEqual(await nestedExit, [1, null], nestedStderr);
      assert.match(nestedStderr, /HSTACK_NESTED_ADMISSION_CAPACITY/);
      await assert.rejects(readFile(fixture.path('nested-started')), { code: 'ENOENT' });
      assert.equal(await readFile(join(ancestorOwner, 'class'), 'utf8'), 'package-dist\n');
      await writeFile(memory, '41943040 73400320\n');
      const immediate = spawn(command, [...invocation.argsPrefix], { env: { ...env,
        HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: `${process.pid}:${token}`,
        HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: admissionRoot,
        HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: machine,
      } });
      assert.deepEqual(await once(immediate, 'exit'), [7, null]);
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

test('routes direct compilation through hstack but executes an admitted payload directly', () => {
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
  }), true);
  for (const args of [[], ['--build'], ['--noEmit', 'true'], ['source.ts'], ['--version', '-p', 'tsconfig.json']]) {
    assert.equal(shouldRouteTypeScriptCliThroughHstack({ args, env: { CODEX_CI: '1', CI: 'true' } }), true, args.join(' '));
  }
  for (const arg of ['--version', '-v', '--help', '-h']) {
    assert.equal(shouldRouteTypeScriptCliThroughHstack({ args: [arg], env: {} }), false, arg);
  }
  for (const env of [{ HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '1:1' }, { HAPPIER_WORKSPACE_BUILD_STARTUP: '1' }]) {
    assert.equal(shouldRouteTypeScriptCliThroughHstack({ args: ['-p', 'tsconfig.json'], env }), false);
  }
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
  for (const env of [
    { CI: 'true', HAPPIER_DEV_TARGET_EXECUTION: '1' },
    { CI: 'true', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '1:1' },
    { CI: 'true', HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED: '1' },
  ]) {
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
    cacheSuffix: '',
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
    assert.ok(Number.isInteger(result.status) && result.status > 0, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /source\.ts\(1,14\): error TS2322/u);
    assert.match(result.stdout, /case\.test\.ts\(1,14\): error TS2322/u);
    assert.ok(result.stdout.indexOf('source.ts(1,14)') < result.stdout.indexOf('case.test.ts(1,14)'));
    writeFileSync(join(root, 'case.test.ts'), 'export const testValue: number = 2;\n');
    const sourceFailure = spawnSync(process.execPath, [
      runner, '--project', join(root, 'source.json'),
      '--project', join(root, 'tests.json'), '--noEmit', '--pretty', 'false',
    ], { encoding: 'utf8' });
    assert.ifError(sourceFailure.error);
    assert.equal(sourceFailure.status, result.status, 'a later passing project must not hide an earlier failure');
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
