import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { commitProducerClosure } from './commitProducerClosure.mjs';

// IMPL-MODEL 2026-11-16 20:22Z: require('@/assets/fonts/*.ttf') of tracked HEAD fonts was
// refused as "missing module": TypeScript resolution knows only modules, while the bundler
// loads tracked assets by path.
test('a tracked asset imported by path or path alias is present, an untracked one is missing', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'happier-closure-assets-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const write = async (path, content) => { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), content); };
  git('init', '--quiet');
  git('config', 'user.name', 'Closure Test');
  git('config', 'user.email', 'closure@example.invalid');
  await write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
    baseUrl: '.', paths: { '@/*': ['./src/*'] } }, include: ['src/**/*.ts'] }));
  await write('src/assets/fonts/Inter.ttf', 'font-bytes');
  await write('src/assets/logo.png', 'png-bytes');
  await write('src/index.ts', 'export const zero = 0;\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  await write('src/fonts.ts', [
    "export const inter = require('@/assets/fonts/Inter.ttf');",
    "import logo from './assets/logo.png';",
    "export const missing = require('@/assets/fonts/Absent.ttf');",
    'export { logo };', '',
  ].join('\n'));
  git('add', '-A');
  git('commit', '--quiet', '-m', 'consumer');
  const tree = git('rev-parse', 'HEAD').trim();
  const { findings } = commitProducerClosure({ repo, base, tree });
  assert.deepEqual(findings, ['missing module: src/fonts.ts -> @/assets/fonts/Absent.ttf']);
});
