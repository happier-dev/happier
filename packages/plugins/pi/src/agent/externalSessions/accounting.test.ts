import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPiExternalSessionsContribution } from './contribution.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const message = (id: string, parentId: string | null, input: number) => ({
  type: 'message', id, parentId, timestamp: '2026-01-01T00:00:01.000Z',
  message: { role: 'assistant', model: 'test-model', provider: 'test-provider', timestamp: 1767225601000,
    usage: { input, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: input + 9, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } }, content: [] },
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'happier-pi-accounting-')); roots.push(root);
  const agentDir = join(root, 'agent'); const dir = join(agentDir, 'sessions', '--project--');
  await mkdir(dir, { recursive: true });
  const file = join(dir, '2026-01-01_session-one.jsonl');
  await writeFile(file, line({ type: 'session', version: 3, id: 'session-one', cwd: '/native/pi-project', timestamp: '2026-01-01T00:00:00.000Z' })
    + line(message('paid-a', null, 10)) + line(message('off-branch-paid', null, 20)));
  const contribution = createPiExternalSessionsContribution({ env: { PI_CODING_AGENT_DIR: agentDir } });
  const request = { source: { kind: 'piAgentDir', agentDir }, signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 30_000, maxSerializedBytes: 64 * 1024 };
  return { file, contribution, request };
}
describe('Pi source accounting through the external-session contribution', () => {
  it('preserves an already witnessed child append frontier after parent cleanup', async () => {
    const { file, contribution, request } = await setup();
    const child = join(file, '..', 'child.jsonl');
    await writeFile(child, line({ type: 'session', version: 3, id: 'child', cwd: '/native/child-project', parentSession: file })
      + line(message('paid-a', null, 10)) + line(message('off-branch-paid', null, 20)) + line(message('child-new', null, 30)));
    const initial = await contribution.readAccounting?.(request);
    if (!initial?.ok || initial.value.outcome !== 'advanced') throw new Error('Accounting setup failed');
    await rm(file);
    await appendFile(child, line(message('child-after-cleanup', 'child-new', 40)));
    const appended = await contribution.readAccounting?.({ ...request, cursor: initial.value.nextCursor });
    expect(appended).toMatchObject({ ok: true, value: { outcome: 'advanced', coverage: { complete: false }, observations: [
      { nativeSessionId: 'child', inferenceId: 'child-after-cleanup', parentNativeSessionId: 'session-one',
        project: { rootPath: '/native/child-project' }, observation: { tokens: { total: 49 } } },
    ] } });
    if (!appended?.ok || appended.value.outcome !== 'advanced') return;
    expect(await contribution.readAccounting?.({ ...request, cursor: appended.value.nextCursor }))
      .toEqual({ ok: true, value: { outcome: 'unchanged' } });
  });
  it('retains compaction and branch-summary spend without borrowing the coding model for an unrecorded summary model', async () => {
    const { file, contribution, request } = await setup();
    await appendFile(file, line({ type: 'model_change', modelId: 'coding-model' })
      + line({ type: 'compaction', id: 'paid-compaction', timestamp: '2026-01-01T00:00:01.000Z', usage: message('x', null, 30).message.usage })
      + line({ type: 'branch_summary', id: 'paid-summary', timestamp: '2026-01-01T00:00:01.000Z', usage: message('x', null, 40).message.usage }));
    expect(await contribution.readAccounting?.(request)).toMatchObject({ ok: true, value: { outcome: 'advanced', coverage: { complete: false },
      observations: expect.arrayContaining([
        expect.objectContaining({ inferenceId: 'paid-compaction', observation: expect.objectContaining({ modelId: null, tokens: expect.objectContaining({ total: 39 }) }) }),
        expect.objectContaining({ inferenceId: 'paid-summary', observation: expect.objectContaining({ modelId: null, tokens: expect.objectContaining({ total: 49 }) }) }),
      ]) } });
  });
  it('captures paid tool-result generations rather than only assistant messages', async () => {
    const { file, contribution, request } = await setup();
    const tool = message('paid-tool', null, 5);
    await appendFile(file, line({ ...tool, message: { ...tool.message, role: 'toolResult' } }));
    expect(await contribution.readAccounting?.(request)).toMatchObject({ ok: true, value: { outcome: 'advanced',
      observations: expect.arrayContaining([{ nativeSessionId: 'session-one', inferenceId: 'paid-tool', observedAt: 1767225601000,
        project: { rootPath: '/native/pi-project' },
        accounting: { inputIncludesCache: false, outputIncludesReasoning: false },
        observation: expect.objectContaining({ tokens: expect.objectContaining({ total: 14 }) }) }]) } });
  });
  it('rejects a same-size native rewrite rather than accepting the stale frontier', async () => {
    const { file, contribution, request } = await setup();
    const initial = await contribution.readAccounting?.(request);
    if (!initial?.ok || initial.value.outcome !== 'advanced') throw new Error('Accounting setup failed');
    await writeFile(file, line({ type: 'session', version: 3, id: 'session-two', cwd: '/native/pi-project', timestamp: '2026-01-01T00:00:00.000Z' })
      + line(message('paid-b', null, 10)) + line(message('off-branch-paid', null, 20)));
    await utimes(file, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    expect(await contribution.readAccounting?.({ ...request, cursor: initial.value.nextCursor }))
      .toEqual({ ok: true, value: { outcome: 'gap_or_cursor_expired' } });
  });
  it('counts copied fork entries under their exact parent identity and omits unwitnessed copies', async () => {
    const { file, contribution, request } = await setup();
    const child = join(file, '..', 'child.jsonl');
    await writeFile(child, line({ type: 'session', version: 3, id: 'child', cwd: '/native/child-project', parentSession: file })
      + line(message('paid-a', null, 10)) + line(message('off-branch-paid', null, 20)) + line(message('child-new', null, 30)));
    const result = await contribution.readAccounting?.(request);
    expect(result).toMatchObject({ ok: true, value: { outcome: 'advanced' } });
    if (!result?.ok || result.value.outcome !== 'advanced') return;
    const claims = result.value.observations.map((entry) => `${entry.nativeSessionId}:${entry.inferenceId}`);
    expect(new Set(claims)).toEqual(new Set(['session-one:paid-a', 'session-one:off-branch-paid', 'child:child-new']));
    expect(result.value.observations.filter((entry) => entry.nativeSessionId === 'session-one'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ project: { rootPath: '/native/pi-project' } })]));
    expect(result.value.observations.find((entry) => entry.inferenceId === 'child-new'))
      .toMatchObject({ project: { rootPath: '/native/child-project' } });
    await rm(file);
    const unavailable = await contribution.readAccounting?.(request);
    expect(unavailable).toMatchObject({ ok: true, value: { outcome: 'advanced', observations: [],
      coverage: { complete: false, reason: 'native_fork_lineage_unavailable' } } });
  });
  it('captures every paid branch, advances only complete records, and resumes without replay', async () => {
    const { file, contribution, request } = await setup();
    expect(await contribution.resolveSource?.(request)).toMatchObject({ ok: true, value: {
      source: { sessionsRoot: join(request.source.agentDir, 'sessions') },
      accountingSource: { rootPath: join(request.source.agentDir, 'sessions'), rootField: 'sessionsRoot', changeObservation: 'watch_file_changes' },
    } });
    const initial = await contribution.readAccounting?.(request);
    expect(initial).toMatchObject({ ok: true, value: { outcome: 'advanced', coverage: { complete: true }, observations: [
      { nativeSessionId: 'session-one', inferenceId: 'paid-a', project: { rootPath: '/native/pi-project' }, observation: { tokens: { total: 19 }, cost: { estimatedUsd: 0.3 } } },
      { nativeSessionId: 'session-one', inferenceId: 'off-branch-paid', observation: { tokens: { total: 29 } } },
    ] } });
    if (!initial?.ok || initial.value.outcome !== 'advanced') return;
    await appendFile(file, JSON.stringify(message('partial', null, 30)));
    const partial = await contribution.readAccounting?.({ ...request, cursor: initial.value.nextCursor });
    expect(partial).toMatchObject({ ok: true, value: { outcome: 'advanced', observations: [], coverage: { complete: false } } });
    if (!partial?.ok || partial.value.outcome !== 'advanced') return;
    await appendFile(file, '\n');
    const completed = await contribution.readAccounting?.({ ...request, cursor: partial.value.nextCursor });
    expect(completed).toMatchObject({ ok: true, value: { outcome: 'advanced', observations: [{ inferenceId: 'partial' }] } });
    if (!completed?.ok || completed.value.outcome !== 'advanced') return;
    expect(await contribution.readAccounting?.({ ...request, cursor: completed.value.nextCursor })).toEqual({ ok: true, value: { outcome: 'unchanged' } });
  });
  it('reports truncation and replacement instead of skipping new accounting', async () => {
    const { file, contribution, request } = await setup();
    const initial = await contribution.readAccounting?.(request);
    expect(initial).toMatchObject({ ok: true, value: { outcome: 'advanced' } });
    if (!initial?.ok || initial.value.outcome !== 'advanced') return;
    await writeFile(file, '');
    expect(await contribution.readAccounting?.({ ...request, cursor: initial.value.nextCursor })).toEqual({ ok: true, value: { outcome: 'gap_or_cursor_expired' } });
    await rename(file, `${file}.old`); await writeFile(file, line(message('new-file', null, 40)));
    expect(await contribution.readAccounting?.({ ...request, cursor: initial.value.nextCursor })).toEqual({ ok: true, value: { outcome: 'source_replaced' } });
  });
});
