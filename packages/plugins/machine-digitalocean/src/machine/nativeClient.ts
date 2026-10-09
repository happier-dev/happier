import * as z from 'zod/mini';
import {
  dropletAcquireInputSchema, dropletPowerIntentSchema, dropletResourceSchema,
  nativeDropletSchema, nativeActionSchema, nativeSizeSchema, nativeRegionSchema, nativeImageSchema,
  type DropletAcquireInputV1, type DropletResourceV1,
} from './schemas.js';

// DigitalOcean REST v2 OpenAPI fetched 2026-10-08: droplets_create.yml and
// sizes/models/size.yml. A 202 is acceptance, never readiness. Prices remain
// native facts; no hourly-to-monthly conversion is performed here.
const origin = 'https://api.digitalocean.com';
const base = `${origin}/v2`;
type NativeFailureReason = 'authorization' | 'transport' | 'native-error' | 'invalid-response' | 'invalid-pagination' | 'resource-mismatch';
type Unavailable = Readonly<{ kind: 'unavailable'; reason: NativeFailureReason; status?: number }>;
type HttpResult = Readonly<{ kind: 'response'; status: number; body: unknown }> | Unavailable;
type ResourceUnavailable = Unavailable & Readonly<{ resource: DropletResourceV1 }>;
type SshAddress = Readonly<{ address: string; user: 'root' }>;
type Inspection = ResourceUnavailable | Readonly<{ kind: 'absent'; resource: DropletResourceV1 }> | Readonly<{
  kind: 'present'; resource: DropletResourceV1; power: 'running' | 'stopped' | 'unknown'; stoppedBilling: 'billed';
  ready: boolean; ssh?: SshAddress;
}>;
type Binding = Readonly<{ kind: 'bound'; resource: DropletResourceV1; actionIds: number[]; ready: false }>;
type NativePrice = Readonly<{ amount: string; currency: 'USD'; unit: 'hour' | 'month'; source: string; observedAt: number }>;
const pageLinksSchema = z.optional(z.object({ pages: z.optional(z.object({ next: z.optional(z.string()) })) }));
const createReplySchema = z.object({ droplet: nativeDropletSchema });
const actionReferencesSchema = z.object({ links: z.object({ actions: z.array(z.object({ id: z.int().check(z.gt(0)), rel: z.optional(z.string()) })) }) });

export function createDigitalOceanNativeClient(options: { token: string; fetch?: typeof fetch; signal?: AbortSignal; now?: () => Date }) {
  const network = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  async function request(path: string, method = 'GET', body?: unknown): Promise<HttpResult> {
    try {
      const reply = await network(`${base}${path}`, {
        method, headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: options.signal, redirect: 'error',
      });
      if (reply.status === 401 || reply.status === 403) return { kind: 'unavailable', reason: 'authorization', status: reply.status };
      if (reply.status !== 404 && !reply.ok) return { kind: 'unavailable', reason: 'native-error', status: reply.status };
      if (reply.status === 204 || reply.status === 404) return { kind: 'response', status: reply.status, body: null };
      try { return { kind: 'response', status: reply.status, body: await reply.json() as unknown }; }
      catch { return { kind: 'unavailable', reason: 'invalid-response', status: reply.status }; }
    } catch { return { kind: 'unavailable', reason: 'transport' }; }
  }
  async function collection<T>(path: string, key: string, schema: z.ZodMiniType<T>): Promise<{ kind: 'available'; values: T[] } | Unavailable> {
    const values: T[] = [];
    const seen = new Set<string>();
    const pageSchema = z.object({ values: z.array(schema), links: pageLinksSchema });
    let next: string | undefined = `${base}${path}`;
    while (next) {
      let url: URL;
      try { url = new URL(next); } catch { return { kind: 'unavailable', reason: 'invalid-pagination' }; }
      if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== new URL(`${base}${path}`).pathname || seen.has(url.href)) return { kind: 'unavailable', reason: 'invalid-pagination' };
      seen.add(url.href);
      const result = await request(url.pathname.slice('/v2'.length) + url.search);
      if (result.kind === 'unavailable') return result;
      if (!result.body || typeof result.body !== 'object') return { kind: 'unavailable', reason: 'invalid-response' };
      const body = result.body as Record<string, unknown>;
      const page = pageSchema.safeParse({ values: body[key], links: body.links });
      if (!page.success) return { kind: 'unavailable', reason: 'invalid-response' };
      values.push(...page.data.values);
      next = page.data.links?.pages?.next;
    }
    return { kind: 'available', values };
  }
  async function inspect(input: DropletResourceV1): Promise<Inspection> {
    const resource = dropletResourceSchema.parse(input);
    const result = await request(`/droplets/${resource.dropletId}`);
    if (result.kind === 'unavailable') return { ...result, resource };
    if (result.status === 404) return { kind: 'absent', resource };
    const decoded = z.object({ droplet: nativeDropletSchema }).safeParse(result.body);
    if (!decoded.success) return { kind: 'unavailable', reason: 'invalid-response', resource };
    const droplet = decoded.data.droplet;
    if (droplet.id !== resource.dropletId) return { kind: 'unavailable', reason: 'resource-mismatch', resource };
    const address = [...(droplet.networks?.v4 ?? []), ...(droplet.networks?.v6 ?? [])].find(item => item.type === 'public')?.ip_address;
    const ready = droplet.status === 'active' && address !== undefined;
    return { kind: 'present', resource, power: droplet.status === 'active' ? 'running' : droplet.status === 'off' ? 'stopped' : 'unknown', stoppedBilling: 'billed', ready, ...(ready && address ? { ssh: { address, user: 'root' as const } } : {}) };
  }
  async function observeAction(input: DropletResourceV1, actionId: number) {
    const resource = dropletResourceSchema.parse(input);
    z.int().check(z.gt(0)).parse(actionId);
    const result = await request(`/actions/${actionId}`);
    if (result.kind === 'unavailable') return { ...result, resource };
    const decoded = z.object({ action: nativeActionSchema }).safeParse(result.body);
    if (!decoded.success) return { kind: 'unavailable', reason: 'invalid-response', resource } as const;
    const action = decoded.data.action;
    if (action.id !== actionId || action.resource_id !== resource.dropletId) return { kind: 'unavailable', reason: 'resource-mismatch', resource } as const;
    if (action.status === 'errored') return { kind: 'failed', resource, actionId } as const;
    if (action.status === 'in-progress') return { kind: 'pending', resource, actionId } as const;
    const observed = await inspect(resource);
    if (observed.kind !== 'present') return observed;
    const settled = action.type === 'create' || action.type === 'power_on' ? observed.ready : action.type === 'shutdown' || action.type === 'power_off' ? observed.power === 'stopped' : true;
    return settled ? { ...observed, kind: 'completed' as const, actionId } : { kind: 'pending' as const, resource, actionId };
  }
  async function nativeOptions() {
    const sizes = await collection('/sizes', 'sizes', nativeSizeSchema);
    if (sizes.kind !== 'available') return sizes;
    const regions = await collection('/regions', 'regions', nativeRegionSchema);
    if (regions.kind !== 'available') return regions;
    const images = await collection('/images', 'images', nativeImageSchema);
    if (images.kind !== 'available') return images;
    const observedAt = now().getTime();
    return {
      kind: 'available' as const, regions: regions.values, images: images.values,
      sizes: sizes.values.map(size => {
        const price = (amount: number, unit: 'hour' | 'month'): NativePrice => ({ amount: String(amount), currency: 'USD', unit, source: `${base}/sizes`, observedAt });
        // The API size model calls price_monthly a cost, not a cap. Never
        // relabel that rate as a returned cap. Choosing-a-plan (2026-10-08)
        // explicitly identifies s5-/g5- as v5 configurations with no cap.
        const monthlyCapStatus = /^(?:s5|g5)-/.test(size.slug) ? 'none' as const : 'unknown' as const;
        return { ...size, prices: [ ...(size.price_hourly == null ? [] : [price(size.price_hourly, 'hour')]), ...(size.price_monthly == null ? [] : [price(size.price_monthly, 'month')]) ], monthlyCap: null, monthlyCapStatus };
      }),
    };
  }
  return {
    inspect, observeAction, options: nativeOptions,
    async check() {
      const result = await request('/account');
      return result.kind === 'response' && z.object({ account: z.object({ status: z.literal('active') }) }).safeParse(result.body).success
        ? { available: true } as const : { available: false, code: result.kind === 'unavailable' ? result.reason : 'account-unavailable' } as const;
    },
    async create(raw: DropletAcquireInputV1): Promise<Binding | Unavailable | { kind: 'unknown'; recoveryTag: string; reason: string }> {
      const input = dropletAcquireInputSchema.parse(raw);
      const launch = input.launch;
      const publicKey = input.bootstrapSshPublicKey;
      const result = await request('/droplets', 'POST', {
        name: input.name, region: launch.regionSlug, size: launch.sizeSlug, image: launch.imageId,
        ipv6: launch.publicNetworking.ipv6, tags: [input.recoveryTag],
        user_data: `#cloud-config\nssh_authorized_keys:\n  - ${JSON.stringify(publicKey)}\n`,
      });
      if (result.kind === 'unavailable') {
        if (result.reason === 'authorization' || (result.status !== undefined && result.status < 500 && result.reason === 'native-error')) return result;
        return { kind: 'unknown', recoveryTag: input.recoveryTag, reason: result.reason };
      }
      const parsed = createReplySchema.safeParse(result.body);
      if (!parsed.success) return { kind: 'unknown', recoveryTag: input.recoveryTag, reason: 'invalid-response' };
      const references = actionReferencesSchema.safeParse(result.body);
      return { kind: 'bound', resource: { dropletId: parsed.data.droplet.id, ownedVolumeIds: [] }, actionIds: (references.success ? references.data.links.actions : []).filter(action => !action.rel || action.rel === 'create').map(action => action.id), ready: false };
    },
    async recover(recoveryTag: string): Promise<Binding | Unavailable | { kind: 'unknown'; recoveryTag: string; reason: 'ambiguous' | 'not-found' }> {
      const result = await collection(`/droplets?tag_name=${encodeURIComponent(recoveryTag)}`, 'droplets', nativeDropletSchema);
      if (result.kind !== 'available') return result;
      // REST v2 droplets_list.yml (2026-10-08) excludes GPU Droplets by
      // default. Both native classes must complete before uniqueness is known.
      const gpu = await collection(`/droplets?tag_name=${encodeURIComponent(recoveryTag)}&type=gpus`, 'droplets', nativeDropletSchema);
      if (gpu.kind !== 'available') return gpu;
      const matches = [...new Map([...result.values, ...gpu.values].filter(droplet => droplet.tags.includes(recoveryTag)).map(droplet => [droplet.id, droplet])).values()];
      if (matches.length !== 1) return { kind: 'unknown', recoveryTag, reason: matches.length > 1 ? 'ambiguous' : 'not-found' };
      return { kind: 'bound', resource: { dropletId: matches[0].id, ownedVolumeIds: [] }, actionIds: [], ready: false };
    },
    async observeResourceActions(input: DropletResourceV1) {
      const resource = dropletResourceSchema.parse(input);
      const result = await collection(`/droplets/${resource.dropletId}/actions`, 'actions', nativeActionSchema);
      if (result.kind !== 'available') return { ...result, resource };
      if (result.values.some(action => action.resource_id !== resource.dropletId)) return { kind: 'unavailable', reason: 'resource-mismatch', resource } as const;
      const create = result.values.filter(action => action.type === 'create');
      if (create.some(action => action.status === 'errored')) return { kind: 'failed', resource } as const;
      if (!create.some(action => action.status === 'completed') || result.values.some(action => action.status === 'in-progress')) return { kind: 'pending', resource } as const;
      return inspect(resource);
    },
    async power(input: DropletResourceV1, intent: 'start' | 'stop') {
      const resource = dropletResourceSchema.parse(input);
      const admittedIntent = dropletPowerIntentSchema.parse(intent);
      const result = await request(`/droplets/${resource.dropletId}/actions`, 'POST', { type: admittedIntent === 'start' ? 'power_on' : 'shutdown' });
      if (result.kind === 'unavailable') return { ...result, resource };
      const parsed = z.object({ action: nativeActionSchema }).safeParse(result.body);
      if (!parsed.success) return { kind: 'unavailable', reason: 'invalid-response', resource } as const;
      if (parsed.data.action.resource_id !== resource.dropletId) return { kind: 'unavailable', reason: 'resource-mismatch', resource } as const;
      return { kind: parsed.data.action.status === 'errored' ? 'failed' as const : 'pending' as const, resource, actionId: parsed.data.action.id };
    },
    async destroy(input: DropletResourceV1) {
      const resource = dropletResourceSchema.parse(input);
      const deleted = await request(`/droplets/${resource.dropletId}`, 'DELETE');
      if (deleted.kind === 'unavailable') return { ...deleted, resource };
      const observed = await inspect(resource);
      if (observed.kind !== 'absent') return { kind: 'incomplete', resource, remainingVolumeIds: resource.ownedVolumeIds, dropletAbsent: false } as const;
      const remainingVolumeIds: string[] = [];
      for (const id of resource.ownedVolumeIds) {
        const volume = await request(`/volumes/${encodeURIComponent(id)}`, 'DELETE');
        if (volume.kind === 'unavailable') { remainingVolumeIds.push(id); continue; }
        if (volume.status === 404) continue;
        const absent = await request(`/volumes/${encodeURIComponent(id)}`);
        if (absent.kind !== 'response' || absent.status !== 404) remainingVolumeIds.push(id);
      }
      return remainingVolumeIds.length ? { kind: 'incomplete' as const, resource, remainingVolumeIds, dropletAbsent: true } : { kind: 'deleted' as const, resource, dropletAbsent: true };
    },
  };
}
export type DigitalOceanNativeClient = ReturnType<typeof createDigitalOceanNativeClient>;
