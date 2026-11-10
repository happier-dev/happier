import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { defineProtocolArray as array, defineProtocolLiteral as literal, defineProtocolObject as object,
  defineProtocolString as string, defineProtocolNumber as number, defineProtocolUnion as union } from '@happier-dev/plugin-sdk/protocol';
import { cloudflareZoneIdentity, isObject } from '../connectedAccounts/probe.js';

const closed = { policy: 'closed' } as const;
const text = string({ minLength: 1 });
const zone = object({ accountId: text, zoneId: text, name: text }, closed);
const selectedZoneInput = object({ credentialRef: QualifiedConnectedAccountRefSchema, accountId: text, zoneId: text }, closed);
const selectedZoneResult = union([
  object({ kind: literal('ready'), zones: array(zone), defaultZoneId: text }, closed),
  object({ kind: literal('unavailable'), zones: array(zone), reason: text, providerStatus: number().optional() }, closed),
]);

/** Read the deliberate selected zone; never infer a default from list order.
 * GET zone accepts DNS Write and reports exact Account identity/status/type:
 * https://developers.cloudflare.com/api/resources/zones/methods/get/
 * Partial zones support Tunnel, but every hostname needs external DNS setup:
 * https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/
 */
export async function readSelectedZone(value: JsonValue, context: PluginAccountActionContext,
  purpose: 'tunnel.manage' | 'deploy.manage' = 'tunnel.manage') {
  if (!context.services.http) throw new PluginError({ code: 'client_required' });
  const input = value as ReturnType<typeof selectedZoneInput.parse>;
  const unavailable = (reason: string, providerStatus?: number) => ({ kind: 'unavailable' as const, zones: [], reason,
    ...(providerStatus === undefined ? {} : { providerStatus }) });
  context.signal.throwIfAborted();
  try {
    const response = await context.services.http.request({ method: 'GET',
      url: `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(input.zoneId)}`, redirect: 'error',
      credentialBinding: { kind: 'connectedAccountPurpose', purpose, origin: 'https://api.cloudflare.com', method: 'GET', headerNames: ['authorization'] },
    }, { signal: context.signal }).catch(error => {
      context.signal.throwIfAborted();
      if (isPluginError(error)) throw error;
      return null;
    });
    context.signal.throwIfAborted();
    if (response === null) return unavailable('network_unavailable');
    if (response.status === 401) return unavailable('credential_unavailable', response.status);
    if (response.status === 403) return unavailable('denied', response.status);
    if (response.status !== 200) return unavailable('provider_unavailable', response.status);
    const body: unknown = JSON.parse(new TextDecoder().decode(response.body));
    if (!isObject(body) || body.success !== true) return unavailable('invalid_provider_output');
    const identity = cloudflareZoneIdentity(body.result, input.accountId, input.zoneId);
    if (!identity || !isObject(body.result) || typeof body.result.status !== 'string'
      || typeof body.result.paused !== 'boolean' || typeof body.result.type !== 'string') return unavailable('invalid_provider_output');
    if (body.result.status !== 'active') return unavailable('zone_not_active');
    if (body.result.paused) return unavailable('zone_paused');
    if (body.result.type === 'partial') return unavailable('external_dns_setup_required');
    // Secondary/internal DNS has no established automatic public Tunnel route.
    if (body.result.type !== 'full') return unavailable('zone_type_requires_setup');
    return { kind: 'ready' as const, zones: [identity], defaultZoneId: identity.zoneId };
  } catch (error) {
    context.signal.throwIfAborted();
    if (isPluginError(error)) throw error;
    return unavailable('invalid_provider_output');
  }
}

export const zoneActions = {
  'cloudflare-named/zone-read': {
    title: 'Read selected Cloudflare tunnel zone', description: 'Read whether the explicitly selected zone can supply an automatic public tunnel DNS route.',
    execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
    scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
    dangerLevel: 'safe', readOnly: true,
    inputSchema: selectedZoneInput, resultSchema: selectedZoneResult,
    hostAccess: ['tunnel.manage', 'cloudflare-api'],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'tunnel.manage' }],
    run: readSelectedZone,
  },
} as const;
