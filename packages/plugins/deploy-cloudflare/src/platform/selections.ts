import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
import { AccessProviderSelectionV1Schema } from '@happier-dev/plugin-sdk/access-providers';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { defineProtocolArray as array, defineProtocolLiteral as literal, defineProtocolObject as object,
  defineProtocolString as string, defineProtocolUnion as union, type ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { isObject } from '../connectedAccounts/probe.js';
import { CloudflareProviderRefusal, cloudflareHasNextPage, cloudflareRemoteTunnel,
  cloudflareResponseOperation, readCloudflareResponse } from './cloudflareRoutes.js';
import { readSelectedZone } from './zone.js';
import { CLOUDFLARE_CONNECTOR_DEFAULTS } from './connectorDefaults.js';

const closed = { policy: 'closed' } as const;
const text = string({ minLength: 1 });
const connectorDiscoverySchema = object({ kind: literal('unavailable'), reason: literal('connector_discovery_unavailable') }, closed);
const connectorDiscovery = { kind: 'unavailable', reason: 'connector_discovery_unavailable' } as const;
const selectionOption = object({ label: text, selection: AccessProviderSelectionV1Schema }, closed);
const zoneOption = object({ zoneId: text, name: text }, closed);
const connectorSchema = object({ imageRef: text, version: text }, closed);
const defaultsSchema = object({ accountId: text.optional(), connector: connectorSchema }, closed);
const selectionsInput = object({ credentialRef: QualifiedConnectedAccountRefSchema, accountId: text.optional(), zoneId: text.optional(),
  hostname: text, connector: connectorSchema.optional() }, closed);
const selectionsResult = union([
  object({ kind: literal('ready'), zones: array(zoneOption), options: array(selectionOption, { maxItems: 0 }),
    defaults: defaultsSchema, connectorDiscovery: connectorDiscoverySchema }, closed),
  object({ kind: literal('ready'), options: array(selectionOption), defaults: defaultsSchema, connectorDiscovery: connectorDiscoverySchema }, closed),
  object({ kind: literal('unavailable'), options: array(selectionOption, { maxItems: 0 }), reason: text,
    defaults: defaultsSchema, connectorDiscovery: connectorDiscoverySchema }, closed),
]);

/** An omitted zone lists the configured Account's zones when the token allows it.
 * A permission refusal leaves the caller able to supply an explicit zone.
 * Tunnels belong to an Account, not a zone: validate that exact zone first,
 * then offer remote tunnels using the connected Account identity and canonical
 * connector pin unless the caller deliberately supplies overrides.
 * Cloudflare v4 list contract checked 2026-11-07:
 * https://developers.cloudflare.com/api/resources/zones/methods/list/
 * https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/list/
 */
const readSelections: PluginAccountActionHandler<ReturnType<typeof selectionsInput.parse>,
  ReturnType<typeof selectionsResult.parse>> = async (input, context) => {
  const accounts = await context.services.actions.execute('connectedServices.accounts.list',
    { service: input.credentialRef.service }, { signal: context.signal });
  context.signal.throwIfAborted();
  const profile = 'accounts' in accounts ? accounts.accounts.find(({ account }) =>
    account.ref.accountId === input.credentialRef.accountId
      && account.ref.service.pluginId === input.credentialRef.service.pluginId
      && account.ref.service.localId === input.credentialRef.service.localId)?.account : undefined;
  const connectedAccountId = profile?.providerIdentity?.accountId;
  const defaults = { connector: CLOUDFLARE_CONNECTOR_DEFAULTS,
    ...(typeof connectedAccountId === 'string' && connectedAccountId.length > 0 ? { accountId: connectedAccountId } : {}) };
  const unavailable = (reason: string) => ({ kind: 'unavailable' as const, options: [], reason, defaults, connectorDiscovery });
  const accountId = input.accountId ?? defaults.accountId;
  if (accountId === undefined) return unavailable('account_id_unavailable');
  const connector = input.connector ?? defaults.connector;
  const zoneId = input.zoneId;
  if (zoneId !== undefined) {
    const selected = await readSelectedZone({ credentialRef: input.credentialRef, accountId, zoneId }, context);
    if (selected.kind === 'unavailable') return unavailable(selected.reason);
    const hostname = input.hostname.toLowerCase(), zoneName = selected.zones[0].name.toLowerCase();
    if (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) return unavailable('hostname_outside_zone');
  }
  const collection = zoneId === undefined ? 'https://api.cloudflare.com/client/v4/zones'
    : `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`;
  const operation = zoneId === undefined ? 'GET /zones' : cloudflareResponseOperation('GET', collection);
  const options: Array<ReturnType<typeof selectionOption.parse>> = [];
  const zones: Array<ReturnType<typeof zoneOption.parse>> = [];
  try {
    for (let page = 1; ; page += 1) {
      context.signal.throwIfAborted();
      const query = new URLSearchParams(zoneId === undefined ? { 'account.id': accountId, page: String(page) }
        : { is_deleted: 'false', page: String(page) });
      const response = await context.services.http.request({ method: 'GET', url: `${collection}?${query}`, redirect: 'error',
        credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'tunnel.manage', origin: 'https://api.cloudflare.com',
          method: 'GET', headerNames: ['authorization'] } }, { signal: context.signal });
      context.signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) return unavailable(zoneId === undefined ? 'zone_list_unavailable' : 'denied');
      if (response.status < 200 || response.status >= 300) return unavailable('provider_unavailable');
      const native = readCloudflareResponse(response.body, operation);
      if (!Array.isArray(native.result)) return unavailable('invalid_provider_output');
      const rows: readonly ProtocolJsonValue[] = native.result;
      for (const row of rows) {
        if (!isObject(row)) return unavailable('invalid_provider_output');
        // The vendor marks coordinates optional. A row without coordinates
        // cannot produce a complete choice; explicit malformed values refuse.
        if (row.id === undefined || row.name === undefined) continue;
        if (typeof row.id !== 'string' || row.id.length === 0 || typeof row.name !== 'string' || row.name.length === 0) {
          return unavailable('invalid_provider_output');
        }
        if (zoneId === undefined) {
          zones.push({ zoneId: row.id, name: row.name });
          continue;
        }
        if (!cloudflareRemoteTunnel(row, accountId)) continue;
        options.push({ label: row.name, selection: { provider: { kind: 'builtin', id: 'cloudflareNamed' },
          config: { hostname: input.hostname, controller: { accountId, zoneId,
            connector, tunnel: { kind: 'adopt', tunnelId: row.id, name: row.name }, owned: [], dnsOwnership: [] } },
          credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account: input.credentialRef } }] } });
      }
      if (!cloudflareHasNextPage(native, page, operation)) return zoneId === undefined
        ? { kind: 'ready', zones, options: [], defaults, connectorDiscovery } : { kind: 'ready', options, defaults, connectorDiscovery };
    }
  } catch (error) {
    context.signal.throwIfAborted();
    if (isPluginError(error)) throw error;
    return unavailable(error instanceof CloudflareProviderRefusal ? error.code : 'provider_unavailable');
  }
};

export const selectionActions = {
  'cloudflare-named/selections-read': {
    title: 'Read named Cloudflare tunnel choices',
    description: 'List Account zones or read complete tunnel choices using connected Account and connector defaults with optional overrides. Connector discovery is unavailable.',
    execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
    scopes: ['global'], surfaces: ['cli', 'plugin', 'ui'], placementBindings: [], dangerLevel: 'safe', readOnly: true,
    inputSchema: selectionsInput, resultSchema: selectionsResult,
    hostAccess: ['tunnel.manage', 'cloudflare-api'],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'tunnel.manage' }],
    run: readSelections,
  },
} as const;
