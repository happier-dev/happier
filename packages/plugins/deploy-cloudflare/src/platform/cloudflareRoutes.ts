import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { HttpService, PluginFetchCredentialBinding } from '@happier-dev/plugin-sdk/http';
import { pluginJsonValuesEqual, type ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { prepareOwnedCloudflareIngress } from './cloudflareIngress.js';
import type { DesiredHostname, OwnedHostname } from './cloudflareIngress.js';

type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type PurposeBinding = Extract<PluginFetchCredentialBinding, { kind: 'connectedAccountPurpose' }>;

export type CloudflareRouteRequest = Readonly<{
  http: Pick<HttpService, 'request'>;
  /** Exact operands supplied by the admitted controller's purpose owner. */
  credentialBindings: Readonly<{ [Method in RouteMethod]: PurposeBinding & Readonly<{ method: Method }> }>;
  signal: AbortSignal;
  accountId: string;
  zoneId: string;
  tunnelId: string;
  /** Exact reviewed create/adopt name, when supplied by the lifecycle caller. */
  expectedTunnelName?: string;
  owned: readonly OwnedHostname[];
  desired: readonly DesiredHostname[];
  dnsOwnership: readonly Readonly<{ hostname: string; recordId: string }>[];
}>;
export type CloudflareRouteResult =
  | Readonly<{ kind: 'verified'; tunnelId: string; dnsOwnership: readonly Readonly<{ hostname: string; recordId: string }>[] }>
  | Readonly<{ kind: 'refused'; code: string; providerOutput?: string }>
  | Readonly<{ kind: 'unknown'; code: string; providerOutput?: string; dnsOwnership?: readonly Readonly<{ hostname: string; recordId: string }>[] }>;
type CloudflareRemovalRouteRequest = Omit<CloudflareRouteRequest, 'tunnelId' | 'expectedTunnelName' | 'desired'> & Readonly<{
  tunnelName: string;
  desired: readonly [];
}>;
type CloudflareRemovalRouteResult = Exclude<CloudflareRouteResult, { kind: 'verified' }>
  | Readonly<{ kind: 'verified'; tunnelId?: string; dnsOwnership: readonly Readonly<{ hostname: string; recordId: string }>[] }>;

type NativeObject = Readonly<Record<string, ProtocolJsonValue>>;
function object(value: ProtocolJsonValue | undefined): value is NativeObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export class CloudflareProviderRefusal extends Error {
  constructor(readonly code: string, readonly providerOutput?: string) { super(code); }
}

/** Diagnostic labels contain only endpoint templates, never operand or response values. */
export function cloudflareResponseOperation(method: RouteMethod, url: string): string {
  const path = new URL(url).pathname;
  const endpoint = path.includes('/dns_records')
    ? `/zones/{zone_id}/dns_records${path.endsWith('/dns_records') ? '' : '/{record_id}'}`
    : `/accounts/{account_id}/cfd_tunnel${path.endsWith('/cfd_tunnel') ? '' : path.endsWith('/configurations')
      ? '/{tunnel_id}/configurations' : path.endsWith('/token') ? '/{tunnel_id}/token' : '/{tunnel_id}'}`;
  return `${method} ${endpoint}`;
}

function invalidOutput(operation: string, path: string, expected: string) {
  return new CloudflareProviderRefusal('invalid_provider_output', `${operation}: ${path} expected ${expected}`);
}

/** One envelope decoder serves create/token and route reconciliation. */
export function readCloudflareResponse(body: Uint8Array, operation: string): NativeObject {
  let value: ProtocolJsonValue;
  try {
    // JSON.parse is the external JSON boundary; nested shapes narrow at their owner.
    value = JSON.parse(new TextDecoder().decode(body)) as ProtocolJsonValue;
  } catch { throw invalidOutput(operation, '$', 'JSON'); }
  if (!object(value)) throw invalidOutput(operation, '$', 'object');
  if (value.success !== true) throw invalidOutput(operation, 'success', 'true');
  return value;
}

export function cloudflareHasNextPage(response: NativeObject, page: number, operation: string): boolean {
  // Cloudflare documents result_info and its fields as optional. When no
  // end marker is provided, read through the first empty native page rather
  // than assuming that the first page proves absence or unique ownership.
  const info = response.result_info;
  if (info !== undefined) {
    if (!object(info)) throw invalidOutput(operation, 'result_info', 'object');
    if (info.page !== undefined && info.page !== page) throw invalidOutput(operation, 'result_info.page', 'requested page integer');
    if (info.total_pages !== undefined) {
      const total = info.total_pages;
      if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw invalidOutput(operation, 'result_info.total_pages', 'nonnegative integer');
      return page < total;
    }
    if (info.per_page !== undefined && info.total_count !== undefined) {
      const { per_page: perPage, total_count: totalCount } = info;
      if (typeof perPage !== 'number' || !Number.isSafeInteger(perPage) || perPage < 1) throw invalidOutput(operation, 'result_info.per_page', 'positive integer');
      if (typeof totalCount !== 'number' || !Number.isSafeInteger(totalCount) || totalCount < 0) throw invalidOutput(operation, 'result_info.total_count', 'nonnegative integer');
      return page * perPage < totalCount;
    }
  }
  return Array.isArray(response.result) && response.result.length > 0;
}

/** One remote-management eligibility decision serves selection and reconciliation. */
export function cloudflareRemoteTunnel(value: ProtocolJsonValue | undefined, accountId: string): value is NativeObject {
  return object(value) && value.account_tag === accountId
    && (value.config_src === undefined ? value.remote_config === true : value.config_src === 'cloudflare')
    && value.deleted_at === null;
}

/** P21 owned-route semantics, consumed by the admitted Cloudflare Account Action.
 * Cloudflare v4 tunnel/configuration and DNS contracts checked 2026-10-31:
 * https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/
 * https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/delete/
 */
export type CloudflareConnectorRouteResult<T> =
  | (Extract<CloudflareRouteResult, { kind: 'verified' }> & Readonly<{ connector: T }>)
  | (Exclude<CloudflareRouteResult, { kind: 'verified' }> & Readonly<{ connector?: T }>);
export function reconcileOwnedCloudflareRoutes<T>(input: CloudflareRouteRequest & Readonly<{
  prepareConnector(): Promise<T>;
}>): Promise<CloudflareConnectorRouteResult<T>>;
export function reconcileOwnedCloudflareRoutes(input: CloudflareRouteRequest): Promise<CloudflareRouteResult>;
export function reconcileOwnedCloudflareRoutes(input: CloudflareRouteRequest | CloudflareRemovalRouteRequest): Promise<CloudflareRemovalRouteResult>;
export async function reconcileOwnedCloudflareRoutes(input: (CloudflareRouteRequest | CloudflareRemovalRouteRequest) & Readonly<{
  prepareConnector?: () => Promise<unknown>;
}>): Promise<CloudflareRemovalRouteResult & Readonly<{ connector?: unknown }>> {
  const collectionUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel`;
  const dnsUrl = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(input.zoneId)}/dns_records`;
  let attempted = false, changed = false;
  let operation = '';
  let connector: Readonly<{ connector: unknown }> | undefined;
  const ownership = new Map(input.dnsOwnership.map(row => [row.hostname, row.recordId]));
  function readRecord(value: ProtocolJsonValue, path = 'result'): NativeObject {
    if (!object(value)) throw invalidOutput(operation, path, 'object');
    return value;
  }
  async function request(method: RouteMethod, url: string, body?: ProtocolJsonValue): Promise<NativeObject> {
    operation = cloudflareResponseOperation(method, url);
    input.signal.throwIfAborted();
    if (method !== 'GET') attempted = true;
    const response = await input.http.request({ method, url, redirect: 'error', credentialBinding: input.credentialBindings[method],
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) }),
    }, { signal: input.signal });
    // The invocation's existing HTTP service owns credential injection and
    // currentness; this vendor codec never accepts a raw API credential.
    if (response.status === 401 || response.status === 403) {
      attempted = false;
      throw new CloudflareProviderRefusal(response.status === 403 ? 'denied' : 'credential_unavailable');
    }
    if (response.status < 200 || response.status >= 300) throw new CloudflareProviderRefusal('provider_unavailable');
    const decoded = readCloudflareResponse(response.body, operation);
    if (method !== 'GET') { changed = true; attempted = false; }
    input.signal.throwIfAborted();
    return decoded;
  }
  async function configuration(configurationUrl: string) {
    // Both result and config are optional in the successful GET contract.
    // A successful real GET also returns config:null for an unconfigured tunnel
    // (observed 2026-11-07). Other explicit malformed values still refuse.
    const result = (await request('GET', configurationUrl)).result;
    const native: NativeObject = result === undefined ? {} : readRecord(result);
    if (native.config !== undefined && native.config !== null && !object(native.config)) throw invalidOutput(operation, 'result.config', 'object');
    return { config: native.config ?? {} };
  }
  async function dnsRecords(hostname: string) {
    const result: NativeObject[] = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({ name: hostname, page: String(page) });
      const response = await request('GET', `${dnsUrl}?${query}`);
      if (!Array.isArray(response.result)) throw invalidOutput(operation, 'result', 'array');
      for (const [index, entry] of response.result.entries()) {
        const record = readRecord(entry, `result[${index}]`);
        if (record.name !== hostname) throw invalidOutput(operation, `result[${index}].name`, 'requested hostname string');
        if (typeof record.id !== 'string') throw invalidOutput(operation, `result[${index}].id`, 'string');
        result.push(record);
      }
      if (!cloudflareHasNextPage(response, page, operation)) return result;
    }
  }
  function sameOwnedRecord(record: NativeObject, hostname: string, recordId: string, cname: string) {
    return record.id === recordId && record.name === hostname && record.type === 'CNAME' && record.content === cname && record.proxied === true;
  }
  try {
    let tunnel: NativeObject | undefined;
    let tunnelId: string;
    const recoverDnsOwnership = 'tunnelName' in input;
    const expectedTunnelName = 'tunnelName' in input ? input.tunnelName : input.expectedTunnelName;
    if ('tunnelName' in input) {
      // Cloudflare v4 list contract checked 2026-11-05:
      // https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/list/
      // The provider's name filter is not an exact-identity guarantee. Read
      // every native page and select the reviewed name ourselves, never create.
      for (let page = 1; ; page += 1) {
        const query = new URLSearchParams({ name: input.tunnelName, is_deleted: 'false', page: String(page) });
        const response = await request('GET', `${collectionUrl}?${query}`);
        if (!Array.isArray(response.result)) throw invalidOutput(operation, 'result', 'array');
        for (const [index, entry] of response.result.entries()) {
          const candidate = readRecord(entry, `result[${index}]`);
          if (typeof candidate.id !== 'string' || candidate.id.length === 0) throw invalidOutput(operation, `result[${index}].id`, 'nonempty string');
          if (typeof candidate.name !== 'string') throw invalidOutput(operation, `result[${index}].name`, 'string');
          if (candidate.name === input.tunnelName) {
            if (tunnel) throw new CloudflareProviderRefusal('route_conflict');
            tunnel = candidate;
          }
        }
        if (!cloudflareHasNextPage(response, page, operation)) break;
      }
      if (!tunnel) return { kind: 'verified', dnsOwnership: [] };
      // The native list boundary validated the selected identifier above.
      tunnelId = tunnel.id as string;
    } else {
      tunnelId = input.tunnelId;
      tunnel = readRecord((await request('GET', `${collectionUrl}/${encodeURIComponent(tunnelId)}`)).result);
    }
    if (tunnel.id !== tunnelId || !cloudflareRemoteTunnel(tunnel, input.accountId)
      || expectedTunnelName !== undefined && tunnel.name !== expectedTunnelName) throw new CloudflareProviderRefusal('route_conflict');
    const root = `${collectionUrl}/${encodeURIComponent(tunnelId)}`;
    const configurationUrl = `${root}/configurations`;
    const cname = `${tunnelId}.cfargotunnel.com`;
    const previous = await configuration(configurationUrl);
    const prepared = prepareOwnedCloudflareIngress({ config: previous.config, owned: input.owned, desired: input.desired });
    if (prepared.kind === 'refused') return prepared;
    if (ownership.size !== input.dnsOwnership.length) throw new CloudflareProviderRefusal('route_conflict');
    const hostnames = new Set([...input.owned, ...input.desired].map(route => route.hostname));
    const observed = new Map<string, NativeObject[]>();
    for (const hostname of hostnames) {
      const records = await dnsRecords(hostname);
      let recordId = ownership.get(hostname);
      // Name-selected removal has no retained record IDs. The ingress owner
      // above checked every present owned route's expected service; only the
      // exact tunnel CNAME at those reviewed hostnames can establish DNS IDs.
      if (recoverDnsOwnership && !recordId && records.length === 1
        && sameOwnedRecord(records[0]!, hostname, records[0]!.id as string, cname)) {
        recordId = records[0]!.id as string;
        ownership.set(hostname, recordId);
      }
      if (records.length > 0 && (records.length !== 1 || !recordId || !sameOwnedRecord(records[0]!, hostname, recordId, cname))) {
        throw new CloudflareProviderRefusal('route_conflict');
      }
      if (recordId && records.length === 0) throw new CloudflareProviderRefusal('plan_changed');
      observed.set(hostname, records);
    }
    // Seal within this invocation after ownership preflight and before PUT;
    // retain only its opaque result if a later vendor effect is unknown.
    if (input.prepareConnector) connector = { connector: await input.prepareConnector() };
    // One GET supplies the merge basis; consume the PUT acknowledgement.
    // Cloudflare offers no compare-and-swap; another GET cannot add one.
    if (prepared.config !== previous.config) {
      const applied = readRecord((await request('PUT', configurationUrl, { config: prepared.config })).result);
      if (!object(applied.config) || !pluginJsonValuesEqual(applied.config, prepared.config)) throw new CloudflareProviderRefusal('outcome_unknown');
    }
    const nextRules = prepared.config.ingress;
    for (const hostname of hostnames) {
      const retained = Array.isArray(nextRules) && nextRules.some(rule => object(rule) && rule.hostname === hostname);
      const records = observed.get(hostname)!;
      const recordId = ownership.get(hostname);
      if (retained && records.length === 0 && input.desired.some(route => route.hostname === hostname)) {
        if ((await dnsRecords(hostname)).length !== 0) throw new CloudflareProviderRefusal('plan_changed');
        const record = readRecord((await request('POST', dnsUrl, { type: 'CNAME', name: hostname, content: cname, proxied: true })).result);
        if (typeof record.id !== 'string' || !sameOwnedRecord(record, hostname, record.id, cname)) throw new CloudflareProviderRefusal('outcome_unknown');
        // The validated POST acknowledgement establishes the created record.
        ownership.set(hostname, record.id);
      } else if (!retained && recordId) {
        const removed = readRecord((await request('DELETE', `${dnsUrl}/${encodeURIComponent(recordId)}`)).result);
        if (removed.id !== recordId) throw new CloudflareProviderRefusal('outcome_unknown');
        ownership.delete(hostname);
      }
    }
    return { kind: 'verified', tunnelId, dnsOwnership: [...ownership].map(([hostname, recordId]) => ({ hostname, recordId })), ...connector };
  } catch (error) {
    if (isPluginError(error) && !connector) throw error;
    const providerOutput = error instanceof CloudflareProviderRefusal && error.providerOutput ? { providerOutput: error.providerOutput } : {};
    if (changed || attempted || connector) return { kind: 'unknown', code: isPluginError(error) || error instanceof CloudflareProviderRefusal ? error.code : 'outcome_unknown', ...providerOutput,
      ...(ownership.size === 0 ? {} : { dnsOwnership: [...ownership].map(([hostname, recordId]) => ({ hostname, recordId })) }), ...connector };
    if (input.signal.aborted) return { kind: 'refused', code: 'cancelled' };
    return error instanceof CloudflareProviderRefusal ? { kind: 'refused', code: error.code, ...providerOutput } : { kind: 'unknown', code: 'provider_unavailable' };
  }
}
