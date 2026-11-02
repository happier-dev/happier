import type { RegistryPackagedSourceDescriptorV1 } from '../registrySourcesV1.js';
import type { RegistrySourceV1, RegistryFormatV1, RegistryKindV1 } from '../registrySourcesV1.js';
import type { RegistryItemV1, RegistrySkillItemV1, RegistryContentRefV1, RegistryProvenanceV1 } from '../registryItemsV1.js';
import type { RegistryListPageV1, RegistrySourceStatusV1 } from '../registryListV1.js';
export type RegistryHttpResultV1<T> = Readonly<{ ok: true; value: T; fetchedAt: number }> | Readonly<{ ok: false; status: Exclude<RegistrySourceStatusV1, {state:'ok'}> }>;
export type RegistryHttpV1 = Readonly<{
  getJson(url: string, opts?: { source?: RegistrySourceV1 }): Promise<RegistryHttpResultV1<unknown>>;
  getText(url: string, opts?: { source?: RegistrySourceV1 }): Promise<RegistryHttpResultV1<string>>;
  getBytes(url: string, opts?: { source?: RegistrySourceV1 }): Promise<RegistryHttpResultV1<Uint8Array>>;
}>;
export type RegistryDetectedSourceV1 = Readonly<{ format: RegistryFormatV1; kinds: readonly RegistryKindV1[]; title: string; itemCount?: number }>
  | Readonly<{ unsupported: 'organisation' | 'unknown_format' | 'needs_token' | 'unreachable' }>;
export type RegistryFetchContextV1 = Readonly<{
packageContent?: Readonly<{ read(source: RegistryPackagedSourceDescriptorV1): Promise<Readonly<{ text: string; fetchedAt: number }>> }>;
 http: RegistryHttpV1; signal?: AbortSignal;
  /** Node owner retains immutable catalog resources across finite reads; mutable currentness stays with the adapter. */
  withAppCatalog?: <T>(input: Readonly<{ source: RegistrySourceV1; commit: string; current: boolean; http: RegistryHttpV1 }>,
    consume: (http: RegistryHttpV1) => Promise<T>) => Promise<T>;
  /** The host applies target placement while retaining the original catalog
   * pointer on daemon requests. Null defers a daemon-only target during browse. */
  readTargetItem?: (request: Readonly<{ source: RegistrySourceV1; kind: RegistryKindV1; itemId: string; version?: string }>) => Promise<RegistryItemV1 | null>;
  /** Non-HTTP git transports are supplied by the Node SCM owner. */
  git?: Readonly<Pick<RegistrySkillFormatAdapterV1, 'list' | 'read' | 'latest'> & {
    /** One request shares temporary acquisitions; the transport retires them when consumption settles. */
    withOperation?: <T>(consume: (git: NonNullable<RegistryFetchContextV1['git']>) => Promise<T>) => Promise<T>;
    files:(skill:import('../registryItemsV1.js').RegistrySkillSourceV1,source:RegistrySourceV1)=>Promise<readonly import('../registryGitTreeV1.js').RegistrySkillFileBytesV1[]>;
  }>;
}>;
/** Skill readers preserve their known payload discriminant for real skill consumers. */
export type RegistrySkillFormatAdapterV1=Omit<RegistryFormatAdapterV1,'read'> & Readonly<{
  read:(...args:Parameters<RegistryFormatAdapterV1['read']>)=>Promise<RegistrySkillItemV1>;
}>;
export type RegistryFormatAdapterV1 = Readonly<{
  format: RegistryFormatV1; kinds: readonly RegistryKindV1[];
  browserFetchable: (source: RegistrySourceV1) => boolean; supportsQuery: boolean;
  detect?: (ctx: RegistryFetchContextV1, url: string) => Promise<RegistryDetectedSourceV1 | null>;
  list: (ctx: RegistryFetchContextV1, req: { source: RegistrySourceV1; kind: RegistryKindV1; query?: string; cursor?: string | null }) => Promise<RegistryListPageV1>;
  read: (ctx: RegistryFetchContextV1, req: { source: RegistrySourceV1; kind: RegistryKindV1; itemId: string; version?: string }) => Promise<RegistryItemV1>;
  latest: (ctx: RegistryFetchContextV1, items: readonly RegistryProvenanceV1[], options?: Readonly<{ source: RegistrySourceV1 }>) => Promise<ReadonlyMap<string, RegistryContentRefV1 | 'removed'>>;
}>;
