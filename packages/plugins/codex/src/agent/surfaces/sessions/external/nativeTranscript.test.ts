import { describe, expect, it } from 'vitest';

import { pageCodexNativeTranscript } from './nativeTranscript.js';

// Boundary: the native app-server JSON-RPC client. Paging, projection and the
// unsupported-record diagnostic below it are the real owner code.
function nativeClient(items: Record<string, unknown>[]) {
  return {
    request: async (method: string, value: unknown) => {
      if (method !== 'thread/items/list') throw new Error(`unexpected ${method}`);
      const args = value as { sortDirection: string; limit: number };
      const ordered = items.map((item, index) => ({ turnId: 'turn', item, startedAtMs: index + 1, completedAtMs: index + 1 }));
      if (args.sortDirection === 'desc') ordered.reverse();
      const data = ordered.slice(0, args.limit);
      return { data, nextCursor: null, backwardsCursor: data.length ? 'head' : null };
    },
  };
}

describe('pageCodexNativeTranscript', () => {
  it('preserves native user client ids without conflating repeated prompt text', async () => {
    const client = nativeClient([
      { id: 'first', type: 'userMessage', clientId: 'outbound-first', content: [{ type: 'text', text: 'repeat this prompt' }] },
      { id: 'second', type: 'userMessage', client_id: 'outbound-second', content: [{ type: 'text', text: 'repeat this prompt' }] },
      { id: 'missing', type: 'userMessage', content: [{ type: 'text', text: 'repeat this prompt' }] },
      { id: 'nullable', type: 'userMessage', clientId: null, content: [{ type: 'text', text: 'repeat this prompt' }] },
    ]);
    const page = await pageCodexNativeTranscript({ client, home: '/codex-home', remoteSessionId: 'thread-1',
      direction: 'older', maxItems: 50, maxBytes: 512 * 1024 });
    const nativeIds = ['first', 'second', 'missing', 'nullable'].map(id =>
      `codex:native:thread-1:${JSON.stringify(['turn', id])}:0`);
    expect(page.items.map(item => item.id)).toEqual(nativeIds);
    expect(page.items.map(item => item.localId)).toEqual([
      'outbound-first', 'outbound-second', nativeIds[2], nativeIds[3],
    ]);
    expect(page.items.map(item => item.raw)).toEqual(Array.from({ length: 4 }, () => ({
      role: 'user', content: { type: 'text', text: 'repeat this prompt' },
    })));
  });

  it('preserves native subagent activity without inventing child completion', async () => {
    // Codex 0.167 history carries `subAgentActivity` items between ordinary rows.
    const page = await pageCodexNativeTranscript({
      client: nativeClient([
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'start' }] },
        { id: 'sub-1', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-thread' },
        { id: 'reply-1', type: 'agentMessage', text: 'done' },
      ]),
      home: '/codex-home',
      remoteSessionId: 'thread-1',
      direction: 'older',
      maxItems: 50,
      maxBytes: 512 * 1024,
    });

    expect(page.items.map(item => item.raw)).toMatchObject([
      { role: 'user' },
      { role: 'agent', content: { data: { type: 'tool-call', name: 'subAgentActivity', input: { kind: 'started', agentThreadId: 'child-thread' } } } },
      { role: 'agent', content: { data: { type: 'tool-call-result', output: {} } } },
      { role: 'agent' },
    ]);
    expect('diagnostics' in page ? page.diagnostics : undefined).toBeUndefined();
  });
  it.each([
    { type: 'image', url: 'data:image/png;base64,cHJpdmF0ZQ==' },
    { type: 'image', fileId: 'image-file' },
    { type: 'audio', fileId: 'audio-file' },
    { type: 'localAudio', path: '/repo/audio.wav' },
    { type: 'mention', name: 'README', path: '/repo/README.md' },
    { type: 'skill', name: 'review', path: '/repo/SKILL.md' },
  ])('retains native $type user content through external history', async part => {
    const content = [{ type: 'text', text: 'Inspect this', text_elements: [] }, part];
    const page = await pageCodexNativeTranscript({ client: nativeClient([{ id: 'mixed', type: 'userMessage', content }]),
      home: '/codex-home', remoteSessionId: 'thread-1', direction: 'older', maxItems: 50, maxBytes: 512 * 1024 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.raw).toMatchObject({ role: 'user', meta: { nativeContent: content } });
    expect(JSON.stringify(page.items[0]?.raw.content)).not.toContain('cHJpdmF0ZQ==');
  });

  it('honors the 0.3 hard byte allowance for an indivisible record', async () => {
    const text = 'long native message'.repeat(100);
    await expect(pageCodexNativeTranscript({ client: nativeClient([{ id: 'large', type: 'userMessage',
      content: [{ type: 'text', text }] }]), home: '/codex-home', remoteSessionId: 'thread-1',
      direction: 'older', maxItems: 50, maxBytes: 64 })).rejects.toThrow('byte budget');
  });

  it('keeps a visible safe placeholder for unknown native content in source order', async () => {
    const page = await pageCodexNativeTranscript({ client: nativeClient([
      { id: 'before', type: 'agentMessage', text: 'before' },
      { id: 'unknown', type: 'future', privatePayload: 'must not disclose' },
      { id: 'after', type: 'agentMessage', text: 'after' },
    ]), home: '/codex-home', remoteSessionId: 'thread-1', direction: 'older', maxItems: 50, maxBytes: 512 * 1024 });
    expect(page.items).toHaveLength(3);
    expect(page.items[1]?.id).toContain('unknown');
    expect(page.items[1]?.raw).toMatchObject({ role: 'agent', content: { type: 'acp', data: { type: 'message' } } });
    expect(JSON.stringify(page.items)).not.toContain('must not disclose');
    expect(page.diagnostics).toEqual([{ code: 'external_sessions_transcript_unsupported_record', severity: 'benign', count: 1, positions: [] }]);
  });

  it('reports unsupported records only on the page that returns their placeholder', async () => {
    const client = nativeClient([
      { id: 'before', type: 'agentMessage', text: 'before' },
      { id: 'unknown', type: 'future', privatePayload: 'must not disclose' },
      { id: 'after', type: 'agentMessage', text: 'after' },
    ]);
    const params = { client, home: '/codex-home', remoteSessionId: 'thread-1', direction: 'older' as const,
      maxItems: 50, maxBytes: 400 };
    const first = await pageCodexNativeTranscript(params);
    expect(first.items).toHaveLength(1);
    expect(first.diagnostics).toBeUndefined();
    const ids = first.items.map(item => item.id);
    let diagnostics = 0;
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await pageCodexNativeTranscript({ ...params, cursor });
      ids.push(...page.items.map(item => item.id));
      diagnostics += page.diagnostics?.reduce((count, item) => count + item.count, 0) ?? 0;
      cursor = page.nextCursor;
    }
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(diagnostics).toBe(1);
  });

});
