import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serverRoot = resolve(repoRoot, 'apps/server');

function readProject(name, packageRoot = serverRoot) {
  const project = ts.getParsedCommandLineOfConfigFile(resolve(packageRoot, name), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  assert.ok(project);
  assert.deepEqual(project.errors, []);
  return project;
}

function resolvesToTypeScriptSource(target) {
  const isSource = (path) => /\.(?:[cm]?ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path) && existsSync(path);
  return [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts')].some(isSource);
}

test('CLI editor roots keep composed fixtures outside its package compiler', () => {
  const cliRoot = resolve(repoRoot, 'apps/cli');
  const cli = readProject('tsconfig.json', cliRoot);
  assert.deepEqual(cli.fileNames.filter(file => file.includes('.composed.')), [],
    'CLI editor roots must honor the existing composition boundary');
  assert.ok(cli.fileNames.includes(resolve(cliRoot, 'src/index.ts')));
  assert.ok(cli.fileNames.some(file => file.endsWith('.test.ts')), 'Ordinary CLI tests remain checked');
});

test('UI compiler roots keep cross-app composition in its existing Vitest lanes', () => {
  const ui = readProject('tsconfig.json', resolve(repoRoot, 'apps/ui'));
  const crossAppEdges = [];
  for (const file of ui.fileNames) {
    const source = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName } of source.importedFiles) {
      if (!fileName.startsWith('.')) continue;
      const target = resolve(dirname(file), fileName);
      for (const app of ['cli', 'server']) {
        const appPath = relative(resolve(repoRoot, `apps/${app}`), target);
        if (appPath && appPath !== '..' && !appPath.startsWith(`..${sep}`) && !isAbsolute(appPath)) {
          crossAppEdges.push(`${relative(repoRoot, file)} -> ${fileName}`);
        }
      }
    }
  }
  assert.deepEqual(crossAppEdges, [], 'Cross-app fixtures must use the excluded .composed. convention');
  assert.ok(ui.fileNames.some(file => file.endsWith('.test.ts') || file.endsWith('.test.tsx')),
    'Ordinary UI tests remain in the developer compiler');
});

test('server compiler roots keep cross-app composition in the test-only project', () => {
  const server = readProject('tsconfig.json');
  const vitest = readProject('tsconfig.vitest.json');
  const crossAppEdges = [];
  const browserRoots = [];
  for (const file of server.fileNames) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    if (source.libReferenceDirectives.some(directive => directive.fileName === 'dom')) {
      browserRoots.push(relative(repoRoot, file));
    }
    function visit(node) {
      if (ts.isStringLiteralLike(node) && node.text.startsWith('.')) {
        const target = resolve(dirname(file), node.text);
        const isInside = (root) => {
          const path = relative(root, target);
          return Boolean(path) && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
        };
        // Another app, or TypeScript source from any other workspace package,
        // would join the server program outside its rootDir.
        if (isInside(repoRoot) && !isInside(serverRoot) && resolvesToTypeScriptSource(target)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          crossAppEdges.push(`${relative(repoRoot, file)}:${line + 1} -> ${node.text}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(crossAppEdges, [], 'Cross-app fixtures must use the excluded .composed. convention');
  assert.deepEqual(browserRoots, [], 'Browser globals must stay out of the Node server compiler');
  const composed = vitest.fileNames.filter(file => file.includes('.composed.'));
  assert.ok(composed.length > 0, 'Vitest must still resolve composed fixtures');
  assert.ok(composed.every(file => !server.fileNames.includes(file)));
  assert.ok(server.fileNames.some(file => file.endsWith('.test.ts') || file.endsWith('.spec.ts')),
    'Ordinary server tests remain in the developer compiler');
  const browser = readProject('tsconfig.publicViewer.json');
  const viewerDir = resolve(serverRoot, 'sources/app/api/routes/share');
  for (const name of ['publicShareViewerBrowser.ts', 'publicShareViewerClient.test.ts']) {
    assert.ok(browser.fileNames.includes(resolve(viewerDir, name)), `${name} must remain typechecked`);
    assert.ok(!server.fileNames.includes(resolve(viewerDir, name)));
  }
  assert.ok(browser.options.lib.includes('lib.dom.d.ts'));
});
