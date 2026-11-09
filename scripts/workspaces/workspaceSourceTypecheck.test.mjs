import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { prepareWorkspaceSourceTypecheckProjects, sourceTypecheckCompilerOptions } from './workspaceSourceTypecheck.mjs';
import { prepareCliTypecheckProjects } from '../../apps/cli/scripts/deriveTypecheckProjects.mjs';
import { prepareReferencedTypecheckDeclarations, orderTypecheckProjects } from './prepareReferencedTypecheckDeclarations.mjs';
import { createDistTypeScriptProjectConfig } from './buildTypeScriptPackageDist.mjs';

test('declaration preparation resolves producer self imports from source before replacing old output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-declaration-self-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const producer = join(root, 'producer');
  const configPath = join(producer, 'tsconfig.json');
  const files = {
    'package.json': JSON.stringify({ name: '@fixture/ui', exports: { './model': {
      'happier-source': './src/model.ts', types: './dist/model.d.ts', default: './dist/model.js',
    } } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler',
      types: [], target: 'ES2022', rootDir: 'src', outDir: 'dist', declaration: true }, include: ['src/**/*.ts'] }),
    'src/index.ts': 'import { value } from "@fixture/ui/model"; export const result = value;',
    'src/model.ts': 'export const value = "current";',
    'dist/model.d.ts': 'export declare const value: "stale";',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(producer, path)), { recursive: true });
    await writeFile(join(producer, path), content);
  }
  const project = join(root, 'declarations.json');
  await writeFile(project, JSON.stringify(createDistTypeScriptProjectConfig({ projectPath: configPath,
    compilerOptions: { emitDeclarationOnly: true, noCheck: true } })));
  const args = ['--project', project, '--pretty', 'false'];
  const env = buildNativeAdmissionFixtureEnv();
  const invocation = resolveTypeScriptCliInvocation({ args, workspaceDir: producer, env, invocationKind: 'build' });
  const admission = process.platform === 'linux' ? await installNativeAdmissionFixture({ root }) : null;
  const result = spawnSync(admission ? admission.launcher : invocation.command,
    [...invocation.argsPrefix, ...args, ...(invocation.argsSuffix ?? [])], { cwd: producer, env, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const { readFile } = await import('node:fs/promises');
  assert.match(await readFile(join(producer, 'dist/index.d.ts'), 'utf8'), /"current"/u,
    'emitted consumers must describe current source rather than stale self declarations');
});

test('a non-JSX server consumes its explicit UI declaration boundary without hiding server errors', async t => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-server-ui-boundary-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const server = join(repoRoot, 'apps/server');
  const ui = join(repoRoot, 'packages/plugin-ui');
  const configPath = join(server, 'tsconfig.json');
  const options = { noEmit: true, strict: true, module: 'ESNext', moduleResolution: 'Bundler', types: [],
    paths: {
      '@happier-dev/plugin-ui/*': ['../../packages/plugin-ui/dist/*/index.d.ts', '../../packages/plugin-ui/dist/*.d.ts'],
      '@happier-dev/plugin-ui/presentation/pageMetrics': ['../../packages/plugin-ui/dist/presentation/layout/pageMetrics.d.ts'],
    } };
  const files = {
    'apps/server/tsconfig.json': JSON.stringify({ compilerOptions: options, files: ['index.ts'] }),
    'apps/server/index.ts': 'import type { Profile } from "@happier-dev/plugin-ui/presentation";\nimport { width } from "@happier-dev/plugin-ui/presentation/pageMetrics";\ndeclare const profile: Profile;\nconst invalid: number = profile.title;\nexport const size = width;',
    'packages/plugin-ui/src/presentation/index.ts': 'export { view } from "./view.js"; export interface Profile { title: string }',
    'packages/plugin-ui/src/presentation/view.tsx': 'export const view = <panel />;',
    'packages/plugin-ui/dist/presentation/index.d.ts': 'export interface Profile { title: string }',
    'packages/plugin-ui/src/presentation/layout/pageMetrics.ts': 'export { view } from "../view.js"; export const width = 1;',
    'packages/plugin-ui/dist/presentation/layout/pageMetrics.d.ts': 'export declare const width: 1;',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repoRoot, path)), { recursive: true });
    await writeFile(join(repoRoot, path), content);
  }
  const project = join(server, 'source-tsconfig.json');
  await writeFile(project, JSON.stringify({ extends: configPath,
    compilerOptions: sourceTypecheckCompilerOptions({ ...options, noEmit: true }, configPath, {
      repoRoot, packageNames: new Set(['@happier-dev/plugin-ui']),
      paths: {
        '@happier-dev/plugin-ui/presentation': [join(ui, 'src/presentation/index.ts')],
        '@happier-dev/plugin-ui/presentation/pageMetrics': [join(ui, 'src/presentation/layout/pageMetrics.ts')],
      },
    }),
  }));
  const args = ['--project', project, '--pretty', 'false'];
  const env = buildNativeAdmissionFixtureEnv();
  const invocation = resolveTypeScriptCliInvocation({ args, workspaceDir: server, env });
  const admission = process.platform === 'linux' ? await installNativeAdmissionFixture({ root: repoRoot }) : null;
  const result = spawnSync(admission ? admission.launcher : invocation.command,
    [...invocation.argsPrefix, ...args, ...(invocation.argsSuffix ?? [])], { cwd: server, env, encoding: 'utf8' });
  assert.ifError(result.error);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 2, output);
  assert.match(output, /index\.ts\(4,7\): error TS2322:/, 'the server still checks its use of UI types');
  assert.doesNotMatch(output, /error TS6142:/, 'the server must not consume the UI implementation graph');
});

test('CLI partitions keep nested JSX packages and cross-host alias testkits in their compiler environments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-source-partition-options-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'apps/cli');
  const foreignDir = 'packages/plugin-sdk/fixtures/compiler-host';
  const common = { strict: true, types: [], module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', jsx: 'react', noEmit: true };
  const files = {
    'apps/cli/package.json': JSON.stringify({ name: '@fixture/cli' }),
    'apps/ui/package.json': JSON.stringify({ name: '@fixture/ui' }),
    'apps/server/package.json': JSON.stringify({ name: '@fixture/server' }),
    'apps/cli/tsconfig.json': JSON.stringify({ compilerOptions: { ...common, paths: { ...common.paths, '@/*': ['./src/*'] } }, include: ['src/**/*.ts'] }),
    'apps/cli/src/entry.ts': 'export const entry = true;',
    'apps/cli/src/daemon/model.ts': 'export const host = "cli";',
    'apps/cli/src/daemon/firstConversation.testkit.ts': 'export { host } from "@/daemon/model";',
    'apps/cli/src/consumer.test.ts': 'import { result } from "../../../packages/plugin-sdk/fixtures/compiler-host/sources/service"; import { values } from "../../other/sources/service"; export const checked = values.map(value => value.toFixed()) + result;',
    [`${foreignDir}/tsconfig.json`]: JSON.stringify({ compilerOptions: { ...common, paths: { ...common.paths, '@/*': ['./sources/*'] } }, include: ['sources/**/*.ts'] }),
    [`${foreignDir}/sources/service.ts`]: 'import { host } from "../../../../../apps/cli/src/daemon/firstConversation.testkit"; import { surface } from "@happier-dev/plugin-ui"; import { values } from "@happier-dev/shared"; import { nestedValue } from "../../../../../packages/shared/src/nestedOnly"; import { usingScript } from "../../../../../scripts/tooling.mjs"; export const result = usingScript(host + surface.kind + values.length + nestedValue);',
    'apps/other/tsconfig.json': JSON.stringify({ compilerOptions: { ...common, paths: { '@/*': ['./sources/*'] } }, include: ['sources/**/*.ts'] }),
    'apps/other/sources/service.ts': 'export { surface } from "@happier-dev/plugin-ui"; export { values } from "@happier-dev/shared";',
    'scripts/tooling.d.mts': 'export declare function usingScript(value: string): string;',
    'packages/plugin-ui/tsconfig.json': JSON.stringify({ compilerOptions: { ...common, jsx: 'react-jsx', jsxImportSource: 'fixture-jsx' }, include: ['src/**/*'] }),
    'packages/plugin-ui/package.json': JSON.stringify({ name: '@happier-dev/plugin-ui', exports: { '.': { 'happier-source': './src/surface.tsx', types: './dist/surface.d.ts' } } }),
    'packages/plugin-ui/src/surface.tsx': 'export { values } from "@happier-dev/shared"; export const surface = <panel />;',
    'packages/shared/tsconfig.json': JSON.stringify({ compilerOptions: common, include: ['src/**/*.ts'] }),
    'packages/shared/package.json': JSON.stringify({ name: '@happier-dev/shared', exports: { '.': { 'happier-source': './src/model.ts', types: './dist/model.d.ts' } } }),
    'packages/shared/src/model.ts': 'export const values: number[] = [];',
    'packages/shared/src/nestedOnly.ts': 'export const nestedValue = 1;',
    'node_modules/fixture-jsx/package.json': JSON.stringify({ name: 'fixture-jsx', exports: { './jsx-runtime': { types: './jsx-runtime.d.ts' } } }),
    'node_modules/fixture-jsx/jsx-runtime.d.ts': 'export namespace JSX { interface Element { kind: string } interface IntrinsicElements { panel: {} } }',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const names = ['foundation', 'services', 'core', 'source', 'test', 'test-ui'];
  for (const [index, name] of names.entries()) await writeFile(join(cli, `tsconfig.${name}.json`), JSON.stringify({
    extends: './tsconfig.json', files: [], include: [],
    compilerOptions: index < 4 ? { composite: true, noEmit: false, declaration: true, emitDeclarationOnly: true,
      rootDir: root, outDir: `node_modules/.cache/tsc/${name}.declarations`,
      tsBuildInfoFile: `node_modules/.cache/tsc/${name}.tsbuildinfo`, disableSourceOfProjectReferenceRedirect: true }
      : { noEmit: true, disableSourceOfProjectReferenceRedirect: true },
    references: names.slice(0, Math.min(index, 4)).map(previous => ({ path: `./tsconfig.${previous}.json` })),
  }));
  const projects = names.map(name => ({ project: join(cli, `tsconfig.${name}.json`),
    authoredProject: join(cli, `tsconfig.${name}.json`), args: ['--project', join(cli, `tsconfig.${name}.json`)] }));
  const inventory = await prepareCliTypecheckProjects(projects, cli);
  const producers = await prepareReferencedTypecheckDeclarations(projects, cli, inventory);
  const ordered = orderTypecheckProjects([...producers, ...projects], cli);
  await prepareWorkspaceSourceTypecheckProjects([...producers, ...projects], cli);
  const env = buildNativeAdmissionFixtureEnv();
  const admission = process.platform === 'linux' ? await installNativeAdmissionFixture({ root }) : null;
  const run = project => {
    const args = [...project.args, '--pretty', 'false'];
    const invocation = resolveTypeScriptCliInvocation({ args, workspaceDir: cli, env });
    const result = spawnSync(admission ? admission.launcher : invocation.command,
      [...invocation.argsPrefix, ...args, ...(invocation.argsSuffix ?? [])], { cwd: cli, env, encoding: 'utf8' });
    assert.ifError(result.error);
    return result;
  };
  const results = ordered.map(run);
  const output = results.map(result => `${result.stdout ?? ''}\n${result.stderr ?? ''}`).join('\n');
  assert.doesNotMatch(output, /error TS(?:17004|6142|6307|2307|6305|6059|7006):/, 'source projections must preserve referenced types, JSX, private aliases and complete composite membership');
  assert.ok(results.every(result => result.status === 0), output);
  await writeFile(join(root, foreignDir, 'sources/service.ts'), files[`${foreignDir}/sources/service.ts`] + '\nexport const invalid: string = 1;');
  const rejected = run(producers.find(project => project.authoredProject.startsWith(join(root, foreignDir))));
  assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr);
  assert.match(rejected.stdout + rejected.stderr, /service\.ts\(2,\d+\): error TS2322:/, 'the owner still checks real semantic errors strictly');
  const checked = ordered.map(run);
  const checkedOutput = checked.map(result => `${result.stdout ?? ''}\n${result.stderr ?? ''}`).join('\n');
  assert.doesNotMatch(checkedOutput, /error TS(?:6305|7006):/, 'a producer diagnostic must not erase referenced consumer types');
});

test('generated server source config accepts workspace sources and retains real diagnostics', async t => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-source-root-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const server = join(repoRoot, 'apps/server');
  const cache = join(server, 'node_modules/.cache/tsc');
  const shared = join(repoRoot, 'packages/shared');
  await mkdir(cache, { recursive: true });
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, 'index.ts'), 'export const value = 1;\n');
  await writeFile(join(server, 'index.ts'), 'import { value } from "../../packages/shared/index";\nconst wrong: string = value;\n');
  const configPath = join(server, 'tsconfig.json');
  await writeFile(configPath, JSON.stringify({
    compilerOptions: { noEmit: true, strict: true, module: 'ESNext', moduleResolution: 'Bundler', types: [],
      incremental: true, outDir: './dist', tsBuildInfoFile: './node_modules/.cache/tsc/server.tsbuildinfo' },
    files: ['index.ts'],
  }));
  const project = join(cache, 'source-tsconfig.json');
  await writeFile(project, JSON.stringify({ extends: configPath,
    compilerOptions: sourceTypecheckCompilerOptions({ noEmit: true }, configPath,
      { repoRoot, packageNames: new Set(), paths: {} }),
  }));
  // The selector owns the pinned typecheck compiler and its admission; checking
  // parsed options through the retained TypeScript API misses inferred roots.
  const args = ['--project', project, '--pretty', 'false'];
  const env = buildNativeAdmissionFixtureEnv();
  const invocation = resolveTypeScriptCliInvocation({ args, workspaceDir: server, env });
  const admission = process.platform === 'linux' ? await installNativeAdmissionFixture({ root: repoRoot }) : null;
  const result = spawnSync(admission ? admission.launcher : invocation.command,
    [...invocation.argsPrefix, ...args, ...(invocation.argsSuffix ?? [])],
    { cwd: server, env, encoding: 'utf8' });
  assert.ifError(result.error);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 2, output);
  assert.match(output, /error TS2322:/, 'the real assignment error remains visible');
  assert.doesNotMatch(output, /error TS6059:/, 'shared workspace source must be inside the generated noEmit root');
});
