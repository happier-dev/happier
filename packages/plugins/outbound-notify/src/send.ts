import { isPluginError, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import type { NotificationSendRequest, NotificationSendResult } from '@happier-dev/plugin-sdk/notifications';
type Services = PluginInvocationContext['services'];
export type SendContext = Readonly<{ signal: AbortSignal; services: {
  http: Pick<Services['http'], 'request'>;
  settings: { forScope(scope: { kind: 'account' }): { get(id: string, options?: { signal?: AbortSignal }): Promise<unknown> } };
  secrets: Pick<Services['secrets'], 'status' | 'get'>;
  logger: Pick<Services['logger'], 'warn'>;
} }>;

type Provider = 'ntfy' | 'teams' | 'mattermost' | 'gotify' | 'pushover';

/** Settings and Saved Secrets retain configuration custody; never put credentials in destination/data. */
async function buildRequest(provider: Provider, request: NotificationSendRequest, context: SendContext) {
  const settings = context.services.settings.forScope({ kind: 'account' });
  const setting = async (id: string) => {
    const value = await settings.get(id, { signal: context.signal });
    if (typeof value !== 'string' || !value.trim()) throw new PluginError({ code: 'notification_configuration_missing' });
    return value.trim();
  };
  const secret = async (id: string) => {
    const value = await context.services.secrets.get(id, { signal: context.signal });
    if (!value.trim()) throw new PluginError({ code: 'notification_configuration_missing' });
    return value.trim();
  };
  const message = request.body || request.title;
  let url: string;
  let payload: unknown;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  switch (provider) {
    case 'ntfy': {
      url = await setting('ntfy-url');
      const topic = await setting('ntfy-topic');
      const tokenStatus = await context.services.secrets.status('ntfy-token');
      if (tokenStatus.state !== 'missing') headers.authorization = 'Bearer ' + await secret('ntfy-token');
      payload = { topic, title: request.title, message };
      break;
    }
    case 'mattermost':
      url = await secret('mattermost-url');
      payload = { text: [request.title, request.body].filter(Boolean).join('\n') };
      break;
    case 'teams':
      url = await secret('teams-url');
      payload = { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null,
        content: { type: 'AdaptiveCard', version: '1.2', body: [
          { type: 'TextBlock', text: request.title, weight: 'Bolder', wrap: true },
          ...(request.body ? [{ type: 'TextBlock', text: request.body, wrap: true }] : []),
        ] },
      }] };
      break;
    case 'gotify': {
      const base = new URL(await setting('gotify-url'));
      base.pathname = base.pathname.replace(/\/+$/u, '') + '/message';
      url = base.toString();
      headers['X-Gotify-Key'] = await secret('gotify-token');
      payload = { title: request.title, message };
      break;
    }
    case 'pushover':
      url = 'https://api.pushover.net/1/messages.json';
      payload = { token: await secret('pushover-token'), user: await secret('pushover-user'), title: request.title, message };
      break;
  }
  // URL parsing belongs at configuration ingress; no private-network or plugin trust policy here.
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new PluginError({ code: 'notification_configuration_invalid' });
  }
  return { url: parsed.toString(), method: 'POST' as const, headers, body: new TextEncoder().encode(JSON.stringify(payload)),
    // Never replay a credential-bearing POST to a redirect target.
    redirect: 'error' as const, responseBody: provider === 'pushover' ? 'buffer' as const : 'discard' as const };
}

function sender(provider: Provider) {
  return async (request: NotificationSendRequest, context: SendContext): Promise<NotificationSendResult> => {
    const identity = { deliveryId: request.deliveryId, channelId: request.channelId };
    context.signal.throwIfAborted();
    let outgoing: Awaited<ReturnType<typeof buildRequest>>;
    try {
      outgoing = await buildRequest(provider, request, context);
    } catch (error) {
      context.signal.throwIfAborted();
      return { ...identity, status: 'failed', code: isPluginError(error) ? error.code
        : error instanceof TypeError ? 'notification_configuration_invalid' : 'notification_configuration_unavailable', retryable: false };
    }
    context.signal.throwIfAborted();
    try {
      const response = await context.services.http.request(outgoing, { signal: context.signal });
      if (response.status < 200 || response.status >= 300) {
        return { ...identity, status: 'failed', code: 'notification_http_' + response.status, retryable: false };
      }
      if (provider === 'pushover') {
        const result: unknown = JSON.parse(new TextDecoder().decode(response.body));
        if (result === null || typeof result !== 'object' || !('status' in result)) {
          return { ...identity, status: 'outcomeUnknown', code: 'plugin_notification_outcome_unknown' };
        }
        if (result.status !== 1) return { ...identity, status: 'failed', code: 'notification_provider_rejected', retryable: false };
      }
      return { ...identity, status: 'accepted', evidence: 'provider' };
    } catch (error) {
      // After dispatch a lost response/cancel can follow an effect. Retain only
      // the safe cause, without provider payloads or an automatic retry.
      context.services.logger.warn('[Notifications] send failed', {
        failureCause: projectActionFailureCauseV1(error, 'notification.send', { allowUnknownErrorCode: false }),
      });
      return { ...identity, status: 'outcomeUnknown', code: 'plugin_notification_outcome_unknown' };
    }
  };
}

export const senders = { ntfy: sender('ntfy'), teams: sender('teams'), mattermost: sender('mattermost'),
  gotify: sender('gotify'), pushover: sender('pushover') };
