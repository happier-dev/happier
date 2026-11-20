// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { createDependencyGeneration, flipDependencyGeneration } from '../../apps/stack/scripts/utils/proc/dependency_generations.mjs';
import { prepareCliTypecheckProjects } from '../../apps/cli/scripts/deriveTypecheckProjects.mjs';
import { prepareUiTypecheckProjects } from '../../apps/ui/scripts/deriveTypecheckProjects.mjs';
import { installUiTypecheckFixtureDependencies } from '../testing/lib/typecheckProjectFixture.mjs';
import { readTypecheckProject } from './deriveTypecheckProjects.mjs';
import { prepareWorkspaceSourceTypecheckProjects } from './workspaceSourceTypecheck.mjs';

test('selected compiler inputs survive dependency generation replacement', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-typecheck-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  };
  await put('package.json', { private: true });
  await put('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n");
  for (const app of ['cli', 'ui', 'server']) await put(`apps/${app}/package.json`, { name: `@fixture/${app}` });
  const groups = [
    ['cli', prepareCliTypecheckProjects, ['foundation', 'services', 'core', 'source', 'test', 'test-ui']],
    ['ui', prepareUiTypecheckProjects, ['foundation', 'core', 'source', 'test-components', 'test-other']],
  ];
  for (const [app, , names] of groups) {
    await put(`apps/${app}/node_modules/@types/fixture-private/index.d.ts`, `interface PrivateAmbient { owner: '${app}' }`);
    await put(`apps/${app}/src/entry.ts`, 'export const value = true;');
    await put(`apps/${app}/tsconfig.json`, { compilerOptions: { types: [], noEmit: true }, include: ['src/**/*.ts'] });
    for (const [index, name] of [...new Set([...names, 'test'])].entries()) {
      await put(`apps/${app}/tsconfig.${name}.json`, { extends: './tsconfig.json', files: [], include: [],
        compilerOptions: index < names.length - 2 ? { composite: true, noEmit: false, declaration: true,
          emitDeclarationOnly: true, rootDir: root, disableSourceOfProjectReferenceRedirect: true,
          outDir: `node_modules/.cache/tsc/${name}.declarations`,
          tsBuildInfoFile: `node_modules/.cache/tsc/${name}.tsbuildinfo` } : {},
        references: index > 0 && index < names.length ? [{ path: `./tsconfig.${names[index - 1]}.json` }] : [],
      });
    }
  }
  await put('apps/ui/app.json', { expo: { name: 'Generation', slug: 'generation', experiments: { typedRoutes: true } } });
  await put('apps/ui/metro.config.js', 'module.exports = { resolver: { blockList: [] } };');
  await put('apps/ui/app/index.tsx', 'export default function Route() {}');
  await installUiTypecheckFixtureDependencies(t, join(root, 'apps/ui'));
  const selected = [];
  for (const [app, prepare, names] of groups) {
    const projects = names.map(name => {
      const project = join(root, `apps/${app}/tsconfig.${name}.json`);
      return { project, authoredProject: project, args: ['--project', project] };
    });
    await prepare(projects, join(root, `apps/${app}`));
    selected.push(...projects);
  }
  const initial = selected.map(project => readTypecheckProject(project.project));
  const assertPrivateTypes = () => {
    for (const project of selected) {
      const { parsed } = readTypecheckProject(project.project);
      const reference = ts.resolveTypeReferenceDirective('fixture-private', project.project, parsed.options, ts.sys).resolvedTypeReferenceDirective;
      assert.ok(reference, `generated configs retain the authored package's ambient type roots: ${project.authoredProject}`);
    }
  };
  assertPrivateTypes();
  const route = initial.flatMap(project => project.parsed.fileNames).find(file => file.endsWith('/router.d.ts'));
  assert.ok(route, 'real Expo typed-route preparation must be selected');
  assert.ok((await readFile(route, 'utf8')).length > 0);
  // This is the dependency owner's real replacement, not a simulated unlink.
  const replaceDependencies = async () => {
    const generation = await createDependencyGeneration(root);
    for (const [app] of groups) {
      const ambient = join(generation.genRoot, `apps/${app}/node_modules/@types/fixture-private/index.d.ts`);
      await mkdir(dirname(ambient), { recursive: true });
      await writeFile(ambient, `interface PrivateAmbient { owner: '${app}' }`);
    }
    await flipDependencyGeneration(root, generation);
  };
  await replaceDependencies();
  for (const project of selected) readTypecheckProject(project.project);
  assertPrivateTypes();
  assert.ok((await readFile(route, 'utf8')).length > 0, 'the selected route declaration survives replacement');
  await put('apps/server/index.ts', 'export const publicOutput = true;');
  await put('apps/server/tsconfig.json', { compilerOptions: { types: [], declaration: true,
    emitDeclarationOnly: true, incremental: true, outDir: 'dist',
    tsBuildInfoFile: 'node_modules/.cache/happier/server.tsbuildinfo' }, files: ['index.ts'] });
  const authored = join(root, 'apps/server/tsconfig.json');
  const publicProject = { project: authored, authoredProject: authored, args: ['--project', authored] };
  selected.push(publicProject);
  // Preparation reads the selected configs after declaration publication, which
  // can refresh dependencies. Its wrapper configs must survive the next flip too.
  await prepareWorkspaceSourceTypecheckProjects(selected, root);
  assert.equal(readTypecheckProject(publicProject.project).parsed.options.outDir, join(root, 'apps/server/dist'),
    'public declaration outputs retain their authored publication owner');
  const outputs = [];
  for (const project of selected) {
    const { parsed } = readTypecheckProject(project.project);
    if (parsed.options.outDir) outputs.push(join(parsed.options.outDir, 'selected.d.ts'));
    if (parsed.options.tsBuildInfoFile) outputs.push(parsed.options.tsBuildInfoFile);
  }
  for (const path of outputs) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'compiler-owned output'); }
  await replaceDependencies();
  for (const project of selected) {
    const { config } = readTypecheckProject(project.project);
    for (const reference of config.references ?? []) readTypecheckProject(reference.path);
  }
  for (const path of [...outputs, route]) assert.ok((await readFile(path, 'utf8')).length > 0, path);
});
