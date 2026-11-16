import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { attributeBreakLane } from './break-attribution.mjs';

const heading = (at, from, kind = 'CLAIM') => `### ${at} UTC — ${from} → P03 ORCH — ${kind} — work`;

test('a break is attributed to the lane that named the uncommitted file or posted the blamed commit', async t => {
  const fixture = await createTempFixture(t, { prefix: 'break-attribution-' });
  const git = (...args) => execFileSync('git', args, { cwd: fixture.root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await mkdir(fixture.path('packages/protocol/src'), { recursive: true });
  await writeFile(fixture.path('packages/protocol/src/machineProvisioners.ts'), 'export const a = 1;\n');
  await writeFile(fixture.path('packages/protocol/src/index.ts'), 'export * from "./machineProvisioners";\n');
  git('add', '.');
  git('commit', '-qm', 'feat: provisioners');
  const sha = git('rev-parse', 'HEAD');
  const file = async path => ({ path, mtimeMs: (await stat(fixture.path(path))).mtimeMs });

  // Committed: the lane that posted the blamed commit, not a later discussant.
  const committedBoard = [
    `${heading('2026-11-16 09:00', 'LOAD-SENTINEL-1110', 'URGENT')}\n- ${sha.slice(0, 11)} broke it`,
    `${heading('2026-11-16 08:30', 'SANDBOX-LANE', 'RESULT')}\n${sha.slice(0, 11)} committed`,
    `${heading('2026-11-16 08:00', 'OTHER-LANE')}\nmachineProvisioners.ts`,
  ].join('\n');
  const committed = await attributeBreakLane({ repoDir: fixture.root, board: 'board', readBoard: async () => committedBoard,
    files: [await file('packages/protocol/src/machineProvisioners.ts')], module: 'packages/protocol/src/machineProvisioners.ts', line: 1 });
  assert.equal(committed?.lane, 'SANDBOX-LANE');

  // Uncommitted: the newest post naming the file at or before its write.
  await writeFile(fixture.path('packages/protocol/src/machineProvisioners.ts'), 'export const a = b;\n');
  const written = await file('packages/protocol/src/machineProvisioners.ts');
  const minute = iso => iso.slice(0, 16).replace('T', ' ');
  const before = minute(new Date(written.mtimeMs - 5 * 60_000).toISOString());
  const after = minute(new Date(written.mtimeMs + 10 * 60_000).toISOString());
  const dirtyBoard = [
    `${heading(after, 'DISCUSSING-LANE', 'ASK')}\npackages/protocol/src/machineProvisioners.ts is red`,
    `${heading(before, 'WRITER-LANE')}\nediting machineProvisioners.ts`,
  ].join('\n');
  const uncommitted = await attributeBreakLane({ repoDir: fixture.root, board: 'board', readBoard: async () => dirtyBoard,
    files: [written], module: written.path });
  assert.equal(uncommitted?.lane, 'WRITER-LANE');

  // A generic basename alone attributes nothing.
  await writeFile(fixture.path('packages/protocol/src/index.ts'), 'export * from "./missing";\n');
  const generic = await attributeBreakLane({ repoDir: fixture.root, board: 'board',
    readBoard: async () => `${heading(after, 'NOISY-LANE')}\nindex.ts`, files: [await file('packages/protocol/src/index.ts')] });
  assert.equal(generic, null);
});
