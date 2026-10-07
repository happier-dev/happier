import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { describe, expect, it } from 'vitest';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createServerBackedSessionTranscriptStore } from './createServerBackedSessionTranscriptStore';
import { createSessionTranscriptFollowLeaseRegistry, followSessionTranscript } from './followSessionTranscript';

describe('Home-backed transcript Action waits', () => {
  it('wakes on append and revision, retains notifications between reads, and releases on abort', async () => {
    let rows: { id: string; seq: number; localId: null; createdAt: number; updatedAt: number; content: { t: 'plain'; v: unknown } }[] = [];
    let reads = 0;
    const http = createServer((request, response) => {
      reads++;
      const url = new URL(request.url ?? '/', 'http://fixture');
      const after = Number(url.searchParams.get('afterSeq') ?? 0);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ messages: rows.filter((row) => row.seq > after), hasMore: false, nextAfterSeq: rows.at(-1)?.seq ?? after }));
    });
    const io = new Server(http, { path: '/v1/updates/' });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const registry = createSessionTranscriptFollowLeaseRegistry({ idleTtlMs: 20 });
    const controller = new AbortController();
    const follow = (cursor: string) => runWithServerHttpBaseUrl(endpoint, () => followSessionTranscript({
      store: createServerBackedSessionTranscriptStore({ token: 'terminal-test', sessionId: 'session-1', mode: 'plain', ctx: null }),
      registry, sessionId: 'session-1', signal: controller.signal,
      input: { cursor, leaseId: 'lease-1', waitForChanges: true },
    }));
    const update = (body: unknown) => io.emit('update', { id: 'update', seq: 1, createdAt: 1, body });
    try {
      const first = follow('tail');
      void first.catch(() => undefined);
      await expect.poll(() => io.engine.clientsCount).toBe(1);
      await expect.poll(() => reads).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(reads).toBe(1);
      expect(registry.activeCount()).toBe(1);
      rows = [{ id: 'row-1', seq: 1, localId: null, createdAt: 1, updatedAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'appended' } } } }];
      update({ t: 'new-message', sid: 'session-1', message: rows[0] });
      await expect(first).resolves.toMatchObject({ ok: true, items: [{ seq: 1 }], nextCursor: '1' });
      // A revision between Action calls must survive on the retained lease.
      update({ t: 'message-updated', sid: 'session-1', message: { ...rows[0], updatedAt: 2 } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(follow('1')).resolves.toMatchObject({ ok: true, items: [],
        changes: [{ kind: 'revision', messageId: 'row-1', seq: 1 }] });
      const idle = follow('1');
      void idle.catch(() => undefined);
      await expect.poll(() => reads).toBe(4);
      controller.abort();
      await expect(idle).rejects.toMatchObject({ name: 'AbortError' });
      expect(registry.activeCount()).toBe(0);
      await expect.poll(() => io.engine.clientsCount).toBe(0);
    } finally {
      controller.abort();
      await registry.dispose();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });
});
