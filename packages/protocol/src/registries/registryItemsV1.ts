import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { DeploymentTemplateV1Schema } from '../plugins/contributions/deploymentTemplates.js';
import { RegistrySkillContentRefV1Schema, RegistryContentRefV1Schema, RegistryRemoteContentRefV1Schema, RegistryPackageContentRefV1Schema } from './registryContentRefV1.js';
export { RegistryGitTreeRefV1Schema, WellKnownSkillRefV1Schema, RegistrySkillContentRefV1Schema,
  RegistryContentRefV1Schema, RegistryItemPointerV1Schema } from './registryContentRefV1.js';
export type { WellKnownSkillRefV1, RegistrySkillContentRefV1, RegistryContentRefV1, RegistryItemPointerV1 } from './registryContentRefV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RegistryFormatV1Schema, RegistryKindV1Schema } from './registrySourcesV1.js';
import { MarketplaceIndexEntryV1Schema, MarketplaceIndexSourceSnapshotV1Schema } from '../marketplace/marketplaceIndexV1.js';
import { PinnedArchivePlatformSchema } from '../installables/sourceKind.js';









export const RegistryProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
  sourceId: z.string().check(z.minLength(1)), format: RegistryFormatV1Schema, sourceUrl: z.string().check(z.minLength(1)),
  itemId: z.string(), ref: RegistryContentRefV1Schema, importedAt: z.number().check(z.int(), z.nonnegative()),
}));
export type RegistryProvenanceV1 = z.infer<typeof RegistryProvenanceV1Schema>;



export const RegistryItemProblemV1Schema = lazyZodSchema(() => z.discriminatedUnion('code', [
  z.strictObject({ code: z.literal('too_large'), limit: z.enum(['files', 'bytes']) }),
  z.strictObject({ code: z.literal('unsupported_entry'), reason: z.enum(['symlink', 'submodule', 'distribution', 'package_type']) }),
  z.strictObject({ code: z.literal('removed_from_source') }),
  z.strictObject({ code: z.literal('needs_review'), diagnostics: z.array(RegistryAppFieldDiagnosticV1Schema).check(z.minLength(1)) }),
]));
export type RegistryItemProblemV1 = z.infer<typeof RegistryItemProblemV1Schema>;
/** Selected distribution only; list fit needs targets/extraction support, never executable operands. */
export const RegistryAgentDistributionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('npm') }),
  z.strictObject({ kind: z.literal('uv') }),
  z.strictObject({ kind: z.literal('archive'), platforms: z.partialRecord(PinnedArchivePlatformSchema,
    z.enum(['supported', 'archive_type_unsupported'])) }),
]));
export type RegistryAgentDistributionV1 = z.infer<typeof RegistryAgentDistributionV1Schema>;
export const RegistryItemSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  sourceId: z.string().check(z.minLength(1)), kind: RegistryKindV1Schema, itemId: z.string(), title: z.string().check(z.minLength(1)),
  description: z.optional(z.string()), version: z.optional(z.string().check(z.minLength(1))), iconUrl: z.optional(z.string()),
  publisher: z.optional(z.strictObject({ name: z.string().check(z.minLength(1)), verification: z.optional(z.enum(['github-account', 'domain', 'registry-checked', 'happier-reviewed'])) })),
  updatedAt: z.optional(z.number()), installs: z.optional(z.number().check(z.nonnegative())), license: z.optional(z.string()),
  links: z.optional(z.strictObject({ repository: z.optional(z.string()), website: z.optional(z.string()) })),
  flags: z.optional(z.strictObject({ deprecated: z.optional(z.literal(true)), pick: z.optional(z.literal(true)) })),
  problem: z.optional(RegistryItemProblemV1Schema),
  appMetadata: z.optional(z.strictObject({ category: z.optional(z.string()), tags: z.optional(z.array(z.string())),
    upstreamIcon: z.optional(z.string()), upstreamMinimumVersion: z.optional(z.string()),
    containerPort: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65535))),
    architectures: z.optional(z.array(z.enum(['amd64', 'arm64']))) })),
  agentDistribution: z.optional(RegistryAgentDistributionV1Schema),
}));
export type RegistryItemSummaryV1 = z.infer<typeof RegistryItemSummaryV1Schema>;
export const RegistrySkillSourceV1Schema = lazyZodSchema(() => z.strictObject({
  ref: RegistrySkillContentRefV1Schema, skillMarkdown: z.string(), files: z.array(z.strictObject({
    path: z.string().check(z.minLength(1)), size: z.number().check(z.int(), z.nonnegative()), unixMode: z.union([z.literal(0o644), z.literal(0o755)]), blobSha: z.string().check(z.minLength(1)),
  })), notImported: z.optional(z.strictObject({ hooks: z.number().check(z.int(), z.nonnegative()), commands: z.number().check(z.int(), z.nonnegative()),
    mcpServers: z.number().check(z.int(), z.nonnegative()), agents: z.number().check(z.int(), z.nonnegative()) })),
}));
export type RegistrySkillSourceV1 = z.infer<typeof RegistrySkillSourceV1Schema>;
const McpRegistryVariableV1Schema = lazyZodSchema(() => z.strictObject({
  description: z.optional(z.string()), required: z.boolean(), secret: z.boolean(),
  default: z.optional(z.string()), value: z.optional(z.string()), choices: z.optional(z.array(z.string())),
}));
export const McpRegistryInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpRegistryVariableV1Schema, {
  name: z.string().check(z.minLength(1)), target: z.enum(['env', 'header', 'url-variable']),
  variables: z.optional(z.record(z.string(), McpRegistryVariableV1Schema)),
})));
export type McpRegistryInputV1 = z.infer<typeof McpRegistryInputV1Schema>;
export const McpRegistryArgumentV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpRegistryVariableV1Schema, {
  type: z.enum(['named', 'positional']), name: z.optional(z.string()), valueHint: z.optional(z.string()),
  variables: z.optional(z.record(z.string(), McpRegistryVariableV1Schema)),
})));
export type McpRegistryArgumentV1 = z.infer<typeof McpRegistryArgumentV1Schema>;
export const McpRegistryServerV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string().check(z.minLength(1)), title: z.optional(z.string()), description: z.string(), version: z.string().check(z.minLength(1)),
  status: z.enum(['active', 'deprecated']), publishedAt: z.optional(z.number()), repository: z.optional(z.string()),
  websiteUrl: z.optional(z.string()), iconUrl: z.optional(z.string()),
  remotes: z.array(z.strictObject({ transport: z.enum(['streamable-http', 'sse']), url: z.string(), inputs: z.array(McpRegistryInputV1Schema) })),
  packages: z.array(z.strictObject({ ecosystem: z.enum(['npm', 'pypi', 'oci', 'mcpb', 'nuget', 'cargo']),
    identifier: z.string().check(z.minLength(1)), version: z.string(), transport: z.enum(['stdio', 'streamable-http', 'sse']),
    fileSha256: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))), runtimeArguments: z.array(McpRegistryArgumentV1Schema),
    packageArguments: z.array(McpRegistryArgumentV1Schema), environment: z.array(McpRegistryInputV1Schema),
  })),
}));
export type McpRegistryServerV1 = z.infer<typeof McpRegistryServerV1Schema>;
const AcpRegistryPackageV1Schema = lazyZodSchema(() => z.strictObject({
  package: z.string().check(z.minLength(1)), version: z.string().check(z.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)),
  args: z.array(z.string()), env: z.record(z.string(), z.string()),
}));
export const AcpRegistryAgentV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.regex(/^[a-z][a-z0-9-]*$/)), name: z.string().check(z.minLength(1)), version: z.string().check(z.minLength(1)), description: z.string().check(z.minLength(1)),
  authors: z.optional(z.array(z.string())), license: z.optional(z.string()), licenseUrl: z.optional(z.string()),
  repository: z.optional(z.string()), website: z.optional(z.string()), iconUrl: z.optional(z.string()),
  distributions: z.strictObject({
    binary: z.optional(z.partialRecord(PinnedArchivePlatformSchema, z.strictObject({
      archiveUrl: z.string().check(z.url(), z.refine(url => url.startsWith('https://'))), command: z.string().check(z.minLength(1)),
      args: z.array(z.string()), env: z.record(z.string(), z.string()), sha256: z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
    }))), npm: z.optional(AcpRegistryPackageV1Schema), uv: z.optional(AcpRegistryPackageV1Schema),
  }),
}));
export type AcpRegistryAgentV1 = z.infer<typeof AcpRegistryAgentV1Schema>;
export const RegistryItemPayloadV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.discriminatedUnion('state', [
    z.strictObject({ kind: z.literal('app'), state: z.literal('ready'), app: DeploymentTemplateV1Schema, ref: RegistryContentRefV1Schema }),
    z.strictObject({ kind: z.literal('app'), state: z.literal('needs_review'), ref: RegistryContentRefV1Schema,
      diagnostics: z.array(RegistryAppFieldDiagnosticV1Schema).check(z.minLength(1)) }),
  ]),
  z.strictObject({ kind: z.literal('skill'), skill: RegistrySkillSourceV1Schema }),
  z.strictObject({ kind: z.literal('mcpServer'), server: McpRegistryServerV1Schema }),
  z.strictObject({ kind: z.literal('agent'), agent: AcpRegistryAgentV1Schema }),
  z.strictObject({ kind: z.literal('plugin'), listing: MarketplaceIndexEntryV1Schema,
    source: MarketplaceIndexSourceSnapshotV1Schema.shape.source }),
]));
export type RegistryItemPayloadV1 = z.infer<typeof RegistryItemPayloadV1Schema>;
export const RegistryItemV1Schema = lazyZodSchema(() => z.strictObject({
  summary: RegistryItemSummaryV1Schema, payload: RegistryItemPayloadV1Schema,
  fetchedAt: z.number().check(z.int(), z.nonnegative()),
}).check(z.superRefine((item, ctx) => {
  const version = item.payload.kind === 'skill' ? item.payload.skill.ref.kind === 'gitTree' ? item.payload.skill.ref.commit : item.payload.skill.ref.digest
    : item.payload.kind === 'app' ? item.payload.ref.kind === 'gitTree' ? item.payload.ref.commit
      : item.payload.ref.kind === 'version' ? item.payload.ref.version
      : item.payload.ref.kind === 'packageContent' ? item.payload.ref.pluginVersion : item.payload.ref.digest
    : item.payload.kind === 'agent' ? item.payload.agent.version
      : item.payload.kind === 'mcpServer' ? item.payload.server.version : item.payload.listing.distribution.version;
  if (item.summary.kind !== item.payload.kind || item.summary.version !== version
    || item.payload.kind === 'app' && (item.payload.state === 'needs_review'
      ? item.summary.problem?.code !== 'needs_review' || !sameStrictJsonValue(item.summary.problem.diagnostics, item.payload.diagnostics)
      : item.summary.problem !== undefined)
    || item.payload.kind === 'agent' && item.summary.itemId !== item.payload.agent.id
    || item.payload.kind === 'mcpServer' && item.summary.itemId !== item.payload.server.name
    || item.payload.kind === 'plugin' && (item.summary.sourceId !== item.payload.source.id
      || item.summary.itemId !== (item.payload.source.kind === 'community-npm' ? item.payload.listing.distribution.packageName : item.payload.listing.pluginId))) {
    ctx.addIssue({ code: 'custom', path: ['summary'], message: 'Read summary must identify the pinned payload' });
  }
})));
export type RegistryItemV1 = z.infer<typeof RegistryItemV1Schema>;
export type RegistrySkillItemV1 = RegistryItemV1 & Readonly<{ payload: Extract<RegistryItemPayloadV1, { kind: 'skill' }> }>;





export const RegistryAppFieldDiagnosticV1Schema = lazyZodSchema(() => z.strictObject({
  field: z.string().check(z.minLength(1)), reason: z.string().check(z.minLength(1)),
}));
