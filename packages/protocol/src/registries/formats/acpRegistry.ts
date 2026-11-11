import { z } from '../../zodRuntimePolicy.js';
import { AcpRegistryAgentV1Schema, RegistryItemV1Schema, type AcpRegistryAgentV1, type RegistryItemSummaryV1 } from '../registryItemsV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import type { RegistryFetchContextV1, RegistryFormatAdapterV1 } from './registryFormatAdapterV1.js';
import { ACP_REGISTRY_PLATFORM_TARGETS_V1 as targets } from '../../acp/catalog/registry/acpPlatformTargetsV1.js';
import { ACP_REGISTRY_ICONS_MONOCHROME_V1 } from '../../acp/catalog/registry/mapAcpRegistryAgentV1.js';
import { summarizeAcpRegistryDistributionV1 } from '../../acp/catalog/registry/acpPlatformFitV1.js';

// ACP Registry envelope 1.0.0 and agent.schema.json, observed from the public CDN on 2026-10-13.
const metadataSchema = z.object({ id: z.string().check(z.regex(/^[a-z][a-z0-9-]*$/)), name: z.string().check(z.minLength(1)),
  version: z.string().check(z.minLength(1)), description: z.string().check(z.minLength(1)), authors: z.optional(z.array(z.string())),
  license: z.optional(z.string()), license_url: z.optional(z.string()), repository: z.optional(z.string()),
  website: z.optional(z.string()), icon: z.optional(z.string()) });
const targetSchema = z.strictObject({ archive: z.string().check(z.url()), cmd: z.string().check(z.minLength(1)), args: z._default(z.array(z.string()), []),
  env: z._default(z.record(z.string(), z.string()), {}), sha256: z.optional(z.string().check(z.regex(/^[a-fA-F0-9]{64}$/))) });
const packageSchema = z.strictObject({ package: z.string().check(z.minLength(1)), args: z._default(z.array(z.string()), []),
  env: z._default(z.record(z.string(), z.string()), {}) });
const distributionSchema = z.strictObject({ binary: z.optional(z.partialRecord(z.enum(Object.keys(targets) as [keyof typeof targets, ...(keyof typeof targets)[]]), targetSchema)),
  npx: z.optional(packageSchema), uvx: z.optional(packageSchema) });
const entrySchema = z.extend(metadataSchema, { distribution: distributionSchema });
const envelopeSchema = z.object({ version: z.string(), agents: z.array(z.unknown()) });

function pinnedPackage(value: z.infer<typeof packageSchema>, ecosystem: 'npm' | 'uv') {
  const match = ecosystem === 'npm'
    ? /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(value.package)
    : /^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:==|@)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(value.package);
  return match ? { package: match[1]!, version: match[2]!, args: value.args, env: value.env } : null;
}
function normalizeAgent(raw: unknown): AcpRegistryAgentV1 | null {
  const parsed = entrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const { distribution, license_url, icon, ...metadata } = parsed.data;
  const npm = distribution.npx ? pinnedPackage(distribution.npx, 'npm') : null;
  const uv = distribution.uvx ? pinnedPackage(distribution.uvx, 'uv') : null;
  if (distribution.npx && !npm || distribution.uvx && !uv) return null;
  const binary = distribution.binary ? Object.fromEntries(Object.entries(distribution.binary).map(([target, asset]) => [targets[target as keyof typeof targets], {
    archiveUrl: asset.archive, command: asset.cmd, args: asset.args, env: asset.env,
    ...(asset.sha256 ? { sha256: asset.sha256.toLowerCase() } : {}),
  }])) : undefined;
  if (!npm && !uv && (!binary || Object.keys(binary).length === 0)) return null;
  const normalized = AcpRegistryAgentV1Schema.safeParse({ ...metadata,
    ...(license_url ? { licenseUrl: license_url } : {}), ...(icon ? { iconUrl: icon } : {}),
    distributions: { ...(binary ? { binary } : {}), ...(npm ? { npm } : {}), ...(uv ? { uv } : {}) } });
  return normalized.success ? normalized.data : null;
}
async function readIndex(ctx: RegistryFetchContextV1, source: RegistrySourceV1) {
  ctx.signal?.throwIfAborted();
  const response = await ctx.http.getJson(source.url, { source });
  ctx.signal?.throwIfAborted();
  if (!response.ok) throw new RegistryFetchErrorV1(response.status);
  const envelope = envelopeSchema.safeParse(response.value);
  if (!envelope.success) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  if (!/^1\.\d+\.\d+$/.test(envelope.data.version)) throw new RegistryFetchErrorV1({ state: 'newer_format', found: envelope.data.version });
  const declaredIds = new Set(envelope.data.agents.flatMap(raw => raw && typeof raw === 'object'
    && 'id' in raw && typeof raw.id === 'string' ? [raw.id] : []));
  return { declaredIds, entries: envelope.data.agents.flatMap(raw => {
    const metadata = metadataSchema.safeParse(raw);
    return metadata.success ? [{ metadata: metadata.data, agent: normalizeAgent(raw) }] : [];
  }), fetchedAt: response.fetchedAt };
}
function summary(source: RegistrySourceV1, entry: Awaited<ReturnType<typeof readIndex>>['entries'][number]): RegistryItemSummaryV1 {
  const { metadata, agent } = entry;
  return { sourceId: source.id, kind: 'agent', itemId: metadata.id, title: metadata.name, description: metadata.description,
    version: metadata.version, ...(metadata.icon ? { iconUrl: metadata.icon, iconMonochrome: ACP_REGISTRY_ICONS_MONOCHROME_V1 } : {}),
    ...(agent ? { agentDistribution: summarizeAcpRegistryDistributionV1(agent.distributions) } : {}),
    ...(metadata.authors?.length ? { publisher: { name: metadata.authors.join(', ') } } : {}),
    ...(metadata.license ? { license: metadata.license } : {}),
    ...(metadata.repository || metadata.website ? { links: { ...(metadata.repository ? { repository: metadata.repository } : {}), ...(metadata.website ? { website: metadata.website } : {}) } } : {}),
    ...(!agent ? { problem: { code: 'unsupported_entry', reason: 'distribution' } as const } : {}) };
}
export const acpRegistryAdapterV1: RegistryFormatAdapterV1 = {
  format: 'acp-registry', kinds: ['agent'], browserFetchable: () => true, supportsQuery: true,
  async detect(ctx, url) {
    const response = await ctx.http.getJson(url);
    if (!response.ok) return null;
    const envelope = envelopeSchema.safeParse(response.value);
    return envelope.success ? { format: 'acp-registry', kinds: ['agent'], title: new URL(url).hostname, itemCount: envelope.data.agents.length } : null;
  },
  async list(ctx, req) {
    try {
      const index = await readIndex(ctx, req.source);
      const query = req.query?.trim().toLowerCase() ?? '';
      const items = index.entries.map(entry => summary(req.source, entry)).filter(item => !query || `${item.title} ${item.itemId} ${item.description ?? ''}`.toLowerCase().includes(query));
      if (query) items.sort((a, b) => Number(b.title.toLowerCase().startsWith(query) || b.itemId.startsWith(query)) - Number(a.title.toLowerCase().startsWith(query) || a.itemId.startsWith(query)));
      return { sourceId: req.source.id, status: { state: 'ok', fetchedAt: index.fetchedAt }, items, nextCursor: null, total: items.length };
    } catch (error) {
      if (!(error instanceof RegistryFetchErrorV1)) throw error;
      return { sourceId: req.source.id, status: error.status, items: [], nextCursor: null };
    }
  },
  async read(ctx, req) {
    const index = await readIndex(ctx, req.source);
    const entry = index.entries.find(entry => entry.metadata.id === req.itemId);
    // Upstream publishes one current index: an old reviewed version cannot silently become the latest release.
    if (!entry?.agent || req.version && entry.agent.version !== req.version) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    return RegistryItemV1Schema.parse({ summary: summary(req.source, entry), payload: { kind: 'agent', agent: entry.agent }, fetchedAt: index.fetchedAt });
  },
  async latest(ctx, items, options) {
    const result = new Map<string, import('../registryItemsV1.js').RegistryContentRefV1 | 'removed'>();
    for (const url of new Set(items.map(item => item.sourceUrl))) {
      const source: RegistrySourceV1 = options?.source ?? { id: items.find(item => item.sourceUrl === url)!.sourceId, title: url, format: 'acp-registry', kinds: ['agent'], url, enabled: true, addedAt: 0 };
      const index = await readIndex(ctx, source);
      for (const item of items.filter(item => item.sourceUrl === url)) {
        const entry = index.entries.find(entry => entry.metadata.id === item.itemId);
        if (entry && !entry.agent || !entry && index.declaredIds.has(item.itemId)) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        result.set(item.itemId, entry ? { kind: 'version', version: entry.metadata.version } : 'removed');
      }
    }
    return result;
  },
};
