import * as mini from 'zod/mini';
import { HetznerAcquireV1Schema, HetznerCorrelationSchema, HetznerNativeError, HetznerPowerIntentSchema, HetznerResourceV1Schema, parseHetznerValue } from './schemas.js';
import type { HetznerResourceV1 } from './schemas.js';

// Contract: REST v1; official hcloud-python v2.11.0 servers/client.py.
// Vendor responses remain open; only the facts consumed here are decoded.
const nativeId = () => mini.number().check(mini.int(), mini.positive());
const text = () => mini.string().check(mini.minLength(1));
const ip = mini.object({ id: mini.optional(mini.nullable(nativeId())), ip: text() });
const publicNetworkSchema = mini.object({ ipv4: mini.nullable(ip), ipv6: mini.nullable(ip) });
const serverSchema = mini.object({
  id: nativeId(), status: text(), labels: mini.record(mini.string(), mini.string()),
  public_net: publicNetworkSchema, volumes: mini.array(nativeId()),
});
const actionSchema = mini.object({ id: nativeId(), status: mini.enum(['running', 'success', 'error']) });
const paginationSchema = mini.object({ pagination: mini.object({ next_page: mini.nullable(nativeId()) }) });
const amount = mini.string().check(mini.regex(/^\d+(?:\.\d+)?$/));
const pricePair = mini.object({ net: amount, gross: amount });
const locationPriceSchema = mini.object({ location: text(), price_hourly: pricePair, price_monthly: pricePair });
const sizeSchema = mini.object({
  id: nativeId(), name: text(), cores: nativeId(), memory: mini.number().check(mini.positive()), disk: mini.number().check(mini.nonnegative()),
  architecture: mini.enum(['x86', 'arm']),
  deprecation: mini.optional(mini.nullable(mini.object({ unavailable_after: mini.optional(mini.nullable(text())) }))),
  prices: mini.array(locationPriceSchema),
});
const imageSchema = mini.object({
  id: nativeId(), name: mini.nullable(text()), architecture: mini.enum(['x86', 'arm']),
  type: mini.enum(['system', 'snapshot', 'backup', 'app']), status: text(), deprecated: mini.nullable(text()),
});
const locationSchema = mini.object({ id: nativeId(), name: text(), description: text() });
const pricingSchema = mini.object({
  currency: text(),
  primary_ips: mini.optional(mini.array(mini.object({ type: mini.enum(['ipv4', 'ipv6']), prices: mini.array(locationPriceSchema) }))),
  volume: mini.optional(mini.object({ price_per_gb_month: pricePair })),
});
type NativeAction = mini.infer<typeof actionSchema>;
type NativeReply = { kind: 'ok'; status: number; value: unknown } | { kind: 'absent' };
type CleanupResource = { kind: 'server' | 'volume' | 'primary-ip'; id: number };
export type HetznerNativePrice = Readonly<{ amount: string; currency: string; unit: 'hour' | 'month' | 'GB-month'; source: string; observedAt: number }>;
export type HetznerAcquireResult =
  | { kind: 'bound'; resource: HetznerResourceV1; power: 'running' | 'stopped' | 'transitioning' | 'unknown'; nativeAction?: NativeAction; nativeActionUnavailable?: true; nativeFactsUnavailable?: true }
  | { kind: 'unknown'; code: string; correlation: string }
  | { kind: 'rejected'; code: string };
export type HetznerNativeClientOptions = Readonly<{ token: string; fetch?: typeof fetch; signal?: AbortSignal }>;
const billing = { location: 'cloud' as const, stoppedBilling: 'billed' as const };
const apiOrigin = 'https://api.hetzner.cloud/v1';
function powerFact(status: string) {
  if (status === 'running') return 'running' as const;
  if (status === 'off') return 'stopped' as const;
  if (['initializing', 'starting', 'stopping', 'migrating', 'rebuilding', 'deleting'].includes(status)) return 'transitioning' as const;
  return 'unknown' as const;
}
function codeOf(error: unknown) { return error instanceof HetznerNativeError ? error.code : 'native_transport_unavailable'; }

export function createHetznerNativeClient(options: HetznerNativeClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  if (!options.token.trim() || /[\r\n]/.test(options.token)) throw new HetznerNativeError('native_credential_invalid');
  async function request(path: string, method = 'GET', body?: unknown, exactAbsence = false): Promise<NativeReply> {
    let response: Response;
    try {
      response = await transport(`${apiOrigin}${path}`, {
        method, redirect: 'error', signal: options.signal,
        headers: { Authorization: `Bearer ${options.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new HetznerNativeError('native_transport_unavailable'); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new HetznerNativeError('native_authorization_failed');
      if (exactAbsence && response.status === 404) {
        let value: unknown;
        try { value = await response.json(); } catch { throw new HetznerNativeError('native_response_invalid'); }
        if (mini.object({ error: mini.object({ code: mini.literal('not_found') }) }).safeParse(value).success) return { kind: 'absent' };
      }
      throw new HetznerNativeError(response.status >= 500 ? 'native_service_unavailable' : 'native_request_failed');
    }
    if (response.status === 204) return { kind: 'ok', status: 204, value: null };
    try { return { kind: 'ok', status: response.status, value: await response.json() }; }
    catch { throw new HetznerNativeError('native_response_invalid'); }
  }
  function decode<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, reply: NativeReply): T {
    if (reply.kind === 'absent') throw new HetznerNativeError('native_identity_not_found');
    return parseHetznerValue(schema, reply.value, 'native_response_invalid');
  }
  async function list<T>(path: string, key: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, query?: string): Promise<T[]> {
    const values: T[] = [];
    let page: number | null = 1;
    const seen = new Set<number>();
    while (page !== null) {
      if (seen.has(page)) throw new HetznerNativeError('native_response_invalid');
      seen.add(page);
      const reply = await request(`${path}?page=${page}${query ? `&${query}` : ''}`);
      const envelope = decode(mini.record(mini.string(), mini.unknown()), reply);
      const items = parseHetznerValue(mini.array(mini.unknown()), envelope[key], 'native_response_invalid');
      const meta = parseHetznerValue(paginationSchema, envelope.meta, 'native_response_invalid');
      for (const value of items) values.push(parseHetznerValue(schema, value, 'native_response_invalid'));
      page = meta.pagination.next_page;
    }
    return values;
  }
  async function inspect(rawResource: unknown) {
    const resource = parseHetznerValue(HetznerResourceV1Schema, rawResource);
    const reply = await request(`/servers/${resource.serverId}`, 'GET', undefined, true);
    if (reply.kind === 'absent') return { kind: 'absent' as const };
    const { server } = decode(mini.object({ server: serverSchema }), reply);
    if (server.id !== resource.serverId) throw new HetznerNativeError('native_identity_mismatch');
    return { kind: 'present' as const, power: powerFact(server.status), billing, server };
  }
  function bind(server: Readonly<{ id: number; status?: string }>, owned: HetznerResourceV1['owned'], nativeAction?: NativeAction): Extract<HetznerAcquireResult, { kind: 'bound' }> {
    return { kind: 'bound', resource: { serverId: server.id, owned }, power: powerFact(server.status ?? ''), ...(nativeAction ? { nativeAction } : {}) };
  }
  return {
    async check() { await request('/servers?page=1'); return { available: true as const }; },
    async acquire(rawInput: unknown): Promise<HetznerAcquireResult> {
      const input = parseHetznerValue(HetznerAcquireV1Schema, rawInput);
      const publicKey = input.bootstrapSshPublicKey.split(' ').slice(0, 2).join(' ');
      let reply: NativeReply;
      try {
        reply = await request('/servers', 'POST', {
          name: input.name, server_type: input.launch.serverTypeId, image: input.launch.imageId, location: input.launch.locationId,
          public_net: { enable_ipv4: input.launch.publicNetworking.ipv4, enable_ipv6: input.launch.publicNetworking.ipv6 },
          labels: { 'happier-managed': input.correlation }, start_after_create: true,
          user_data: `#cloud-config\nssh_authorized_keys: ${JSON.stringify([publicKey])}\n`,
        });
      } catch (error) {
        const code = codeOf(error);
        if (['native_authorization_failed', 'native_request_failed'].includes(code)) return { kind: 'rejected', code };
        return { kind: 'unknown', code: code === 'native_transport_unavailable' ? 'native_transport_unknown' : code, correlation: input.correlation };
      }
      try {
        // An accepted create's exact paid id survives missing readiness/connection facts.
        const { server: identity } = decode(mini.object({ server: mini.object({ id: nativeId() }) }), reply);
        const value = reply.kind === 'ok' ? reply.value : null;
        const serverResult = mini.object({ server: serverSchema }).safeParse(value);
        const networkResult = mini.object({ server: mini.object({ public_net: publicNetworkSchema }) }).safeParse(value);
        const actionResult = mini.object({ action: actionSchema }).safeParse(value);
        const server = serverResult.success && serverResult.data.server.labels['happier-managed'] === input.correlation ? serverResult.data.server : identity;
        const network = networkResult.success ? networkResult.data.server.public_net : undefined;
        const primaryIpIds = [
          input.launch.publicNetworking.ipv4 ? network?.ipv4?.id : undefined,
          input.launch.publicNetworking.ipv6 ? network?.ipv6?.id : undefined,
        ].filter((id): id is number => typeof id === 'number');
        // Creation evidence owns returned IPs; labeled recovery never adopts attachments.
        const bound = bind(server, { volumeIds: [], primaryIpIds }, actionResult.success ? actionResult.data.action : undefined);
        return { ...bound,
          ...(!actionResult.success ? { nativeActionUnavailable: true as const } : {}),
          ...(!serverResult.success || server === identity ? { nativeFactsUnavailable: true as const } : {}),
        };
      } catch (error) { return { kind: 'unknown', code: codeOf(error), correlation: input.correlation }; }
    },
    inspect,
    async recover(rawCorrelation: string): Promise<HetznerAcquireResult> {
      const correlation = parseHetznerValue(HetznerCorrelationSchema, rawCorrelation);
      try {
        const candidates = await list('/servers', 'servers', serverSchema, `label_selector=${encodeURIComponent(`happier-managed=${correlation}`)}`);
        const exact = new Map(candidates.filter(server => server.labels['happier-managed'] === correlation).map(server => [server.id, server]));
        if (exact.size !== 1) return { kind: 'unknown', code: exact.size ? 'native_identity_ambiguous' : 'native_identity_not_found', correlation };
        return bind([...exact.values()][0], { volumeIds: [], primaryIpIds: [] });
      } catch (error) { return { kind: 'unknown', code: codeOf(error), correlation }; }
    },
    async power(rawResource: unknown, rawIntent: unknown) {
      const resource = parseHetznerValue(HetznerResourceV1Schema, rawResource);
      const intent = parseHetznerValue(HetznerPowerIntentSchema, rawIntent);
      const { action } = decode(mini.object({ action: actionSchema }), await request(`/servers/${resource.serverId}/actions/${intent === 'start' ? 'poweron' : 'shutdown'}`, 'POST'));
      // Action success acknowledges shutdown; only exact inspect proves stopped.
      return action.status === 'error' ? { kind: 'refused' as const, code: 'native_action_failed', nativeAction: action }
        : { kind: 'pending' as const, nativeAction: action };
    },
    async destroy(rawResource: unknown) {
      const resource = parseHetznerValue(HetznerResourceV1Schema, rawResource);
      const attachments: CleanupResource[] = [
        ...resource.owned.volumeIds.map(id => ({ kind: 'volume' as const, id })),
        ...resource.owned.primaryIpIds.map(id => ({ kind: 'primary-ip' as const, id })),
      ];
      const remaining: CleanupResource[] = [{ kind: 'server', id: resource.serverId }, ...attachments];
      try {
        await request(`/servers/${resource.serverId}`, 'DELETE', undefined, true);
        if ((await inspect(resource)).kind !== 'absent') return { kind: 'incomplete' as const, remaining };
      } catch (error) { return { kind: 'incomplete' as const, code: codeOf(error), remaining }; }
      remaining.shift();
      for (const attachment of attachments) {
        try {
          const path = `/${attachment.kind === 'volume' ? 'volumes' : 'primary_ips'}/${attachment.id}`;
          // Native Volume/Primary IP deletion is synchronous (204). Any accepted
          // action instead requires exact absence, never merely a successful HTTP reply.
          const deletion = await request(path, 'DELETE', undefined, true);
          if (deletion.kind === 'ok' && deletion.status !== 204 && (await request(path, 'GET', undefined, true)).kind !== 'absent') continue;
          remaining.splice(remaining.indexOf(attachment), 1);
        } catch { /* Failed owned cleanup stays visible; vendor text stays private. */ }
      }
      return remaining.length ? { kind: 'incomplete' as const, remaining } : { kind: 'confirmed' as const };
    },
    async options() {
      const [sizes, images, locations, pricingReply] = await Promise.all([
        list('/server_types', 'server_types', sizeSchema), list('/images', 'images', imageSchema),
        list('/locations', 'locations', locationSchema), request('/pricing'),
      ]);
      const { pricing } = decode(mini.object({ pricing: pricingSchema }), pricingReply);
      const observedAt = Date.now();
      const price = (amount: string, unit: HetznerNativePrice['unit'], source = `${apiOrigin}/server_types`): HetznerNativePrice => ({ amount, currency: pricing.currency, unit, source, observedAt });
      return { sizes: sizes.map(size => ({ ...size, prices: size.prices.map(entry => ({
        location: entry.location, hourly: price(entry.price_hourly.gross, 'hour'), monthly: price(entry.price_monthly.gross, 'month'),
      })) })), images, locations, observedAt,
        ...(pricing.primary_ips ? { primaryIpPrices: pricing.primary_ips.map(primaryIp => ({ type: primaryIp.type, prices: primaryIp.prices.map(entry => ({
          location: entry.location, hourly: price(entry.price_hourly.gross, 'hour', `${apiOrigin}/pricing#primary_ips`), monthly: price(entry.price_monthly.gross, 'month', `${apiOrigin}/pricing#primary_ips`),
        })) })) } : {}),
        ...(pricing.volume ? { storageCharges: [price(pricing.volume.price_per_gb_month.gross, 'GB-month', `${apiOrigin}/pricing#volume`)] } : {}),
      };
    },
  };
}
