import * as z from 'zod/mini';
import {
  LumeNativeConfigurationSchema, LumeNativeDetailsSchema, LumeNativeHostStatusSchema, LumeNativeImagesSchema, LumeNativeLocationsSchema, LumeNativeVmsSchema,
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
  kind: 'unknown'; reason: 'transport' | 'http' | 'response'; httpStatus?: number;
}>;
export type LumeNativeResourceUnknown = LumeNativeUnknown & Readonly<{ resource: LumeNativeResource }>;
export type LumeNativeMutationKind = 'pull-accepted' | 'start-accepted' | 'configure-accepted' | 'stop-accepted' | 'delete-accepted';
export type LumeNativeMutation = Readonly<{ kind: LumeNativeMutationKind; resource: LumeNativeResource }> | LumeNativeResourceUnknown;
export type LumeNativeVm = Readonly<{
  kind: 'present'; resource: LumeNativeResource;
  // The vendor consults its name-only cache for this value; it is not power proof.
  vendorStatus: string; os: string;
  cpu: number; memoryBytes: number; diskBytes: number; allocatedDiskBytes: number;
}>;
export type LumeNativeInspection = LumeNativeVm | LumeNativeResourceUnknown;
export type LumeNativeVms = Readonly<{ kind: 'vms'; vms: ReadonlyArray<LumeNativeVm> }> | LumeNativeUnknown;
export type LumeNativeRuntime = Readonly<{ kind: 'runtime'; version: string }> | LumeNativeUnknown;
export type LumeNativeLocations = Readonly<{ kind: 'locations'; locations: ReadonlyArray<Readonly<{ name: string }>> }> | LumeNativeUnknown;
export type LumeNativeImages = Readonly<{
  kind: 'images'; images: ReadonlyArray<Readonly<{ repository: string; imageId: string }>>;
}> | LumeNativeUnknown;
export type LumeNativeCatalog = Readonly<{ kind: 'catalog'; references: readonly string[] }> | LumeNativeUnknown;
const RegistryTokenSchema = z.object({ token: z.string().check(z.minLength(1), z.refine(value => !/[\r\n]/u.test(value))) });
const RegistryTagsSchema = z.object({ name: z.string(), tags: z.nullable(z.array(z.string().check(z.regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u)))) });
const LumePrivateConnectionSchema = z.object({ ipAddress: z.string().check(z.minLength(1)), sshAvailable: z.literal(true) });

export function createLumeNativeClient(options: { baseUrl: string; fetch?: typeof fetch }) {
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Lume requires an HTTP origin without credentials');
  }
  const nativeFetch = options.fetch ?? globalThis.fetch;

  function vmFacts(vm: z.infer<typeof LumeNativeDetailsSchema>): LumeNativeVm {
    return {
      kind: 'present', resource: LumeNativeResourceSchema.parse({ storage: vm.locationName, vmName: vm.name }),
      vendorStatus: vm.status, os: vm.os, cpu: vm.cpuCount, memoryBytes: vm.memorySize,
      diskBytes: vm.diskSize.total, allocatedDiskBytes: vm.diskSize.allocated,
    };
  }

  async function request(path: string, expectedStatus: number, init: RequestInit): Promise<Response | LumeNativeUnknown> {
    // Cancellation before dispatch proves no effect; after dispatch it cannot prove
    // that a native mutation was canceled. The caller retains the exact identity.
    init.signal?.throwIfAborted();
    try {
      const response = await nativeFetch(new URL(path, base), { ...init, redirect: 'error' });
      if (response.status !== expectedStatus) return { kind: 'unknown', reason: 'http', httpStatus: response.status };
      return response;
    } catch {
      // Vendor diagnostics and thrown transport errors may contain private material.
      return { kind: 'unknown', reason: 'transport' };
    }
  }

  function vmPath(resource: LumeNativeResource) {
    return `/lume/vms/${encodeURIComponent(resource.vmName)}`;
  }

  async function mutate(resource: LumeNativeResource, path: string, method: string, body: unknown, status: number, kind: LumeNativeMutationKind, signal?: AbortSignal): Promise<LumeNativeMutation> {
    const response = await request(path, status, {
      method, signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return response instanceof Response ? { kind, resource } : { ...response, resource };
  }

  const client = {
    // OCI Distribution tags and token auth, observed against public GHCR on
    // 2026-10-08. No user credential, refresh token, blob download or catalog
    // cache: the registry is the native authority for full tagged references.
    async catalog(repository: 'macos' | 'macos-tahoe-cua', signal?: AbortSignal): Promise<LumeNativeCatalog> {
      const selected = z.enum(['macos', 'macos-tahoe-cua']).parse(repository);
      const name = `trycua/${selected}`;
      const registry = 'https://ghcr.io';
      const path = `/v2/${name}/tags/list`;
      const tokenResponse = await request(`${registry}/token?${new URLSearchParams({ service: 'ghcr.io', scope: `repository:${name}:pull` })}`, 200, { method: 'GET', signal });
      if (!(tokenResponse instanceof Response)) return tokenResponse;
      try {
        const token = RegistryTokenSchema.safeParse(await tokenResponse.json());
        if (!token.success) return { kind: 'unknown', reason: 'response' };
        const references = new Set<string>();
        const visited = new Set<string>();
        let next: string | undefined = `${registry}${path}`;
        while (next) {
          if (visited.has(next)) return { kind: 'unknown', reason: 'response' };
          visited.add(next);
          const response = await request(next, 200, { method: 'GET', signal, headers: { Authorization: `Bearer ${token.data.token}` } });
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
    async check(signal?: AbortSignal): Promise<LumeNativeRuntime> {
      const response = await request('/lume/host/status', 200, { method: 'GET', signal });
      if (!(response instanceof Response)) return response;
      try {
        const result = LumeNativeHostStatusSchema.safeParse(await response.json());
        if (result.success) return { kind: 'runtime', version: result.data.version };
      } catch { /* A reachable endpoint without valid version facts is unknown. */ }
      return { kind: 'unknown', reason: 'response' };
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
    async list(storage: string, signal?: AbortSignal): Promise<LumeNativeVms> {
      const selectedStorage = z.string().check(z.minLength(1)).parse(storage);
      const response = await request(`/lume/vms?${new URLSearchParams({ storage: selectedStorage })}`, 200, { method: 'GET', signal });
      if (!(response instanceof Response)) return response;
      try {
        const result = LumeNativeVmsSchema.safeParse(await response.json());
        if (result.success && result.data.every((vm) => vm.locationName === selectedStorage)) {
          // Listing is inventory, not absence proof: name-only in-flight pulls
          // may be omitted. Exact recovery remains inspect(storage, vmName).
          return { kind: 'vms', vms: result.data.map(vmFacts) };
        }
      } catch { /* Unqualified or malformed inventory remains unknown. */ }
      return { kind: 'unknown', reason: 'response' };
    },
    async pull(input: unknown, signal?: AbortSignal): Promise<LumeNativeMutation> {
      const launch = LumeNativePullSchema.parse(input);
      const resource = { storage: launch.storage, vmName: launch.vmName };
      const response = await request('/lume/pull', 200, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: launch.image, name: launch.vmName, registry: launch.registry, organization: launch.organization, storage: launch.storage }),
      });
      if (!(response instanceof Response)) return { ...response, resource };
      try {
        const result = LumeNativePullResponseSchema.safeParse(await response.json());
        if (result.success && result.data.name === launch.vmName && result.data.image === launch.image) return { kind: 'pull-accepted', resource };
      } catch { /* A lost response body leaves creation uncertain. */ }
      return { kind: 'unknown', resource, reason: 'response' };
    },
    async inspect(input: unknown, signal?: AbortSignal): Promise<LumeNativeInspection> {
      const resource = LumeNativeResourceSchema.parse(input);
      const response = await request(`${vmPath(resource)}?${new URLSearchParams({ storage: resource.storage })}`, 200, { method: 'GET', signal });
      if (!(response instanceof Response)) return { ...response, resource };
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
      return mutate(resource, `${vmPath(resource)}/run`, 'POST', { storage: resource.storage, noDisplay: true, vnc: 'disabled' }, 202, 'start-accepted', signal);
    },
    async stop(input: unknown, signal?: AbortSignal): Promise<LumeNativeMutation> {
      const resource = LumeNativeResourceSchema.parse(input);
      const observed = await client.inspect(resource, signal);
      if (observed.kind !== 'present') return observed;
      return mutate(resource, `${vmPath(resource)}/stop?${new URLSearchParams({ storage: resource.storage })}`, 'POST', undefined, 200, 'stop-accepted', signal);
    },
    async destroy(input: unknown, signal?: AbortSignal): Promise<LumeNativeMutation> {
      const resource = LumeNativeResourceSchema.parse(input);
      const observed = await client.inspect(resource, signal);
      if (observed.kind !== 'present') return observed;
      return mutate(resource, `${vmPath(resource)}?${new URLSearchParams({ storage: resource.storage })}`, 'DELETE', undefined, 200, 'delete-accepted', signal);
    },
    // These facts travel only into protected bootstrap; safe inspect/choices
    // deliberately continue projecting away the guest address and native bags.
    async connection(input: unknown, signal?: AbortSignal) {
      const resource = LumeNativeResourceSchema.parse(input);
      const response = await request(`${vmPath(resource)}?${new URLSearchParams({ storage: resource.storage })}`, 200, { method: 'GET', signal });
      if (!(response instanceof Response)) return { ...response, resource };
      try {
        const body: unknown = await response.json();
        const details = LumeNativeDetailsSchema.safeParse(body);
        const connection = LumePrivateConnectionSchema.safeParse(body);
        if (details.success && details.data.name === resource.vmName && details.data.locationName === resource.storage
          && details.data.status === 'running' && connection.success) {
          return { kind: 'connection' as const, resource, address: connection.data.ipAddress, guestOs: details.data.os };
        }
      } catch { /* Invalid private connection facts never escape. */ }
      return { kind: 'unknown' as const, resource, reason: 'response' as const };
    },
    async images(organization: string, signal?: AbortSignal): Promise<LumeNativeImages> {
      const selectedOrganization = z.string().check(z.minLength(1)).parse(organization);
      const response = await request(`/lume/images?${new URLSearchParams({ organization: selectedOrganization })}`, 200, { method: 'GET', signal });
      if (!(response instanceof Response)) return response;
      try {
        const result = LumeNativeImagesSchema.safeParse(await response.json());
        if (result.success) return { kind: 'images', images: result.data };
      } catch { /* Cache/catalog unavailability is not an empty catalog. */ }
      return { kind: 'unknown', reason: 'response' };
    },
    async configure(input: unknown, configuration: unknown, signal?: AbortSignal): Promise<LumeNativeMutation> {
      const resource = LumeNativeResourceSchema.parse(input);
      const settings = LumeNativeConfigurationSchema.parse(configuration);
      return mutate(resource, vmPath(resource), 'PATCH', { ...settings, storage: resource.storage }, 200, 'configure-accepted', signal);
    },
  };
  return client;
}
export type LumeNativeClient = ReturnType<typeof createLumeNativeClient>;
