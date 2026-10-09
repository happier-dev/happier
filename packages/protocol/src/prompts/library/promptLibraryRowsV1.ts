import { z } from 'zod';
import tweetnacl from 'tweetnacl';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { isAccountScopedBlobCiphertextForKind } from '../../crypto/accountScopedCipherEnvelope.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { PromptStackEntryV1Schema } from './promptStacksV1.js';
import { PromptFoldersV1RecordSchema } from './promptFoldersV1.js';
import { PromptInvocationEntryV1Schema } from './promptInvocationsV1.js';
import { PromptExternalLinkEntryV1Schema } from './promptExternalLinksV1.js';
import { PromptRegistryConfiguredSourceV1Schema } from './promptRegistriesV1.js';
import { ContextSelectionV1Schema } from './contextSelectionsV1.js';
import { RoleOverrideRecordV1Schema } from '../roles/roleOverrideRecordV1.js';

export const PromptLibraryCatalogKeyV1Schema = lazyZodSchema(() => z.enum([
  'coding', 'voice', 'folders', 'invocations', 'external-links', 'registry-sources', 'contexts', 'role-overrides',
]));
export type PromptLibraryCatalogKeyV1 = z.infer<typeof PromptLibraryCatalogKeyV1Schema>;
export const PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1 = '@happier/account/prompt-library/v1/' as const;
export const PROMPT_LIBRARY_ROWS_ROUTE_V1 = '/v1/account/entity-rows/prompt-library' as const;
export const PROMPT_LIBRARY_ACCOUNT_CIPHER_KIND_V1 = 'account_prompt_catalog' as const;

export function buildPromptLibraryPhysicalKeyV1(key: PromptLibraryCatalogKeyV1): string {
  return PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1 + PromptLibraryCatalogKeyV1Schema.parse(key);
}
export function parsePromptLibraryPhysicalKeyV1(key: string): PromptLibraryCatalogKeyV1 | null {
  if (!key.startsWith(PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1)) return null;
  const parsed = PromptLibraryCatalogKeyV1Schema.safeParse(key.slice(PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1.length));
  return parsed.success ? parsed.data : null;
}

export const PromptStackRecordV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), scope: z.object({ kind: z.enum(['coding', 'voice']) }).strict(), entries: z.array(PromptStackEntryV1Schema),
}).strict());
export type PromptStackRecordV1 = z.infer<typeof PromptStackRecordV1Schema>;

/** Each existing small domain has one row; Profile stacks remain Profile-owned. */
export const PromptLibraryRecordV1Schema = lazyZodSchema(() => z.discriminatedUnion('key', [
  z.object({ key: z.literal('coding'), value: PromptStackRecordV1Schema }).strict(),
  z.object({ key: z.literal('voice'), value: PromptStackRecordV1Schema }).strict(),
  z.object({ key: z.literal('folders'), value: PromptFoldersV1RecordSchema }).strict(),
  z.object({ key: z.literal('invocations'), value: z.object({ v: z.literal(1), entries: z.array(PromptInvocationEntryV1Schema.strict()) }).strict() }).strict(),
  z.object({ key: z.literal('external-links'), value: z.object({ v: z.literal(1), links: z.array(PromptExternalLinkEntryV1Schema.strict()) }).strict() }).strict(),
  z.object({ key: z.literal('registry-sources'), value: z.object({ v: z.literal(1), sources: z.array(PromptRegistryConfiguredSourceV1Schema.strict()) }).strict() }).strict(),
  z.object({ key: z.literal('contexts'), value: z.object({ v: z.literal(1), selectionsByKey: z.record(z.string(), ContextSelectionV1Schema.strict()) }).strict() }).strict(),
  z.object({ key: z.literal('role-overrides'), value: RoleOverrideRecordV1Schema }).strict(),
]).superRefine((record, context) => {
  if ((record.key === 'coding' || record.key === 'voice') && record.value.scope.kind !== record.key) {
    context.addIssue({ code: 'custom', path: ['value', 'scope', 'kind'], message: 'Stack scope must match its catalog address' });
  }
  const ids = record.key === 'coding' || record.key === 'voice' ? record.value.entries.map(entry => entry.id)
    : record.key === 'folders' ? record.value.folders.map(entry => entry.id)
    : record.key === 'invocations' ? record.value.entries.map(entry => entry.id)
    : record.key === 'external-links' ? record.value.links.map(entry => entry.id)
    : record.key === 'registry-sources' ? record.value.sources.map(entry => entry.id) : [];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['value'], message: 'Catalog entry identities must be unique' });
}));
export type PromptLibraryRecordV1 = z.infer<typeof PromptLibraryRecordV1Schema>;
export const StoredPromptLibraryRecordV1Schema = createStoredReadSchema(PromptLibraryRecordV1Schema);

export const PromptLibraryContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: PromptLibraryRecordV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));
export type PromptLibraryContentV1 = z.infer<typeof PromptLibraryContentV1Schema>;
export const StoredPromptLibraryContentV1Schema = createStoredReadSchema(PromptLibraryContentV1Schema);

export function assertPromptLibraryContentForModeV1(content: PromptLibraryContentV1, mode: 'plain' | 'e2ee'): void {
  if ((mode === 'plain') !== (content.t === 'plain') || (content.t === 'encrypted'
    && !isAccountScopedBlobCiphertextForKind({ kind: PROMPT_LIBRARY_ACCOUNT_CIPHER_KIND_V1, ciphertext: content.c }))) throw new Error('account-mode-mismatch');
}
export function openPromptLibraryContentV1(input: Readonly<{
  key: PromptLibraryCatalogKeyV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; content: unknown;
}>): Readonly<{ status: 'opened'; record: PromptLibraryRecordV1 }> | Readonly<{
  status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content';
}> {
  const content = StoredPromptLibraryContentV1Schema.safeParse(input.content);
  if (!content.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  try { assertPromptLibraryContentForModeV1(content.data, input.mode); }
  catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  let value: unknown;
  if (content.data.t === 'plain') value = content.data.v;
  else {
    if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    value = openAccountScopedBlobCiphertext({ kind: PROMPT_LIBRARY_ACCOUNT_CIPHER_KIND_V1, material: input.material, ciphertext: content.data.c })?.value;
  }
  const record = StoredPromptLibraryRecordV1Schema.safeParse(value);
  return record.success && record.data.key === input.key
    ? { status: 'opened', record: record.data } : { status: 'unavailable', reason: 'invalid-stored-content' };
}
export function sealPromptLibraryContentV1(input: Readonly<{
  record: PromptLibraryRecordV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; randomBytes?: (length: number) => Uint8Array;
}>): PromptLibraryContentV1 {
  const record = PromptLibraryRecordV1Schema.parse(input.record);
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    return { t: 'plain', v: record };
  }
  if (!input.material) throw new Error('encryption-material-unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: PROMPT_LIBRARY_ACCOUNT_CIPHER_KIND_V1,
    material: input.material, payload: record, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}

const revision = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const PromptLibraryRowFailureV1Schema = lazyZodSchema(() => z.object({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content']), reason: z.string().optional(),
}).strict());
export const PromptLibraryRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('present'), revision, content: PromptLibraryContentV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(), z.object({ status: z.literal('deleted'), revision }).strict(), PromptLibraryRowFailureV1Schema,
]));
export const PromptLibraryRowMutationV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: z.union([revision, z.literal('absent')]), content: PromptLibraryContentV1Schema.nullable(),
  sourceSettingsVersion: revision.optional(),
}).strict().superRefine((mutation, context) => {
  if (mutation.expectedRevision === 'absent' && (mutation.sourceSettingsVersion === undefined || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'First destination authority requires captured source currentness' });
  }
  if (mutation.sourceSettingsVersion !== undefined && (mutation.expectedRevision !== 'absent' || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Source admission initializes destination authority only' });
  }
}));
export type PromptLibraryRowMutationV1 = z.infer<typeof PromptLibraryRowMutationV1Schema>;
export const PromptLibraryRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision, cursor: revision }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(), PromptLibraryRowFailureV1Schema,
  z.object({ status: z.literal('settings-conflict'), revision }).strict(),
]));
export const PromptLibraryRowsListResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('listed'), rows: z.array(z.object({
    key: PromptLibraryCatalogKeyV1Schema, revision, content: PromptLibraryContentV1Schema.nullable(),
  }).strict()) }).strict(), PromptLibraryRowFailureV1Schema,
]));
export const AccountEncryptionMigratePromptLibraryDirectiveV1Schema = lazyZodSchema(() => z.object({
  items: z.array(z.object({ key: PromptLibraryCatalogKeyV1Schema, expectedRevision: revision, content: PromptLibraryContentV1Schema }).strict()),
}).strict().superRefine((directive, context) => {
  const keys = new Set<string>();
  for (const [index, item] of directive.items.entries()) {
    if (keys.has(item.key) || (item.content.t === 'plain' && item.content.v.key !== item.key)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'key'], message: 'Prompt catalog identity must be unique and match its content' });
    }
    keys.add(item.key);
  }
}));
export type AccountEncryptionMigratePromptLibraryDirectiveV1 = z.infer<typeof AccountEncryptionMigratePromptLibraryDirectiveV1Schema>;
export const AccountEncryptionMigratePromptLibraryResultV1Schema = lazyZodSchema(() => z.object({
  rows: z.array(z.object({ key: PromptLibraryCatalogKeyV1Schema, revision, content: PromptLibraryContentV1Schema.nullable() }).strict()),
}).strict());
export type AccountEncryptionMigratePromptLibraryResultV1 = z.infer<typeof AccountEncryptionMigratePromptLibraryResultV1Schema>;
