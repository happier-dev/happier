import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { PromptStackEntryV1Schema } from './promptStacksV1.js';
import { PromptFoldersV1RecordSchema } from './promptFoldersV1.js';
import { PromptInvocationEntryV1Schema } from './promptInvocationsV1.js';
import { PromptExternalLinkEntryV1Schema, PromptExternalLinksV1Schema } from './promptExternalLinksV1.js';
import { RegistrySourcesRecordV1Schema, RegistrySourcesReadEnvelopeV1Schema, readRegistrySourcesInventoryV1 } from '../../registries/registrySourcesV1.js';
import { ContextSelectionV1Schema } from './contextSelectionsV1.js';
import { RoleOverrideRecordV1Schema } from '../roles/roleOverrideRecordV1.js';
import { SkillRuleV1Schema } from '../../reach/reachRuleV1.js';
import { reachRuleKeyV1 } from '../../reach/reachRulesChangeV1.js';
import { McpServerCatalogRowMutationV1Schema } from '../../mcp/servers/catalogSchemasV1.js';
import { SkillUsageRowV1Schema } from './skills/skillUsageV1.js';

export const PromptLibraryCatalogKeyV1Schema = lazyZodSchema(() => z.enum([
  'coding', 'voice', 'folders', 'invocations', 'external-links', 'registry-sources', 'contexts', 'role-overrides', 'skill-rules', 'skill-usage',
]));
export type PromptLibraryCatalogKeyV1 = z.infer<typeof PromptLibraryCatalogKeyV1Schema>;
export const PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1 = '@happier/account/prompt-library/v1/' as const;
export const PROMPT_LIBRARY_ROWS_ROUTE_V1 = '/v1/account/entity-rows/prompt-library' as const;
export const PROMPT_LIBRARY_ACCOUNT_CIPHER_KIND_V1 = 'account_prompt_catalog' as const;

export const PromptStackRecordV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), scope: z.strictObject({ kind: z.enum(['coding', 'voice']) }), entries: z.array(PromptStackEntryV1Schema),
}));
export type PromptStackRecordV1 = z.infer<typeof PromptStackRecordV1Schema>;

export const SkillRulesRecordV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), rules: z.array(SkillRuleV1Schema),
  consumedLegacyEntryIds: z.optional(z.array(z.string().check(z.minLength(1)))),
}));
export type SkillRulesRecordV1 = z.infer<typeof SkillRulesRecordV1Schema>;

/** Each existing small domain has one row; Profile stacks remain Profile-owned. */
export const PromptLibraryRecordV1Schema = lazyZodSchema(() => z.discriminatedUnion('key', [
  z.strictObject({ key: z.literal('coding'), value: PromptStackRecordV1Schema }),
  z.strictObject({ key: z.literal('voice'), value: PromptStackRecordV1Schema }),
  z.strictObject({ key: z.literal('folders'), value: PromptFoldersV1RecordSchema }),
  z.strictObject({ key: z.literal('invocations'), value: z.strictObject({ v: z.literal(1), entries: z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(PromptInvocationEntryV1Schema)) }) }),
  z.strictObject({ key: z.literal('external-links'), value: defineStoredReadProjection(
    z.pipe(z.strictObject({ v: z.literal(1), links: z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(PromptExternalLinkEntryV1Schema)) }), z.transform(value => ({ ...value, links: value.links.map(({ syncMode: _syncMode, ...link }) => link) }))),
    () => createStoredReadSchema(PromptExternalLinksV1Schema),
  ) }),
  z.strictObject({ key: z.literal('registry-sources'), value: defineStoredReadProjection(RegistrySourcesRecordV1Schema,
    () => z.pipe((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(RegistrySourcesReadEnvelopeV1Schema), z.transform((value, context) => {
      try {
        const inventory = readRegistrySourcesInventoryV1(value);
        if (inventory.status === 'ready') return inventory.record;
      } catch { /* Invalid envelopes or incomplete token references cannot admit authority. */ }
      context.issues.push({ code: 'custom', message: 'Registry source inventory is incomplete', input: context.value });
      return z.NEVER;
    }))) }),
  z.strictObject({ key: z.literal('contexts'), value: z.strictObject({ v: z.literal(1), selectionsByKey: z.record(z.string(), (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ContextSelectionV1Schema)) }) }),
  z.strictObject({ key: z.literal('role-overrides'), value: RoleOverrideRecordV1Schema }),
  z.strictObject({ key: z.literal('skill-rules'), value: SkillRulesRecordV1Schema }),
  z.strictObject({ key: z.literal('skill-usage'), value: SkillUsageRowV1Schema }),
]).check(z.superRefine((record, context) => {
  if ((record.key === 'coding' || record.key === 'voice') && record.value.scope.kind !== record.key) {
    context.addIssue({ code: 'custom', path: ['value', 'scope', 'kind'], message: 'Stack scope must match its catalog address' });
  }
  if (record.key === 'skill-rules') {
    const seen = new Set<string>();
    for (const [index, rule] of record.value.rules.entries()) {
      const key = JSON.stringify([rule.skillId, reachRuleKeyV1(rule)]);
      if (seen.has(key)) context.addIssue({ code: 'custom', path: ['value', 'rules', index],
        message: 'Skill rules must be unique per item, place and Agent scope' });
      seen.add(key);
    }
  }
  const ids = record.key === 'coding' || record.key === 'voice' ? record.value.entries.map(entry => entry.id)
    : record.key === 'folders' ? record.value.folders.map(entry => entry.id)
    : record.key === 'invocations' ? record.value.entries.map(entry => entry.id)
    : record.key === 'external-links' ? record.value.links.map(entry => entry.id)
    : record.key === 'registry-sources' ? record.value.sources.map(entry => entry.id) : [];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['value'], message: 'Catalog entry identities must be unique' });
})));
export type PromptLibraryRecordV1 = z.infer<typeof PromptLibraryRecordV1Schema>;
export const StoredPromptLibraryRecordV1Schema = createStoredReadSchema(PromptLibraryRecordV1Schema);

const plainContent = lazyZodSchema(() => z.strictObject({ t: z.literal('plain'), v: PromptLibraryRecordV1Schema }));
const encryptedContent = lazyZodSchema(() => z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }));
export const PromptLibraryContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [plainContent, encryptedContent]));
export type PromptLibraryContentV1 = z.infer<typeof PromptLibraryContentV1Schema>;
export const StoredPromptLibraryContentV1Schema = createStoredReadSchema(PromptLibraryContentV1Schema);
// HTTP reads carry persisted records. Drop their additive fields before strict domain admission,
// while keeping the response, content discriminator and ciphertext envelopes closed.
const readContent = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.extend(plainContent, { v: StoredPromptLibraryRecordV1Schema }), encryptedContent,
]));

const revision = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
export const PromptLibraryRowFailureV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content']), reason: z.optional(z.string()),
}));
export const PromptLibraryRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('present'), revision, content: readContent }),
  z.strictObject({ status: z.literal('absent') }), z.strictObject({ status: z.literal('deleted'), revision }), PromptLibraryRowFailureV1Schema,
]));
export const PromptLibraryRowMutationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.union([revision, z.literal('absent')]), content: z.nullable(PromptLibraryContentV1Schema),
  sourceSettingsVersion: z.optional(revision),
  referencedSavedSecretIds: z.optional(McpServerCatalogRowMutationV1Schema.shape.referencedSavedSecretIds._zod.def.innerType),
  savedSecretRevisions: z.optional(McpServerCatalogRowMutationV1Schema.shape.savedSecretRevisions._zod.def.innerType),
}).check(z.superRefine((mutation, context) => {
  if (mutation.expectedRevision === 'absent' && (mutation.sourceSettingsVersion === undefined || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'First destination authority requires captured source currentness' });
  }
  if (mutation.sourceSettingsVersion !== undefined && (mutation.expectedRevision !== 'absent' || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Source admission initializes destination authority only' });
  }
})));
export type PromptLibraryRowMutationV1 = z.infer<typeof PromptLibraryRowMutationV1Schema>;
export const PromptLibraryRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('updated'), revision, cursor: revision }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int(), z.minimum(-1)) }), PromptLibraryRowFailureV1Schema,
  z.strictObject({ status: z.literal('settings-conflict'), revision }),
  z.strictObject({ status: z.literal('invalid-reference') }),
]));
export const PromptLibraryRowsListResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('listed'), rows: z.array(z.strictObject({
    key: PromptLibraryCatalogKeyV1Schema, revision, content: z.nullable(readContent),
  })) }), PromptLibraryRowFailureV1Schema,
]));
export const AccountEncryptionMigratePromptLibraryDirectiveV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.strictObject({ key: PromptLibraryCatalogKeyV1Schema, expectedRevision: revision, content: PromptLibraryContentV1Schema })),
}).check(z.superRefine((directive, context) => {
  const keys = new Set<string>();
  for (const [index, item] of directive.items.entries()) {
    if (keys.has(item.key) || (item.content.t === 'plain' && item.content.v.key !== item.key)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'key'], message: 'Prompt catalog identity must be unique and match its content' });
    }
    keys.add(item.key);
  }
})));
export type AccountEncryptionMigratePromptLibraryDirectiveV1 = z.infer<typeof AccountEncryptionMigratePromptLibraryDirectiveV1Schema>;
export const AccountEncryptionMigratePromptLibraryResultV1Schema = lazyZodSchema(() => z.strictObject({
  rows: z.array(z.strictObject({ key: PromptLibraryCatalogKeyV1Schema, revision, content: z.nullable(PromptLibraryContentV1Schema) })),
}));
export type AccountEncryptionMigratePromptLibraryResultV1 = z.infer<typeof AccountEncryptionMigratePromptLibraryResultV1Schema>;
