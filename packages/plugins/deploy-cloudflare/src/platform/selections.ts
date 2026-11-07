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

const closed = { policy: 'closed' } as const;
const text = string({ minLength: 1 });
const connectorDiscoverySchema = object({ kind: literal('unavailable'), reason: literal('connector_discovery_unavailable') }, closed);
const connectorDiscovery = { kind: 'unavailable', reason: 'connector_discovery_unavailable' } as const;
const selectionOption = object({ label: text, selection: AccessProviderSelectionV1Schema }, closed);
const selectionsInput = object({ credentialRef: QualifiedConnectedAccountRefSchema, accountId: text, zoneId: text,
  hostname: text, connector: object({ imageRef: text, version: text }, closed) }, closed);
const selectionsResult = union([
  object({ kind: literal('ready'), options: array(selectionOption), connectorDiscovery: connectorDiscoverySchema }, closed),
  object({ kind: literal('unavailable'), options: array(selectionOption, { maxItems: 0 }), reason: text,
    connectorDiscovery: connectorDiscoverySchema }, closed),
]);

/** The caller supplies its configured Account/zone and deliberate connector.
 * Tunnels belong to an Account, not a zone: validate that exact zone first,
 * then offer remote tunnels for use with it. No Zone Read permission is added.
 * Cloudflare v4 list contract checked 2026-11-07:
 * https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/list/
 */
const readSelections: PluginAccountActionHandler<ReturnType<typeof selectionsInput.parse>,
  ReturnType<typeof selectionsResult.parse>> = async (input, context) => {
  const unavailable = (reason: string) => ({ kind: 'unavailable' as const, options: [], reason, connectorDiscovery });
  const selected = await readSelectedZone({ credentialRef: input.credentialRef, accountId: input.accountId, zoneId: input.zoneId }, context);
  if (selected.kind === 'unavailable') return unavailable(selected.reason);
  const hostname = input.hostname.toLowerCase(), zoneName = selected.zones[0].name.toLowerCase();
  if (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) return unavailable('hostname_outside_zone');
  const collection = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel`;
  const operation = cloudflareResponseOperation('GET', collection);
  const options: Array<ReturnType<typeof selectionOption.parse>> = [];
  try {
    for (let page = 1; ; page += 1) {
      context.signal.throwIfAborted();
      const query = new URLSearchParams({ is_deleted: 'false', page: String(page) });
      const response = await context.services.http.request({ method: 'GET', url: `${collection}?${query}`, redirect: 'error',
        credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'tunnel.manage', origin: 'https://api.cloudflare.com',
          method: 'GET', headerNames: ['authorization'] } }, { signal: context.signal });
      context.signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) return unavailable('denied');
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
        if (!cloudflareRemoteTunnel(row, input.accountId)) continue;
        options.push({ label: row.name, selection: { provider: { kind: 'builtin', id: 'cloudflareNamed' },
          config: { hostname: input.hostname, controller: { accountId: input.accountId, zoneId: input.zoneId,
            connector: input.connector, tunnel: { kind: 'adopt', tunnelId: row.id, name: row.name }, owned: [], dnsOwnership: [] } },
          credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account: input.credentialRef } }] } });
      }
      if (!cloudflareHasNextPage(native, page, operation)) return { kind: 'ready', options, connectorDiscovery };
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
    description: 'Read complete choices for the configured zone using an explicitly supplied connector. Connector discovery is unavailable.',
    execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
    scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [], dangerLevel: 'safe', readOnly: true,
    inputSchema: selectionsInput, resultSchema: selectionsResult,
    hostAccess: ['tunnel.manage', 'cloudflare-api'],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'tunnel.manage' }],
    run: readSelections,
  },
} as const;
