import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOhMyPiExternalSessionsContribution } from './contribution.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-content-'));
  roots.push(agentDir);
  const directory = join(agentDir, 'sessions', '-repo');
  await mkdir(directory, { recursive: true });
  const path = join(directory, '2026-07-23T10-00-00-000Z_session.jsonl');
  const record = (id: string, parentId: string | null, message: unknown) =>
    ({ type: 'message', id, parentId, timestamp: '2026-07-23T10:00:00.000Z', message });
  const body = 'body-only phrase with "quotes"\n東京 café';
  const records = [
    { type: 'session', version: 3, id: 'session', timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' },
    record('user', null, { role: 'user', content: 'ordinary title' }),
    record('abandoned', 'user', { role: 'assistant', content: [{ type: 'text', text: 'abandoned-only phrase' }] }),
    record('active', 'user', { role: 'assistant', content: [{ type: 'text', text: body }] }),
    record('tools', 'active', { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'metadata-only phrase' } }] }),
  ];
  await writeFile(path, records.map((record) => JSON.stringify(record).replaceAll('東京', '\\u6771\\u4eac')).join('\n') + '\n');
  const contribution = createOhMyPiExternalSessionsContribution({ env: {} });
  const request = {
    signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000,
    maxSerializedBytes: 1024 * 1024, maxItems: 10,
    source: { kind: 'ohMyPiAgentDir', agentDir }, searchTarget: 'content' as const,
    // Host subprocess boundary only; actual transcript decoding/matching stays real.
    ripgrep: { run: vi.fn(async () => ({ exitCode: 0, stdout: path + '\0', stderr: '', stdoutTruncated: false })) },
  };
  return { contribution, request, body };
}

describe('ohmypi direct conversation content search', () => {
  it.each(['body-only phrase', 'body-only phrase with "quotes"\n東京', '東京 café'])('finds decoded active-branch body %s with its transcript locator', async (query) => {
    const { contribution, request, body } = await fixture();
    const result = await contribution.listCandidates({ ...request, searchTerm: query });
    expect(result).toMatchObject({ ok: true, value: {
      candidates: [{ remoteSessionId: 'session', match: { snippet: expect.stringContaining(query), sourceItemId: expect.any(String), messageIndex: 1 } }],
      contentCoverage: 'complete', nextCursor: null,
    } });
    if (!result.ok) return;
    const page = await contribution.pageTranscript({ ...request, source: { ...request.source, sessionFilePath: join(request.source.agentDir, 'sessions', '-repo', '2026-07-23T10-00-00-000Z_session.jsonl') }, remoteSessionId: 'session', direction: 'older' });
    expect(page.ok && page.value.items[1]?.id).toBe(result.value.candidates[0]?.match?.sourceItemId);
    expect(body).toContain(query);
  });

  it.each(['abandoned-only phrase', 'metadata-only phrase'])('excludes %s from content matches', async (searchTerm) => {
    const { contribution, request } = await fixture();
    await expect(contribution.listCandidates({ ...request, searchTerm })).resolves.toMatchObject({
      ok: true, value: { candidates: [], contentCoverage: 'complete' },
    });
  });

  it('keeps the full projected message ordinal when native transcript pages are small', async () => {
    const { contribution, request } = await fixture();
    await expect(contribution.listCandidates({ ...request, maxItems: 1, searchTerm: 'body-only phrase' })).resolves.toMatchObject({
      ok: true, value: { candidates: [{ match: { messageIndex: 1 } }], contentCoverage: 'complete' },
    });
  });

  it('preserves literal query whitespace instead of broadening a content search', async () => {
    const { contribution, request } = await fixture();
    await expect(contribution.listCandidates({ ...request, searchTerm: ' body-only phrase' })).resolves.toMatchObject({
      ok: true, value: { candidates: [], contentCoverage: 'complete' },
    });
  });

  it('yields a resumable partial page at the host deadline and binds it to its query and target', async () => {
    const { contribution, request } = await fixture();
    const now = Date.now();
    let clock = now;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    request.deadlineAtMs = now + 1000;
    request.ripgrep.run.mockImplementation(async () => {
      clock = request.deadlineAtMs;
      return { exitCode: 0, stdout: 'hit\0', stderr: '', stdoutTruncated: false };
    });
    const first = await contribution.listCandidates({ ...request, searchTerm: 'body-only' });
    expect(first).toMatchObject({ ok: true, value: { contentCoverage: 'partial', searchIncomplete: true, nextCursor: expect.any(String) } });
    if (!first.ok || !first.value.nextCursor) return;
    clock = now;
    const nextRequest = { ...request, ripgrep: { run: vi.fn(async () => ({ exitCode: 0, stdout: 'hit\0', stderr: '', stdoutTruncated: false })) }, cursor: first.value.nextCursor };
    await expect(contribution.listCandidates({ ...nextRequest, searchTerm: 'different' })).resolves.toMatchObject({ ok: false });
    await expect(contribution.listCandidates({ ...nextRequest, searchTarget: 'metadata', searchTerm: 'body-only' })).resolves.toMatchObject({ ok: false });
    await expect(contribution.listCandidates({ ...nextRequest, searchTerm: 'body-only' })).resolves.toMatchObject({ ok: true, value: { candidates: [{ match: { messageIndex: 1 } }], contentCoverage: 'complete' } });
  });
});
