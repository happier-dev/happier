import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { readAgentAccountingJsonlSource } from './accountingJsonl.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const line = (id: string, total: number) => `${JSON.stringify({ id, total })}\n`;
// This filesystem-only fixture has no admitted process or managed API service.
const unavailableService = async () => { throw new Error('External service unavailable in JSONL fixture'); };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'happier-accounting-frontier-')); roots.push(root);
  const file = join(root, 'native.jsonl');
  await writeFile(file, line('first', 10));
  const read = (cursor?: string) => readAgentAccountingJsonlSource({ roots: [root], sourceKey: root,
    invocation: {
      signal: new AbortController().signal,
      managedEndpointRead: unavailableService,
      exec: {
        agentCli: { checkReadiness: unavailableService },
        systemTools: { resolve: unavailableService },
        run: unavailableService,
        spawn: unavailableService,
        clients: { spawn: unavailableService },
      },
      ripgrep: { run: unavailableService },
    }, ...(cursor ? { cursor } : {}),
    projectRecord(record, state) {
      if (!record || typeof record !== 'object' || !('id' in record) || typeof record.id !== 'string'
        || !('total' in record) || typeof record.total !== 'number') return { state, observations: [], incomplete: true };
      // This fixture grammar is the helper's real caller-supplied projection seam.
      return { state, observations: [{ nativeSessionId: 'native-session', observedAt: 1000,
        inferenceId: record.id, observation: { provider: 'fixture', source: 'native-jsonl', scope: 'turn_delta' as const,
          key: record.id, modelId: null,
          tokens: { input: record.total, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: record.total }, cost: null,
          contextUsedTokens: null, contextWindowTokens: null } }] };
    },
  });
  return { file, read };
}
it('rejects a larger same-inode rewrite before treating its suffix as appended accounting', async () => {
  const { file, read } = await setup();
  const initial = await read();
  if (!initial.ok || initial.value.outcome !== 'advanced') throw new Error('Accounting setup failed');
  expect(initial.value.observations[0]?.observation.tokens?.total).toBe(10);
  const before = await stat(file);
  await writeFile(file, line('rewritten-first', 20) + line('rewritten-second', 30));
  const after = await stat(file);
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBeGreaterThan(before.size);
  expect(await read(initial.value.nextCursor)).toEqual({ ok: true, value: { outcome: 'gap_or_cursor_expired' } });
  const replay = await read();
  expect(replay).toMatchObject({ ok: true, value: { outcome: 'advanced', observations: [
    { inferenceId: 'rewritten-first', observation: { tokens: { total: 20 } } },
    { inferenceId: 'rewritten-second', observation: { tokens: { total: 30 } } },
  ] } });
});
it('conserves ordinary append and a completed partial tail without replaying retained records', async () => {
  const { file, read } = await setup();
  await appendFile(file, '{"id":"second","total":20');
  const initial = await read();
  if (!initial.ok || initial.value.outcome !== 'advanced') throw new Error('Accounting setup failed');
  expect(initial.value.observations.map((row) => row.inferenceId)).toEqual(['first']);
  await appendFile(file, '}\n' + line('third', 30));
  const appended = await read(initial.value.nextCursor);
  expect(appended).toMatchObject({ ok: true, value: { outcome: 'advanced', observations: [
    { inferenceId: 'second' }, { inferenceId: 'third' },
  ] } });
  if (!appended.ok || appended.value.outcome !== 'advanced') return;
  expect(await read(appended.value.nextCursor)).toEqual({ ok: true, value: { outcome: 'unchanged' } });
});
