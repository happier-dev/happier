import type { RegistryAppMappingV1 } from '../registryAppMappingV1.js';
import type { RegistrySourceV1, RegistryFormatV1, RegistryKindV1, RegistryPackagedSourceDescriptorV1, RegistryAppTemplateHintsV1 } from '../registrySourcesV1.js';
import type { RegistryItemV1, RegistrySkillItemV1, RegistryContentRefV1, RegistryRemoteProvenanceV1 } from '../registryItemsV1.js';
import type { RegistryListPageV1, RegistrySourceStatusV1, RegistryContributionFamilyV1 } from '../registryListV1.js';
export type RegistryHttpResultV1<T> = Readonly<{ ok: true; value: T; fetchedAt: number }> | Readonly<{ ok: false; status: Exclude<RegistrySourceStatusV1, {state:'ok'}> }>;
export type RegistryHttpV1 = Readonly<{
  getJson(url: string, opts?: { source?: RegistrySourceV1 }): Promise<RegistryHttpResultV1<unknown>>;
  getText(url: string, opts?: { source?: RegistrySourceV1 }): Promise<RegistryHttpResultV1<string>>;
  getBytes(url: string, opts?: { source?: RegistrySourceV1 }): Promise<RegistryHttpResultV1<Uint8Array>>;
  /** Form-encoded POST for upstream RPCs; preserves GET result/error/freshness semantics. */
  postForm?: (url: string, body: string, opts?: { source?: RegistrySourceV1 }) => Promise<RegistryHttpResultV1<string>>;
}>;
export type RegistryDetectedSourceV1 = Readonly<{ format: RegistryFormatV1; kinds: readonly RegistryKindV1[]; title: string; itemCount?: number }>
  | Readonly<{ unsupported: 'organisation' | 'unknown_format' | 'needs_token' | 'unreachable' }>;
export type RegistryFetchContextV1 = Readonly<{ http: RegistryHttpV1; signal?: AbortSignal;
  /** Platform digest for package checksums; hosts acquiring theme content supply it. */
  sha256Bytes?: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** Already resolved by the source owner; normalization consumes authored probes before admission. */
  appTemplateHints?: RegistryAppTemplateHintsV1;
  /** Node owner retains immutable catalog resources across finite reads; mutable currentness stays with the adapter. */
  withAppCatalog?: <T>(input: Readonly<{ source: RegistrySourceV1; commit: string; current: boolean; http: RegistryHttpV1 }>,
    consume: (http: RegistryHttpV1) => Promise<T>) => Promise<T>;
  /** Host-owned filesystem transport, admitted against the current installed plugin occurrence. */
  packageContent?: Readonly<{ read(source: RegistryPackagedSourceDescriptorV1): Promise<Readonly<{ text: string; fetchedAt: number }>> }>;
  /** Selected reads apply target placement while retaining the original catalog pointer on daemon requests. */
  readTargetItem?: (request: Readonly<{ source: RegistrySourceV1; kind: RegistryKindV1; itemId: string; version?: string; appMappingCorrection?: RegistryAppMappingV1; themeContent?: true }>) => Promise<RegistryItemV1>;
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
  /** Complete-page adapters apply the same query projection to fresh and retained summaries. */
  projectListQuery?: (page: RegistryListPageV1, query: string) => RegistryListPageV1;
  supportsContributionFamily?: boolean;
  detect?: (ctx: RegistryFetchContextV1, url: string) => Promise<RegistryDetectedSourceV1 | null>;
  list: (ctx: RegistryFetchContextV1, req: { source: RegistrySourceV1; kind: RegistryKindV1; contributionFamily?: RegistryContributionFamilyV1; query?: string; cursor?: string | null }) => Promise<RegistryListPageV1>;
  read: (ctx: RegistryFetchContextV1, req: { source: RegistrySourceV1; kind: RegistryKindV1; itemId: string; version?: string; appMappingCorrection?: RegistryAppMappingV1; themeContent?: true }) => Promise<RegistryItemV1>;
  latest: (ctx: RegistryFetchContextV1, items: readonly RegistryRemoteProvenanceV1[], options?: Readonly<{ source: RegistrySourceV1 }>) => Promise<ReadonlyMap<string, RegistryContentRefV1 | 'removed'>>;
}>;
