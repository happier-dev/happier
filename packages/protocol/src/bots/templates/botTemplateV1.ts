import { z } from 'zod/mini';
import { BotTemplateVersionV1Schema } from './templateVersionV1.js';
export { BotTemplateVersionV1Schema, type BotTemplateVersionV1 } from './templateVersionV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ArtifactCreateIdV1Schema } from '../../artifacts/artifactIdV1.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactRevisionV1.js';
import { SessionBotFaceV1Schema, SessionBotFaceV1AuthoringSchema } from '../../sessions/identity/sessionBotFaceV1.js';
import { MachineRecipeReferenceV1Schema } from '../../machines/setup/machineRecipeReferenceV1.js';
import { RegistryItemPointerV1Schema } from '../../registries/registryContentRefV1.js';
import { PromptBundleActionEntryV1Schema, validatePromptBundleBodyV1AgainstSchemaId } from '../../prompts/library/promptBundleSchemas.js';
import { BotTemplateMcpDefinitionV1Schema } from '../../mcp/servers/portableMcpDefinitionV1.js';

export const BOT_TEMPLATE_ARTIFACT_KIND_V1 = 'bot_template.v1' as const;
const text = () => z.string().check(z.minLength(1));
export const BotTemplateSourceSessionRefV1Schema = lazyZodSchema(() => z.strictObject({ serverId: text(), sessionId: text() }));
export const BotTemplateDraftRefV1Schema = lazyZodSchema(() => z.strictObject({ serverId: text(), artifactId: text() }));
export const BotTemplateMemoryRuleV1Schema = lazyZodSchema(() => z.strictObject({ key: text(), text: text(), topic: z.optional(z.string()) }));
export const BotTemplateSkillV1Schema = lazyZodSchema(() => z.strictObject({
  key: text(), title: text(), bundleSchemaId: z.literal('skills.skill_md_v1'), entries: z.array(PromptBundleActionEntryV1Schema),
}).check(z.refine(skill => validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: skill.bundleSchemaId,
  body: { v: 1, entries: skill.entries, createdAtMs: 0, updatedAtMs: 0 } }).ok, 'Invalid portable skill bundle')));
export type BotTemplateSkillV1 = z.infer<typeof BotTemplateSkillV1Schema>;

const needFields = () => ({ key: text(), name: text(), requirement: z.enum(['required', 'optional']),
  purpose: z.string(), skipConsequence: z.string() });
export const BotTemplateSoftwareNeedV1Schema = lazyZodSchema(() => z.strictObject({ ...needFields(), recipe: MachineRecipeReferenceV1Schema }));
export const BotTemplateAccountNeedV1Schema = lazyZodSchema(() => z.strictObject({ ...needFields(), serviceId: text() }));
export const BotTemplateMcpNeedV1Schema = lazyZodSchema(() => z.strictObject({ ...needFields(), definition: BotTemplateMcpDefinitionV1Schema }));
export type BotTemplateSoftwareNeedV1 = z.infer<typeof BotTemplateSoftwareNeedV1Schema>;
export type BotTemplateAccountNeedV1 = z.infer<typeof BotTemplateAccountNeedV1Schema>;
export type BotTemplateMcpNeedV1 = z.infer<typeof BotTemplateMcpNeedV1Schema>;

const identity = lazyZodSchema(() => z.strictObject({ name: text(), description: z.string(),
  face: z.optional(SessionBotFaceV1Schema), madeFromName: z.optional(z.string()) }));
const uniqueKeys = (items: readonly { key: string }[]) => new Set(items.map(item => item.key)).size === items.length;
export const BotTemplateContentV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), identity, instructions: z.strictObject({ markdown: z.string() }),
  memoryRules: z.array(BotTemplateMemoryRuleV1Schema), skills: z.array(BotTemplateSkillV1Schema),
  needs: z.strictObject({ software: z.array(BotTemplateSoftwareNeedV1Schema),
    connectedAccounts: z.array(BotTemplateAccountNeedV1Schema), mcpServers: z.array(BotTemplateMcpNeedV1Schema) }),
  suggestedAgent: z.optional(z.strictObject({ agentId: text(), modelId: z.optional(text()) })), firstTask: z.optional(z.string()),
}).check(z.refine(value => [value.memoryRules, value.skills, value.needs.software,
  value.needs.connectedAccounts, value.needs.mcpServers].every(uniqueKeys), 'Template item keys must be unique within their section')));
export type BotTemplateContentV1 = z.infer<typeof BotTemplateContentV1Schema>;
/** Admission for draft/release authors; Artifact and preview reads remain structural. */
export const BotTemplateContentV1AuthoringSchema = lazyZodSchema(() => z.safeExtend(BotTemplateContentV1Schema, {
  identity: z.safeExtend(identity, { face: z.optional(SessionBotFaceV1AuthoringSchema) }),
}));

export const BotTemplateCandidatesV1Schema = lazyZodSchema(() => z.strictObject({
  memoryRules: z.array(z.strictObject({ ...BotTemplateMemoryRuleV1Schema.shape,
    selected: z._default(z.boolean(), false), personal: z._default(z.boolean(), false), sourceRef: z.optional(text()) })),
  skills: z.array(z.strictObject({ ...BotTemplateSkillV1Schema.shape,
    selection: z.enum(['private', 'as_is', 'general_copy']),
    generalCopy: z.optional(z.strictObject({ title: text(), entries: z.array(PromptBundleActionEntryV1Schema) })),
  }).check(z.refine(value => validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: value.bundleSchemaId,
    body: { v: 1, entries: value.selection === 'general_copy' ? value.generalCopy?.entries ?? [] : value.entries,
      createdAtMs: 0, updatedAtMs: 0 } }).ok, 'A selected skill needs valid reviewed content'))),
}).check(z.refine(value => uniqueKeys(value.memoryRules) && uniqueKeys(value.skills), 'Candidate keys must be unique')));
export const BotTemplateDraftV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1), state: z.literal('draft'),
  sourceSessionRef: BotTemplateSourceSessionRefV1Schema, releaseArtifactId: ArtifactCreateIdV1Schema,
  content: BotTemplateContentV1Schema, candidates: BotTemplateCandidatesV1Schema }));
export type BotTemplateDraftV1 = z.infer<typeof BotTemplateDraftV1Schema>;
export const BotTemplateReleaseV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1), version: BotTemplateVersionV1Schema,
  releasedAtMs: z.number().check(z.int(), z.nonnegative()), changelog: z.string(), content: BotTemplateContentV1Schema }));
export type BotTemplateReleaseV1 = z.infer<typeof BotTemplateReleaseV1Schema>;
export const BotTemplateReleaseV1AuthoringSchema = lazyZodSchema(() => z.safeExtend(BotTemplateReleaseV1Schema, {
  content: BotTemplateContentV1AuthoringSchema,
}));
export const BotTemplateReleasedArtifactV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1), state: z.literal('released'), release: BotTemplateReleaseV1Schema }));
export const BotTemplateArtifactV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [BotTemplateDraftV1Schema, BotTemplateReleasedArtifactV1Schema]));
export type BotTemplateArtifactV1 = z.infer<typeof BotTemplateArtifactV1Schema>;
const artifactHeaderFields = () => ({ v: z.literal(1), kind: z.literal(BOT_TEMPLATE_ARTIFACT_KIND_V1),
  title: text(), description: z.string(), face: z.optional(SessionBotFaceV1Schema),
  // The ordinary Artifact writer owns this body-derived projection.
  excerpt: z.optional(z.string()) });
export const BotTemplateArtifactHeaderV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.strictObject({ ...artifactHeaderFields(), state: z.literal('draft') }),
  z.strictObject({ ...artifactHeaderFields(), state: z.literal('released'), version: BotTemplateVersionV1Schema, changelog: z.string() }),
]));
export type BotTemplateArtifactHeaderV1 = z.infer<typeof BotTemplateArtifactHeaderV1Schema>;

export const BotTemplateReleaseSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('artifact'), serverId: text(), artifactId: text() }),
  z.strictObject({ kind: z.literal('plugin'), registryItem: RegistryItemPointerV1Schema, contributionId: text() }),
]));
export type BotTemplateReleaseSourceV1 = z.infer<typeof BotTemplateReleaseSourceV1Schema>;
export const BotTemplateArtifactPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  ownerDisplayName: z.optional(z.nullable(z.string())), shared: z.optional(z.boolean()),
}));
export type BotTemplateArtifactPresentationV1 = z.infer<typeof BotTemplateArtifactPresentationV1Schema>;
/** Source-transport provenance; portable template content cannot establish its author. */
export const BotTemplateRequesterAuthorshipV1Schema = z.enum(['requester', 'other']);
export type BotTemplateRequesterAuthorshipV1 = z.infer<typeof BotTemplateRequesterAuthorshipV1Schema>;
export const BotTemplatePreviewResultV1Schema = lazyZodSchema(() => z.strictObject({ source: BotTemplateReleaseSourceV1Schema,
  release: BotTemplateReleaseV1Schema, revision: z.optional(ArtifactRevisionV1Schema),
  requesterAuthorship: z.optional(BotTemplateRequesterAuthorshipV1Schema),
  presentation: z.optional(BotTemplateArtifactPresentationV1Schema) }));
export type BotTemplatePreviewResultV1 = z.infer<typeof BotTemplatePreviewResultV1Schema>;
export type ResolvedBotTemplateReleaseV1 = Readonly<{ release: BotTemplateReleaseV1; source: BotTemplateReleaseSourceV1;
  requesterAuthorship?: BotTemplateRequesterAuthorshipV1 }>;

/** Private candidates can replace, omit or generalize copied items. Only portable fields leave this owner. */
export function projectBotTemplateContentV1(draft: BotTemplateDraftV1): BotTemplateContentV1 {
  const memory = new Map(draft.content.memoryRules.map(item => [item.key, item]));
  for (const candidate of draft.candidates.memoryRules) {
    if (!candidate.selected) { memory.delete(candidate.key); continue; }
    memory.set(candidate.key, { key: candidate.key, text: candidate.text, ...(candidate.topic === undefined ? {} : { topic: candidate.topic }) });
  }
  const skills = new Map(draft.content.skills.map(item => [item.key, item]));
  for (const candidate of draft.candidates.skills) {
    if (candidate.selection === 'private') { skills.delete(candidate.key); continue; }
    const selected = candidate.selection === 'general_copy' ? candidate.generalCopy! : candidate;
    skills.set(candidate.key, { key: candidate.key, title: selected.title,
      bundleSchemaId: candidate.bundleSchemaId, entries: selected.entries });
  }
  return { ...draft.content, memoryRules: [...memory.values()], skills: [...skills.values()] };
}

export function projectBotTemplateReleaseV1(draft: BotTemplateDraftV1,
  metadata: Omit<BotTemplateReleaseV1, 'v' | 'content'>): BotTemplateReleaseV1 {
  return { v: 1, ...metadata, content: BotTemplateContentV1AuthoringSchema.parse(projectBotTemplateContentV1(draft)) };
}

export function projectBotTemplateArtifactHeaderV1(artifact: BotTemplateArtifactV1): BotTemplateArtifactHeaderV1 {
  const content = artifact.state === 'draft' ? artifact.content : artifact.release.content;
  const shared = { v: 1 as const, kind: BOT_TEMPLATE_ARTIFACT_KIND_V1, title: content.identity.name,
    description: content.identity.description, ...(content.identity.face ? { face: content.identity.face } : {}) };
  return artifact.state === 'draft' ? { ...shared, state: 'draft' } : { ...shared, state: 'released',
    version: artifact.release.version, changelog: artifact.release.changelog };
}

/** Input was already authorized and opened by the mode-aware Artifact reader. */
export function readBotTemplateArtifactV1(resource: Readonly<{ header: unknown; body?: unknown }>): BotTemplateArtifactV1 | null {
  if (resource.header && typeof resource.header === 'object'
      && Reflect.get(resource.header, 'kind') === BOT_TEMPLATE_ARTIFACT_KIND_V1) assertSupportedVersion(resource.header);
  const header = BotTemplateArtifactHeaderV1Schema.safeParse(resource.header);
  if (!header.success || typeof resource.body !== 'string') return null;
  let body: unknown;
  try { body = JSON.parse(resource.body); } catch { return null; }
  assertSupportedContentVersion(body);
  if (body && typeof body === 'object') assertSupportedContentVersion(Reflect.get(body, 'release'));
  const parsed = BotTemplateArtifactV1Schema.safeParse(body);
  return parsed.success && parsed.data.state === header.data.state ? parsed.data : null;
}

function assertSupportedVersion(value: unknown): void {
  if (value && typeof value === 'object' && 'v' in value && value.v !== 1)
    throw Object.assign(new Error('update_required'), { code: 'update_required' });
}
function assertSupportedContentVersion(value: unknown): void {
  assertSupportedVersion(value);
  if (value && typeof value === 'object') assertSupportedVersion(Reflect.get(value, 'content'));
}

export function readBotTemplateReleaseV1(value: unknown): BotTemplateReleaseV1;
export function readBotTemplateReleaseV1(value: unknown, source: BotTemplateReleaseSourceV1): ResolvedBotTemplateReleaseV1;
/** Transport supplies provenance separately; portable authored bytes never attest their own source. */
export function readBotTemplateReleaseV1(value: unknown, source?: BotTemplateReleaseSourceV1): BotTemplateReleaseV1 | ResolvedBotTemplateReleaseV1 {
  assertSupportedContentVersion(value);
  const parsed = BotTemplateReleaseV1Schema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  return source ? { release: parsed.data, source } : parsed.data;
}

export { BotTemplateInstanceV1Schema, readBotTemplateInstanceV1, type BotTemplateInstanceV1 } from './templateInstanceV1.js';
