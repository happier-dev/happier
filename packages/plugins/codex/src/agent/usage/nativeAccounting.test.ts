import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createCodexExternalSessionsContribution } from '../surfaces/sessions/external/contribution.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it('retains separate legacy records when a rewritten source reuses a native Session and byte position', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'happier-codex-accounting-')); roots.push(homePath);
  const dir = join(homePath, 'sessions'); await mkdir(dir);
  const file = join(dir, 'rollout.jsonl');
  const snapshot = (input: number, timestamp: string) => [
    { type: 'session_meta', payload: { id: 'codex-native' }, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'turn_context', payload: { turn_id: 'turn-native', model: 'gpt-5' }, timestamp: '2026-01-01T00:00:01.000Z' },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 2 } } }, timestamp },
  ].map((record) => JSON.stringify(record) + '\n').join('');
  const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: homePath } });
  const request = { source: { kind: 'codexHome', home: 'user', homePath }, signal: new AbortController().signal };
  await writeFile(file, snapshot(100, '2026-01-01T00:00:02.000Z'));
  const initial = await contribution.readAccounting?.(request);
  if (!initial?.ok || initial.value.outcome !== 'advanced') throw new Error('Initial accounting failed');
  await writeFile(file, snapshot(10, '2026-01-01T00:00:03.000Z'));
  expect(await contribution.readAccounting?.({ ...request, cursor: initial.value.nextCursor }))
    .toEqual({ ok: true, value: { outcome: 'gap_or_cursor_expired' } });
  const replaced = await contribution.readAccounting?.(request);
  if (!replaced?.ok || replaced.value.outcome !== 'advanced') throw new Error('Source replay failed');
  expect(initial.value.observations[0]?.observation.tokens?.total).toBe(102);
  expect(replaced.value.observations[0]?.observation.tokens?.total).toBe(12);
  expect(replaced.value.observations[0]?.observation.key).not.toBe(initial.value.observations[0]?.observation.key);
  expect(replaced.value.observations[0]?.inferenceId).toBeUndefined();
});
it('rejects last-only active-context usage instead of treating it as a paid inference delta', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'happier-codex-accounting-')); roots.push(homePath);
  const dir = join(homePath, 'sessions'); await mkdir(dir);
  await writeFile(join(dir, 'rollout.jsonl'), [
    { type: 'session_meta', payload: { id: 'codex-native' }, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }, timestamp: '2026-01-01T00:00:02.000Z' },
  ].map((value) => JSON.stringify(value) + '\n').join(''));
  expect(await createCodexExternalSessionsContribution({ env: { CODEX_HOME: homePath } }).readAccounting?.({
    source: { kind: 'codexHome', home: 'user', homePath }, signal: new AbortController().signal,
  })).toMatchObject({ ok: true, value: { coverage: { complete: false }, observations: [] } });
});
it('uses the pinned modern recorder native thread and response identities with its authoritative total', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'happier-codex-accounting-')); roots.push(homePath);
  const dir = join(homePath, 'archived_sessions'); await mkdir(dir);
  await writeFile(join(dir, 'rollout.jsonl'), [
    { type: 'session_meta', payload: { id: 'root-native' }, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'turn_context', payload: { turn_id: 'turn_1', model: 'gpt-5' }, timestamp: '2026-01-01T00:00:01.000Z' },
    { type: 'token_usage_record', payload: { thread_id: 'paid-thread', session_id: 'root-native', response_id: 'resp_1', turn_id: 'turn_1',
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 123 } }, timestamp: '2026-01-01T00:00:02.000Z' },
  ].map((value) => JSON.stringify(value) + '\n').join(''));
  expect(await createCodexExternalSessionsContribution({ env: { CODEX_HOME: homePath } }).readAccounting?.({
    source: { kind: 'codexHome', home: 'user', homePath }, signal: new AbortController().signal,
  })).toMatchObject({ ok: true, value: { outcome: 'advanced', coverage: { complete: true }, observations: [
    { nativeSessionId: 'paid-thread', inferenceId: 'resp_1', accounting: { inputIncludesCache: true, outputIncludesReasoning: true },
      observation: { scope: 'turn_delta', key: 'resp_1', tokens: { input: 100, output: 20, cacheRead: 40, reasoning: 5, total: 123 } } },
  ] } });
});
it('retains a native paid record without assigning another turn or thread model', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'happier-codex-accounting-')); roots.push(homePath);
  const dir = join(homePath, 'sessions'); await mkdir(dir);
  await writeFile(join(dir, 'rollout.jsonl'), [
    { type: 'session_meta', payload: { id: 'root-native' }, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'turn_context', payload: { turn_id: 'coding-turn', model: 'gpt-5' }, timestamp: '2026-01-01T00:00:01.000Z' },
    { type: 'token_usage_record', payload: { thread_id: 'other-thread', response_id: 'resp_other', turn_id: 'other-turn',
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }, timestamp: '2026-01-01T00:00:02.000Z' },
  ].map((value) => JSON.stringify(value) + '\n').join(''));
  expect(await createCodexExternalSessionsContribution({ env: { CODEX_HOME: homePath } }).readAccounting?.({
    source: { kind: 'codexHome', home: 'user', homePath }, signal: new AbortController().signal,
  })).toMatchObject({ ok: true, value: { outcome: 'advanced', coverage: { complete: false }, observations: [
    { nativeSessionId: 'other-thread', inferenceId: 'resp_other', observation: { modelId: null, cost: null, tokens: { total: 12 } } },
  ] } });
});
it('accounts the legacy counter grammar without adding cached input or reasoning twice', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'happier-codex-accounting-')); roots.push(homePath);
  const dir = join(homePath, 'sessions'); await mkdir(dir);
  const usage = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40, reasoning_output_tokens: 5 };
  await writeFile(join(dir, 'rollout.jsonl'), [
    { type: 'session_meta', payload: { id: 'codex-native', cwd: '/native/codex-project' }, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'turn_context', payload: { turn_id: 'turn-native', model: 'gpt-5' }, timestamp: '2026-01-01T00:00:01.000Z' },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } }, timestamp: '2026-01-01T00:00:02.000Z' },
  ].map((value) => JSON.stringify(value) + '\n').join(''));
  const result = await createCodexExternalSessionsContribution({ env: { CODEX_HOME: homePath } }).readAccounting?.({
    source: { kind: 'codexHome', home: 'user', homePath }, signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000, maxSerializedBytes: 100_000,
  });
  expect(result).toMatchObject({ ok: true, value: { outcome: 'advanced', observations: [{ nativeSessionId: 'codex-native',
    accounting: { inputIncludesCache: true, outputIncludesReasoning: true },
    project: { rootPath: '/native/codex-project' },
    observation: { provider: 'codex', tokens: { total: 120, input: 100, output: 20, cacheRead: 40, reasoning: 5 } } }] } });
});
