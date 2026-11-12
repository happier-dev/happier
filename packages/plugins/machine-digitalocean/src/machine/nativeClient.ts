import * as z from 'zod/mini';
import type { MachineProvisionerNativeCauseV1, MachineProvisionerSnapshotResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { projectMachineProvisionerActionFailure, buildMachineProvisionerCloudInit, MACHINE_PROVISIONER_CLOUD_SSH_USER, type MachineProvisionerCloudHostKeyV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
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
const accountResponseSchema = z.object({ account: z.object({ status: z.string() }) });
export function readDigitalOceanAccountAccess(value: unknown): Readonly<{ kind: 'active' | 'inactive' }> | undefined {
  const parsed = accountResponseSchema.safeParse(value);
  return parsed.success ? { kind: parsed.data.account.status === 'active' ? 'active' : 'inactive' } : undefined;
}
// REST v2 official shared/responses/{bad_request,unauthorized,forbidden,
// not_found,conflict,unprocessable_entity,too_many_requests,server_error}.yml,
// https://github.com/digitalocean/openapi/tree/main/specification/shared/responses
// verified 2026-10-25. Never project vendor messages, request ids or unknown ids.
const nativeErrorCodeSchema = z.enum(['bad_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'unprocessable_entity', 'too_many_requests', 'server_error']);
async function readNativeCause(reply: Response): Promise<MachineProvisionerNativeCauseV1> {
  const httpStatusClass = reply.status >= 300 && reply.status < 400 ? '3xx' : reply.status >= 400 && reply.status < 500 ? '4xx'
    : reply.status >= 500 && reply.status < 600 ? '5xx' : 'other';
  let body: unknown;
  try { body = await reply.json(); } catch { return { httpStatusClass }; }
  const parsed = z.object({ id: nativeErrorCodeSchema }).safeParse(body);
  return { httpStatusClass, ...(parsed.success ? { code: parsed.data.id } : {}) };
}
type NativeFailureReason = 'authorization' | 'transport' | 'native-error' | 'invalid-response' | 'invalid-pagination' | 'resource-mismatch' | 'cleanup-unconfirmed';
type Unavailable = Readonly<{ kind: 'unavailable'; reason: NativeFailureReason; status?: number; nativeCause?: MachineProvisionerNativeCauseV1 }>;
type HttpResult = Readonly<{ kind: 'response'; status: number; body: unknown }> | Unavailable;
type ResourceUnavailable = Unavailable & Readonly<{ resource: DropletResourceV1 }>;
type SshAddress = Readonly<{ address: string; user: typeof MACHINE_PROVISIONER_CLOUD_SSH_USER }>;
type Inspection = ResourceUnavailable | Readonly<{ kind: 'absent'; resource: DropletResourceV1 }> | Readonly<{
  kind: 'present'; resource: DropletResourceV1; power: 'running' | 'stopped' | 'unknown'; stoppedBilling: 'billed';
  ready: boolean; ssh?: SshAddress;
}>;
type Binding = Readonly<{ kind: 'bound'; resource: DropletResourceV1 }>;
type NativePrice = Readonly<{ amount: string; currency: 'USD'; unit: 'hour' | 'month'; source: string; observedAt: number }>;
const pageLinksSchema = z.optional(z.object({ pages: z.optional(z.object({ next: z.optional(z.string()) })) }));
// Paid identity survives unavailable readiness facts; inspect keeps the full schema.
const createReplySchema = z.object({ droplet: z.pick(nativeDropletSchema, { id: true }) });
const snapshotDropletSchema = z.object({ droplet: z.extend(z.pick(nativeDropletSchema, { id: true, status: true }), {
  snapshot_ids: z.array(nativeDropletSchema.shape.id),
}) });
// REST v2 Droplet Actions and droplet.yml snapshot_ids, read 2026-11-10.
// Droplet disk snapshots exclude attached Block Storage volumes. Running is
// disclosed separately: this operation does not claim application quiescence.
export const DIGITALOCEAN_SNAPSHOT_FACTS = { coverage: { rootDisk: true, attachedVolumes: false },
  cost: { kind: 'billed', source: 'https://docs.digitalocean.com/products/snapshots/details/pricing/' } } as const;

export function createDigitalOceanNativeClient(options: { token: string; fetch?: typeof fetch; signal?: AbortSignal; now?: () => Date; guestHostKey?: MachineProvisionerCloudHostKeyV1 }) {
  const network = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  async function request(path: string, method = 'GET', body?: unknown, acceptNotFound = false): Promise<HttpResult> {
    try {
      const reply = await network(`${base}${path}`, {
        method, headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: options.signal, redirect: 'error',
      });
      if (!reply.ok && !(reply.status === 404 && acceptNotFound)) return { kind: 'unavailable', reason: reply.status === 401 || reply.status === 403 ? 'authorization' : 'native-error',
        status: reply.status, nativeCause: await readNativeCause(reply) };
      if (reply.status === 204 || reply.status === 404) return { kind: 'response', status: reply.status, body: null };
      try { return { kind: 'response', status: reply.status, body: await reply.json() as unknown }; }
      catch { return { kind: 'unavailable', reason: 'invalid-response', status: reply.status }; }
    } catch (error) {
      const transportFailure = (): HttpResult => ({ kind: 'unavailable', reason: 'transport' });
      return projectMachineProvisionerActionFailure(error, transportFailure);
    }
  }
  async function collection<T>(path: string, key: string, schema: z.ZodMiniType<T>): Promise<{ kind: 'available'; values: T[] } | Unavailable> {
    const values: T[] = [];
    const pageSchema = z.object({ values: z.array(schema), links: pageLinksSchema });
    const firstPage = new URL(`${base}${path}`);
    // REST v2's documented maximum, not a result limit: follow every next link.
    // https://github.com/digitalocean/openapi/blob/main/specification/shared/parameters.yml
    // Verified 2026-10-26: default 20, maximum 200 items per page.
    firstPage.searchParams.set('per_page', '200');
    let next: string | undefined = firstPage.href;
    while (next) {
      let url: URL;
      try { url = new URL(next); } catch { return { kind: 'unavailable', reason: 'invalid-pagination' }; }
      if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== new URL(`${base}${path}`).pathname) return { kind: 'unavailable', reason: 'invalid-pagination' };
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
  async function inspectDroplet(input: DropletResourceV1): Promise<Inspection> {
    const resource = dropletResourceSchema.parse(input);
    const result = await request(`/droplets/${resource.dropletId}`, 'GET', undefined, true);
    if (result.kind === 'unavailable') return { ...result, resource };
    if (result.status === 404) return { kind: 'absent', resource };
    const decoded = z.object({ droplet: nativeDropletSchema }).safeParse(result.body);
    if (!decoded.success) return { kind: 'unavailable', reason: 'invalid-response', resource };
    const droplet = decoded.data.droplet;
    if (droplet.id !== resource.dropletId) return { kind: 'unavailable', reason: 'resource-mismatch', resource };
    if (!['new', 'active', 'off'].includes(droplet.status)) return { kind: 'unavailable', reason: 'invalid-response', resource };
    const address = [...(droplet.networks?.v4 ?? []), ...(droplet.networks?.v6 ?? [])].find(item => item.type === 'public')?.ip_address;
    const ready = droplet.status === 'active' && address !== undefined;
    return { kind: 'present', resource, power: droplet.status === 'active' ? 'running' : droplet.status === 'off' ? 'stopped' : 'unknown', stoppedBilling: 'billed', ready, ...(ready && address ? { ssh: { address, user: MACHINE_PROVISIONER_CLOUD_SSH_USER } } : {}) };
  }
  async function inspect(input: DropletResourceV1): Promise<Inspection> {
    const observed = await inspectDroplet(input);
    if (observed.kind !== 'absent') return observed;
    for (const id of observed.resource.ownedVolumeIds) {
      const volume = await request(`/volumes/${encodeURIComponent(id)}`, 'GET', undefined, true);
      if (volume.kind === 'unavailable') return { ...volume, resource: observed.resource };
      if (volume.status !== 404) return { kind: 'unavailable', reason: 'cleanup-unconfirmed', resource: observed.resource };
    }
    return observed;
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
    async snapshot(rawResource: DropletResourceV1, label: string, waitForObservation: () => Promise<void>): Promise<MachineProvisionerSnapshotResultV1> {
      const resource = dropletResourceSchema.parse(rawResource);
      const failure = (kind: 'unknown' | 'refused', code: string, result?: Unavailable) => ({ kind, code,
        ...(result?.nativeCause ? { nativeCause: result.nativeCause } : {}) });
      async function readDroplet() {
        const response = await request(`/droplets/${resource.dropletId}`);
        if (response.kind === 'unavailable') return response;
        const parsed = snapshotDropletSchema.safeParse(response.body);
        if (!parsed.success) return { kind: 'unavailable', reason: 'invalid-response' } as const;
        return parsed.data.droplet.id === resource.dropletId
          ? { kind: 'available', droplet: parsed.data.droplet } as const
          : { kind: 'unavailable', reason: 'resource-mismatch' } as const;
      }
      const before = await readDroplet();
      if (before.kind === 'unavailable') return failure('refused', 'native_snapshot_preflight_unavailable', before);
      const submitted = await request(`/droplets/${resource.dropletId}/actions`, 'POST', { type: 'snapshot', name: label });
      if (submitted.kind === 'unavailable') return failure(submitted.status !== undefined && submitted.status >= 400 && submitted.status < 500
        ? 'refused' : 'unknown', 'native_snapshot_submission_unavailable', submitted);
      const decodeAction = (body: unknown) => {
        const decoded = z.object({ action: nativeActionSchema }).safeParse(body);
        return decoded.success && decoded.data.action.type === 'snapshot' && decoded.data.action.resource_id === resource.dropletId
          ? decoded.data.action : undefined;
      };
      let action = decodeAction(submitted.body);
      if (!action) return failure('unknown', 'native_snapshot_action_unavailable');
      const actionId = action.id;
      while (action.status === 'in-progress') {
        try { await waitForObservation(); }
        catch { return failure('unknown', 'native_snapshot_observation_cancelled'); }
        const observed = await request(`/actions/${actionId}`);
        if (observed.kind === 'unavailable') return failure('unknown', 'native_snapshot_observation_unavailable', observed);
        action = decodeAction(observed.body);
        if (!action || action.id !== actionId) return failure('unknown', 'native_snapshot_action_mismatch');
      }
      if (action.status === 'errored') return { kind: 'failed', code: 'native_snapshot_failed' };
      const after = await readDroplet();
      if (after.kind === 'unavailable') return failure('unknown', 'native_snapshot_identity_unavailable', after);
      const previous = new Set(before.droplet.snapshot_ids);
      const created = after.droplet.snapshot_ids.filter(id => !previous.has(id));
      if (created.length !== 1) return failure('unknown', 'native_snapshot_identity_ambiguous');
      return { kind: 'confirmed', snapshotId: String(created[0]), ...DIGITALOCEAN_SNAPSHOT_FACTS,
        consistency: before.droplet.status === 'active' ? 'running' : before.droplet.status === 'off' ? 'stopped' : 'unknown' };
    },
    async check() {
      const result = await request('/account');
      const account = result.kind === 'response' ? readDigitalOceanAccountAccess(result.body) : undefined;
      return account?.kind === 'active'
        ? { available: true } as const : { available: false, code: result.kind === 'unavailable' ? result.reason : 'account-unavailable',
          ...(result.kind === 'unavailable' && result.nativeCause ? { nativeCause: result.nativeCause } : {}) } as const;
    },
    async create(raw: DropletAcquireInputV1): Promise<Binding | Unavailable | { kind: 'unknown'; recoveryTag: string; reason: string; nativeCause?: MachineProvisionerNativeCauseV1 }> {
      const input = dropletAcquireInputSchema.parse(raw);
      const launch = input.launch;
      const publicKey = input.bootstrapSshPublicKey;
      const result = await request('/droplets', 'POST', {
        name: input.name, region: launch.regionSlug, size: launch.sizeSlug, image: launch.imageId,
        ipv6: launch.publicNetworking.ipv6, tags: [input.recoveryTag],
        user_data: buildMachineProvisionerCloudInit(publicKey, options.guestHostKey),
      });
      if (result.kind === 'unavailable') {
        if (result.reason === 'authorization' || (result.status !== undefined && result.status < 500 && result.reason === 'native-error')) return result;
        return { kind: 'unknown', recoveryTag: input.recoveryTag, reason: result.reason, ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
      }
      const parsed = createReplySchema.safeParse(result.body);
      if (!parsed.success) return { kind: 'unknown', recoveryTag: input.recoveryTag, reason: 'invalid-response' };
      return { kind: 'bound', resource: { dropletId: parsed.data.droplet.id, ownedVolumeIds: [] } };
    },
    async recover(recoveryTag: string): Promise<Binding | Unavailable | { kind: 'unknown'; recoveryTag: string; reason: 'ambiguous' | 'not-found' }> {
      const result = await collection(`/droplets?tag_name=${encodeURIComponent(recoveryTag)}`, 'droplets', nativeDropletSchema);
      if (result.kind !== 'available') return result;
      // REST v2 droplets_list.yml excludes GPUs by default; parameters.yml
      // (verified 2026-10-29) forbids combining type with tag_name. Read all GPU
      // pages and qualify exact tags locally before deciding CPU/GPU uniqueness.
      const gpu = await collection('/droplets?type=gpus', 'droplets', nativeDropletSchema);
      if (gpu.kind !== 'available') return gpu;
      const matches = [...new Map([...result.values, ...gpu.values].filter(droplet => droplet.tags.includes(recoveryTag)).map(droplet => [droplet.id, droplet])).values()];
      if (matches.length !== 1) return { kind: 'unknown', recoveryTag, reason: matches.length > 1 ? 'ambiguous' : 'not-found' };
      return { kind: 'bound', resource: { dropletId: matches[0].id, ownedVolumeIds: [] } };
    },
    async observeResourceActions(input: DropletResourceV1) {
      const resource = dropletResourceSchema.parse(input);
      const result = await collection(`/droplets/${resource.dropletId}/actions`, 'actions', nativeActionSchema);
      if (result.kind !== 'available') return { ...result, resource };
      if (result.values.some(action => action.resource_id !== resource.dropletId)) return { kind: 'unavailable', reason: 'resource-mismatch', resource } as const;
      const create = result.values.filter(action => action.type === 'create');
      if (create.some(action => action.status === 'errored')) return { kind: 'failed', resource } as const;
      const observed = await inspect(resource);
      if (observed.kind !== 'present') return observed;
      // Only native creation/power-on can make this retained guest ready.
      // Historical absence and unrelated actions cannot prolong readiness.
      if (result.values.some(action => (action.type === 'create' || action.type === 'power_on') && action.status === 'in-progress')) {
        return { kind: 'pending', resource } as const;
      }
      return observed;
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
    async destroy(input: DropletResourceV1, continuing = false) {
      const resource = dropletResourceSchema.parse(input);
      if (!continuing) {
        const deleted = await request(`/droplets/${resource.dropletId}`, 'DELETE', undefined, true);
        if (deleted.kind === 'unavailable') return { ...deleted, resource };
      }
      const observed = await inspectDroplet(resource);
      if (observed.kind !== 'absent') return { kind: 'incomplete', resource, remainingVolumeIds: resource.ownedVolumeIds, dropletAbsent: false,
        ...(observed.kind === 'unavailable' ? { reason: observed.reason } : {}),
        ...(observed.kind === 'unavailable' && observed.nativeCause ? { nativeCause: observed.nativeCause } : {}) } as const;
      const remainingVolumeIds: string[] = [];
      let nativeCause: MachineProvisionerNativeCauseV1 | undefined;
      let reason: string | undefined;
      for (const id of resource.ownedVolumeIds) {
        if (continuing) {
          const current = await request(`/volumes/${encodeURIComponent(id)}`, 'GET', undefined, true);
          if (current.kind === 'unavailable') { reason ??= current.reason; nativeCause ??= current.nativeCause; remainingVolumeIds.push(id); continue; }
          if (current.status === 404) continue;
        }
        const volume = await request(`/volumes/${encodeURIComponent(id)}`, 'DELETE', undefined, true);
        if (volume.kind === 'unavailable') { reason ??= volume.reason; nativeCause ??= volume.nativeCause; remainingVolumeIds.push(id); continue; }
        if (volume.status === 404) continue;
        const absent = await request(`/volumes/${encodeURIComponent(id)}`, 'GET', undefined, true);
        if (absent.kind !== 'response' || absent.status !== 404) {
          if (absent.kind === 'unavailable') { reason ??= absent.reason; nativeCause ??= absent.nativeCause; }
          remainingVolumeIds.push(id);
        }
      }
      return remainingVolumeIds.length ? { kind: 'incomplete' as const, resource, remainingVolumeIds, dropletAbsent: true,
        ...(reason ? { reason } : {}),
        ...(nativeCause ? { nativeCause } : {}) } : { kind: 'deleted' as const, resource, dropletAbsent: true };
    },
  };
}
export type DigitalOceanNativeClient = ReturnType<typeof createDigitalOceanNativeClient>;
