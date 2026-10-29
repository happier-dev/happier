import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { isPortableRelativePath } from '../filesystem/portablePathSegment.js';
import { listSavedSecretReferenceCarrierPathsV1 } from '../account/settings/savedSecretReferenceV1.js';
import type { DeploymentTemplateV1 } from '../plugins/contributions/deploymentTemplates.js';
import { COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, PUBLIC_NPM_REGISTRY_ORIGIN_V1, DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE, DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, deriveMarketplaceSourceId } from '../marketplace/marketplaceSourceRegistryV1.js';

export const RegistryFormatV1Schema = lazyZodSchema(() => z.enum([
  'skills-sh', 'git', 'claude-marketplace', 'mcp-registry', 'acp-registry', 'happier-catalog', 'happier-npm', 'coolify-templates', 'dokploy-templates',
]));
export type RegistryFormatV1 = z.infer<typeof RegistryFormatV1Schema>;

export const RegistryKindV1Schema = lazyZodSchema(() => z.enum(['skill', 'mcpServer', 'agent', 'plugin', 'app']));
export type RegistryKindV1 = z.infer<typeof RegistryKindV1Schema>;
export const REGISTRY_FORMAT_KINDS_V1: Readonly<Record<RegistryFormatV1, readonly RegistryKindV1[]>> = {
  'skills-sh': ['skill'], git: ['skill'], 'claude-marketplace': ['skill'], 'mcp-registry': ['mcpServer'],
  'acp-registry': ['agent'], 'happier-catalog': ['skill', 'mcpServer', 'agent', 'plugin', 'app'], 'happier-npm': ['plugin', 'agent'],
  'coolify-templates': ['app'], 'dokploy-templates': ['app'],
};
export const RegistrySourceTokenV1Schema = lazyZodSchema(() => z.strictObject({ secretRef: z.string().check(z.minLength(1)),
  header: z.optional(z.strictObject({ name: z.string().check(z.minLength(1)), scheme: z.optional(z.enum(['Bearer', 'token'])) })),
}));
export const RegistrySourceV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), title: z.string().check(z.minLength(1)), format: RegistryFormatV1Schema,
  kinds: z.array(RegistryKindV1Schema).check(z.minLength(1)), url: z.string().check(z.minLength(1)), path: z.optional(z.string()), ref: z.optional(z.string().check(z.minLength(1))),
  enabled: z.boolean(), token: z.optional(RegistrySourceTokenV1Schema),
  npmRegistryProfileId: z.optional(z.string().check(z.minLength(1))), addedAt: z.number().check(z.int(), z.nonnegative()),
}).check(z.superRefine((source, ctx) => {
  if (source.kinds.some(kind => !REGISTRY_FORMAT_KINDS_V1[source.format].includes(kind))) {
    ctx.addIssue({ code: 'custom', path: ['kinds'], message: 'Kind not supported by source format' });
  }
  try { const url = new URL(source.url); if (url.username || url.password || source.format !== 'git' && url.protocol !== 'https:') throw new Error('credentials-or-scheme'); }
  catch { if (source.format !== 'git' || source.url.includes('://') && !/^(ssh|git):\/\//.test(source.url)) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'Invalid credential-free source URL' });
  } }
})));
export type RegistrySourceV1 = z.infer<typeof RegistrySourceV1Schema>;
const RegistrySourceContributorV1Schema = lazyZodSchema(() => z.strictObject({
  pluginVersion: z.string().check(z.minLength(1)), occurrenceId: z.string().check(z.minLength(1)),
}));
const RegistryRemoteSourceDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  ...RegistrySourceV1Schema.shape,
  origin: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('built_in') }), z.strictObject({ kind: z.literal('user') }),
    z.strictObject({ kind: z.literal('plugin'), pluginId: z.string().check(z.minLength(1)), localId: z.string().check(z.minLength(1)),
      suppliers: z.array(z.string().check(z.minLength(1))), contributor: z.optional(RegistrySourceContributorV1Schema) })]),
  removable: z.boolean(),
}).check(z.superRefine((descriptor, ctx) => {
  const { origin: _origin, removable: _removable, ...source } = descriptor;
  const parsed = RegistrySourceV1Schema.safeParse(source);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({code:'custom',path:issue.path,message:issue.message});
})));
export type RegistryRemoteSourceDescriptorV1 = RegistrySourceV1 & Readonly<{
  origin: Readonly<{ kind: 'built_in' }> | Readonly<{ kind: 'user' }> | Readonly<{ kind: 'plugin'; pluginId: string; localId: string;
    suppliers: readonly string[]; contributor?: Readonly<z.infer<typeof RegistrySourceContributorV1Schema>> }>;
  removable: boolean;
}>;
export const RegistryPackageContentPathV1Schema = lazyZodSchema(() => z.string().check(z.refine(isPortableRelativePath,
  'Package content must use a confined portable package-relative path')));
export const RegistryPackageContentSourceV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.minLength(1)), pluginVersion: z.string().check(z.minLength(1)),
  occurrenceId: z.string().check(z.minLength(1)), path: RegistryPackageContentPathV1Schema,
}));
export const RegistryPackagedSourceDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), title: z.string().check(z.minLength(1)),
  format: z.literal('happier-catalog'), kinds: z.array(z.literal('app')).check(z.minLength(1), z.maxLength(1)),
  packageContent: RegistryPackageContentSourceV1Schema, enabled: z.boolean(),
  addedAt: z.number().check(z.int(), z.nonnegative()), removable: z.literal(false),
  origin: z.strictObject({ kind: z.literal('plugin'), pluginId: z.string().check(z.minLength(1)),
    localId: z.string().check(z.minLength(1)), suppliers: z.array(z.string().check(z.minLength(1))) }),
}).check(z.superRefine((source, context) => {
  if (source.origin.pluginId !== source.packageContent.pluginId || source.id !== `${source.origin.pluginId}/${source.origin.localId}`) {
    context.addIssue({ code: 'custom', path: ['packageContent'], message: 'Package source must match its qualified plugin declaration' });
  }
})));
export type RegistryPackagedSourceDescriptorV1 = z.infer<typeof RegistryPackagedSourceDescriptorV1Schema>;
export const RegistrySourceDescriptorV1Schema = lazyZodSchema(() => z.union([
  RegistryRemoteSourceDescriptorV1Schema, RegistryPackagedSourceDescriptorV1Schema,
]));
export type RegistrySourceDescriptorV1 = RegistryRemoteSourceDescriptorV1 | RegistryPackagedSourceDescriptorV1;
export const RegistrySourcesRecordV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(2),
  sources: z.array(RegistrySourceV1Schema), disabledSourceIds: z.array(z.string().check(z.minLength(1))),
}));
export type RegistrySourcesRecordV1 = z.infer<typeof RegistrySourcesRecordV1Schema>;
export const RegistrySourcesReadEnvelopeV1Schema=lazyZodSchema(()=>z.object({v:z.union([z.literal(1),z.literal(2)]),sources:z.array(z.unknown()),
  disabledSourceIds:z.optional(z.array(z.string().check(z.minLength(1))))}));

export function normalizeRegistrySourceUrlV1(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid_source');
  url.hash = ''; url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (url.hostname === 'github.com') url.pathname = url.pathname.replace(/\.git$/, '');
  return url.toString().replace(/\/$/, '');
}
export function deriveRegistrySourceIdV1(url: string): string {
  return `registry:${bytesToHex(sha256(new TextEncoder().encode(normalizeRegistrySourceUrlV1(url)))).slice(0, 12)}`;
}
export const HAPPIER_PICKS_SOURCE_ID = deriveMarketplaceSourceId(DEFAULT_CURATED_MARKETPLACE_SOURCE_URL);

export type RegistrySourcesInventoryV1 = Readonly<{
  status: 'ready' | 'partial';
  record: RegistrySourcesRecordV1;
  diagnostics: readonly Readonly<{ index: number; reason: 'invalid-source' | 'duplicate-id' | 'unrepresented-config' }>[];
}>;

/** One stored projection serves display and transfer; only complete inventory admits authority. */
export function readRegistrySourcesInventoryV1(raw: unknown): RegistrySourcesInventoryV1 {
  const input = RegistrySourcesReadEnvelopeV1Schema.parse(raw);
  const sources: RegistrySourceV1[] = [];
  const diagnostics: Array<RegistrySourcesInventoryV1['diagnostics'][number]> = [];
  const seen = new Set<string>();
  for (const [index, entry] of input.sources.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      diagnostics.push({ index, reason: 'invalid-source' }); continue;
    }
    const value = entry as Record<string, unknown>;
    const config = value.config && typeof value.config === 'object' && !Array.isArray(value.config)
      ? value.config as Record<string, unknown> : {};
    const legacy = input.v === 1;
    if (legacy && ((value.config !== undefined && (value.config === null || typeof value.config !== 'object' || Array.isArray(value.config)))
      || (value.enabled !== undefined && typeof value.enabled !== 'boolean'))) {
      diagnostics.push({ index, reason: 'invalid-source' }); continue;
    }
    const legacySkillsSh = value.adapterId === 'skillsSh' || value.adapterId === 'skills-sh' || value.adapterId === 'skills_sh';
    const shape = legacy ? { id: value.id, title: value.title, format: legacySkillsSh ? 'skills-sh' : value.adapterId,
      kinds: ['skill'], url: config.repositoryUrl ?? config.baseUrl ?? (legacySkillsSh ? 'https://skills.sh' : undefined),
      ...(typeof config.subdirectory === 'string' ? { path: config.subdirectory } : {}),
      ...(typeof config.ref === 'string' ? { ref: config.ref } : {}), enabled: value.enabled !== false, addedAt: 0 }
      : Object.fromEntries(['id', 'title', 'format', 'kinds', 'url', 'path', 'ref', 'enabled', 'token', 'npmRegistryProfileId', 'addedAt']
        .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
    const parsed = createStoredReadSchema(RegistrySourceV1Schema).safeParse(shape);
    if (!parsed.success) { diagnostics.push({ index, reason: 'invalid-source' }); continue; }
    if (seen.has(parsed.data.id)) { diagnostics.push({ index, reason: 'duplicate-id' }); continue; }
    // The released V1 adapter owns arbitrary config. Never certify a transfer
    // that projects away a field (including a second, shadowed URL).
    if (legacy && Object.entries(config).some(([key, value]) => typeof value !== 'string'
      || ![config.repositoryUrl !== undefined ? 'repositoryUrl' : 'baseUrl', 'subdirectory', 'ref'].includes(key))) {
      diagnostics.push({ index, reason: 'unrepresented-config' });
    }
    seen.add(parsed.data.id); sources.push(parsed.data);
  }
  // Stored projection may discard an unusable source, but never its token
  // binding: deletion and promotion consume this same complete inventory.
  const represented = new Set<string>();
  const sourcesById = new Map(sources.map(source => [source.id, source] as const));
  for (const [index, entry] of input.sources.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    const token = value.token;
    if (!token || typeof token !== 'object' || Array.isArray(token) || !('secretRef' in token)) continue;
    const source = typeof value.id === 'string' ? sourcesById.get(value.id) : undefined;
    if (source?.token?.secretRef === token.secretRef) represented.add(`sources[${index}].token.secretRef`);
  }
  if (listSavedSecretReferenceCarrierPathsV1(raw).some(path => !represented.has(path))) {
    throw new Error('Registry token reference inventory is incomplete');
  }
  return { status: diagnostics.length ? 'partial' : 'ready', diagnostics,
    record: { v: 2, sources, disabledSourceIds: Array.isArray(input.disabledSourceIds)
      ? [...new Set(input.disabledSourceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [] } };
}

/** Display-only compatibility projection; not proof that every source was represented. */
export function readRegistrySourcesRecordV1(raw: unknown): RegistrySourcesRecordV1 {
  return readRegistrySourcesInventoryV1(raw).record;
}
// Other built-ins co-land with their format's first consuming unit.
export const BUILT_IN_REGISTRY_SOURCES_V1: readonly RegistrySourceDescriptorV1[] = [{
  id: HAPPIER_PICKS_SOURCE_ID, title: DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE, format: 'happier-catalog', kinds: ['skill', 'mcpServer', 'agent', 'plugin', 'app'],
  url: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, enabled: true, addedAt: 0, origin: { kind: 'built_in' }, removable: false,
}, {
  id: 'builtin:skills-sh', title: 'skills.sh', format: 'skills-sh', kinds: ['skill'], url: 'https://skills.sh', enabled: true,
  addedAt: 0, origin: { kind: 'built_in' }, removable: false,
}, {
  id: 'builtin:mcp-registry', title: 'MCP Registry', format: 'mcp-registry', kinds: ['mcpServer'],
  url: 'https://registry.modelcontextprotocol.io', enabled: true, addedAt: 0, origin: { kind: 'built_in' }, removable: false,
}, {
  id: 'builtin:acp-registry', title: 'ACP Registry', format: 'acp-registry', kinds: ['agent'],
  url: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json', enabled: true,
  addedAt: 0, origin: { kind: 'built_in' }, removable: false,
}, {
  id: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, title: 'Community npm', format: 'happier-npm', kinds: ['plugin', 'agent'],
  url: `${PUBLIC_NPM_REGISTRY_ORIGIN_V1}/-/v1/search`, enabled: true, addedAt: 0, origin: { kind: 'built_in' }, removable: false,
}, {
  id: 'builtin:compose-catalog', title: 'Service templates', format: 'coolify-templates', kinds: ['app'],
  url: 'https://github.com/coollabsio/coolify', enabled: true, addedAt: 0, origin: { kind: 'built_in' }, removable: false,
}];

/** Host-owned additions to catalog data, restricted to existing descriptor fields. */
type RegistryAppTemplateHintsV1 = Pick<DeploymentTemplateV1, 'data' | 'loginFields' | 'firstRunSetup'>;
const BUILT_IN_APP_TEMPLATE_HINTS_V1: Readonly<Record<string, Readonly<Record<string, RegistryAppTemplateHintsV1>>>> = {
  'builtin:compose-catalog': { 'uptime-kuma': { firstRunSetup: true } },
};
export function readBuiltInRegistryAppTemplateHintsV1(source: RegistryRemoteSourceDescriptorV1,
  itemId: string): RegistryAppTemplateHintsV1 | undefined {
  if (source.origin.kind !== 'built_in') return undefined;
  const builtin = BUILT_IN_REGISTRY_SOURCES_V1.find(candidate => candidate.id === source.id && !('packageContent' in candidate)
    && candidate.format === source.format && candidate.url === source.url
    && candidate.path === source.path && candidate.ref === source.ref);
  return builtin && BUILT_IN_APP_TEMPLATE_HINTS_V1[builtin.id]?.[itemId];
}
export function listRegistrySourcesV1(input: Readonly<{ record: RegistrySourcesRecordV1; pluginSources: readonly RegistrySourceDescriptorV1[] }>): readonly RegistrySourceDescriptorV1[] {
  const disabled = new Set(input.record.disabledSourceIds);
  const seen = new Set<string>();
  return [...BUILT_IN_REGISTRY_SOURCES_V1, ...input.pluginSources,
    ...input.record.sources.map(source => ({ ...source, origin: { kind: 'user' as const }, removable: true }))]
    .filter(source => { if (seen.has(source.id)) return false; seen.add(source.id); return true; })
    // Existing plugin-only declarations also provide Agent plugin discovery.
    // This is a source projection, not a rewrite of the person's stored kinds.
    .map(source => !('packageContent' in source)
      && source.kinds.some(kind => kind === 'plugin') && !source.kinds.some(kind => kind === 'agent')
      && REGISTRY_FORMAT_KINDS_V1[source.format].includes('agent')
      ? { ...source, kinds: [...source.kinds, 'agent' as const] } : source)
    .map(source => source.origin.kind === 'user' ? source : { ...source, enabled: !disabled.has(source.id) });
}
export function resolveLegacyRegistrySourceRefV1(sourceId: string): string {
  return sourceId.startsWith('git:') ? sourceId.slice(4) : sourceId;
}
