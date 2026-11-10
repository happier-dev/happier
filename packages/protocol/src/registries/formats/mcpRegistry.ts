import { z } from '../../zodRuntimePolicy.js';
import { McpRegistryServerV1Schema, RegistryItemV1Schema, type McpRegistryInputV1, type RegistryItemSummaryV1 } from '../registryItemsV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import type { RegistryFetchContextV1, RegistryFormatAdapterV1 } from './registryFormatAdapterV1.js';

// v0.1 API and published 2025-12-11 server schema, captured 2026-10-13.
const input = z.object({ description: z.optional(z.string()), isRequired: z._default(z.boolean(), false),
  isSecret: z._default(z.boolean(), false), default: z.optional(z.string()), value: z.optional(z.string()), choices: z.optional(z.nullable(z.array(z.string()))) });
const keyInput = z.extend(input, { name: z.string().check(z.minLength(1)), variables: z.optional(z.record(z.string(), input)) });
const argument = z.extend(input, { type: z.enum(['named', 'positional']), name: z.optional(z.string()),
  valueHint: z.optional(z.string()), variables: z.optional(z.record(z.string(), input)) });
const remote = z.object({ type: z.enum(['streamable-http', 'sse']), url: z.string(), headers: z.optional(z.nullable(z.array(keyInput))), variables: z.optional(z.record(z.string(), input)) });
const wireServer = z.object({ name: z.string().check(z.minLength(1)), description: z.string(), version: z.string().check(z.minLength(1)), title: z.optional(z.string()),
  repository: z.optional(z.object({ url: z.optional(z.string()) })), websiteUrl: z.optional(z.string()), icons: z.optional(z.nullable(z.array(z.object({ src: z.string(), theme: z.optional(z.enum(['light', 'dark'])) })))),
  remotes: z.optional(z.nullable(z.array(remote))), packages: z.optional(z.nullable(z.array(z.object({ registryType: z.string(), identifier: z.string().check(z.minLength(1)),
    version: z.optional(z.string()), transport: z.object({ type: z.enum(['stdio', 'streamable-http', 'sse']) }), fileSha256: z.optional(z.string()),
    runtimeArguments: z.optional(z.nullable(z.array(argument))), packageArguments: z.optional(z.nullable(z.array(argument))),
    environmentVariables: z.optional(z.nullable(z.array(keyInput))),
  })))),
});
const official = z.object({ status: z.enum(['active', 'deprecated', 'deleted']), publishedAt: z.optional(z.string()), updatedAt: z.optional(z.string()), isLatest: z.optional(z.boolean()) });
const record = z.object({ server: wireServer, _meta: z.optional(z.object({ 'io.modelcontextprotocol.registry/official': z.optional(official) })) });
const page = z.object({ servers: z.array(record), metadata: z.object({ count: z.number().check(z.int(), z.nonnegative()), nextCursor: z.optional(z.string()) }) });
function endpoint(sourceUrl: string) {
  const url = new URL(sourceUrl); url.search = ''; url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v0\.1(?:\/servers)?$/, '') + '/v0.1/servers'; return url;
}
function variable(value: z.infer<typeof input>) {
  return { required: value.isRequired, secret: value.isSecret,
    ...(value.description === undefined ? {} : { description: value.description }), ...(value.default === undefined ? {} : { default: value.default }),
    ...(value.value === undefined ? {} : { value: value.value }), ...(value.choices ? { choices: value.choices } : {}) };
}
function variables(value: Record<string, z.infer<typeof input>> | undefined) {
  return value ? { variables: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, variable(item)])) } : {};
}
function inputs(items: readonly z.infer<typeof keyInput>[], target: 'env' | 'header'): McpRegistryInputV1[] {
  return items.map(item => ({ ...variable(item), ...variables(item.variables), name: item.name, target }));
}
function normalize(item: z.infer<typeof record>) {
  const server = item.server;
  const meta = item._meta?.['io.modelcontextprotocol.registry/official'];
  const defaultIcon = server.icons?.find(icon => icon.theme === undefined)?.src;
  const lightIcon = server.icons?.find(icon => icon.theme === 'light')?.src;
  const iconUrl = lightIcon ?? defaultIcon;
  const iconDarkUrl = server.icons?.find(icon => icon.theme === 'dark')?.src ?? (lightIcon ? defaultIcon : undefined);
  return McpRegistryServerV1Schema.parse({ name: server.name, description: server.description, version: server.version,
    ...(server.title ? { title: server.title } : {}), status: meta?.status === 'deprecated' ? 'deprecated' : 'active',
    ...(meta?.publishedAt && Number.isFinite(Date.parse(meta.publishedAt)) ? { publishedAt: Date.parse(meta.publishedAt) } : {}),
    ...(server.repository?.url ? { repository: server.repository.url } : {}), ...(server.websiteUrl ? { websiteUrl: server.websiteUrl } : {}),
    ...(iconUrl ? { iconUrl } : {}), ...(iconDarkUrl ? { iconDarkUrl } : {}),
    remotes: (server.remotes ?? []).map(remote => ({ transport: remote.type, url: remote.url,
      inputs: [...inputs(remote.headers ?? [], 'header'), ...Object.entries(remote.variables ?? {}).map(([name, item]) => ({ ...variable(item), name, target: 'url-variable' as const }))] })),
    packages: (server.packages ?? []).flatMap(pkg => ['npm', 'pypi', 'oci', 'mcpb', 'nuget', 'cargo'].includes(pkg.registryType) ? [{
      ecosystem: pkg.registryType, identifier: pkg.identifier, version: pkg.version ?? '', transport: pkg.transport.type, ...(pkg.fileSha256 ? { fileSha256: pkg.fileSha256 } : {}),
      runtimeArguments: (pkg.runtimeArguments ?? []).map(arg => ({ ...variable(arg), ...variables(arg.variables), type: arg.type,
        ...(arg.name ? { name: arg.name } : {}), ...(arg.valueHint ? { valueHint: arg.valueHint } : {}) })),
      packageArguments: (pkg.packageArguments ?? []).map(arg => ({ ...variable(arg), ...variables(arg.variables), type: arg.type,
        ...(arg.name ? { name: arg.name } : {}), ...(arg.valueHint ? { valueHint: arg.valueHint } : {}) })), environment: inputs(pkg.environmentVariables ?? [], 'env'),
    }] : []),
  });
}
/** Standalone server.json import uses the same wire decoder as registry reads. */
export function readMcpRegistryServerV1(raw: unknown) { return normalize(record.parse({ server: raw })); }
function summary(source: RegistrySourceV1, item: z.infer<typeof record>, server = normalize(item)): RegistryItemSummaryV1 {
  const meta = item._meta?.['io.modelcontextprotocol.registry/official'];
  return { sourceId: source.id, kind: 'mcpServer', itemId: server.name, title: server.title ?? server.name, description: server.description, version: server.version,
    ...(server.iconUrl ? { iconUrl: server.iconUrl } : {}), ...(server.iconDarkUrl ? { iconDarkUrl: server.iconDarkUrl } : {}), publisher: { name: server.name.split('/')[0]!,
      ...(new URL(source.url).origin === 'https://registry.modelcontextprotocol.io' && meta ? { verification: 'registry-checked' as const } : {}) },
    ...(server.repository || server.websiteUrl ? { links: { ...(server.repository ? { repository: server.repository } : {}), ...(server.websiteUrl ? { website: server.websiteUrl } : {}) } } : {}),
    ...(meta?.updatedAt && Number.isFinite(Date.parse(meta.updatedAt)) ? { updatedAt: Date.parse(meta.updatedAt) } : {}), ...(server.status === 'deprecated' ? { flags: { deprecated: true } } : {}),
    ...(meta?.status === 'deleted' ? { problem: { code: 'removed_from_source' as const } }
      : server.remotes.length === 0 && !server.packages.some(pkg => ['npm', 'pypi', 'oci'].includes(pkg.ecosystem) && pkg.transport === 'stdio')
      ? { problem: { code: 'unsupported_entry' as const, reason: 'package_type' as const } } : {}),
  };
}
async function json(ctx: RegistryFetchContextV1, source: RegistrySourceV1, url: URL) {
  ctx.signal?.throwIfAborted(); const response = await ctx.http.getJson(url.href, { source }); ctx.signal?.throwIfAborted();
  if (!response.ok) throw new RegistryFetchErrorV1(response.status); return response;
}
export const mcpRegistryAdapterV1: RegistryFormatAdapterV1 = {
  format: 'mcp-registry', kinds: ['mcpServer'], browserFetchable: () => true, supportsQuery: true,
  async detect(ctx, url) {
    const target = endpoint(url); target.searchParams.set('limit', '1'); const response = await ctx.http.getJson(target.href);
    if (!response.ok) return response.status.state === 'auth_failed' ? { unsupported: 'needs_token' } : null;
    return page.safeParse(response.value).success ? { format: 'mcp-registry', kinds: ['mcpServer'], title: new URL(url).hostname } : null;
  },
  async list(ctx, req) {
    try {
      const url = endpoint(req.source.url); url.searchParams.set('limit', '100'); url.searchParams.set('version', 'latest');
      if (req.query) url.searchParams.set('search', req.query); if (req.cursor) url.searchParams.set('cursor', req.cursor);
      const response = await json(ctx, req.source, url); const parsed = page.safeParse(response.value);
      if (!parsed.success) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      return { sourceId: req.source.id, status: { state: 'ok', fetchedAt: response.fetchedAt }, items: parsed.data.servers.map(item => summary(req.source, item)), nextCursor: parsed.data.metadata.nextCursor ?? null };
    } catch (error) { if (!(error instanceof RegistryFetchErrorV1)) throw error;
      return { sourceId: req.source.id, status: error.status, items: [], nextCursor: null }; }
  },
  async read(ctx, req) {
    const url = endpoint(req.source.url); url.pathname += `/${encodeURIComponent(req.itemId)}/versions/${encodeURIComponent(req.version ?? 'latest')}`;
    const response = await json(ctx, req.source, url); const parsed = record.safeParse(response.value);
    if (!parsed.success || parsed.data._meta?.['io.modelcontextprotocol.registry/official']?.status === 'deleted'
      || parsed.data.server.name !== req.itemId || req.version && parsed.data.server.version !== req.version) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const server = normalize(parsed.data);
    return RegistryItemV1Schema.parse({ summary: summary(req.source, parsed.data, server), payload: { kind: 'mcpServer', server }, fetchedAt: response.fetchedAt });
  },
  async latest(ctx, items, options) {
    const result = new Map<string, import('../registryItemsV1.js').RegistryContentRefV1 | 'removed'>();
    for (const item of items) {
      const source: RegistrySourceV1 = options?.source ?? { id: item.sourceId, title: item.sourceUrl, format: 'mcp-registry', kinds: ['mcpServer'], url: item.sourceUrl, enabled: true, addedAt: 0 };
      let cursor: string | null = null; let found = false;
      do {
        const listed = await mcpRegistryAdapterV1.list(ctx, { source, kind: 'mcpServer', query: item.itemId, cursor });
        if (listed.status.state !== 'ok') throw new RegistryFetchErrorV1(listed.status);
        const match = listed.items.find(entry => entry.itemId === item.itemId);
        if (match?.problem?.code === 'removed_from_source') { result.set(item.itemId, 'removed'); found = true; break; }
        if (match?.version) { result.set(item.itemId, { kind: 'version', version: match.version }); found = true; break; } cursor = listed.nextCursor;
      } while (cursor);
      if (!found) result.set(item.itemId, 'removed');
    } return result;
  },
};
