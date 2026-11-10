import * as z from 'zod/mini';
import type { MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { isLumeMacos, readLumeCapacity } from './capacity.js';
import { readLumeHostResources } from './hostResources.js';
import {
  LumeNativeConfigurationSchema, LumeNativeDetailsSchema, LumeNativeHostStatusSchema, LumeNativeLocationsSchema,
  LumeNativePullResponseSchema, LumeNativePullSchema, LumeNativeResourceSchema,
  type LumeNativeResource,
} from './schemas.js';

// Immutable external basis: trycua/cua lume-v0.6.1,
// 3350f504014c85416009a90fcb339fe556ce02fc, libs/lume/src/Server/Handlers.swift
// and libs/lume/src/VM/VMDetails.swift. This is native IO only; C50 owns admission,
// ownership, cancellation/cleanup decisions and protected enrollment.
// The managed leaf generates globally unique names from its host-owned row id.
// Stop/delete inspect the recorded storage before the vendor's name-keyed cache
// dispatch (C53 CD1). Unknown inspection never authorizes a mutation.
export type LumeNativeUnknown = Readonly<{
  kind: 'unknown'; reason: 'transport' | 'http' | 'response'; httpStatus?: number; nativeCause?: MachineProvisionerNativeCauseV1;
  /** Connection setup failed before this request could be delivered. */
  delivery?: 'not-sent';
}>;
export type LumeNativeResourceUnknown = LumeNativeUnknown & Readonly<{ resource: LumeNativeResource }>;
export type LumeNativeAbsent = Readonly<{ kind: 'absent'; resource: LumeNativeResource }>;
export type LumeNativeMutationKind = 'pull-accepted' | 'start-accepted' | 'configure-accepted' | 'stop-accepted' | 'delete-accepted';
export type LumeNativeMutation = Readonly<{ kind: LumeNativeMutationKind; resource: LumeNativeResource }> | LumeNativeResourceUnknown | LumeNativeAbsent
  | Readonly<{ kind: 'refused'; code: 'native_route_unavailable'; nativeCause: { localCause: 'native_route_unavailable' }; resource: LumeNativeResource }>
  | (NonNullable<NonNullable<ReturnType<typeof readLumeCapacity>>['macosStartRefusal']> & Readonly<{ resource: LumeNativeResource }>);
export type LumeNativeVm = Readonly<{
  kind: 'present'; resource: LumeNativeResource;
  // The vendor consults its name-only cache for this value; it is not power proof.
  vendorStatus: string; os: string;
  cpu: number; memoryBytes: number; diskBytes: number; allocatedDiskBytes: number;
}>;
export type LumeNativeInspection = LumeNativeVm | LumeNativeResourceUnknown | LumeNativeAbsent;
type LumeNativeRoute = Extract<MachineProvisionerNativeCauseV1, { localCause: 'native_route_not_found' }>['route'];
export type LumeNativeRuntime = Readonly<{ kind: 'runtime'; version: string }> | LumeNativeUnknown;
export type LumeCacheState = 'enabled' | 'disabled' | 'unknown';
export type LumeNativeLocations = Readonly<{ kind: 'locations'; locations: ReadonlyArray<Readonly<{ name: string }>> }> | LumeNativeUnknown;
export type LumeNativeCatalog = Readonly<{ kind: 'catalog'; references: readonly string[] }> | LumeNativeUnknown;
const RegistryTokenSchema = z.object({ token: z.string().check(z.minLength(1), z.refine(value => !/[\r\n]/u.test(value))) });
const RegistryTagsSchema = z.object({ name: z.string(), tags: z.nullable(z.array(z.string().check(z.regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u)))) });
const RegistryDiskSchema = z.object({ annotations: z.object({
  'org.trycua.lume.disk-size': z.string().check(z.regex(/^[1-9][0-9]*$/u), z.refine(value => Number.isSafeInteger(Number(value)))),
}) });
const LumePrivateConnectionSchema = z.object({ ipAddress: z.optional(z.nullable(z.string())), sshAvailable: z.optional(z.nullable(z.boolean())) });
// Settings includes private registry configuration. Project only this native fact.
const LumeCacheSettingsSchema = z.object({ cachingEnabled: z.boolean() });

export function createLumeNativeClient(options: { baseUrl: string; fetch?: typeof fetch }) {
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Lume requires an HTTP origin without credentials');
  }
  const nativeFetch = options.fetch ?? globalThis.fetch;
  // One client belongs to one Action invocation. Reuse its repository auth
  // across tag and image-metadata reads, never across invocations.
  const registryTokens = new Map<string, Promise<Readonly<{ kind: 'token'; token: string }> | LumeNativeUnknown>>();

  function vmFacts(vm: z.infer<typeof LumeNativeDetailsSchema>): LumeNativeVm {
    return {
      kind: 'present', resource: LumeNativeResourceSchema.parse({ storage: vm.locationName, vmName: vm.name }),
      vendorStatus: vm.status, os: vm.os, cpu: vm.cpuCount, memoryBytes: vm.memorySize,
      diskBytes: vm.diskSize.total, allocatedDiskBytes: vm.diskSize.allocated,
    };
  }

  async function request(path: string, expectedStatus: number | readonly number[], init: RequestInit, route?: LumeNativeRoute): Promise<Response | LumeNativeUnknown> {
    // Cancellation before dispatch proves no effect; after dispatch it cannot prove
    // that a native mutation was canceled. The caller retains the exact identity.
    init.signal?.throwIfAborted();
    try {
      const response = await nativeFetch(new URL(path, base), { ...init, redirect: 'error' });
      if (!(typeof expectedStatus === 'number' ? response.status === expectedStatus : expectedStatus.includes(response.status))) {
        // Pinned lifecycle handlers report missing VMs as HTTP400. HTTP404 is
        // a missing route, never resource absence; retain only static facts.
        if (response.status === 404 && route) return { kind: 'unknown', reason: 'http', httpStatus: 404,
          nativeCause: { localCause: 'native_route_not_found', route, httpStatus: 404 } };
        return { kind: 'unknown', reason: 'http', httpStatus: response.status, nativeCause: {
          httpStatusClass: response.status >= 500 ? '5xx' : response.status >= 400 ? '4xx' : response.status >= 300 ? '3xx' : 'other',
        } };
      }
      return response;
    } catch (error) {
      // Vendor diagnostics and thrown transport errors may contain private material.
      const cause = error instanceof Error && error.cause ? error.cause : error;
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
      const notSent = code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND';
      return { kind: 'unknown', reason: 'transport',
        ...(notSent ? { delivery: 'not-sent' as const } : {}),
        ...(route === 'run' ? { nativeCause: { localCause: 'native_route_unavailable' as const } } : {}) };
    }
  }

  function vmPath(resource: LumeNativeResource) {
    return `/lume/vms/${encodeURIComponent(resource.vmName)}`;
  }

  function registryToken(name: string, signal?: AbortSignal) {
    let pending = registryTokens.get(name);
    if (!pending) {
      pending = (async (): Promise<Readonly<{ kind: 'token'; token: string }> | LumeNativeUnknown> => {
        const response = await request(`https://ghcr.io/token?${new URLSearchParams({ service: 'ghcr.io', scope: `repository:${name}:pull` })}`, 200, { method: 'GET', signal });
        if (!(response instanceof Response)) return response;
        try {
          const result = RegistryTokenSchema.safeParse(await response.json());
          if (result.success) return { kind: 'token', token: result.data.token };
        } catch { /* Invalid registry authentication remains unavailable. */ }
        return { kind: 'unknown', reason: 'response' };
      })();
      registryTokens.set(name, pending);
    }
    return pending;
  }

  async function mutate(resource: LumeNativeResource, path: string, method: string, body: unknown, status: number, kind: LumeNativeMutationKind, route: LumeNativeRoute, signal?: AbortSignal): Promise<LumeNativeMutation> {
    const response = await request(path, status, {
      method, signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, route);
    return response instanceof Response ? { kind, resource } : mutationFailure(resource, response);
  }

  function mutationFailure(resource: LumeNativeResource, failure: LumeNativeUnknown): LumeNativeMutation {
    return failure.delivery === 'not-sent'
      ? { kind: 'refused', code: 'native_route_unavailable', nativeCause: { localCause: 'native_route_unavailable' }, resource }
      : { ...failure, resource };
  }

  function stopPresent(resource: LumeNativeResource, signal?: AbortSignal) {
    // Server.swift matches raw URL segments: a query would turn the literal
    // final segment into "stop?storage=...". Stop reads storage from JSON.
    return mutate(resource, `${vmPath(resource)}/stop`, 'POST', { storage: resource.storage }, 200, 'stop-accepted', 'stop', signal);
  }

  async function readConfiguration(signal?: AbortSignal): Promise<unknown> {
    const response = await request('/lume/config', 200, { method: 'GET', signal });
    if (response instanceof Response) {
      try { return await response.json(); } catch { /* An unreadable configuration stays unknown. */ }
    }
    return undefined;
  }

  function configurationCacheState(configuration: unknown): LumeCacheState {
    const result = LumeCacheSettingsSchema.safeParse(configuration);
    return result.success ? result.data.cachingEnabled ? 'enabled' : 'disabled' : 'unknown';
  }

  async function readInventory(signal?: AbortSignal) {
    // Omit storage: the platform limit covers all Lume locations on this Mac.
    const response = await request('/lume/vms', 200, { method: 'GET', signal });
    if (!(response instanceof Response)) return response;
    try {
      const inventory = readLumeCapacity(await response.json());
      if (inventory) return inventory;
    } catch { /* An unreadable inventory cannot establish capacity. */ }
    return { kind: 'unknown' as const, reason: 'response' as const };
  }

  const client = {
    async hostFacts(observedAt: number, signal?: AbortSignal) {
      const [configuration, inventory] = await Promise.all([readConfiguration(signal), readInventory(signal)]);
      return { cacheState: configurationCacheState(configuration),
        localResources: await readLumeHostResources(observedAt, configuration, inventory.kind === 'inventory' ? inventory.vms : undefined) };
    },
    inventory: readInventory,
    // OCI Distribution tags and token auth, observed against public GHCR on
    // 2026-10-08. No user credential, refresh token, blob download or catalog
    // cache: the registry is the native authority for full tagged references.
    async catalog(repository: 'macos' | 'macos-tahoe-cua', signal?: AbortSignal): Promise<LumeNativeCatalog> {
      const selected = z.enum(['macos', 'macos-tahoe-cua']).parse(repository);
      const name = `trycua/${selected}`;
      const registry = 'https://ghcr.io';
      const path = `/v2/${name}/tags/list`;
      const token = await registryToken(name, signal);
      if (token.kind !== 'token') return token;
      try {
        const references = new Set<string>();
        const visited = new Set<string>();
        let next: string | undefined = `${registry}${path}`;
        while (next) {
          if (visited.has(next)) return { kind: 'unknown', reason: 'response' };
          visited.add(next);
          const response = await request(next, 200, { method: 'GET', signal, headers: { Authorization: `Bearer ${token.token}` } });
          if (!(response instanceof Response)) return response;
          const tags = RegistryTagsSchema.safeParse(await response.json());
          if (!tags.success || tags.data.name !== name) return { kind: 'unknown', reason: 'response' };
          for (const tag of tags.data.tags ?? []) references.add(`ghcr.io/${name}:${tag}`);
          const link = response.headers.get('link');
          next = undefined;
          if (link !== null) {
            const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/u.exec(link);
            if (!match) return { kind: 'unknown', reason: 'response' };
            const url = new URL(match[1], response.url || `${registry}${path}`);
            if (url.origin !== registry || url.pathname !== path || url.username || url.password || url.hash) return { kind: 'unknown', reason: 'response' };
            next = url.href;
          }
        }
        return { kind: 'catalog', references: [...references] };
      } catch { return { kind: 'unknown', reason: 'response' }; }
    },
    async imageDiskBytes(reference: string, signal?: AbortSignal): Promise<Readonly<{ kind: 'image'; diskBytes: number }> | LumeNativeUnknown> {
      const match = /^ghcr\.io\/(trycua\/(?:macos|macos-tahoe-cua))(?::([A-Za-z0-9_][A-Za-z0-9_.-]*)|@(sha256:[a-f0-9]{64}))$/u.exec(reference);
      if (!match) return { kind: 'unknown', reason: 'response' };
      const name = match[1];
      const token = await registryToken(name, signal);
      if (token.kind !== 'token') return token;
      const response = await request(`https://ghcr.io/v2/${name}/manifests/${encodeURIComponent(match[2] ?? match[3])}`, 200,
        { method: 'GET', signal, headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/vnd.oci.image.manifest.v1+json' } });
      if (!(response instanceof Response)) return response;
      try {
        const result = RegistryDiskSchema.safeParse(await response.json());
        if (result.success) return { kind: 'image', diskBytes: Number(result.data.annotations['org.trycua.lume.disk-size']) };
      } catch { /* Missing or malformed native sizing facts are unknown, not zero. */ }
      return { kind: 'unknown', reason: 'response' };
    },
    async check(signal?: AbortSignal): Promise<LumeNativeRuntime> {
      const response = await request('/lume/host/status', 200, { method: 'GET', signal });
      if (!(response instanceof Response)) return response;
      try {
        const result = LumeNativeHostStatusSchema.safeParse(await response.json());
        if (result.success) return { kind: 'runtime', version: result.data.version };
      } catch { /* A reachable endpoint without valid version facts is unknown. */ }
      return { kind: 'unknown', reason: 'response' };
    },
    async cacheState(signal?: AbortSignal): Promise<LumeCacheState> {
      return configurationCacheState(await readConfiguration(signal));
    },
    async enableCaching(signal?: AbortSignal): Promise<LumeCacheState> {
      // Lume 0.6.1 ConfigRequest updates only supplied fields. Preserve both
      // user directories; an acknowledgement alone does not prove enablement.
      const response = await request('/lume/config', 200, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cachingEnabled: true }),
      });
      return response instanceof Response ? client.cacheState(signal) : 'unknown';
    },
    async locations(signal?: AbortSignal): Promise<LumeNativeLocations> {
      const response = await request('/lume/config/locations', 200, { method: 'GET', signal });
      if (!(response instanceof Response)) return response;
      try {
        const result = LumeNativeLocationsSchema.safeParse(await response.json());
        if (result.success) return { kind: 'locations', locations: result.data };
      } catch { /* Storage discovery failures do not invent a default location. */ }
      return { kind: 'unknown', reason: 'response' };
    },
    async pull(input: unknown, signal?: AbortSignal): Promise<LumeNativeMutation> {
      const launch = LumeNativePullSchema.parse(input);
      const resource = { storage: launch.storage, vmName: launch.vmName };
      const response = await request('/lume/pull', 200, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: launch.image, name: launch.vmName, registry: launch.registry, organization: launch.organization, storage: launch.storage }),
      }, 'pull');
      if (!(response instanceof Response)) return { ...response, resource };
      try {
        const result = LumeNativePullResponseSchema.safeParse(await response.json());
        if (result.success && result.data.name === launch.vmName && result.data.image === launch.image) return { kind: 'pull-accepted', resource };
      } catch { /* A lost response body leaves creation uncertain. */ }
      return { kind: 'unknown', resource, reason: 'response' };
    },
    async inspect(input: unknown, signal?: AbortSignal): Promise<LumeNativeInspection> {
      const resource = LumeNativeResourceSchema.parse(input);
      const response = await request(`${vmPath(resource)}?${new URLSearchParams({ storage: resource.storage })}`, [200, 400], { method: 'GET', signal }, 'inspect');
      if (!(response instanceof Response)) return { ...response, resource };
      if (response.status === 400) {
        // Lume 0.6.1 VMError.notFound includes the exact requested name.
        // Invalid storage, authorization and failed/in-flight pulls are not absence.
        try {
          const missing = z.object({ message: z.literal(`Virtual machine not found: ${resource.vmName}`) }).safeParse(await response.json());
          if (missing.success) return { kind: 'absent', resource };
        } catch { /* An unreadable native error remains uncertain. */ }
        return { kind: 'unknown', resource, reason: 'http', httpStatus: 400, nativeCause: { httpStatusClass: '4xx' } };
      }
      try {
        const result = LumeNativeDetailsSchema.safeParse(await response.json());
        if (result.success && result.data.name === resource.vmName && result.data.locationName === resource.storage) {
          return vmFacts(result.data);
        }
      } catch { /* Missing/invalid native facts cannot prove absence. */ }
      // The vendor's name-only synthetic "pulling" response ignores storage, so
      // it cannot qualify this resource even when the requested name matches.
      return { kind: 'unknown', resource, reason: 'response' };
    },
    async run(input: unknown, signal?: AbortSignal): Promise<LumeNativeMutation> {
      const resource = LumeNativeResourceSchema.parse(input);
      const inventory = await client.inventory(signal);
      if (inventory.kind !== 'inventory') return mutationFailure(resource, inventory);
      const target = inventory.vms.find(vm => vm.name === resource.vmName && vm.locationName === resource.storage);
      if (target && isLumeMacos(target.os) && target.status !== 'running' && inventory.macosStartRefusal) {
        return { ...inventory.macosStartRefusal, resource };
      }
      return mutate(resource, `${vmPath(resource)}/run`, 'POST', { storage: resource.storage, noDisplay: true, vnc: 'disabled' }, 202, 'start-accepted', 'run', signal);
    },
    async stop(input: unknown, signal?: AbortSignal): Promise<LumeNativeMutation> {
      const resource = LumeNativeResourceSchema.parse(input);
      const observed = await client.inspect(resource, signal);
      if (observed.kind !== 'present') return observed.kind === 'unknown' ? mutationFailure(resource, observed) : observed;
      return stopPresent(resource, signal);
    },
    async destroy(input: unknown, signal?: AbortSignal): Promise<LumeNativeMutation> {
      const resource = LumeNativeResourceSchema.parse(input);
      let observed = await client.inspect(resource, signal);
      if (observed.kind !== 'present') return observed;
      // Pinned LumeController.delete implicitly stops cached VMs before its
      // resize-lock checks. Own Stop separately and prove its exact readback so
      // Delete never relies on that partially effectful implicit-stop path.
      if (observed.vendorStatus === 'running') {
        const stopped = await stopPresent(resource, signal);
        if (stopped.kind !== 'stop-accepted') return stopped;
        observed = await client.inspect(resource, signal);
        if (observed.kind !== 'present') return observed;
        if (observed.vendorStatus !== 'stopped') return stopped;
      }
      if (observed.vendorStatus !== 'stopped') return { kind: 'unknown', resource, reason: 'response' };
      const result = await mutate(resource, `${vmPath(resource)}?${new URLSearchParams({ storage: resource.storage })}`, 'DELETE', undefined, 200, 'delete-accepted', 'delete', signal);
      // The handler maps a thrown native delete to HTTP400. It proves refusal
      // to complete deletion, not absence or absence of preceding side effects.
      return result.kind === 'unknown' && result.reason === 'http' && result.httpStatus === 400
        ? { ...result, nativeCause: { localCause: 'native_delete_refused', httpStatus: 400 } } : result;
    },
    // These facts travel only into protected bootstrap; safe inspect/choices
    // deliberately continue projecting away the guest address and native bags.
    async connection(input: unknown, signal?: AbortSignal) {
      const resource = LumeNativeResourceSchema.parse(input);
      const response = await request(`${vmPath(resource)}?${new URLSearchParams({ storage: resource.storage })}`, 200, { method: 'GET', signal }, 'inspect');
      if (!(response instanceof Response)) return { ...response, resource };
      try {
        const body: unknown = await response.json();
        const details = LumeNativeDetailsSchema.safeParse(body);
        const connection = LumePrivateConnectionSchema.safeParse(body);
        if (details.success && details.data.name === resource.vmName && details.data.locationName === resource.storage
          && connection.success) {
          if (details.data.status === 'provisioning') return { kind: 'pending' as const, resource };
          if (details.data.status !== 'running') {
            const inventory = details.data.status === 'stopped' && isLumeMacos(details.data.os) ? await client.inventory(signal) : undefined;
            return { kind: 'unavailable' as const, resource,
              nativeCause: inventory?.kind === 'inventory' ? inventory.macosStartRefusal?.nativeCause : undefined };
          }
          // VMDetails' optional DHCP/SSH facts can lag the accepted native run.
          // The host readiness owner waits; malformed or mismatched facts do not.
          if (!connection.data.ipAddress || connection.data.sshAvailable !== true) return { kind: 'pending' as const, resource };
          return { kind: 'connection' as const, resource, address: connection.data.ipAddress, guestOs: details.data.os };
        }
      } catch { /* Invalid private connection facts never escape. */ }
      return { kind: 'unknown' as const, resource, reason: 'response' as const };
    },
    async configure(input: unknown, configuration: unknown, signal?: AbortSignal): Promise<LumeNativeMutation> {
      const resource = LumeNativeResourceSchema.parse(input);
      const settings = LumeNativeConfigurationSchema.parse(configuration);
      const result = await mutate(resource, vmPath(resource), 'PATCH', { ...settings, storage: resource.storage }, 200, 'configure-accepted', 'configure', signal);
      // HTTP400 is a native configure refusal, not proof of no effect: CPU or
      // memory may already have applied. Never read/forward the message body.
      return result.kind === 'unknown' && result.reason === 'http' && result.httpStatus === 400
        ? { ...result, nativeCause: { localCause: 'native_configure_refused', httpStatus: 400 } } : result;
    },
  };
  return client;
}
export type LumeNativeClient = ReturnType<typeof createLumeNativeClient>;
