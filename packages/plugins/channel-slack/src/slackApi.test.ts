import { describe, expect, it, vi } from 'vitest';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { ConversationDeliveryResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { createSlackApi } from './slackApi.js';
import { createSlackMessagePayload } from './slackDelivery.js';

const credentials = { botToken: 'xoxb-test', appToken: 'xapp-test' };
function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return { status, headers, finalUrl: 'https://slack.com/api/', body: new TextEncoder().encode(JSON.stringify(body)) };
}
const identity = { teamId: 'T1', appId: 'A1', botUserId: 'U1', botId: 'B1', label: 'Happier' };
const payload = () => createSlackMessagePayload({ channelId: 'C1', text: 'hello', linkPreviewPolicy: 'suppress' });

describe('Slack Web API boundary', () => {
  it('retains a safe send failure cause without replaying an uncertain effect', async () => {
    const privateDetails = 'private-token-and-message';
    const warn = vi.fn();
    const request = vi.fn(async () => { throw Object.assign(new Error(privateDetails), { code: 'ECONNRESET' }); });
    const api = createSlackApi({ credentials, http: { request }, logger: { warn } });
    await expect(api.postMessage(payload())).resolves.toEqual({ kind: 'outcomeUnknown' });
    expect(request).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.any(String), { failureCause: expect.objectContaining({ errorCode: 'ECONNRESET' }) });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateDetails);
  });

  it('updates with the bot credential and treats an uncorrelated update as uncertain without posting a replacement', async () => {
    const requests: string[] = [];
    const api = createSlackApi({ credentials, http: { async request(input) {
      requests.push(new URL(input.url).pathname);
      expect(input.method).toBe('POST');
      expect(input.headers?.Authorization).toBe(`Bearer ${credentials.botToken}`);
      expect(JSON.parse(new TextDecoder().decode(input.body))).toEqual({ channel: 'C1', ts: '123.456', text: 'Working…' });
      return response({ ok: true, channel: 'C1', ts: '999.999' });
    } } });
    expect(await api.updateMessage({ channel: 'C1', ts: '123.456', text: 'Working…' })).toEqual({ kind: 'outcomeUnknown' });
    expect(requests).toEqual(['/api/chat.update']);
  });

  it.each([
    [{ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '17' }, { kind: 'notDelivered', retry: 'after', retryAfterMs: 17_000 }],
    [{ ok: false, error: 'cant_update_message' }, 200, {}, { kind: 'notReady', reason: 'permissionMissing' }],
    [{ ok: false, error: 'is_archived' }, 200, {}, { kind: 'endpointArchived', recovery: 'ownerMustUnarchiveOrRebind' }],
    [null, 200, {}, { kind: 'outcomeUnknown' }],
  ] as const)('retains the update effect outcome without retry or replacement (%j)', async (body, status, headers, expected) => {
    let attempts = 0;
    const api = createSlackApi({ credentials, http: { async request() {
      attempts += 1;
      if (body === null) throw new Error('provider response lost');
      return response(body, status, headers);
    } } });
    expect(await api.updateMessage({ channel: 'C1', ts: '123.456', text: 'Working…' })).toEqual(expected);
    expect(attempts).toBe(1);
  });

  it('proves correlated bot identity with bot credentials and opens Socket Mode only with the app token', async () => {
    const signal = new AbortController().signal;
    const http: Pick<HttpService, 'request'> = { async request(input, options) {
      expect(options?.signal).toBe(signal);
      expect(input.redirect).toBe('error');
      const url = new URL(input.url);
      const isOpen = url.pathname.endsWith('/apps.connections.open');
      expect(input.headers?.Authorization).toBe(`Bearer ${isOpen ? credentials.appToken : credentials.botToken}`);
      if (url.pathname.endsWith('/auth.test')) return response({ ok: true, team_id: 'T1', user_id: 'U1', bot_id: 'B1' });
      if (url.pathname.endsWith('/bots.info')) {
        expect(url.searchParams.get('bot')).toBe('B1');
        return response({ ok: true, bot: { id: 'B1', user_id: 'U1', app_id: 'A1', name: 'Happier' } });
      }
      if (isOpen) return response({ ok: true, url: 'wss://wss-primary.slack.com/link?ticket=secret' });
      throw new Error('Unexpected request');
    } };
    const api = createSlackApi({ credentials, http });
    await expect(api.getIdentity({ signal })).resolves.toEqual(identity);
    await expect(api.openConnection({ signal })).resolves.toEqual({ url: 'wss://wss-primary.slack.com/link?ticket=secret' });
  });

  it('rejects identity disagreement and unsafe socket URLs without disclosing provider payloads', async () => {
    const api = createSlackApi({ credentials, http: { async request(input) {
      return response(input.url.includes('auth.test')
        ? { ok: true, team_id: 'T1', user_id: 'U1', bot_id: 'B1' }
        : input.url.includes('bots.info')
          ? { ok: true, bot: { id: 'B1', user_id: 'OTHER', app_id: 'A1' } }
          : { ok: true, url: 'https://example.org/socket?token=xapp-secret' });
    } } });
    await expect(api.getIdentity()).resolves.toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
    await expect(api.openConnection()).resolves.toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
  });

  it('reads documented direct-channel omissions and authenticates immutable user IDs', async () => {
    const api = createSlackApi({ credentials, http: { async request(input) {
      const url = new URL(input.url);
      if (url.pathname.endsWith('/conversations.info')) {
        expect(url.searchParams.get('channel')).toBe('D1');
        return response({ ok: true, channel: { id: 'D1', is_im: true } });
      }
      expect(url.searchParams.get('user')).toBe('U2');
      return response({ ok: true, user: { id: 'U2', team_id: 'T1', is_bot: false, deleted: false, profile: { display_name: 'Alice' } } });
    } } });
    await expect(api.getChannel('D1')).resolves.toEqual({ id: 'D1', isIm: true, isMpim: false, isPrivate: true, isArchived: false });
    await expect(api.getUser('U2')).resolves.toEqual({ id: 'U2', teamId: 'T1', isBot: false, deleted: false, label: 'Alice' });
  });

  it('resolves an existing selected message to its authenticated Slack thread root', async () => {
    let permalink = 'https://workspace.slack.com/archives/C1/p123456';
    const api = createSlackApi({ credentials, http: { async request(input) {
      const url = new URL(input.url);
      expect(url.pathname).toBe('/api/chat.getPermalink');
      expect(url.searchParams.get('channel')).toBe('C1');
      expect(url.searchParams.get('message_ts')).toBe('123.456');
      return response({ ok: true, channel: 'C1', permalink });
    } } });
    await expect(api.getThreadRoot('C1', '123.456')).resolves.toEqual({ threadTs: '123.456' });
    permalink += '?thread_ts=100.001&cid=C1';
    await expect(api.getThreadRoot('C1', '123.456')).resolves.toEqual({ threadTs: '100.001' });
  });

  it.each([
    { channel: 'OTHER', permalink: 'https://workspace.slack.com/archives/C1/p123456' },
    { channel: 'C1', permalink: 'https://outside.example/archives/C1/p123456' },
    { channel: 'C1', permalink: 'https://workspace.slack.com/archives/OTHER/p123456' },
    { channel: 'C1', permalink: 'https://workspace.slack.com/archives/C1/p999999' },
    { channel: 'C1', permalink: 'https://workspace.slack.com/archives/C1/p123456?thread_ts=invalid' },
  ])('rejects uncorrelated thread evidence', async (body) => {
    const api = createSlackApi({ credentials, http: { async request() { return response({ ok: true, ...body }); } } });
    await expect(api.getThreadRoot('C1', '123.456')).resolves.toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
  });

  it.each([
    ['invalid_auth', 'credentialInvalid'], ['token_revoked', 'credentialInvalid'], ['missing_scope', 'permissionMissing'],
  ])('maps %s to typed %s on reads and writes', async (error, reason) => {
    const api = createSlackApi({ credentials, http: { async request() { return response({ ok: false, error }); } } });
    await expect(api.getIdentity()).resolves.toMatchObject({ kind: 'notReady', reason });
    await expect(api.postMessage(payload())).resolves.toMatchObject({ kind: 'notReady', reason });
  });

  it('passes provider rate-limit custody without retrying or losing Retry-After', async () => {
    let attempts = 0;
    const api = createSlackApi({ credentials, http: { async request() {
      attempts += 1;
      return response({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '17' });
    } } });
    const result = await api.postMessage(payload());
    expect(result).toEqual({ kind: 'notDelivered', retry: 'after', retryAfterMs: 17_000 });
    expect(ConversationDeliveryResultV1Schema.parse(result)).toEqual(result);
    expect(attempts).toBe(1);
    await expect(api.getChannel('C1')).resolves.toMatchObject({ kind: 'notReady', reason: 'rateLimited', retryAfterMs: 17_000 });
  });

  it.each([
    response({ ok: true }), response({ ok: true, channel: 'OTHER', ts: '123.456' }),
    response({ ok: false, error: 'internal_error' }), response({ ok: false, error: 'fatal_error' }),
    response({ ok: false, error: 'service_unavailable' }, 503),
  ])('preserves uncertain sends as outcomeUnknown', async (result) => {
    const api = createSlackApi({ credentials, http: { async request() { return result; } } });
    await expect(api.postMessage(payload())).resolves.toEqual({ kind: 'outcomeUnknown' });
  });

  it('does not retry after a lost send response, and returns accepted IDs only on confirmed success', async () => {
    let attempts = 0;
    const api = createSlackApi({ credentials, http: { async request(input) {
      attempts += 1;
      const body: unknown = JSON.parse(new TextDecoder().decode(input.body));
      expect(body).toEqual(payload());
      if (attempts === 1) throw new Error('Connection lost');
      return response({ ok: true, channel: 'C1', ts: '123.456', message: { text: 'hello' } });
    } } });
    await expect(api.postMessage(payload())).resolves.toEqual({ kind: 'outcomeUnknown' });
    expect(attempts).toBe(1);
    await expect(api.postMessage(payload())).resolves.toEqual({ kind: 'delivered', providerMessageIds: ['123.456'] });
  });

  it('does not claim a complete delivery when Slack reports native truncation', async () => {
    const api = createSlackApi({ credentials, http: { async request() {
      return response({ ok: true, channel: 'C1', ts: '123.456', response_metadata: { warnings: ['message_truncated'] } });
    } } });
    await expect(api.postMessage(payload())).resolves.toEqual({ kind: 'outcomeUnknown', providerMessageIds: ['123.456'] });
  });

  it('keeps archived endpoints distinct from denied posting permission', async () => {
    let error = 'is_archived';
    const api = createSlackApi({ credentials, http: { async request() { return response({ ok: false, error }); } } });
    await expect(api.postMessage(payload())).resolves.toEqual({ kind: 'endpointArchived', recovery: 'ownerMustUnarchiveOrRebind' });
    error = 'not_in_channel';
    await expect(api.postMessage(payload())).resolves.toMatchObject({ kind: 'notReady', reason: 'permissionMissing' });
  });

  it('rejects malformed user authority instead of treating missing bot/deleted facts as a human', async () => {
    const api = createSlackApi({ credentials, http: { async request() {
      return response({ ok: true, user: { id: 'U2', team_id: 'T1', profile: { display_name: 'Alice' } } });
    } } });
    await expect(api.getUser('U2')).resolves.toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
  });

  it('does not resolve a different authenticated channel or user than the requested immutable ID', async () => {
    const api = createSlackApi({ credentials, http: { async request() {
      return response({ ok: true, channel: { id: 'OTHER', is_im: true },
        user: { id: 'OTHER', team_id: 'T1', is_bot: false, deleted: false } });
    } } });
    await expect(api.getChannel('D1')).resolves.toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
    await expect(api.getUser('U2')).resolves.toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
  });

  it('makes no provider effect for already-cancelled sends', async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    const api = createSlackApi({ credentials, http: { async request() { attempts += 1; return response({ ok: true }); } } });
    await expect(api.postMessage(payload(), { signal: controller.signal })).resolves.toEqual({ kind: 'notDelivered', retry: 'safe' });
    expect(attempts).toBe(0);
  });

  it('retains confirmed acceptance if cancellation arrives with the send response', async () => {
    const controller = new AbortController();
    const api = createSlackApi({ credentials, http: { async request() {
      controller.abort();
      return response({ ok: true, channel: 'C1', ts: '123.456' });
    } } });
    await expect(api.postMessage(payload(), { signal: controller.signal }))
      .resolves.toEqual({ kind: 'delivered', providerMessageIds: ['123.456'] });
  });
});

// Private downloads must preserve binary bytes and never expose bearer credentials via redirects.
describe('Slack private files', () => {
  it.each([200, 403, 429, 503])('downloads bytes or preserves the HTTP failure at %s', async status => {
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const signal = new AbortController().signal;
    const urls: string[] = [];
    const api = createSlackApi({ credentials, http: { async request(input, options) {
      urls.push(input.url);
      expect(options?.signal).toBe(signal);
      expect(input.redirect).toBe('error');
      expect(input.headers?.Authorization).toBe('Bearer xoxb-test');
      if (new URL(input.url).pathname === '/api/files.info') {
        expect(new URL(input.url).searchParams.get('file')).toBe('F1');
        return response({ ok: true, file: { id: 'F1', url_private: 'https://files.slack.com/private' } });
      }
      return { status, headers: { 'retry-after': '2' }, finalUrl: input.url, body: bytes };
    } } });
    expect(await api.downloadFile('F1', { signal })).toEqual(status === 200 ? { kind: 'downloaded', bytes }
      : status === 429 ? { kind: 'notReady', reason: 'rateLimited', retryAfterMs: 2000 }
      : { kind: 'notReady', reason: status === 403 ? 'permissionMissing' : 'network' });
    expect(urls).toHaveLength(2);
  });
  it('does not send credentials to a foreign private URL', async () => {
    let requests = 0;
    const api = createSlackApi({ credentials, http: { async request() {
      requests += 1;
      return response({ ok: true, file: { id: 'F1', url_private: 'https://outside.example/file' } });
    } } });
    expect(await api.downloadFile('F1')).toMatchObject({ kind: 'notReady', reason: 'unsupported' });
    expect(requests).toBe(1);
  });
});
