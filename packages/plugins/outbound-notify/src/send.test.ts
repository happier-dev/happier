import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationSendRequest } from '@happier-dev/plugin-sdk/notifications';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { senders, type SendContext } from './send.js';
import { outboundNotifyPlugin } from './manifest.js';

const request: NotificationSendRequest = { clientRequestId: 'request-1', deliveryId: 'delivery-1', channelId: 'selected',
  title: 'Build finished ✓', body: 'Deployment is ready', data: { privateEvidence: 'must not leave' } };
function boundary(options: { status?: number; body?: unknown; settings?: Record<string, string>; secrets?: Record<string, string> } = {}) {
  const settings = options.settings ?? { 'ntfy-url': 'https://ntfy.example/base/', 'ntfy-topic': 'ops', 'gotify-url': 'https://gotify.example/base/' };
  const secrets = options.secrets ?? { 'ntfy-token': 'ntfy-secret', 'teams-url': 'https://teams.example/workflow/secret',
    'mattermost-url': 'https://chat.example/hooks/secret', 'gotify-token': 'gotify-secret', 'pushover-token': 'app-secret', 'pushover-user': 'user-secret' };
  const http = vi.fn(async (_input: Parameters<SendContext['services']['http']['request']>[0], _options?: { signal?: AbortSignal }) => ({ status: options.status ?? 200, finalUrl: 'https://receiver.example/', headers: {},
    body: new TextEncoder().encode(JSON.stringify(options.body ?? { status: 1 })) }));
  return { http, context: { signal: new AbortController().signal, services: {
    logger: { warn: vi.fn() },
    http: createPluginHttpFixture({ request: http }), settings: { forScope: () => ({ get: async (id: string) => settings[id] ?? null }) },
    secrets: { status: async (id: string) => ({ state: id in secrets ? 'configured' as const : 'missing' as const, revision: '1' }),
      get: async (id: string) => { if (!(id in secrets)) throw new Error('secret unavailable'); return secrets[id]; } },
  } } };
}

describe('outbound notification provider contracts', () => {
  it('admits and activates the contributed senders through the public SDK', async () => {
    const kit = await createPluginTestkit({ manifest: outboundNotifyPlugin.manifest, module: outboundNotifyPlugin });
    try {
      expect(kit.registration('notificationChannels', 'mattermost')).toBeDefined();
    } finally { await kit.dispose(); }
  });
  it.each([
    ['ntfy', 'https://ntfy.example/base/', { topic: 'ops', title: request.title, message: request.body }, { authorization: 'Bearer ntfy-secret' }],
    ['mattermost', 'https://chat.example/hooks/secret', { text: `${request.title}\n${request.body}` }, {}],
    ['teams', 'https://teams.example/workflow/secret', { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null,
      content: { type: 'AdaptiveCard', version: '1.2', body: [
        { type: 'TextBlock', text: request.title, weight: 'Bolder', wrap: true }, { type: 'TextBlock', text: request.body, wrap: true },
      ] } }] }, {}],
    ['gotify', 'https://gotify.example/base/message', { title: request.title, message: request.body }, { 'X-Gotify-Key': 'gotify-secret' }],
    ['pushover', 'https://api.pushover.net/1/messages.json', { token: 'app-secret', user: 'user-secret', title: request.title, message: request.body }, {}],
  ] as const)('%s sends exactly one provider payload, without raw host data', async (provider, url, payload, headers) => {
    const { http, context } = boundary();
    expect(await senders[provider](request, context)).toEqual({ deliveryId: request.deliveryId, channelId: request.channelId, status: 'accepted', evidence: 'provider' });
    expect(http).toHaveBeenCalledTimes(1);
    const [sent, options] = http.mock.calls[0];
    expect(sent).toMatchObject({ url, method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...headers } });
    expect(JSON.parse(new TextDecoder().decode(sent.body))).toEqual(payload);
    expect(options?.signal).toBe(context.signal);
  });

  it('allows public ntfy topics without a token and preserves Unicode without a header encoding', async () => {
    const { http, context } = boundary({ secrets: {} });
    expect(await senders.ntfy({ ...request, body: undefined }, context)).toMatchObject({ status: 'accepted' });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each(Object.keys(senders) as (keyof typeof senders)[])('%s refuses missing configuration before HTTP', async provider => {
    const { http, context } = boundary({ settings: {}, secrets: {} });
    expect(await senders[provider](request, context)).toMatchObject({ status: 'failed' });
    expect(http).not.toHaveBeenCalled();
  });

  it('retains the HTTP refusal status without echoing provider response bytes or credentials', async () => {
    const { http, context } = boundary({ status: 403, body: { error: 'secret echoed' } });
    expect(await senders.gotify(request, context)).toEqual({ deliveryId: request.deliveryId, channelId: request.channelId,
      status: 'failed', code: 'notification_http_403', retryable: false });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('retains the safe preparation cause without attempting delivery', async () => {
    const { http, context } = boundary();
    const privateDetails = 'private saved-secret retrieval failure';
    context.services.secrets.get = async () => { throw Object.assign(new Error(privateDetails), { code: 'ECONNRESET' }); };
    expect(await senders.teams(request, context)).toEqual({ deliveryId: request.deliveryId, channelId: request.channelId,
      status: 'failed', code: 'notification_configuration_unavailable', retryable: false });
    expect(http).not.toHaveBeenCalled();
    expect(context.services.logger.warn).toHaveBeenCalledWith(expect.any(String), { failureCause: expect.objectContaining({ errorCode: 'ECONNRESET' }) });
    expect(JSON.stringify(context.services.logger.warn.mock.calls)).not.toContain(privateDetails);
  });

  it('does not replay an uncertain transport effect', async () => {
    const { http, context } = boundary();
    const privateDetails = 'secret in URL must not escape';
    http.mockRejectedValueOnce(Object.assign(new Error(privateDetails), { code: 'ECONNRESET' }));
    expect(await senders.teams(request, context)).toEqual({ deliveryId: request.deliveryId, channelId: request.channelId,
      status: 'outcomeUnknown', code: 'plugin_notification_outcome_unknown' });
    expect(http).toHaveBeenCalledTimes(1);
    expect(context.services.logger.warn).toHaveBeenCalledWith(expect.any(String), { failureCause: expect.objectContaining({ errorCode: 'ECONNRESET' }) });
    expect(JSON.stringify(context.services.logger.warn.mock.calls)).not.toContain(privateDetails);
  });

  it('does not accept a Pushover application refusal returned with HTTP 200', async () => {
    const { context } = boundary({ body: { status: 0, errors: ['private provider response'] } });
    expect(await senders.pushover(request, context)).toMatchObject({ status: 'failed', code: 'notification_provider_rejected' });
  });

  it('delivers Mattermost JSON to a real HTTP receiver using its configured path', async () => {
    let received: unknown;
    let receivedPath: string | undefined;
    const server = createServer((incoming, response) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { body += chunk; });
      incoming.on('end', () => {
        received = JSON.parse(body);
        receivedPath = incoming.url;
        response.writeHead(200).end('ok');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP receiver did not bind');
      const { context } = boundary({ secrets: { 'mattermost-url': `http://127.0.0.1:${address.port}/hooks/private` } });
      context.services.http = createPluginHttpFixture({ request: async (input, options) => {
        const response = await fetch(input.url, { method: input.method, headers: input.headers,
          body: input.body ? Buffer.from(input.body) : undefined, redirect: input.redirect, signal: options?.signal });
        return { status: response.status, headers: {}, body: new Uint8Array(await response.arrayBuffer()) };
      } });
      expect(await senders.mattermost(request, context)).toMatchObject({ status: 'accepted' });
      expect(received).toEqual({ text: `${request.title}\n${request.body}` });
      expect(receivedPath).toBe('/hooks/private');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('cancels before the outbound effect', async () => {
    const { http, context } = boundary();
    const abort = new AbortController(); abort.abort();
    await expect(senders.ntfy(request, { ...context, signal: abort.signal })).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
  });
});
