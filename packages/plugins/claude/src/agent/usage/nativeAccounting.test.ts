import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createClaudeExternalSessionsContribution } from '../surfaces/sessions/external/contribution.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it('preserves distinct native record keys when assistant inference identity is unavailable', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'happier-claude-accounting-')); roots.push(configDir);
  const dir = join(configDir, 'projects', 'project'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'native-session.jsonl'), ['record-a', 'record-b'].map((uuid) => JSON.stringify({
    type: 'assistant', sessionId: 'native-session', uuid, timestamp: '2026-01-01T00:00:00.000Z',
    message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 10, output_tokens: 2 } },
  }) + '\n').join(''));
  const result = await createClaudeExternalSessionsContribution({ env: { CLAUDE_CONFIG_DIR: configDir } }).readAccounting?.({
    source: { kind: 'claudeConfig', configDir }, signal: new AbortController().signal,
  });
  if (!result?.ok || result.value.outcome !== 'advanced') throw new Error('Accounting setup failed');
  expect(result.value.observations.map((entry) => entry.observation.key)).toEqual(['record-a', 'record-b']);
  expect(result.value.coverage.complete).toBe(false);
  expect(result.value.observations.map((entry) => entry.inferenceId)).toEqual([undefined, undefined]);
});
it.each(['success', 'error_max_turns'])('marks a recognized %s result incomplete when its whole-call counters are missing', async (subtype) => {
  const configDir = await mkdtemp(join(tmpdir(), 'happier-claude-accounting-')); roots.push(configDir);
  const dir = join(configDir, 'projects', 'project'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'native-session.jsonl'), JSON.stringify({ type: 'result', subtype,
    session_id: 'native-session', uuid: 'native-result', timestamp: '2026-01-01T00:00:00.000Z',
    usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.1 }) + '\n');
  expect(await createClaudeExternalSessionsContribution({ env: { CLAUDE_CONFIG_DIR: configDir } }).readAccounting?.({
    source: { kind: 'claudeConfig', configDir }, signal: new AbortController().signal,
  })).toMatchObject({ ok: true, value: { coverage: { complete: false }, observations: [] } });
});
it('preserves the native whole-call estimate without attributing a multi-model summary to one model', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'happier-claude-accounting-')); roots.push(configDir);
  const dir = join(configDir, 'projects', 'project'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'native-session.jsonl'), JSON.stringify({ type: 'result', subtype: 'success',
    session_id: 'native-session', uuid: 'native-result', timestamp: '2026-01-01T00:00:00.000Z',
    usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.1,
    modelUsage: { 'claude-sonnet-4-6': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      'claude-haiku-4-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }) + '\n');
  expect(await createClaudeExternalSessionsContribution({ env: { CLAUDE_CONFIG_DIR: configDir } }).readAccounting?.({
    source: { kind: 'claudeConfig', configDir }, signal: new AbortController().signal,
  })).toMatchObject({ ok: true, value: { outcome: 'advanced', coverage: { complete: false }, observations: [
    { nativeSessionId: 'native-session', observation: { modelId: null,
      tokens: { total: 12 }, cost: { reportedUsd: 0.1 } } },
  ] } });
});
it('reads Claude assistant accounting through its existing live codec without transcript disclosure', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'happier-claude-accounting-')); roots.push(configDir);
  const dir = join(configDir, 'projects', 'project'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'native-session.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'native-session', uuid: 'native-record', cwd: '/native/claude-project',
    timestamp: '2026-01-01T00:00:00.000Z', message: { id: 'native-inference', model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text: 'PRIVATE_TRANSCRIPT' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } }) + '\n');
  const result = await createClaudeExternalSessionsContribution({ env: { CLAUDE_CONFIG_DIR: configDir } }).readAccounting?.({
    source: { kind: 'claudeConfig', configDir }, signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000, maxSerializedBytes: 100_000,
  });
  expect(result).toMatchObject({ ok: true, value: { outcome: 'advanced', observations: [{ nativeSessionId: 'native-session', inferenceId: 'native-inference',
    accounting: { inputIncludesCache: false, outputIncludesReasoning: false },
    project: { rootPath: '/native/claude-project' },
    observation: { provider: 'claude', tokens: { total: 20, input: 10, output: 5, cacheRead: 3, cacheWrite: 2 } } }] } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_TRANSCRIPT');
  expect(JSON.stringify(result)).not.toContain(configDir);
});
