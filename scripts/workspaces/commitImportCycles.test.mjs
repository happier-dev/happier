import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { commitImportCycles } from './commitImportCycles.mjs';

// 2026-11-16: 6964ea8f1a3 closed registryItemsV1 -> registryThemeV1 -> themeProfiles -> registryItemsV1,
// and the unchanged themeProfiles.ts:65 read RegistryProvenanceV1Schema while evaluating: a TDZ crash
// found only by another lane's stack start. The commit gate refuses such a packet from Git objects.
async function scratchRepo(t) {
  const repo = await mkdtemp(join(tmpdir(), 'happier-import-cycles-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = async (path, lines) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), `${lines.join('\n')}\n`);
  };
  const commit = message => { git('add', '-A'); git('commit', '--quiet', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init', '--quiet');
  git('config', 'user.name', 'Cycle Test');
  git('config', 'user.email', 'cycle@example.invalid');
  await write('packages/pkg/package.json', [JSON.stringify({ name: '@scratch/pkg', type: 'module' })]);
  await write('packages/pkg/tsconfig.json', [JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler',
    baseUrl: '.', paths: { '@/*': ['./src/*'] } }, include: ['src/**/*.ts'] })]);
  return { repo, write, commit };
}

test('a packet closing a cycle over an unchanged eager read is refused with the cycle and the line', async t => {
  const { repo, write, commit } = await scratchRepo(t);
  await write('packages/pkg/src/provenance.ts', ['export const Provenance = { kind: "provenance" };']);
  await write('packages/pkg/src/profiles.ts', [
    "import { Provenance } from './provenance.js';",
    '',
    'export const Source = { provenance: Provenance };',
  ]);
  const base = commit('base');
  // The packet changes only provenance.ts: it now imports profiles (through the tsconfig alias), closing the cycle.
  await write('packages/pkg/src/provenance.ts', [
    "import { Source } from '@/profiles';",
    'export const Provenance = { kind: "provenance" };',
    'export function describe() { return Source; }',
  ]);
  const tree = commit('close the cycle');
  const { findings } = commitImportCycles({ repo, base, tree });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /packages\/pkg\/src\/profiles\.ts:3 reads Provenance from packages\/pkg\/src\/provenance\.ts while loading/);
  assert.match(findings[0], /Cycle: packages\/pkg\/src\/profiles\.ts -> packages\/pkg\/src\/provenance\.ts -> packages\/pkg\/src\/profiles\.ts/);
});

test('function-body and type-only cycles through the packet pass', async t => {
  const { repo, write, commit } = await scratchRepo(t);
  await write('packages/pkg/src/a.ts', ['export const A = 1;']);
  await write('packages/pkg/src/b.ts', ["import { A } from './a.js';", 'export function readA() { return A; }', 'export const B = 2;']);
  await write('packages/pkg/src/c.ts', ['export const C = 3;']);
  // C is read only in a type position, so TypeScript elides this import: no runtime edge.
  await write('packages/pkg/src/d.ts', ["import { C } from './c.js';", 'export const D: typeof C = 4;']);
  const base = commit('base');
  await write('packages/pkg/src/a.ts', ["import { B } from './b.js';", 'export const A = 1;', 'export function readB() { return B; }']);
  await write('packages/pkg/src/c.ts', ["import { type D } from './d.js';", 'export const C = 3;', 'export type Both = typeof D;']);
  const tree = commit('harmless cycles');
  assert.deepEqual(commitImportCycles({ repo, base, tree }).findings, []);
});

test('a packet joining a cycle whose eager read the base already had is not refused', async t => {
  const { repo, write, commit } = await scratchRepo(t);
  await write('packages/pkg/src/a.ts', ["import { B } from './b.js';", 'export const A = 1;', 'export const AB = B;']);
  await write('packages/pkg/src/b.ts', ["import { A } from './a.js';", "import { F } from './f.js';", 'export const B = 2;',
    'export function read() { return [A, F]; }']);
  await write('packages/pkg/src/f.ts', ['export const F = 3;']);
  const base = commit('base');
  await write('packages/pkg/src/f.ts', ["import { A } from './a.js';", 'export const F = 3;', 'export function readA() { return A; }']);
  const tree = commit('join');
  assert.deepEqual(commitImportCycles({ repo, base, tree }).findings, []);
});

test('an eager cycle already present at the base is not attributed to a packet touching it', async t => {
  const { repo, write, commit } = await scratchRepo(t);
  await write('packages/pkg/src/a.ts', ["import { B } from './b.js';", 'export const A = 1;', 'export const AB = B;']);
  await write('packages/pkg/src/b.ts', ["import { A } from './a.js';", 'export const B = 2;', 'export function readA() { return A; }']);
  const base = commit('base');
  await write('packages/pkg/src/a.ts', ["import { B } from './b.js';", 'export const A = 10;', 'export const AB = B;']);
  const tree = commit('touch');
  assert.deepEqual(commitImportCycles({ repo, base, tree }).findings, []);
});
