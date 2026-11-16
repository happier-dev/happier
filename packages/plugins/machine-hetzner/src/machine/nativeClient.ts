import * as mini from 'zod/mini';
import { projectMachineProvisionerActionFailure, buildMachineProvisionerCloudInit, type MachineProvisionerCloudHostKeyV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { MachineProvisionerNativeCauseV1Schema, type MachineProvisionerNativeCauseV1, type MachineProvisionerSnapshotResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { HetznerAcquireV1Schema, HetznerCorrelationSchema, HetznerDeleteOperationV1Schema, HetznerNativeError, HetznerPowerIntentSchema, HetznerResourceV1Schema, parseHetznerValue } from './schemas.js';
import type { HetznerResourceV1 } from './schemas.js';

// Contract: REST v1; official hcloud-python v2.11.0 servers/client.py.
// Vendor responses remain open; only the facts consumed here are decoded.
const nativeId = () => mini.number().check(mini.int(), mini.positive());
const text = () => mini.string().check(mini.minLength(1));
const ip = mini.object({ id: mini.optional(mini.nullable(nativeId())), ip: text() });
const publicNetworkSchema = mini.object({ ipv4: mini.nullable(ip), ipv6: mini.nullable(ip) });
const serverSchema = mini.object({
  id: nativeId(), status: text(), labels: mini.record(mini.string(), mini.string()),
  public_net: publicNetworkSchema,
});
const actionSchema = mini.object({ id: nativeId(), status: mini.enum(['running', 'success', 'error']) });
const paginationSchema = mini.object({ pagination: mini.object({ next_page: mini.nullable(nativeId()) }) });
const amount = mini.string().check(mini.regex(/^\d+(?:\.\d+)?$/));
const pricePair = mini.object({ net: amount, gross: amount });
const locationPriceSchema = mini.object({ location: text(), price_hourly: pricePair, price_monthly: pricePair });
const sizeSchema = mini.object({
  id: nativeId(), name: text(), cores: nativeId(), memory: mini.number().check(mini.positive()), disk: mini.number().check(mini.nonnegative()),
  architecture: mini.enum(['x86', 'arm']),
  locations: mini.array(mini.object({ name: text(), available: mini.boolean(),
    deprecation: mini.nullable(mini.object({ unavailable_after: text() })),
  })),
  prices: mini.array(locationPriceSchema),
});
const imageSchema = mini.object({
  id: nativeId(), name: mini.nullable(text()), architecture: mini.enum(['x86', 'arm']),
  os_flavor: mini.optional(text()),
  description: mini.optional(mini.nullable(mini.string().check(mini.trim()))),
  type: mini.enum(['system', 'snapshot', 'backup', 'app']), status: text(),
  // REST v1 removed deprecated on 2026-11-02. Decode current and legacy
  // responses here; a missing native deprecation fact is still unavailable.
  deprecated: mini.optional(mini.nullable(text())),
  deprecation: mini.optional(mini.nullable(mini.object({ announced: text(), unavailable_after: text() }))),
}).check(mini.refine(image => image.deprecation !== undefined || image.deprecated !== undefined));
const locationSchema = mini.object({ id: nativeId(), name: text(), description: text(),
  country: mini.optional(mini.nullable(text())),
});
const pricingSchema = mini.object({
  currency: text(),
  primary_ips: mini.optional(mini.array(mini.object({ type: mini.enum(['ipv4', 'ipv6']), prices: mini.array(locationPriceSchema) }))),
  volume: mini.optional(mini.object({ price_per_gb_month: pricePair })),
});
type NativeReply = { kind: 'ok'; status: number; value: unknown } | { kind: 'absent' };
type CleanupResource = { kind: 'server' | 'volume' | 'primary-ip'; id: number };
export type HetznerNativePrice = Readonly<{ amount: string; currency: string; unit: 'hour' | 'month' | 'GB-month'; source: string; observedAt: number }>;
export type HetznerAcquireResult =
  | { kind: 'bound'; resource: HetznerResourceV1; power: 'running' | 'stopped' | 'transitioning' | 'unknown' }
  | { kind: 'unknown'; code: string; correlation: string; nativeCause?: MachineProvisionerNativeCauseV1 }
  | { kind: 'rejected'; code: string; nativeCause?: MachineProvisionerNativeCauseV1 };
export type HetznerNativeClientOptions = Readonly<{ token: string; fetch?: typeof fetch; signal?: AbortSignal;
  guestHostKey?: MachineProvisionerCloudHostKeyV1 }>;
const billing = { location: 'cloud' as const, stoppedBilling: 'billed' as const };
// REST v1 snapshots cover the server disk, excluding attached Volumes. Actual
// storage determines billing; no compute price is substituted for snapshot cost.
export const HETZNER_SNAPSHOT_FACTS = {
  coverage: { rootDisk: true, attachedVolumes: false },
  cost: { kind: 'billed', source: 'https://docs.hetzner.com/cloud/billing/faq/' },
} as const;
const apiOrigin = 'https://api.hetzner.cloud/v1';
function powerFact(status: string) {
  if (status === 'running') return 'running' as const;
  if (status === 'off') return 'stopped' as const;
  if (['initializing', 'starting', 'stopping', 'migrating', 'rebuilding', 'deleting'].includes(status)) return 'transitioning' as const;
  return 'unknown' as const;
}
function codeOf(error: unknown) { return error instanceof HetznerNativeError ? error.code : 'native_transport_unavailable'; }

export function createHetznerNativeTransport(options: HetznerNativeClientOptions) {
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
    } catch (error) {
      const transportFailure = (): never => { throw new HetznerNativeError('native_transport_unavailable'); };
      return projectMachineProvisionerActionFailure(error, transportFailure);
    }
    if (!response.ok) {
      // REST v1 Errors (https://docs.hetzner.cloud/reference/cloud), fetched
      // 2026-10-26: expose only closed codes and submitted field names. Messages
      // and reflected values (including dynamic label paths) remain private.
      let value: unknown;
      let invalidBody = false;
      try { value = await response.json(); } catch { invalidBody = true; }
      const httpStatusClass = response.status >= 500 ? '5xx' : response.status >= 400 ? '4xx' : response.status >= 300 ? '3xx' : 'other';
      const code = mini.object({ error: mini.object({ code: mini.string() }) }).safeParse(value);
      const projected = MachineProvisionerNativeCauseV1Schema.safeParse({ httpStatusClass, ...(code.success ? { code: code.data.error.code } : {}) });
      let nativeCause: MachineProvisionerNativeCauseV1 = projected.success ? projected.data : { httpStatusClass };
      if (code.success && ['invalid_input', 'uniqueness_error'].includes(code.data.error.code) && body && typeof body === 'object') {
        const details = mini.object({ error: mini.object({ details: mini.object({ fields: mini.array(mini.unknown()) }) }) }).safeParse(value);
        if (details.success) {
          const fields = [...new Set(details.data.error.details.fields.flatMap(field => {
            const parsed = mini.object({ name: mini.string() }).safeParse(field);
            return parsed.success && Object.hasOwn(body, parsed.data.name) ? [parsed.data.name] : [];
          }))];
          if (fields.length) {
            const withFields = MachineProvisionerNativeCauseV1Schema.safeParse({ ...nativeCause, fields });
            if (withFields.success) nativeCause = withFields.data;
          }
        }
      }
      if (response.status === 401 || response.status === 403) throw new HetznerNativeError('native_authorization_failed', nativeCause);
      if (exactAbsence && response.status === 404) {
        if (invalidBody) throw new HetznerNativeError('native_response_invalid', nativeCause);
        if (mini.object({ error: mini.object({ code: mini.literal('not_found') }) }).safeParse(value).success) return { kind: 'absent' };
      }
      throw new HetznerNativeError(response.status >= 500 ? 'native_service_unavailable' : 'native_request_failed', nativeCause);
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
    while (page !== null) {
      // REST v1 Pagination (docs.hetzner.cloud/reference/cloud), verified
      // 2026-11-04: default 25, maximum 50. Follow every page without capping results.
      const reply = await request(`${path}?page=${page}&per_page=50${query ? `&${query}` : ''}`);
      const envelope = decode(mini.record(mini.string(), mini.unknown()), reply);
      const items = parseHetznerValue(mini.array(mini.unknown()), envelope[key], 'native_response_invalid');
      const meta = parseHetznerValue(paginationSchema, envelope.meta, 'native_response_invalid');
      for (const value of items) values.push(parseHetznerValue(schema, value, 'native_response_invalid'));
      page = meta.pagination.next_page;
    }
    return values;
  }
  async function waitForAction(serverId: number, initial: mini.infer<typeof actionSchema>, waitForObservation: () => Promise<void>) {
    let action = initial;
    while (action.status === 'running') {
      await waitForObservation();
      action = decode(mini.object({ action: actionSchema }), await request(`/servers/${serverId}/actions/${initial.id}`)).action;
      if (action.id !== initial.id) throw new HetznerNativeError('native_identity_mismatch');
    }
    return action;
  }
  return { request, decode, list, waitForAction };
}

export function createHetznerNativeClient(options: HetznerNativeClientOptions) {
  const { request, decode, list, waitForAction } = createHetznerNativeTransport(options);
  function ownedAttachments(resource: HetznerResourceV1): CleanupResource[] {
    return [
      ...resource.owned.volumeIds.map(id => ({ kind: 'volume' as const, id })),
      ...resource.owned.primaryIpIds.map(id => ({ kind: 'primary-ip' as const, id })),
    ];
  }
  async function inspectServer(rawResource: unknown) {
    const resource = parseHetznerValue(HetznerResourceV1Schema, rawResource);
    const reply = await request(`/servers/${resource.serverId}`, 'GET', undefined, true);
    if (reply.kind === 'absent') return { kind: 'absent' as const };
    const { server } = decode(mini.object({ server: serverSchema }), reply);
    if (server.id !== resource.serverId) throw new HetznerNativeError('native_identity_mismatch');
    return { kind: 'present' as const, power: powerFact(server.status), billing, server };
  }
  async function inspect(rawResource: unknown) {
    const resource = parseHetznerValue(HetznerResourceV1Schema, rawResource);
    const observed = await inspectServer(resource);
    if (observed.kind !== 'absent') return observed;
    for (const attachment of ownedAttachments(resource)) {
      const path = `/${attachment.kind === 'volume' ? 'volumes' : 'primary_ips'}/${attachment.id}`;
      if ((await request(path, 'GET', undefined, true)).kind !== 'absent') throw new HetznerNativeError('native_cleanup_unconfirmed');
    }
    return observed;
  }
  function bind(server: Readonly<{ id: number; status?: string }>, owned: HetznerResourceV1['owned']): Extract<HetznerAcquireResult, { kind: 'bound' }> {
    return { kind: 'bound', resource: { serverId: server.id, owned }, power: powerFact(server.status ?? '') };
  }
  return {
    async check() { await request('/servers?page=1&per_page=1'); return { available: true as const }; },
    async acquire(rawInput: unknown): Promise<HetznerAcquireResult> {
      const input = parseHetznerValue(HetznerAcquireV1Schema, rawInput);
      const publicKey = input.bootstrapSshPublicKey.split(' ').slice(0, 2).join(' ');
      let reply: NativeReply;
      try {
        reply = await request('/servers', 'POST', {
          name: input.name, server_type: input.launch.serverTypeId, image: input.launch.imageId, location: input.launch.locationId,
          public_net: { enable_ipv4: input.launch.publicNetworking.ipv4, enable_ipv6: input.launch.publicNetworking.ipv6 },
          labels: { 'happier-managed': input.correlation }, start_after_create: true,
          user_data: buildMachineProvisionerCloudInit(publicKey, options.guestHostKey),
        });
      } catch (error) {
        return projectMachineProvisionerActionFailure(error, (): HetznerAcquireResult => {
          const code = codeOf(error);
          const cause = error instanceof HetznerNativeError && error.nativeCause ? { nativeCause: error.nativeCause } : {};
          if (['native_authorization_failed', 'native_request_failed'].includes(code)) return { kind: 'rejected', code, ...cause };
          return { kind: 'unknown', code: code === 'native_transport_unavailable' ? 'native_transport_unknown' : code, correlation: input.correlation, ...cause };
        });
      }
      try {
        // An accepted create's exact paid id survives missing readiness/connection facts.
        const { server: identity } = decode(mini.object({ server: mini.object({ id: nativeId() }) }), reply);
        const value = reply.kind === 'ok' ? reply.value : null;
        const serverResult = mini.object({ server: serverSchema }).safeParse(value);
        const networkResult = mini.object({ server: mini.object({ public_net: publicNetworkSchema }) }).safeParse(value);
        const server = serverResult.success && serverResult.data.server.labels['happier-managed'] === input.correlation ? serverResult.data.server : identity;
        const network = networkResult.success ? networkResult.data.server.public_net : undefined;
        const primaryIpIds = [
          input.launch.publicNetworking.ipv4 ? network?.ipv4?.id : undefined,
          input.launch.publicNetworking.ipv6 ? network?.ipv6?.id : undefined,
        ].filter((id): id is number => typeof id === 'number');
        // Creation evidence owns returned IPs; labeled recovery never adopts attachments.
        return bind(server, { volumeIds: [], primaryIpIds });
      } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: codeOf(error), correlation: input.correlation })); }
    },
    inspect,
    async snapshot(rawResource: unknown, label: string, waitForObservation: () => Promise<void>): Promise<MachineProvisionerSnapshotResultV1> {
      const resource = parseHetznerValue(HetznerResourceV1Schema, rawResource);
      let submitted = false;
      let acknowledged = false;
      try {
        const observed = await inspectServer(resource);
        if (observed.kind === 'absent') return { kind: 'refused', code: 'native_identity_not_found' };
        submitted = true;
        const reply = await request(`/servers/${resource.serverId}/actions/create_image`, 'POST', { type: 'snapshot', description: label });
        acknowledged = true;
        const created = decode(mini.object({ action: actionSchema, image: mini.object({ id: nativeId() }) }), reply);
        const action = await waitForAction(resource.serverId, created.action, waitForObservation);
        if (action.status === 'error') return { kind: 'failed', code: 'native_snapshot_failed' };
        return { kind: 'confirmed', snapshotId: String(created.image.id), ...HETZNER_SNAPSHOT_FACTS,
          consistency: observed.power === 'running' || observed.power === 'stopped' ? observed.power : 'unknown' };
      } catch (error) {
        return projectMachineProvisionerActionFailure(error, (): MachineProvisionerSnapshotResultV1 => {
          const cause = error instanceof HetznerNativeError ? error.nativeCause : undefined;
          return { kind: !submitted || !acknowledged && cause !== undefined && 'httpStatusClass' in cause && cause.httpStatusClass === '4xx' ? 'refused' : 'unknown', code: codeOf(error),
            ...(cause ? { nativeCause: cause } : {}) };
        });
      }
    },
    async recover(rawCorrelation: string): Promise<Exclude<HetznerAcquireResult, { kind: 'rejected' }> | { kind: 'rejected'; code: 'managed_not_found' }> {
      const correlation = parseHetznerValue(HetznerCorrelationSchema, rawCorrelation);
      try {
        const candidates = await list('/servers', 'servers', serverSchema, `label_selector=${encodeURIComponent(`happier-managed=${correlation}`)}`);
        const exact = new Map(candidates.filter(server => server.labels['happier-managed'] === correlation).map(server => [server.id, server]));
        if (candidates.length === 0) {
          // A lost create response can also lose the automatically allocated IP ids.
          // They carry no acquisition label, so only an empty inventory proves
          // there is no remaining resource from this acquisition to clean up.
          const inventory = decode(mini.object({ primary_ips: mini.array(mini.unknown()), meta: paginationSchema }),
            await request('/primary_ips?page=1&per_page=1'));
          if (inventory.primary_ips.length === 0 && inventory.meta.pagination.next_page === null) {
            return { kind: 'rejected', code: 'managed_not_found' };
          }
        }
        if (exact.size !== 1) return { kind: 'unknown', code: exact.size ? 'native_identity_ambiguous' : 'native_identity_not_found', correlation };
        return bind([...exact.values()][0], { volumeIds: [], primaryIpIds: [] });
      } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: codeOf(error), correlation,
        ...(error instanceof HetznerNativeError && error.nativeCause ? { nativeCause: error.nativeCause } : {}) })); }
    },
    async power(rawResource: unknown, rawIntent: unknown) {
      const resource = parseHetznerValue(HetznerResourceV1Schema, rawResource);
      const intent = parseHetznerValue(HetznerPowerIntentSchema, rawIntent);
      const { action } = decode(mini.object({ action: actionSchema }), await request(`/servers/${resource.serverId}/actions/${intent === 'start' ? 'poweron' : 'shutdown'}`, 'POST'));
      // Action success acknowledges shutdown; only exact inspect proves stopped.
      return action.status === 'error' ? { kind: 'refused' as const, code: 'native_action_failed', nativeAction: action }
        : { kind: 'pending' as const, nativeAction: action };
    },
    async destroy(rawResource: unknown, continuing = false) {
      const operation = parseHetznerValue(HetznerDeleteOperationV1Schema, rawResource);
      const resource: HetznerResourceV1 = { serverId: operation.serverId, owned: operation.owned };
      const attachments = ownedAttachments(resource);
      const remaining: CleanupResource[] = [{ kind: 'server', id: resource.serverId }, ...attachments];
      try {
        let action: mini.infer<typeof actionSchema> | undefined;
        if (!continuing) {
          const deletion = await request(`/servers/${resource.serverId}`, 'DELETE', undefined, true);
          if (deletion.kind === 'ok') action = decode(mini.object({ action: actionSchema }), deletion).action;
        } else if (operation.deleteActionId !== undefined) {
          action = decode(mini.object({ action: actionSchema }), await request(`/servers/actions/${operation.deleteActionId}`)).action;
          if (action.id !== operation.deleteActionId) throw new HetznerNativeError('native_identity_mismatch');
        }
        // REST v1 removes the Server from the account immediately, while its
        // attachments detach asynchronously. Only action success proves they
        // are ready for cleanup. CD33's host observer owns the wait/cadence.
        // https://docs.hetzner.cloud/reference/cloud#tag/servers/DELETE/servers/{id}
        if (action?.status === 'running') return { kind: 'incomplete' as const, remaining,
          nativeOperation: { ...resource, deleteActionId: action.id } };
        if (action?.status === 'error') throw new HetznerNativeError('native_action_failed');
        if ((await inspectServer(resource)).kind !== 'absent') return { kind: 'incomplete' as const, remaining, nativeOperation: resource };
      } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'incomplete' as const, code: codeOf(error), remaining,
        ...(error instanceof HetznerNativeError && error.nativeCause ? { nativeCause: error.nativeCause } : {}) })); }
      remaining.shift();
      let nativeCause: MachineProvisionerNativeCauseV1 | undefined;
      let code: string | undefined;
      for (const attachment of attachments) {
        try {
          const path = `/${attachment.kind === 'volume' ? 'volumes' : 'primary_ips'}/${attachment.id}`;
          if (continuing && (await request(path, 'GET', undefined, true)).kind === 'absent') {
            remaining.splice(remaining.indexOf(attachment), 1);
            continue;
          }
          // Native Volume/Primary IP deletion is synchronous (204). Any accepted
          // action instead requires exact absence, never merely a successful HTTP reply.
          const deletion = await request(path, 'DELETE', undefined, true);
          if (deletion.kind === 'ok' && deletion.status !== 204 && (await request(path, 'GET', undefined, true)).kind !== 'absent') continue;
          remaining.splice(remaining.indexOf(attachment), 1);
        } catch (error) { projectMachineProvisionerActionFailure(error, () => {
          code ??= codeOf(error); if (error instanceof HetznerNativeError) nativeCause ??= error.nativeCause;
        }); }
      }
      return remaining.length ? { kind: 'incomplete' as const, remaining, nativeOperation: resource,
        ...(code ? { code } : {}), ...(nativeCause ? { nativeCause } : {}) } : { kind: 'confirmed' as const };
    },
    async options() {
      const [sizes, images, locations, pricingReply] = await Promise.all([
        list('/server_types', 'server_types', sizeSchema), list('/images', 'images', imageSchema),
        list('/locations', 'locations', locationSchema), request('/pricing'),
      ]);
      const { pricing } = decode(mini.object({ pricing: pricingSchema }), pricingReply);
      const observedAt = Date.now();
      const price = (amount: string, unit: HetznerNativePrice['unit'], source = `${apiOrigin}/server_types`): HetznerNativePrice => ({ amount, currency: pricing.currency, unit, source, observedAt });
      return { sizes: sizes.map(({ locations: supportedLocations, ...size }) => {
        // REST v1 server_types.locations (verified 2026-10-26) owns orderability.
        // Prices can remain after a type retires at a location. Normalize once
        // so review offers only the locations that remain orderable.
        const availableLocations = new Set(supportedLocations.filter(location => location.available
          && (!location.deprecation || Date.parse(location.deprecation.unavailable_after) > observedAt)).map(location => location.name));
        return { ...size, prices: size.prices.filter(entry => availableLocations.has(entry.location)).map(entry => ({
          location: entry.location, hourly: price(entry.price_hourly.gross, 'hour'), monthly: price(entry.price_monthly.gross, 'month'),
        })) };
      }), images: images.map(({ deprecation, ...image }) => ({ ...image,
        deprecated: deprecation === undefined ? image.deprecated ?? null : deprecation?.announced ?? null,
      })), locations, observedAt,
        ...(pricing.primary_ips ? { primaryIpPrices: pricing.primary_ips.map(primaryIp => ({ type: primaryIp.type, prices: primaryIp.prices.map(entry => ({
          location: entry.location, hourly: price(entry.price_hourly.gross, 'hour', `${apiOrigin}/pricing#primary_ips`), monthly: price(entry.price_monthly.gross, 'month', `${apiOrigin}/pricing#primary_ips`),
        })) })) } : {}),
        ...(pricing.volume ? { storageCharges: [price(pricing.volume.price_per_gb_month.gross, 'GB-month', `${apiOrigin}/pricing#volume`)] } : {}),
      };
    },
  };
}
