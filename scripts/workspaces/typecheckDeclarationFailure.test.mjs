import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildNativeAdmissionFixtureEnv } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';

import { installUiTypecheckFixtureDependencies } from '../testing/lib/typecheckProjectFixture.mjs';

const buildScript = `node ${JSON.stringify(fileURLToPath(new URL('./buildTypeScriptPackageDist.mjs', import.meta.url)))} -p tsconfig.json`;

test('consumer diagnostics survive an upstream declaration emission error', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-declaration-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ private: true }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters: {}\n",
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
    'apps/ui/package.json': JSON.stringify({ name: '@fixture/ui' }),
    'apps/cli/package.json': JSON.stringify({ name: '@fixture/cli' }),
    'apps/server/package.json': JSON.stringify({ name: '@fixture/server', dependencies: { '@fixture/upstream': 'workspace:*' } }),
    'apps/server/tsconfig.json': JSON.stringify({ compilerOptions: { noEmit: true, strict: true,
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [],
      paths: { '@fixture/upstream': ['../../packages/upstream/dist/index.d.ts'] } }, files: ['index.ts'] }),
    'apps/server/index.ts': 'export const ownError: number = "consumer";\nexport { value } from "@fixture/upstream";',
    'packages/upstream/package.json': JSON.stringify({ name: '@fixture/upstream', type: 'module', scripts: { build: buildScript },
      exports: { '.': { types: './dist/index.d.ts', 'happier-source': './src/index.ts' } } }),
    'packages/upstream/tsconfig.json': JSON.stringify({ compilerOptions: { declaration: true, strict: true,
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [], rootDir: 'src', outDir: 'dist' }, files: ['src/index.ts'] }),
    // This requires a declaration diagnostic even with the emitter's noCheck.
    'packages/upstream/src/index.ts': 'export const value = new class { private hidden = true; }();',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: 'true', HAPPIER_TYPECHECK_DISPATCHED: '1', HAPPIER_STACK_CANONICAL_HOME_DIR: root,
    HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' };
  // This fixture is a local subprocess inside the admitted test, not a placed worker.
  delete env.HAPPIER_DEV_TARGET_EXECUTION;
  delete env.HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED;
  const check = () => spawnSync(process.execPath, [fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url)),
    '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: join(root, 'apps/server'), env, encoding: 'utf8' });
  const result = check();
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /TS4094/, 'the producer must really fail declaration emission');
  assert.match(result.stdout, /index\.ts\(1,\d+\): error TS2322:/, 'the consumer must still check its own source');
  assert.match(result.stderr, /typecheck-declaration-failure.*declaration-emission/);
  await writeFile(join(root, 'apps/server/index.ts'), 'export const ownValue: number = 1;\nexport { value } from "@fixture/upstream";');
  const upstreamOnly = check();
  assert.ifError(upstreamOnly.error);
  assert.notEqual(upstreamOnly.status, 0, 'a clean consumer cannot hide failed declaration preparation');
  assert.match(upstreamOnly.stdout, /TS4094/);
  assert.doesNotMatch(upstreamOnly.stdout, /TS2322/);
  await writeFile(join(root, 'packages/upstream/src/index.ts'), 'export const value = true;');
  const recovered = check();
  assert.ifError(recovered.error);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.doesNotMatch(recovered.stderr, /typecheck-declaration-failure/);
});

test('finite UI typecheck prepares an imported package without building unrelated runtime packages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-declaration-demand-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = ['foundation', 'core', 'source', 'test-components', 'test-other'];
  const packages = ['used', 'unused'];
  const compilerOptions = {
    strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [],
  };
  const files = {
    'package.json': JSON.stringify({ private: true }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters: {}\n",
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
    'apps/cli/package.json': JSON.stringify({ name: '@fixture/cli' }),
    'apps/server/package.json': JSON.stringify({ name: '@fixture/server' }),
    'apps/ui/package.json': JSON.stringify({ name: '@fixture/ui',
      dependencies: Object.fromEntries(packages.map(name => [`@happier-dev/${name}`, 'workspace:*'])) }),
    'apps/ui/tsconfig.json': JSON.stringify({ compilerOptions: { ...compilerOptions, noEmit: true, paths: { '@/*': ['./src/*'] } }, include: ['src/**/*.ts'] }),
    'apps/ui/tsconfig.test.json': JSON.stringify({ extends: './tsconfig.json', include: ['src/**/*.test.ts'] }),
    'apps/ui/src/shared.d.ts': 'declare const widgetEnvironment: boolean;',
    'apps/ui/src/widget.ts': 'export const widget = widgetEnvironment;',
    'apps/ui/src/widget.test.ts': 'import { value } from "@happier-dev/used"; export const checked: number = value;',
  };
  for (const [index, name] of projects.entries()) {
    files[`apps/ui/tsconfig.${name}.json`] = JSON.stringify({
      extends: './tsconfig.json', files: [], include: [],
      compilerOptions: index < 3 ? {
        noEmit: false, composite: true, declaration: true, emitDeclarationOnly: true, rootDir: '../..',
        disableSourceOfProjectReferenceRedirect: true, outDir: `node_modules/.cache/tsc/${name}`,
      } : {},
      references: projects.slice(0, Math.min(index, 3)).map(peer => ({ path: `./tsconfig.${peer}.json` })),
    });
  }
  for (const name of packages) {
    files[`packages/${name}/package.json`] = JSON.stringify({
      name: `@happier-dev/${name}`, type: 'module', scripts: { build: buildScript },
      exports: { '.': { types: './dist/index.d.ts', 'happier-source': './src/index.ts' } },
    });
    files[`packages/${name}/tsconfig.json`] = JSON.stringify({
      compilerOptions: { ...compilerOptions, declaration: true, rootDir: 'src', outDir: 'dist' }, files: ['src/index.ts'],
    });
    files[`packages/${name}/src/index.ts`] = name === 'used'
      ? 'export const value = 7;' : 'export const value = new class { private hidden = true; }();';
  }
  const rssMode = process.platform === 'linux' ? process.env.HAPPIER_TYPECHECK_TEST_LAUNCHER_RSS : undefined;
  const measureLauncher = rssMode === '1' || rssMode === 'baseline';
  if (measureLauncher) {
    const graphSize = rssMode === '1' ? 4096 : 0;
    for (let index = 0; index < graphSize; index++) {
      const imports = Array.from({ length: 24 }, (_, offset) => {
        const target = (index + offset + 1) % graphSize;
        return `import type { T as Peer${offset} } from "../graph-${target}/index";`;
      }).join('\n');
      files[`apps/ui/src/graph-${index}/index.ts`] = `${imports}\nexport interface T { readonly label: ${index}; }\n`;
    }
    const sampler = join(root, 'sample-launcher.mjs');
    files['sample-launcher.mjs'] = `
      import { readFileSync, writeFileSync } from 'node:fs';
      const pid = readFileSync(${JSON.stringify(join(root, 'launcher.pid'))}, 'utf8');
      writeFileSync(${JSON.stringify(join(root, 'launcher.status'))}, readFileSync('/proc/' + pid + '/status'));
    `;
    const usedManifest = JSON.parse(files['packages/used/package.json']);
    usedManifest.scripts.build = `node ${JSON.stringify(sampler)} && ${buildScript}`;
    files['packages/used/package.json'] = JSON.stringify(usedManifest);
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await installUiTypecheckFixtureDependencies(t, join(root, 'apps/ui'));
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: 'true', HAPPIER_TYPECHECK_DISPATCHED: '1', HAPPIER_STACK_CANONICAL_HOME_DIR: root,
    HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' };
  delete env.HAPPIER_DEV_TARGET_EXECUTION;
  delete env.HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED;
  const runnerArgs = [fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url)),
    '--pretty', 'false', ...projects.flatMap(name => ['-p', `tsconfig.${name}.json`])];
  const cwd = join(root, 'apps/ui');
  let rssKiB;
  if (measureLauncher) {
    const child = spawn(process.execPath, runnerArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    const streams = [child.stdout, child.stderr];
    const output = [];
    for (const stream of streams) stream.on('data', chunk => output.push(chunk));
    await writeFile(join(root, 'launcher.pid'), String(child.pid));
    const [status, signal] = await closed;
    assert.equal(status, 0, `${signal ?? ''}\n${Buffer.concat(output)}`);
    const launcherStatus = await readFile(join(root, 'launcher.status'), 'utf8');
    rssKiB = Number(/^VmRSS:\s+(\d+)/mu.exec(launcherStatus)?.[1]);
    const highWaterKiB = Number(/^VmHWM:\s+(\d+)/mu.exec(launcherStatus)?.[1]);
    t.diagnostic(`launcher during declaration publication: RSS ${rssKiB} KiB; VmHWM ${highWaterKiB} KiB`);
  } else {
    const result = spawnSync(process.execPath, runnerArgs, { cwd, env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /TS4094/);
  }
  assert.equal(await readFile(join(root, 'packages/used/dist/index.d.ts'), 'utf8'), 'export declare const value = 7;\n');
  if (measureLauncher) {
    assert.ok(rssKiB > 0 && rssKiB < 275 * 1024, `launcher RSS ${rssKiB} KiB exceeds the declaration fixture envelope`);
  }
});

test('finite UI typecheck prepares only the workspace closure of its referenced CLI declaration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-declaration-demand-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = ['foundation', 'core', 'source', 'test-components', 'test-other'];
  const packages = ['used', 'unused', 'via-used'];
  const compilerOptions = {
    strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [],
  };
  const files = {
    'package.json': JSON.stringify({ private: true }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters: {}\n",
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
    'apps/cli/package.json': JSON.stringify({ name: '@fixture/cli',
      dependencies: { '@happier-dev/used': 'workspace:*', '@happier-dev/unused': 'workspace:*' } }),
    'apps/cli/tsconfig.json': JSON.stringify({ compilerOptions: { ...compilerOptions, noEmit: true,
      paths: { '@/*': ['./src/*'], '@happier-dev/used': ['../../packages/used/dist/index.d.ts'] } }, include: ['src/**/*.ts'] }),
    'apps/cli/src/used.ts': 'import { value } from "@happier-dev/used"; export const selected: number = value;',
    'apps/cli/src/unused.ts': 'export { value } from "@happier-dev/unused";',
    'apps/server/package.json': JSON.stringify({ name: '@fixture/server' }),
    'apps/ui/package.json': JSON.stringify({ name: '@fixture/ui' }),
    'apps/ui/tsconfig.json': JSON.stringify({ compilerOptions: { ...compilerOptions, noEmit: true, paths: { '@/*': ['./src/*'] } }, include: ['src/**/*.ts'] }),
    'apps/ui/tsconfig.test.json': JSON.stringify({ extends: './tsconfig.json', include: ['src/**/*.test.ts'] }),
    'apps/ui/src/shared.d.ts': 'declare const widgetEnvironment: boolean;',
    'apps/ui/src/widget.ts': 'export const widget = widgetEnvironment;',
    'apps/ui/src/widget.test.ts': 'import { selected } from "../../cli/src/used"; export const checked: number = selected;',
  };
  for (const [index, name] of projects.entries()) {
    files[`apps/ui/tsconfig.${name}.json`] = JSON.stringify({
      extends: './tsconfig.json', files: [], include: [],
      compilerOptions: index < 3 ? {
        noEmit: false, composite: true, declaration: true, emitDeclarationOnly: true, rootDir: '../..',
        disableSourceOfProjectReferenceRedirect: true, outDir: `node_modules/.cache/tsc/${name}`,
      } : {},
      references: projects.slice(0, Math.min(index, 3)).map(peer => ({ path: `./tsconfig.${peer}.json` })),
    });
  }
  for (const name of packages) {
    files[`packages/${name}/package.json`] = JSON.stringify({
      name: `@happier-dev/${name}`, type: 'module', scripts: { build: buildScript },
      ...(name === 'used' ? { dependencies: { '@happier-dev/via-used': 'workspace:*' } } : {}),
      exports: { '.': { types: './dist/index.d.ts', 'happier-source': './src/index.ts' } },
    });
    files[`packages/${name}/tsconfig.json`] = JSON.stringify({
      compilerOptions: { ...compilerOptions, declaration: true, rootDir: 'src', outDir: 'dist' }, files: ['src/index.ts'],
    });
    files[`packages/${name}/src/index.ts`] = name === 'used'
      ? 'export const value = 7;' : 'export const value = "unrelated";';
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await installUiTypecheckFixtureDependencies(t, join(root, 'apps/ui'));
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: 'true', HAPPIER_TYPECHECK_DISPATCHED: '1', HAPPIER_STACK_CANONICAL_HOME_DIR: root,
    HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' };
  delete env.HAPPIER_DEV_TARGET_EXECUTION;
  delete env.HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url)),
    '--pretty', 'false', ...projects.flatMap(name => ['-p', `tsconfig.${name}.json`])],
  { cwd: join(root, 'apps/ui'), env, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.match(await readFile(join(root, 'packages/used/dist/index.d.ts'), 'utf8'), /value = 7/);
  assert.match(await readFile(join(root, 'packages/via-used/dist/index.d.ts'), 'utf8'), /value/);
  await assert.rejects(readFile(join(root, 'packages/unused/dist/index.d.ts')), { code: 'ENOENT' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});


test('a second finite app check is refused while the first holds its project inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-typecheck-overlap-'));
  const ui = join(root, 'apps/ui');
  const cli = join(root, 'apps/cli');
  const appProjects = {
    ui: ['foundation', 'core', 'source', 'test-components', 'test-other'],
    cli: ['foundation', 'services', 'core', 'source', 'test', 'test-ui'],
  };
  const compilerOptions = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    strict: true, types: [], noEmit: true };
  const files = {
    'package.json': '{"private":true}',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters: {}\n",
    'pnpm-workspace.yaml': 'packages: [apps/*]',
    'apps/server/package.json': '{"name":"@fixture/server"}',
    'apps/server/tsconfig.json': JSON.stringify({ compilerOptions: {
      ...compilerOptions, paths: { '@/*': ['./src/*'] },
    }, include: ['src/**/*.ts'] }),
    'apps/server/src/forUi.ts': 'export const forUi: number = 1;',
    'apps/server/src/forCli.ts': 'export const forCli: string = "cli";',
    'apps/ui/src/entry.ts': 'export { forUi } from "../../server/src/forUi";',
    'apps/cli/src/entry.ts': 'export { forCli } from "../../server/src/forCli";',
  };
  for (const [app, projects] of Object.entries(appProjects)) {
    files[`apps/${app}/package.json`] = JSON.stringify({ name: `@fixture/${app}` });
    files[`apps/${app}/tsconfig.json`] = JSON.stringify({
      compilerOptions: { ...compilerOptions, paths: { '@/*': ['./src/*'] } },
      include: ['src/**/*.ts'],
    });
    files[`apps/${app}/src/entry.test.ts`] = 'export {};';
    if (app === 'ui') files['apps/ui/tsconfig.test.json'] = '{"files":["src/entry.test.ts"],"include":[]}';
    for (const [index, name] of projects.entries()) {
      files[`apps/${app}/tsconfig.${name}.json`] = JSON.stringify({
        extends: './tsconfig.json', files: [], include: [],
        compilerOptions: name.startsWith('test') ? {} : {
          noEmit: false, composite: true, emitDeclarationOnly: true, rootDir: '../..',
          disableSourceOfProjectReferenceRedirect: true, outDir: `node_modules/.cache/tsc/${name}`,
        },
        references: index ? [{ path: `./tsconfig.${projects[Math.min(index - 1, projects.length - 3)]}.json` }] : [],
      });
    }
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  await installUiTypecheckFixtureDependencies(t, ui);
  const rollingState = join(root, 'rolling-state');
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: 'true', HAPPIER_TYPECHECK_DISPATCHED: '1',
    HAPPIER_STACK_CANONICAL_HOME_DIR: root, HAPPIER_TYPESCRIPT_COMPILER: 'microsoft',
    HAPPIER_COMMIT_TYPECHECK_DIR: rollingState };
  delete env.HAPPIER_DEV_TARGET_EXECUTION;
  delete env.HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED;
  const runner = fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url));
  const child = (app, preload) => spawn(process.execPath, [
    ...(preload ? ['--import', preload] : []), runner, '--pretty', 'false',
    ...appProjects[app].flatMap(name => ['-p', `tsconfig.${name}.json`]),
  ], { cwd: join(root, 'apps', app), env, stdio: ['pipe', 'pipe', 'pipe'] });
  const observe = (process, milestone) => {
    let output = '';
    let reached;
    const ready = new Promise(resolve => { reached = resolve; });
    process.stdout.on('data', chunk => { output += chunk; });
    createInterface({ input: process.stderr }).on('line', line => {
      output += line + '\n';
      if (milestone(line)) reached(line);
    });
    const done = once(process, 'close').then(([status]) => {
      reached();
      return { status, output };
    });
    return { ready, done };
  };
  // Pause the first foreground compiler at its process boundary, after both
  // the declaration roots and consumer references have been prepared.
  const preload = join(root, 'pause-compiler.mjs');
  await writeFile(preload, `
    import { readSync } from 'node:fs';
    const write = process.stderr.write.bind(process.stderr);
    let blocked = false;
    process.stderr.write = (value, ...args) => {
      const result = write(value, ...args);
      if (!blocked && String(value).startsWith('[typescript] starting ')) {
        blocked = true;
        readSync(0, Buffer.alloc(1));
      }
      return result;
    };
  `);
  const first = child('ui', preload);
  const current = observe(first, line => line.startsWith('[typescript] starting '));
  let next;
  let waiting;
  try {
    const firstCompiler = await current.ready;
    assert.ok(firstCompiler, firstCompiler ? undefined : (await current.done).output);
    const { project } = JSON.parse(firstCompiler.slice('[typescript] starting '.length));
    assert.equal(dirname(project), join(root, 'apps', 'server'));
    const other = child('cli');
    other.stdin.end();
    next = observe(other, line => line.includes('waiting for finite project inputs'));
    waiting = await next.ready;
  } finally {
    first.stdin.end();
  }
  const [firstResult, secondResult] = await Promise.all([current.done, next?.done]);
  assert.equal(waiting, undefined, 'the second invocation queued for the finite project inputs');
  assert.equal(secondResult.status, 1, secondResult.output);
  assert.match(secondResult.output, /\[typecheck-failure\] project-input-admission:EWORKSPACEBUNDLELOCKBUSY/);
  const detail = /^\[typecheck-failure-detail\] (.+)$/m.exec(secondResult.output);
  assert.ok(detail, secondResult.output);
  const { message } = JSON.parse(detail[1]);
  assert.ok(message.includes(`pid=${first.pid} `), message);
  assert.match(message, /elapsedMs=\d+/);
  assert.ok(message.includes(join(rollingState, 'verdicts.log')), message);
  assert.doesNotMatch(secondResult.output, /\[typescript\] starting /);
  assert.equal(firstResult.status, 0, firstResult.output);

  const retry = child('cli');
  retry.stdin.end();
  const retryResult = await observe(retry, () => false).done;
  assert.equal(retryResult.status, 0, retryResult.output);
});
