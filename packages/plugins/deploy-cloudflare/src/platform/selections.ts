import { PluginError, isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
import { AccessProviderSelectionV1Schema } from '@happier-dev/plugin-sdk/access-providers';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { defineProtocolArray as array, defineProtocolLiteral as literal, defineProtocolObject as object,
  defineProtocolString as string, defineProtocolNumber as number, defineProtocolUnion as union, type ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { isObject } from '../connectedAccounts/probe.js';
import { CloudflareProviderRefusal, cloudflareHasNextPage, cloudflareRemoteTunnel,
  cloudflareResponseOperation, readCloudflareResponse } from './cloudflareRoutes.js';
import { readSelectedZone } from './zone.js';
import { CLOUDFLARE_CONNECTOR_DEFAULTS } from './connectorDefaults.js';
import type { tunnelConfigureInput } from './tunnel.js';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';

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
    defaults: defaultsSchema, connectorDiscovery: connectorDiscoverySchema,
    dnsRecordAction: PluginContributionIdentityV1Schema.optional() }, closed),
  object({ kind: literal('ready'), options: array(selectionOption), createOption: selectionOption.optional(),
    defaults: defaultsSchema, connectorDiscovery: connectorDiscoverySchema }, closed),
  object({ kind: literal('unavailable'), options: array(selectionOption, { maxItems: 0 }), reason: text, requiredFact: text, remedy: text,
    providerStatus: number().optional(), defaults: defaultsSchema, connectorDiscovery: connectorDiscoverySchema }, closed),
]);

/** Read recovery belongs to the provider boundary; consumers display these facts. */
function selectionRecovery(reason: string): { requiredFact: string; remedy: string } {
  switch (reason) {
    case 'credential_unavailable': return { requiredFact: 'cloudflareCredential',
      remedy: 'Cloudflare could not use the selected account credential. Reconnect that account, then find zones again.' };
    case 'zone_list_unavailable': return { requiredFact: 'cloudflareZoneRead',
      remedy: 'Cloudflare refused zone listing. Grant Zone:Read access to the token, or enter the zone ID explicitly.' };
    case 'denied': return { requiredFact: 'cloudflarePermissions',
      remedy: 'Cloudflare refused access to the selected zone or tunnels. Check the token permissions and resource access, then retry.' };
    case 'network_unavailable': return { requiredFact: 'cloudflareNetwork',
      remedy: 'The request could not reach Cloudflare. Check the connection, then retry.' };
    case 'plugin_fetch_adapter_unavailable': return { requiredFact: 'cloudflareHttpTransport',
      remedy: "This Happier client couldn't complete the Cloudflare request. Check the connection, then retry." };
    case 'account_id_unavailable': return { requiredFact: 'cloudflareAccountId',
      remedy: 'The selected connection has no Cloudflare Account ID. Reconnect that account, or supply its Account ID in Advanced.' };
    case 'hostname_outside_zone': return { requiredFact: 'cloudflareHostnameZone',
      remedy: 'The hostname does not belong to the selected zone. Choose its zone or change the hostname.' };
    case 'zone_not_active': return { requiredFact: 'cloudflareActiveZone',
      remedy: 'The selected Cloudflare zone is not active. Complete its setup in Cloudflare, then retry.' };
    case 'zone_paused': return { requiredFact: 'cloudflareActiveZone',
      remedy: 'The selected Cloudflare zone is paused. Resume it in Cloudflare, then retry.' };
    case 'external_dns_setup_required': return { requiredFact: 'cloudflareZoneDns',
      remedy: 'The selected zone uses external DNS. Complete its external DNS setup before adding this address.' };
    case 'zone_type_requires_setup': return { requiredFact: 'cloudflareZoneDns',
      remedy: 'The selected zone cannot supply an automatic public DNS route. Choose a full Cloudflare zone or complete its DNS setup.' };
    case 'invalid_provider_output': return { requiredFact: 'cloudflareProviderResponse',
      remedy: 'Cloudflare returned an unreadable zone or tunnel response. Retry the read; if it persists, check Cloudflare service status.' };
    default: return { requiredFact: 'cloudflareProviderResponse',
      remedy: 'Cloudflare did not complete the zone or tunnel request. Check Cloudflare service status and the reported HTTP status, then retry.' };
  }
}

/** An omitted zone lists the configured Account's zones when the token allows it.
 * A permission refusal leaves the caller able to supply an explicit zone.
 * Tunnels belong to an Account, not a zone: validate that exact zone first,
 * then offer adoption and creation using the same connected Account identity
 * and canonical connector pin unless the caller deliberately supplies overrides.
 * Cloudflare v4 list contract checked 2026-11-07:
 * https://developers.cloudflare.com/api/resources/zones/methods/list/
 * https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/list/
 */
type SelectionHandler = PluginAccountActionHandler<ReturnType<typeof selectionsInput.parse>, ReturnType<typeof selectionsResult.parse>>;
const readSelectionsImpl = async (input: Parameters<SelectionHandler>[0], context: Parameters<SelectionHandler>[1],
  zonesOnly = false): Promise<ReturnType<typeof selectionsResult.parse>> => {
  const purpose = zonesOnly ? 'deploy.manage' : 'tunnel.manage';
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
  const unavailable = (reason: string, providerStatus?: number) => ({ kind: 'unavailable' as const, options: [], reason,
    ...selectionRecovery(reason), ...(providerStatus === undefined ? {} : { providerStatus }), defaults, connectorDiscovery });
  const accountId = input.accountId ?? defaults.accountId;
  if (accountId === undefined) return unavailable('account_id_unavailable');
  const connector = input.connector ?? defaults.connector;
  const zoneId = input.zoneId;
  if (zoneId !== undefined) {
    const selected = await readSelectedZone({ credentialRef: input.credentialRef, accountId, zoneId }, context, purpose);
    if (selected.kind === 'unavailable') return unavailable(selected.reason, selected.providerStatus);
    const hostname = input.hostname.toLowerCase(), zoneName = selected.zones[0].name.toLowerCase();
    if (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) return unavailable('hostname_outside_zone');
    if (zonesOnly) return { kind: 'ready', zones: selected.zones.map(({ zoneId, name }) => ({ zoneId, name })),
      options: [], defaults, connectorDiscovery };
  }
  const collection = zoneId === undefined ? 'https://api.cloudflare.com/client/v4/zones'
    : `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`;
  const operation = zoneId === undefined ? 'GET /zones' : cloudflareResponseOperation('GET', collection);
  const options: Array<ReturnType<typeof selectionOption.parse>> = [];
  const zones: Array<ReturnType<typeof zoneOption.parse>> = [];
  const tunnelOption = (selectedZoneId: string, label: string, tunnel: ReturnType<typeof tunnelConfigureInput.parse>['tunnel']):
    ReturnType<typeof selectionOption.parse> => ({ label, selection: { provider: { kind: 'builtin', id: 'cloudflareNamed' },
      config: { hostname: input.hostname, controller: { accountId, zoneId: selectedZoneId,
        connector, tunnel, owned: [], dnsOwnership: [] } },
      credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account: input.credentialRef } }] } });
  try {
    for (let page = 1; ; page += 1) {
      context.signal.throwIfAborted();
      const query = new URLSearchParams(zoneId === undefined ? { 'account.id': accountId, page: String(page) }
        : { is_deleted: 'false', page: String(page) });
      const response = await context.services.http.request({ method: 'GET', url: `${collection}?${query}`, redirect: 'error',
        credentialBinding: { kind: 'connectedAccountPurpose', purpose, origin: 'https://api.cloudflare.com',
          method: 'GET', headerNames: ['authorization'] } }, { signal: context.signal }).catch(error => {
          context.signal.throwIfAborted();
          if (isPluginError(error)) throw error;
          return null;
        });
      context.signal.throwIfAborted();
      if (response === null) return unavailable('network_unavailable');
      if (response.status === 401) return unavailable('credential_unavailable', response.status);
      if (response.status === 403) return unavailable(zoneId === undefined ? 'zone_list_unavailable' : 'denied', response.status);
      if (response.status < 200 || response.status >= 300) return unavailable('provider_unavailable', response.status);
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
        options.push(tunnelOption(zoneId, row.name, { kind: 'adopt', tunnelId: row.id, name: row.name }));
      }
      if (cloudflareHasNextPage(native, page, operation)) continue;
      if (zoneId === undefined) {
        return { kind: 'ready', zones, options: [], defaults, connectorDiscovery };
      }
      const name = input.hostname.toLowerCase();
      return { kind: 'ready', options, createOption: tunnelOption(zoneId, name, { kind: 'create', name }), defaults, connectorDiscovery };
    }
  } catch (error) {
    context.signal.throwIfAborted();
    if (isPluginError(error)) throw error;
    if (error instanceof CloudflareProviderRefusal) return unavailable(error.code);
    throw error;
  }
};

const readSelections: typeof readSelectionsImpl = async (input, context, zonesOnly = false) => {
  try { return await readSelectionsImpl(input, context, zonesOnly); }
  catch (error) {
    context.signal.throwIfAborted();
    if (!isPluginError(error)) throw error;
    const reason = error.code === 'credential_unavailable' || error.code === 'plugin_fetch_adapter_unavailable' || error.code === 'denied' ? error.code
      : error.code === 'outcome_unknown' && error.data.failureCause?.phase === 'connected_account.http.execute'
        ? 'network_unavailable' : undefined;
    if (reason === undefined) throw error;
    // Canonical recognition proves the cross-realm SDK exception; its public details carry authored recovery.
    const original = error as PluginError;
    const details = isObject(original.details)
      ? original.details : {};
    const fallback = selectionRecovery(reason);
    throw new PluginError({ ...original.data, details: { ...details,
      requiredFact: typeof details.requiredFact === 'string' ? details.requiredFact : fallback.requiredFact,
      remedy: typeof details.remedy === 'string' ? details.remedy : fallback.remedy } }, { cause: error });
  }
};
const readWorkerZones: SelectionHandler = async (input, context) => {
  const result = await readSelections(input, context, true);
  return result.kind === 'ready' && 'zones' in result ? { ...result,
    dnsRecordAction: { pluginId: context.plugin.id, localId: 'records-create' } } : result;
};

export const selectionActions = {
  'workers-domain-zones-read': {
    title: 'Read Workers Domain zones', description: 'List the linked Account zones or read the explicitly selected zone for this address.',
    execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
    scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent'], placementBindings: [], dangerLevel: 'safe', readOnly: true,
    inputSchema: selectionsInput, resultSchema: selectionsResult,
    hostAccess: ['deploy.manage', 'cloudflare-api'],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
    run: readWorkerZones,
  },
  'cloudflare-named/selections-read': {
    title: 'Read named Cloudflare tunnel choices',
    description: 'List Account zones or read complete tunnel choices using connected Account and connector defaults with optional overrides. Connector discovery is unavailable.',
    execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
    scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent'], placementBindings: [], dangerLevel: 'safe', readOnly: true,
    inputSchema: selectionsInput, resultSchema: selectionsResult,
    hostAccess: ['tunnel.manage', 'cloudflare-api'],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'tunnel.manage' }],
    run: readSelections,
  },
} as const;
