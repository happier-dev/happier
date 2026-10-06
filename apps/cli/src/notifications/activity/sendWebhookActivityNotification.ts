import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';

import { assessEndpointHostLocality, ProviderEndpointSafetyError } from '@happier-dev/protocol/providers/safety/url';
import { classifyProviderHostnameSyntax, parseProviderIpAddress } from '@happier-dev/protocol/providers/safety/locality';
import { isProviderMetadataHostname } from '@happier-dev/protocol/providers/safety/metadataDestinations';
import { buildActivityWebhookPayload } from '@happier-dev/protocol/activity/webhookPayload';
import { decryptSecretValueWithKeysV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { hasConfiguredSecretStringValue } from '@happier-dev/protocol/account/settings/notificationChannels';
import type { AttentionPreviewBehavior, WebhookNotificationChannelV1 } from '@happier-dev/protocol';

import { openPinnedHttpStream, type PinnedHttpStreamTransport } from '@/network/pinnedHttp';

import type { ActivityNotificationEvent } from './activityNotificationEvent';
import { buildActivityNotificationContent } from './buildActivityNotificationContent';

/** DNS is a genuine system boundary; every caller may substitute it. */
export type WebhookDestinationAddressResolver = (hostname: string) => Promise<readonly string[]>;

export type WebhookActivityNotificationNetworkDependencies = Readonly<{
  resolveAddresses?: WebhookDestinationAddressResolver;
  openPinnedStream?: PinnedHttpStreamTransport;
}>;

const resolveWebhookDestinationAddresses: WebhookDestinationAddressResolver = async (hostname) => (
  (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address)
);

/**
 * Keeps the bound the previous global-`fetch` transport applied — undici caps
 * header and body waits at 300s — because `node:http` applies none. An
 * unresponsive receiver otherwise holds this socket and the sequential channel
 * loop behind it forever.
 */
const WEBHOOK_REQUEST_WALL_TIME_MS = 300_000;

type AdmittedWebhookDestination = Readonly<{
  url: string;
  validatedAddresses: readonly string[];
}>;

function readSigningSecret(
  secret: WebhookNotificationChannelV1['signingSecret'],
  settingsSecretsReadKeys: ReadonlyArray<Uint8Array | null | undefined>,
): string | null {
  if (!hasConfiguredSecretStringValue(secret)) return null;
  const value = decryptSecretValueWithKeysV1(secret, settingsSecretsReadKeys)?.trim() ?? '';
  return value.length > 0 ? value : null;
}

/**
 * Admits one webhook destination through the canonical host-locality owner and
 * carries the exact admitted answers to the pinned socket owner, so the address
 * this decision saw is the address the connection uses. Resolving again at the
 * socket would reopen the window this check closes.
 *
 * A public destination must be HTTPS: the payload carries session titles,
 * assistant preview text and the channel HMAC. A non-public destination is
 * admitted only when the configured URL itself names it — a literal address, or
 * a `localhost` host that the locality owner confirms resolves wholly inside
 * loopback. A name that merely *resolves* into loopback, private, link-local or
 * an unsafe range is refused, so DNS cannot turn a public-looking channel into a
 * request against the machine's own network.
 */
async function admitWebhookDestination(
  rawUrl: string,
  resolveAddresses: WebhookDestinationAddressResolver,
): Promise<AdmittedWebhookDestination> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Webhook notification destination must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Webhook notification destination must not contain URL credentials');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '');
  if (isProviderMetadataHostname(hostname)) {
    throw new Error('Webhook notification destination rejected (unsafe_address)');
  }
  const literalAddress = parseProviderIpAddress(hostname);
  const resolvedAddresses = literalAddress ? undefined : await resolveAddresses(hostname);

  let assessed: ReturnType<typeof assessEndpointHostLocality>;
  try {
    assessed = assessEndpointHostLocality({
      hostname,
      literalAddress,
      ...(resolvedAddresses ? { resolvedAddresses } : {}),
    });
  } catch (error) {
    if (error instanceof ProviderEndpointSafetyError) {
      throw new Error(`Webhook notification destination rejected (${error.code})`);
    }
    throw error;
  }

  if (assessed.locality === 'public') {
    if (parsed.protocol !== 'https:') {
      throw new Error('Webhook notification destination must use HTTPS');
    }
  } else if (literalAddress === null && classifyProviderHostnameSyntax(hostname) !== 'loopback') {
    throw new Error('Webhook notification destination resolved to a non-public address');
  }

  return Object.freeze({
    url: parsed.toString(),
    validatedAddresses: Object.freeze([...assessed.resolvedAddresses]),
  });
}

export async function sendWebhookActivityNotificationAsync(params: Readonly<{
  channel: WebhookNotificationChannelV1;
  event: ActivityNotificationEvent;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  nowMs?: () => number;
  network?: WebhookActivityNotificationNetworkDependencies;
  previewBehavior?: AttentionPreviewBehavior;
}>): Promise<void> {
  const built = buildActivityNotificationContent(params.event, {
    readyIncludeMessageText: params.channel.readyIncludeMessageText !== false,
    requestIncludeMessageText: params.channel.requestIncludeMessageText !== false,
    previewBehavior: params.previewBehavior,
  });
  const request = params.event.topic === 'permission_request' || params.event.topic === 'user_action_request'
    ? {
      requestId: params.event.requestId,
      kind: params.event.topic === 'user_action_request' ? 'user_action' as const : 'permission' as const,
      toolName: params.event.toolName,
      toolDetails: built.toolDetails ?? null,
    }
    : null;
  const payload = buildActivityWebhookPayload({
    ...(params.event.topic === 'notify_me' ? { notificationOpen: params.event.open } : {}),
    channelId: params.channel.id,
    createdAt: (params.nowMs ?? (() => Date.now()))(),
    topic: params.event.topic,
    content: {
      title: built.title,
      body: built.body,
    },
    session: 'sessionId' in params.event && params.event.sessionId ? {
      sessionId: params.event.sessionId,
      title: params.previewBehavior === 'status_only' ? null : params.event.sessionTitle ?? null,
    } : null,
    request,
    workflowRun: params.event.topic === 'workflow_run_update'
      ? {
        runId: params.event.runId,
        updateKind: params.event.updateKind,
        ...(params.event.reason ? { reason: params.event.reason } : {}),
      }
      : null,
  });
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
  };
  const signingSecret = readSigningSecret(
    params.channel.signingSecret,
    params.settingsSecretsReadKeys ?? [],
  );
  if (signingSecret) {
    headers['x-happier-signature-256'] = `sha256=${createHmac('sha256', signingSecret).update(body).digest('hex')}`;
  }

  const destination = await admitWebhookDestination(
    params.channel.url,
    params.network?.resolveAddresses ?? resolveWebhookDestinationAddresses,
  );
  const abort = new AbortController();
  const response = await (params.network?.openPinnedStream ?? openPinnedHttpStream)({
    url: destination.url,
    validatedAddresses: destination.validatedAddresses,
    headers,
    method: 'POST',
    body,
    signal: abort.signal,
    wallTimeMs: WEBHOOK_REQUEST_WALL_TIME_MS,
  });
  response.cancel();
  if (response.status >= 300 && response.status < 400) {
    // Following the hop would dispatch the signed payload to a destination this
    // admission never saw. A next hop is the destination operator's request, so
    // it must be reconfigured as the channel URL rather than followed here.
    throw new Error('Webhook notification destination returned a redirect');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Webhook notification failed with status ${response.status}`);
  }
}
