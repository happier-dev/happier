import type { PluginWebSocketConnection, PluginWebSocketMessage } from '@happier-dev/plugin-sdk/http';
import { ConversationProviderObservationIngestInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { createSlackApi } from './slackApi.js';
import { startSlackSocketWorker, verifySlackSocketIdentity } from './slackSocketWorker.js';

const identity = { teamId: 'T1', appId: 'A1', botUserId: 'U1', botId: 'B1', label: 'Happier' };
const hello = { type: 'hello', connection_info: { app_id: 'A1' } };
const envelope = { type: 'events_api', envelope_id: 'envelope-1', payload: {
  type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: 'Ev1',
  event: { type: 'message', channel: 'C1', user: 'U2', text: 'hello', ts: '1700000000.000001' },
} };

function socketBoundary(frames: readonly unknown[]) {
  const queue = frames.map(frame => ({ kind: 'text' as const, text: JSON.stringify(frame) }));
  let close!: () => void;
  const closed = new Promise<Readonly<{ kind: 'local'; wasClean: true }>>(resolve => { close = () => resolve({ kind: 'local', wasClean: true }); });
  const sent: PluginWebSocketMessage[] = [];
  const socket: PluginWebSocketConnection = {
    url: 'wss://wss.slack.com/link/?ticket=secret', protocol: '', closed,
    async send(message) { sent.push(message); },
    async receive(options) {
      if (options?.signal?.aborted) throw options.signal.reason;
      const frame = queue.shift();
      if (frame) return frame;
      return await new Promise((resolve, reject) => {
        const onAbort = () => { options?.signal?.removeEventListener('abort', onAbort); reject(options?.signal?.reason); };
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        void closed.then(value => { options?.signal?.removeEventListener('abort', onAbort); resolve({ kind: 'closed', close: value }); });
      });
    },
    close,
    dispose() { close(); },
  };
  return { socket, sent };
}

function httpBoundary(channelResults: readonly Readonly<{ status: number; body: unknown; headers?: Record<string, string> }>[] = [],
  userBody: unknown = { ok: true, user: { id: 'U2', team_id: 'T1', is_bot: false, deleted: false, profile: { display_name: 'Ada Lovelace' } } }) {
  let channelReads = 0;
  const request = vi.fn(async ({ url }: Readonly<{ url: string }>) => {
    const isChannel = url.includes('conversations.info');
    const reply = isChannel ? channelResults[channelReads++] : undefined;
    return { status: reply?.status ?? 200, finalUrl: url, headers: reply?.headers ?? {}, body: new TextEncoder().encode(JSON.stringify(
      reply?.body ?? (url.includes('users.info') ? userBody
        : isChannel ? { ok: true, channel: { id: 'C1', is_im: false, is_mpim: false, is_private: false, is_archived: false } }
        : { ok: true, url: 'wss://wss.slack.com/link/?ticket=secret' }),
    )) };
  });
  return { request, api: createSlackApi({ credentials: { botToken: 'xoxb-test', appToken: 'xapp-test' }, http: { request } }) };
}

describe('Slack Socket Mode worker', () => {
  it('admits and acknowledges input when the optional sender profile is unavailable', async () => {
    const boundary = socketBoundary([hello, envelope, { type: 'disconnect', reason: 'refresh_requested' }]);
    const admissions: unknown[] = [];
    const http = httpBoundary([], { ok: false, error: 'missing_scope' });
    const worker = startSlackSocketWorker({ connection: { connectionId: 'connection-1', authorityEpoch: 7, identity },
      api: http.api, webSockets: { openWebSocket: async () => boundary.socket },
      admitObservation: async value => { admissions.push(value); }, signal: new AbortController().signal });
    await expect(worker.result).resolves.toEqual({ kind: 'stopped' });
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({ entry: { observation: { observation: {
      actor: { principalId: 'slack:T1:user:U2' }, message: { text: 'hello' },
    } } } });
    expect(boundary.sent).toEqual([{ kind: 'text', text: JSON.stringify({ envelope_id: 'envelope-1' }) }]);
  });
  it('ACKs only after the real normalized ingress reaches durable core custody', async () => {
    const boundary = socketBoundary([hello, envelope]);
    let settle!: () => void;
    const admitted = new Promise<void>(resolve => { settle = resolve; });
    const admissions: unknown[] = [];
    const admitObservation = vi.fn(async (value: unknown) => {
      admissions.push(ConversationProviderObservationIngestInputV1Schema.parse(value));
      await admitted;
    });
    const worker = startSlackSocketWorker({ connection: { connectionId: 'connection-1', authorityEpoch: 7, identity }, api: httpBoundary().api,
      webSockets: { openWebSocket: async () => boundary.socket }, admitObservation, signal: new AbortController().signal });
    await vi.waitFor(() => expect(admissions).toHaveLength(1));
    expect(admissions[0]).toMatchObject({ entry: { observation: { observation: { actor: { label: 'Ada Lovelace' } } } } });
    expect(boundary.sent).toEqual([]);
    settle();
    await vi.waitFor(() => expect(boundary.sent).toEqual([{ kind: 'text', text: JSON.stringify({ envelope_id: 'envelope-1' }) }]));
    worker.stop();
    await expect(worker.result).resolves.toMatchObject({ kind: 'stopped' });
  });

  it('does not ACK unsettled durable custody and reports admission loss', async () => {
    const boundary = socketBoundary([hello, envelope]);
    const worker = startSlackSocketWorker({ connection: { connectionId: 'connection-1', authorityEpoch: 7, identity }, api: httpBoundary().api,
      webSockets: { openWebSocket: async () => boundary.socket }, admitObservation: async () => { throw new Error('retryable core custody refusal'); },
      signal: new AbortController().signal });
    await expect(worker.result).resolves.toEqual({ kind: 'historyGap', reason: 'applicationAdmissionLost' });
    expect(boundary.sent).toEqual([]);
  });

  it('retries Retry-After for this frame without ACK or dropping the message', async () => {
    vi.useFakeTimers();
    try {
      const boundary = socketBoundary([hello, envelope]);
      const http = httpBoundary([{ status: 429, headers: { 'retry-after': '2' }, body: { ok: false, error: 'ratelimited' } }]);
      const admissions: unknown[] = [];
      const worker = startSlackSocketWorker({ connection: { connectionId: 'connection-1', authorityEpoch: 7, identity }, api: http.api,
        webSockets: { openWebSocket: async () => boundary.socket }, admitObservation: async value => { admissions.push(value); }, signal: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(boundary.sent).toEqual([]);
      expect(admissions).toEqual([]);
      await vi.advanceTimersByTimeAsync(1999);
      expect(admissions).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(admissions).toHaveLength(1);
      expect(boundary.sent).toHaveLength(1);
      worker.stop();
      await worker.result;
    } finally { vi.useRealTimers(); }
  });

  it.each([['foreign hello', { type: 'hello', connection_info: { app_id: 'A2' } }], ['event before hello', envelope]])('rejects %s before accepting or ACKing', async (_name, frame) => {
    const boundary = socketBoundary([frame, envelope]);
    const admissions: unknown[] = [];
    const worker = startSlackSocketWorker({ connection: { connectionId: 'connection-1', authorityEpoch: 7, identity }, api: httpBoundary().api,
      webSockets: { openWebSocket: async () => boundary.socket }, admitObservation: async value => { admissions.push(value); }, signal: new AbortController().signal });
    await expect(worker.result).resolves.toMatchObject({ kind: 'notReady', failure: { reason: 'invalidConfiguration' } });
    expect(admissions).toEqual([]);
    expect(boundary.sent).toEqual([]);
  });

  it('keeps a warning socket open and retires a routine refresh without reporting a gap', async () => {
    const boundary = socketBoundary([hello, { type: 'disconnect', reason: 'warning' }, envelope, { type: 'disconnect', reason: 'refresh_requested' }]);
    const admissions: unknown[] = [];
    const worker = startSlackSocketWorker({ connection: { connectionId: 'connection-1', authorityEpoch: 7, identity }, api: httpBoundary().api,
      webSockets: { openWebSocket: async () => boundary.socket }, admitObservation: async value => { admissions.push(value); }, signal: new AbortController().signal });
    await expect(worker.result).resolves.toEqual({ kind: 'stopped' });
    expect(admissions).toHaveLength(1);
    expect(boundary.sent).toEqual([{ kind: 'text', text: JSON.stringify({ envelope_id: 'envelope-1' }) }]);
  });

  it('uses the same verified handshake for setup and closes without ingesting or ACKing', async () => {
    const boundary = socketBoundary([hello, envelope]);
    await expect(verifySlackSocketIdentity({ api: httpBoundary().api, webSockets: { openWebSocket: async () => boundary.socket }, identity, signal: new AbortController().signal })).resolves.toBeNull();
    await expect(boundary.socket.closed).resolves.toMatchObject({ kind: 'local' });
    expect(boundary.sent).toEqual([]);
  });
});
