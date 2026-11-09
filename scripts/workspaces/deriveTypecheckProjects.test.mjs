import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { deriveTypecheckProjects, readTypecheckProject } from './deriveTypecheckProjects.mjs';
import { verifyTypeScriptProjectCoverage } from './prepareTypeScriptProjectBuild.mjs';
import { prepareReferencedTypecheckDeclarations } from './prepareReferencedTypecheckDeclarations.mjs';
import { prepareWorkspaceSourceTypecheckProjects } from './workspaceSourceTypecheck.mjs';
import { prepareUiTypecheckProjects } from '../../apps/ui/scripts/deriveTypecheckProjects.mjs';
import { deriveCliTypecheckProjects, prepareCliTypecheckProjects } from '../../apps/cli/scripts/deriveTypecheckProjects.mjs';
import { installUiTypecheckFixtureDependencies } from '../testing/lib/typecheckProjectFixture.mjs';

for (const failure of ['ENOENT', 'ENOTDIR', 'EISDIR']) {
  test(`public derivation handles a listed root changed before reading: ${failure}`, { skip: process.platform === 'win32' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'happier-compiler-vanished-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const names = ['foundation', 'services', 'core', 'source', 'test', 'test-ui'];
    await mkdir(join(root, 'src/vanished'), { recursive: true });
    await writeFile(join(root, 'src/kept.ts'), 'export const kept = 1;');
    await writeFile(join(root, 'src/kept.test.ts'), 'export const keptTest = 1;');
    await writeFile(join(root, 'src/shared.d.ts'), 'declare const shared: string;');
    const vanished = ['entry.ts', 'globals.d.ts', 'entry.test.ts'].map(name => join(root, 'src/vanished', name));
    for (const file of vanished) await writeFile(file, 'export {};');
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { noEmit: true, strict: true, types: [] }, include: ['src/**/*.ts'],
    }));
    const config = JSON.stringify({ extends: './tsconfig.json', files: [], include: [] });
    for (const name of names.slice(1)) await writeFile(join(root, `tsconfig.${name}.json`), config);
    const pipe = join(root, 'tsconfig.foundation.json');
    const staged = join(root, 'foundation.next.json');
    await writeFile(staged, config);
    assert.equal(spawnSync('mkfifo', [pipe]).status, 0);
    // Opening this real config pipe proves the original root list was read.
    // The writer changes real files before allowing derivation to continue.
    const writer = spawn(process.execPath, ['--input-type=module', '-e', `
      import { openSync, closeSync, writeSync, readFileSync, renameSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
      const [pipe, staged, directory, failure] = process.argv.slice(1);
      const fd = openSync(pipe, 'w');
      rmSync(directory, { recursive: true });
      if (failure === 'ENOTDIR') writeFileSync(directory, 'removed directory');
      if (failure === 'EISDIR') mkdirSync(directory + '/globals.d.ts', { recursive: true });
      renameSync(staged, pipe);
      writeSync(fd, readFileSync(pipe));
      closeSync(fd);
    `, pipe, staged, join(root, 'src/vanished'), failure], { stdio: 'ignore' });
    const writerDone = once(writer, 'exit');
    t.after(() => { if (writer.exitCode === null) writer.kill(); });
    const deriving = deriveCliTypecheckProjects(root);
    if (failure === 'EISDIR') {
      await assert.rejects(deriving, { code: 'EISDIR' });
      assert.equal((await writerDone)[0], 0);
      return;
    }
    const inventory = await deriving;
    assert.equal((await writerDone)[0], 0);
    const configs = await Promise.all(inventory.map(async ({ configPath }) => JSON.parse(await readFile(configPath, 'utf8'))));
    for (const file of vanished) {
      assert.ok(!inventory.baseline.fileNames.includes(file), 'vanished roots leave the selected baseline');
      assert.ok(configs.every(config => !config.files.includes(file)), 'no stale compiler files entry survives');
    }
    assert.ok(inventory.baseline.fileNames.includes(join(root, 'src/kept.ts')));
    await verifyTypeScriptProjectCoverage({ baselinePath: join(root, 'tsconfig.json'), baseline: inventory.baseline,
      projectPaths: inventory.map(project => project.configPath), cwd: root });
    const result = spawnSync(process.execPath, [new URL('./runTypeScriptCli.mjs', import.meta.url).pathname,
      ...inventory.flatMap(project => ['--project', project.configPath])], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  });
}

test('Vitest setup roots belong to the test program rather than source declarations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-setup-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/entry.ts'), 'export const entry = true;');
  await writeFile(join(root, 'src/vitestSetup.ts'), 'export const setup = true;');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: ['src/**/*.ts'] }));
  for (const name of ['foundation', 'services', 'core', 'source', 'test', 'test-ui']) await writeFile(join(root, `tsconfig.${name}.json`), JSON.stringify({ extends: './tsconfig.json', files: [], include: [] }));
  const inventory = await deriveCliTypecheckProjects(root);
  const owners = [];
  for (const project of inventory) {
    if (readTypecheckProject(project.configPath).parsed.fileNames.includes(join(root, 'src/vitestSetup.ts'))) owners.push(project.project);
  }
  assert.deepEqual(owners, ['test'], 'setup-only cross-app imports must not introduce a source declaration cycle');
});

test('compiler switches isolate internal declarations and keep references on the selected graph', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-typecheck-compiler-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'entry.ts'), 'export const entry = 1;');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { noEmit: true, types: [] }, files: ['entry.ts'],
  }));
  const sourceNames = ['foundation', 'core', 'source'];
  const testNames = ['test'];
  for (const [index, name] of [...sourceNames, ...testNames].entries()) {
    await writeFile(join(root, `tsconfig.${name}.json`), JSON.stringify({
      extends: './tsconfig.json', files: [],
      compilerOptions: { composite: true, noEmit: false, emitDeclarationOnly: true,
        outDir: `node_modules/.cache/tsc/${name}.declarations`,
        tsBuildInfoFile: `node_modules/.cache/tsc/${name}.tsbuildinfo` },
      references: index ? [{ path: `./tsconfig.${sourceNames[Math.min(index - 1, 2)]}.json` }] : [],
    }));
  }
  const previousCompiler = process.env.HAPPIER_TYPESCRIPT_COMPILER;
  t.after(() => {
    if (previousCompiler === undefined) delete process.env.HAPPIER_TYPESCRIPT_COMPILER;
    else process.env.HAPPIER_TYPESCRIPT_COMPILER = previousCompiler;
  });
  process.env.HAPPIER_TYPESCRIPT_COMPILER = 'microsoft';
  const microsoft = await deriveTypecheckProjects(root, { sourceNames, testNames });
  process.env.HAPPIER_TYPESCRIPT_COMPILER = 'tsrs';
  const rust = await deriveTypecheckProjects(root, { sourceNames, testNames });
  assert.notEqual(rust[0].configPath, microsoft[0].configPath);
  for (const [index, { configPath }] of rust.entries()) {
    const parsed = readTypecheckProject(configPath);
    assert.equal(parsed.parsed.options.outDir,
      `${readTypecheckProject(microsoft[index].configPath).parsed.options.outDir}.tsrs`);
    assert.deepEqual(parsed.config.references?.map(reference => reference.path) ?? [],
      index ? [rust[Math.min(index - 1, 2)].configPath] : []);
  }
});

test('app compiler programs resolve current workspace source over installed author-example copies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-author-example-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exampleDir = join(root, 'packages/plugin-sdk/examples/public-authoring');
  await mkdir(exampleDir, { recursive: true });
  await writeFile(join(exampleDir, 'package.json'), JSON.stringify({ name: '@example/public-authoring', type: 'module' }));
  await writeFile(join(exampleDir, 'usageCoach.ts'), 'export {};');
  const packages = [
    { name: '@happier-dev/plugin-sdk', directory: 'plugin-sdk', exports: {
      '.': './dist/index.d.ts', './actions': './dist/actions/index.d.ts', './manifest': './dist/manifest.d.ts',
    } },
    { name: '@happier-dev/plugin-ui', directory: 'plugin-ui', exports: {
      '.': './dist/index.d.ts', './presentation': './dist/presentation/index.d.ts',
    } },
  ];
  for (const pkg of packages) {
    const installed = join(exampleDir, 'node_modules', pkg.name);
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, 'package.json'), JSON.stringify({ name: pkg.name,
      exports: Object.fromEntries(Object.entries(pkg.exports).map(([name, target]) => [name, { types: target }])) }));
    const directory = join(root, 'packages', pkg.directory);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: pkg.name,
      exports: Object.fromEntries(Object.entries(pkg.exports).map(([name, target]) => [name, {
        'happier-source': target.replace('./dist/', './src/').replace('.d.ts', '.ts'), types: target,
      }])) }));
    for (const target of Object.values(pkg.exports)) {
      await mkdir(dirname(join(installed, target)), { recursive: true });
      await writeFile(join(installed, target), 'export declare const outdated: true;');
      const source = target.replace('./dist/', './src/').replace('.d.ts', '.ts');
      await mkdir(dirname(join(directory, source)), { recursive: true });
      await writeFile(join(directory, source), 'export const current = true;');
    }
  }
  for (const app of ['ui', 'cli', 'server']) {
    await mkdir(join(root, 'apps', app), { recursive: true });
    await writeFile(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  for (const app of ['ui', 'cli']) {
    const packageDir = join(root, 'apps', app);
    await mkdir(packageDir, { recursive: true });
    const authored = ts.parseConfigFileTextToJson('tsconfig.json',
      await readFile(new URL(`../../apps/${app}/tsconfig.json`, import.meta.url), 'utf8'));
    assert.equal(authored.error, undefined);
    await writeFile(join(packageDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: authored.config.compilerOptions, files: [join(exampleDir, 'usageCoach.ts')],
    }));
    const project = { project: 'tsconfig.json', authoredProject: 'tsconfig.json', args: ['--noEmit', '-p', 'tsconfig.json'] };
    await prepareWorkspaceSourceTypecheckProjects([project], packageDir);
    const { parsed: { options } } = readTypecheckProject(project.project);
    assert.ok(options.customConditions.includes('happier-source'));
    assert.equal(options.paths['@happier-dev/plugin-sdk/*'], undefined, 'old declaration wildcards cannot bypass source exports');
    for (const pkg of packages) for (const [subpath, target] of Object.entries(pkg.exports)) {
      const name = pkg.name + (subpath === '.' ? '' : subpath.slice(1));
      const resolved = ts.resolveModuleName(name, join(exampleDir, 'usageCoach.ts'), options, ts.sys).resolvedModule;
      assert.equal(resolved?.resolvedFileName,
        join(root, 'packages', pkg.directory, target.replace('./dist/', './src/').replace('.d.ts', '.ts')),
        `${app}: ${name} must use its canonical workspace source`);
    }
  }
});

test('CLI browser-library dependencies do not become the UI compiler owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-ui-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'apps/cli');
  const files = {
    'apps/cli/src/entry.ts': 'export const entry = true;',
    'apps/cli/src/node.test.ts': 'import { document } from "../../../packages/browser/src/document"; export { document };',
    'apps/cli/src/ui.test.ts': 'import { screen } from "../../browser-host/sources/screen"; import { document } from "../../../packages/browser/src/document"; export { screen, document };',
    'apps/browser-host/sources/screen.ts': 'export const screen: Element | null = null;',
    'packages/browser/src/document.ts': 'export const document: Document | null = null;',
    'apps/cli/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
      lib: ['ES2022'], jsx: 'react', paths: { '@/*': ['./src/*'] } }, include: ['src/**/*.ts'] }),
    'apps/browser-host/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'], jsx: 'react-jsx', customConditions: ['react-native'],
      paths: { '@/*': ['./sources/*'] } }, include: ['sources/**/*.ts'] }),
    'packages/browser/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM'], jsx: 'react' }, include: ['src/**/*.ts'] }),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  for (const name of ['foundation', 'services', 'core', 'source', 'test', 'test-ui']) {
    await writeFile(join(cli, `tsconfig.${name}.json`), JSON.stringify({
      extends: './tsconfig.json', files: [], include: [],
    }));
  }
  const inventory = await deriveCliTypecheckProjects(cli);
  const read = async name => JSON.parse(await readFile(inventory.find(project => project.project === name).configPath, 'utf8'));
  const node = await read('test');
  const ui = await read('test-ui');
  assert.ok(node.files.includes(join(cli, 'src/node.test.ts')), 'DOM declarations do not turn a Node test into UI composition');
  assert.ok(!ui.files.includes(join(cli, 'src/node.test.ts')));
  assert.ok(ui.files.includes(join(cli, 'src/ui.test.ts')));
  assert.equal(node.compilerOptions.lib, undefined, 'ordinary tests keep the authored CLI libraries');
  assert.deepEqual(ui.compilerOptions.lib, ['dom', 'dom.iterable', 'es2022'],
    'only additive libraries cross the host boundary; JSX and export conditions stay consumer-owned');
  const browser = inventory.foreignProjects.find(project => project.configPath === join(root, 'packages/browser/tsconfig.json'));
  assert.equal(browser, undefined, 'shared dependencies retain the consumer environment');
});

test('library-only dependency differences retain the consuming program environment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-program-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'apps/cli');
  const files = {
    'apps/cli/src/runtime.ts': 'export const run = () => 1;',
    'apps/cli/src/consumer.test.ts': 'import { run } from "../../../packages/browser/src/testkit/runtime.test-support"; import { document } from "../../../packages/browser/src/entry"; export { run, document };',
    'packages/browser/src/entry.ts': 'export { document } from "./excluded/document";',
    'packages/browser/src/excluded/document.ts': 'export const document: Document | null = null;',
    'packages/browser/src/testkit/runtime.test-support.ts': 'export { run } from "@/runtime";',
    'apps/cli/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
      lib: ['ES2022'], paths: { '@/*': ['./src/*'] } }, include: ['src/**/*.ts'] }),
    'packages/browser/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM'] }, files: ['src/entry.ts'], include: [], exclude: ['src/testkit/**', 'src/excluded/**'] }),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  for (const name of ['foundation', 'services', 'core', 'source', 'test', 'test-ui']) {
    await writeFile(join(cli, `tsconfig.${name}.json`), JSON.stringify({ extends: './tsconfig.json', files: [], include: [] }));
  }
  const inventory = await deriveCliTypecheckProjects(cli);
  const browser = inventory.foreignProjects.find(project => project.configPath === join(root, 'packages/browser/tsconfig.json'));
  assert.equal(browser, undefined, 'dependencies do not acquire package-owned declaration environments');
});

test('foreign declaration roots retain their transitive implementation membership', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-declaration-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'apps/cli');
  const server = join(root, 'apps/server');
  const files = {
    'apps/cli/src/entry.ts': 'export const entry = true;',
    'apps/cli/src/consumer.test.ts': 'export { value } from "../../server/sources/entry";',
    'apps/server/sources/entry.ts': 'export const value = true;',
    'apps/server/sources/renderer.ts': 'export { theme } from "@/environment";',
    'apps/server/sources/environment.ts': 'import type { Palette } from "./palette"; export const theme: Palette = { ink: "black" };',
    'apps/server/sources/palette.ts': 'export interface Palette { ink: string }',
    'apps/server/sources/unrelated.ts': 'export const unrelated = true;',
    ...Object.fromEntries(['ts', 'mts', 'cts'].map(extension => [
      `apps/server/sources/renderer.generated.d.${extension}`, 'export { theme } from "./renderer.js";',
    ])),
    'apps/cli/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
      types: [], paths: { '@/*': ['./src/*'] } }, include: ['src/**/*.ts'] }),
    'apps/server/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
      types: [], paths: { '@/*': ['./sources/*'] } }, include: ['sources/**/*'] }),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  for (const name of ['foundation', 'services', 'core', 'source', 'test', 'test-ui']) {
    await writeFile(join(cli, `tsconfig.${name}.json`), JSON.stringify({ extends: './tsconfig.json', files: [], include: [] }));
  }
  const inventory = await deriveCliTypecheckProjects(cli);
  const consumer = { project: inventory.find(item => item.project === 'test').configPath,
    authoredProject: join(cli, 'tsconfig.test.json') };
  const producers = await prepareReferencedTypecheckDeclarations([consumer], cli, inventory);
  const producer = producers.find(item => item.project.startsWith(server));
  const { config } = readTypecheckProject(producer.project);
  for (const file of ['renderer.generated.d.ts', 'renderer.generated.d.mts', 'renderer.generated.d.cts',
    'renderer.ts', 'environment.ts', 'palette.ts']) {
    assert.ok(config.files.includes(join(server, 'sources', file)), `${file} belongs to the declaration producer closure`);
  }
  assert.ok(!config.files.includes(join(server, 'sources/unrelated.ts')), 'unreached implementations stay outside the producer slice');
});

test('foreign declarations preserve consumer primary modules and genuine augmentations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-primary-modules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'apps/cli');
  const server = join(root, 'apps/server');
  const primary = join(cli, 'node_modules/@types/runtime/index.d.ts');
  const foreignPrimary = join(server, 'node_modules/@types/runtime/index.d.ts');
  const augmentation = join(server, 'sources/runtimeAugmentation.d.ts');
  const files = {
    'apps/cli/src/entry.ts': 'export const entry = true;',
    'apps/cli/src/consumer.test.ts': 'export { value } from "../../server/sources/entry";',
    'apps/cli/node_modules/@types/runtime/package.json': '{"name":"@types/runtime","version":"1.0.0","types":"index.d.ts"}',
    'apps/cli/node_modules/@types/runtime/index.d.ts': 'declare module "host-events" { export class EventEmitter { once(): void; } }',
    'apps/server/node_modules/@types/runtime/package.json': '{"name":"@types/runtime","version":"2.0.0","types":"index.d.ts"}',
    'apps/server/node_modules/@types/runtime/index.d.ts': 'declare module "host-events" { export class EventEmitter { changed(): void; } }',
    'apps/server/sources/entry.ts': 'import "./runtimeAugmentation"; export const value = true;',
    'apps/server/sources/runtimeAugmentation.d.ts': 'export {}; declare module "host-events" { interface EventEmitter { addedByProducer(): void; } }',
    ...Object.fromEntries(['cli', 'server'].map(app => [`apps/${app}/tsconfig.json`, JSON.stringify({
      compilerOptions: { module: 'esnext', moduleResolution: 'bundler', lib: ['ES2022'],
        types: ['runtime'], typeRoots: ['./node_modules/@types'],
        paths: { '@/*': [app === 'cli' ? './src/*' : './sources/*'] } },
      include: [app === 'cli' ? 'src/**/*.ts' : 'sources/**/*'],
    })])),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  for (const name of ['foundation', 'services', 'core', 'source', 'test', 'test-ui']) {
    await writeFile(join(cli, `tsconfig.${name}.json`), JSON.stringify({ extends: './tsconfig.json', files: [], include: [] }));
  }
  const inventory = await deriveCliTypecheckProjects(cli);
  assert.ok(inventory.consumerPrimaryAmbientInputs.get(join(cli, 'tsconfig.test.json')).includes(primary));
  const consumer = { project: inventory.find(item => item.project === 'test').configPath,
    authoredProject: join(cli, 'tsconfig.test.json') };
  const producers = await prepareReferencedTypecheckDeclarations([consumer], cli, inventory);
  const prepared = readTypecheckProject(consumer.project);
  assert.ok(!prepared.config.files.includes(foreignPrimary),
    'a producer must not replace consumer-owned ambient module definitions with another installed version');
  assert.ok(prepared.config.files.includes(augmentation), 'a genuine external module augmentation remains reachable');
  const producer = producers.find(item => item.project.startsWith(server));
  assert.ok(readTypecheckProject(producer.project).config.files.includes(foreignPrimary),
    'the producer still compiles against its own primary type definitions');
});

test('foreign ambient implementation roots stay in their producer program', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-ambient-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'apps/cli');
  const server = join(root, 'apps/server');
  const files = {
    'apps/cli/src/entry.ts': 'export const entry = true;',
    'apps/cli/src/consumer.test.ts': 'import { value } from "../../server/sources/entry"; export { value };',
    'apps/server/sources/entry.ts': 'export const value = true;',
    'apps/server/sources/runtime.ts': 'export const marker = "server";',
    'apps/server/sources/globals.ts': 'import { marker } from "@/runtime"; declare global { var serverMarker: typeof marker; }',
    'apps/cli/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
      lib: ['ES2022'], paths: { '@/*': ['./src/*'] } }, include: ['src/**/*.ts'] }),
    'apps/server/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
      lib: ['ES2022'], paths: { '@/*': ['./sources/*'] } }, include: ['sources/**/*.ts'] }),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  for (const name of ['foundation', 'services', 'core', 'source', 'test', 'test-ui']) {
    await writeFile(join(cli, `tsconfig.${name}.json`), JSON.stringify({ extends: './tsconfig.json', files: [], include: [] }));
  }
  const inventory = await deriveCliTypecheckProjects(cli);
  const project = { project: inventory.find(item => item.project === 'test').configPath,
    authoredProject: join(cli, 'tsconfig.test.json') };
  const producers = await prepareReferencedTypecheckDeclarations([project], cli, inventory);
  const consumer = JSON.parse(await readFile(project.project, 'utf8'));
  assert.ok(!consumer.files.includes(join(server, 'sources/globals.ts')),
    'a raw ambient implementation must not acquire the consumer private namespace');
  const producer = producers.find(item => item.project.startsWith(server));
  const producerConfig = JSON.parse(await readFile(producer.project, 'utf8'));
  assert.ok(producerConfig.files.includes(join(server, 'sources/globals.ts')),
    'the producer keeps its real ambient environment without making it a consumer global');
  assert.ok(consumer.references.some(reference => reference.path === producer.project));
});

for (const [app, prepare, names] of [
  ['ui', prepareUiTypecheckProjects, ['foundation', 'core', 'source', 'test-components', 'test-other']],
  ['cli', prepareCliTypecheckProjects, ['foundation', 'services', 'core', 'source', 'test', 'test-ui']],
]) {
  test(`${app} public typecheck preparation removes deleted membership on every invocation`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'happier-compiler-membership-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packageDir = join(root, app);
    await mkdir(join(packageDir, 'src'), { recursive: true });
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: `membership-${app}` }));
    let assertPrivateOutputs;
    if (app === 'ui') {
      // Expo config is a real installed boundary; this fixture does not enable typed routes.
      assertPrivateOutputs = await installUiTypecheckFixtureDependencies(t, packageDir);
      await writeFile(join(packageDir, 'app.json'), JSON.stringify({ expo: { name: 'Membership', slug: 'membership' } }));
    }
    await writeFile(join(packageDir, 'src/kept.ts'), 'export const kept = 1;');
    await writeFile(join(packageDir, 'src/deleted.ts'), 'export const deleted = 1;');
    await writeFile(join(packageDir, 'src/deleted.test.ts'), 'export const deletedTest = 1;');
    await writeFile(join(packageDir, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
    for (const name of new Set([...names, 'test'])) await writeFile(join(packageDir, `tsconfig.${name}.json`), JSON.stringify({
      extends: './tsconfig.json', files: name.startsWith('test') ? ['src/deleted.test.ts'] : ['src/deleted.ts'], include: [],
    }));
    const manifest = JSON.parse(await readFile(new URL(`../../apps/${app}/package.json`, import.meta.url), 'utf8'));
    // Consume the actual public owner's finite command, so a stale entrypoint cannot bypass preparation unnoticed.
    const projects = () => [...manifest.scripts['typecheck:source:finite'].matchAll(/--project (\S+)/g)].map(([, project]) => ({
      project, args: ['--project', project],
    }));
    const initial = await prepare(projects(), packageDir);
    assert.ok(initial, 'the public project set must reach preparation');
    await assertPrivateOutputs?.(initial);
    const membership = async inventory => (await Promise.all(inventory.map(async ({ configPath }) => JSON.parse(await readFile(configPath, 'utf8')).files))).flat();
    assert.ok((await membership(initial)).includes(resolve(packageDir, 'src/deleted.ts')));
    // A moving checkout can gain roots after derivation selected this program.
    // Check the admitted roots now; the next invocation must admit the additions.
    await writeFile(join(packageDir, 'src/added.ts'), 'export const added = 1;');
    await writeFile(join(packageDir, 'src/added.test.ts'), 'export const addedTest = 1;');
    await verifyTypeScriptProjectCoverage({
      baselinePath: join(packageDir, 'tsconfig.json'),
      baseline: initial.baseline,
      projectPaths: initial.map(({ configPath }) => configPath), cwd: packageDir,
    });
    await rm(join(packageDir, 'src/deleted.ts'));
    await rm(join(packageDir, 'src/deleted.test.ts'));
    const nextProjects = projects();
    const next = await prepare(nextProjects, packageDir);
    await assertPrivateOutputs?.(next);
    const files = await membership(next);
    assert.ok(files.includes(resolve(packageDir, 'src/kept.ts')), 'valid source remains checked');
    for (const name of ['added.ts', 'added.test.ts']) assert.equal(
      files.filter(file => file === resolve(packageDir, 'src', name)).length, 1,
      'the next invocation assigns each newly added source and test exactly once');
    assert.ok(!files.includes(resolve(packageDir, 'src/deleted.ts')), 'deleted implementation leaves membership');
    assert.ok(!files.includes(resolve(packageDir, 'src/deleted.test.ts')), 'deleted explicit test leaves membership');
    for (const project of nextProjects) assert.equal(project.args[1], project.project, 'compiler arguments consume the regenerated projection');
  });
}

test('dependency partitions keep cycles whole and prerequisites before their consumers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'src/leaf.ts': 'export * as providers from "../dependency/providerNamespace.js"; export const leaf = 1;',
    'dependency/providerNamespace.ts': 'export const provider = 1;',
    'src/service.ts': 'import { leaf } from "./leaf"; export const service = leaf;',
    'src/a.ts': 'import "./b"; import "./service";',
    'src/b.ts': 'import "./c";',
    'src/c.ts': 'import "./a";',
    'src/entry.ts': 'import "./a";',
    'src/configConsumer.ts': 'import "../vitest.config";',
    'vitest.config.ts': 'import "./src/leaf"; export const config = true;',
    'src/new.test.ts': 'import "./entry";',
    'src/globals.d.ts': 'declare const shared: string;',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'esnext' }, include: ['src/**/*', 'vitest.config.ts'] }));
  const names = ['foundation', 'services', 'core', 'source', 'test'];
  for (const [index, name] of names.entries()) await writeFile(join(root, `tsconfig.${name}.json`), JSON.stringify({
    extends: './tsconfig.json', files: name === 'test' ? ['src/globals.d.ts', 'vitest.config.ts'] : ['src/globals.d.ts'], include: [],
    references: names.slice(0, index).map(previous => ({ path: `./tsconfig.${previous}.json` })),
  }));
  const inventory = await deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'] });
  const configs = await Promise.all(inventory.map(async ({ configPath }) => JSON.parse(await readFile(configPath, 'utf8'))));
  const owned = path => configs.findIndex(config => config.files.includes(resolve(root, path)));
  for (const path of Object.keys(files).filter(path => !path.endsWith('.d.ts'))) assert.equal(configs.filter(config => config.files.includes(resolve(root, path))).length, 1, path);
  assert.equal(owned('src/leaf.ts'), 0);
  assert.ok(owned('dependency/providerNamespace.ts') <= owned('src/leaf.ts'),
    'namespace re-exports outside the authored root glob join the prerequisite closure');
  assert.equal(owned('src/service.ts'), 1);
  for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) assert.equal(owned(path), 2, path);
  assert.equal(owned('src/entry.ts'), 3);
  assert.equal(owned('src/new.test.ts'), 4);
  assert.ok(owned('vitest.config.ts') <= owned('src/configConsumer.ts') && owned('vitest.config.ts') < 4,
    'an explicitly test-listed dependency belongs to its source prerequisite, not a second test program');
  assert.ok(configs.every(config => config.files.includes(resolve(root, 'src/globals.d.ts'))));
  assert.equal(configs[3].references[2].path, inventory[2].configPath, 'references consume the derived producer graph');
  await deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'], check: true });
  await deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'], writeAuthored: true });
  const authoredSource = JSON.parse(await readFile(join(root, 'tsconfig.source.json'), 'utf8'));
  assert.ok(authoredSource.files.includes('src/entry.ts'), 'explicit regeneration refreshes tracked membership through the same graph owner');
  assert.deepEqual(authoredSource.references, names.slice(0, 3).map(name => ({ path: `./tsconfig.${name}.json` })), 'authored references retain portable paths');
  await writeFile(join(root, 'src/new-entry.ts'), 'import "./entry";');
  await assert.rejects(deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'], check: true }), /need regeneration/);
});

test('large dependency edge lists retain exact compiler ownership without variadic calls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-large-edges-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  // Repeated edges reproduce the VM argument ceiling with a small real file graph.
  await writeFile(join(root, 'src/entry.ts'), 'import "./leaf";\n'.repeat(200_000));
  await writeFile(join(root, 'src/leaf.ts'), 'import "./entry"; export const leaf = true;');
  await writeFile(join(root, 'src/entry.test.ts'), 'import "./entry";');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'esnext', moduleResolution: 'bundler', types: [] }, include: ['src/**/*.ts'],
  }));
  const names = ['foundation', 'core', 'source', 'test'];
  for (const name of names) await writeFile(join(root, `tsconfig.${name}.json`), JSON.stringify({
    extends: './tsconfig.json', include: [], files: [name === 'test' ? 'src/entry.test.ts' : 'src/entry.ts'],
  }));
  const inventory = await deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'] });
  const configs = await Promise.all(inventory.map(async ({ configPath }) => JSON.parse(await readFile(configPath, 'utf8'))));
  for (const path of ['src/entry.ts', 'src/leaf.ts', 'src/entry.test.ts']) {
    assert.equal(configs.filter(config => config.files.includes(join(root, path))).length, 1, path);
  }
  assert.ok(configs[names.indexOf('core')].files.includes(join(root, 'src/leaf.ts')));
  assert.ok(configs[names.indexOf('core')].files.includes(join(root, 'src/entry.ts')));
  assert.ok(configs[names.indexOf('test')].files.includes(join(root, 'src/entry.test.ts')));
});

test('explicit legacy test membership cannot re-add excluded cross-app composition', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-composition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'fixtures'), { recursive: true });
  await writeFile(join(root, 'src/entry.ts'), 'export const entry = true;');
  await writeFile(join(root, 'src/bridge.composed.test.ts'), 'import "../foreign/peer";');
  await writeFile(join(root, 'fixtures/ordinary.test.ts'), 'import "../src/entry";');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'], exclude: ['**/*.composed.*'] }));
  const names = ['foundation', 'core', 'source', 'test'];
  for (const name of names) await writeFile(join(root, `tsconfig.${name}.json`), JSON.stringify({
    extends: './tsconfig.json', include: [], files: name === 'test'
      ? ['fixtures/ordinary.test.ts', 'src/bridge.composed.test.ts'] : ['src/entry.ts'],
  }));
  const inventory = await deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'] });
  const files = (await Promise.all(inventory.map(async ({ configPath }) => JSON.parse(await readFile(configPath, 'utf8')).files))).flat();
  assert.ok(!files.includes(join(root, 'src/bridge.composed.test.ts')), 'legacy explicit files must not bypass composition isolation');
  assert.equal(files.filter(file => file === join(root, 'fixtures/ordinary.test.ts')).length, 1,
    'ordinary explicit tests outside editor include globs must remain checked');
});

test('foreign source ownership does not parse a published dependency build config', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-vendor-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules/published'), { recursive: true });
  await writeFile(join(root, 'src/entry.ts'), 'import type { Published } from "published"; export const value: Published = { value: 1 };');
  await writeFile(join(root, 'src/consumer.test.ts'), 'import { value } from "./entry"; export { value };');
  await writeFile(join(root, 'node_modules/published/package.json'), JSON.stringify({ name: 'published', types: './index.d.ts' }));
  await writeFile(join(root, 'node_modules/published/index.d.ts'), 'export interface Published { value: number }');
  // Distribution declarations are consumed as published; their author's
  // private build configuration is not part of the consumer compiler graph.
  await writeFile(join(root, 'node_modules/published/tsconfig.json'), JSON.stringify({ extends: '../missing-build-config.json' }));
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'esnext' }, include: ['src/**/*.ts'] }));
  const names = ['foundation', 'core', 'source', 'test'];
  for (const name of names) await writeFile(join(root, `tsconfig.${name}.json`), JSON.stringify({
    extends: './tsconfig.json', include: [], files: [name === 'test' ? 'src/consumer.test.ts' : 'src/entry.ts'],
  }));
  const inventory = await deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'], resolveSourceOwners: true });
  assert.deepEqual(inventory.foreignProjects, []);
});

for (const allowJs of [false, true]) test(`imported JavaScript joins compiler ownership only when allowJs is ${allowJs}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-javascript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/entry.ts'), 'import "./leaf.mjs"; import "./legacy.cjs"; import "./plain.js"; import "untyped-dependency"; import "typed-dependency";');
  for (const name of ['leaf.mjs', 'legacy.cjs', 'plain.js']) await writeFile(join(root, 'src', name),
    name.endsWith('.cjs') ? 'module.exports = { value: 1 };' : 'export const value = 1;');
  const dependencyDir = join(root, 'node_modules/untyped-dependency');
  await mkdir(dependencyDir, { recursive: true });
  await writeFile(join(dependencyDir, 'package.json'), JSON.stringify({ name: 'untyped-dependency', main: './index.js' }));
  await writeFile(join(dependencyDir, 'index.js'), 'module.exports = { dependency: true };');
  const typedDependencyDir = join(root, 'node_modules/typed-dependency');
  await mkdir(typedDependencyDir, { recursive: true });
  await writeFile(join(typedDependencyDir, 'package.json'), JSON.stringify({ name: 'typed-dependency', types: './index.d.ts',
    exports: { '.': './index.d.ts', './runtime.js': './runtime.js' },
  }));
  // RN's ambient declarations self-reference runtime subpaths. Module
  // resolution marks those as internal even though their bytes are vendor JS.
  await writeFile(join(typedDependencyDir, 'index.d.ts'), 'declare module "typed-dependency/runtime.js" { export interface Runtime {} } '
    + 'declare module "typed-dependency/facade" { import { Runtime } from "typed-dependency/runtime.js"; export const value: Runtime; }');
  await writeFile(join(typedDependencyDir, 'runtime.js'), 'module.exports = { dependency: true };');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { allowJs, moduleResolution: 'bundler', module: 'esnext' }, include: ['src/**/*.ts'],
  }));
  const names = ['foundation', 'core', 'source', 'test'];
  for (const name of names) await writeFile(join(root, `tsconfig.${name}.json`), JSON.stringify({
    extends: './tsconfig.json', files: name === 'test' ? [] : ['src/entry.ts'], include: [],
  }));
  const inventory = await deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'] });
  const files = (await Promise.all(inventory.map(async ({ configPath }) => JSON.parse(await readFile(configPath, 'utf8')).files))).flat();
  assert.ok(files.includes(join(root, 'src/entry.ts')));
  for (const name of ['leaf.mjs', 'legacy.cjs', 'plain.js']) assert.equal(files.filter(file => file === join(root, 'src', name)).length,
    allowJs ? 1 : 0, `${name} must follow the owning project's JavaScript contract`);
  assert.ok(!files.includes(join(dependencyDir, 'index.js')), 'dependency JavaScript must not become authored emission roots');
  assert.ok(!files.includes(join(typedDependencyDir, 'runtime.js')),
    'self-referenced dependency JavaScript must not become authored emission roots');
});
