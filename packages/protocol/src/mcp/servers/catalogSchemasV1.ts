import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { McpServerCatalogEntryV1Schema, McpServerBindingV1Schema, refineMcpServerCatalogV1 } from './settingsV1.js';


export const McpServerCatalogV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), servers: z.array(McpServerCatalogEntryV1Schema), bindings: z.array(McpServerBindingV1Schema),
}).strict().superRefine(refineMcpServerCatalogV1));
export type McpServerCatalogV1 = z.infer<typeof McpServerCatalogV1Schema>;
export const StoredMcpServerCatalogV1Schema = createStoredReadSchema(McpServerCatalogV1Schema);
export const McpServerCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: McpServerCatalogV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));
export type McpServerCatalogContentV1 = z.infer<typeof McpServerCatalogContentV1Schema>;
// Preserve the original JSON until the domain opener has diagnosed individual
// entries and recognizable reference carriers; projecting here loses evidence.
export const StoredMcpServerCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: StrictJsonValueSchema }).catchall(StrictJsonValueSchema),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).catchall(StrictJsonValueSchema),
]));
export type StoredMcpServerCatalogContentV1 = z.infer<typeof StoredMcpServerCatalogContentV1Schema>;
/** Account conversion carries retained JSON, rather than newly authored declarations. */
export const McpServerCatalogMigrationContentV1Schema = StoredMcpServerCatalogContentV1Schema;
export type McpServerCatalogDiagnosticV1 = Readonly<{ path: string; reason: 'invalid-stored-content' | 'unclassified-reference' }>;
export const McpServerCatalogDiagnosticV1Schema = lazyZodSchema(() => z.object({
  path: z.string(), reason: z.enum(['invalid-stored-content', 'unclassified-reference']),
}).strict());
export type McpServerCatalogOpenResultV1 = Readonly<{ status: 'opened'; catalog: McpServerCatalogV1 }>
  | Readonly<{ status: 'partial'; catalog: McpServerCatalogV1; diagnostics: readonly McpServerCatalogDiagnosticV1[] }>
  | Readonly<{ status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content' }>;

const revision = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const McpServerCatalogRowFailureV1Schema = lazyZodSchema(() => z.object({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content', 'invalid-reference']),
  reason: z.string().optional(),
}).strict());
export const McpServerCatalogRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('present'), revision, content: StoredMcpServerCatalogContentV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(), z.object({ status: z.literal('deleted'), revision }).strict(),
  McpServerCatalogRowFailureV1Schema,
]));
export type McpServerCatalogRowReadResponseV1 = z.infer<typeof McpServerCatalogRowReadResponseV1Schema>;
export const McpServerCatalogRowMutationV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: z.union([revision, z.literal('absent')]), content: McpServerCatalogContentV1Schema.nullable(),
  sourceSettingsVersion: revision.optional(), referencedSavedSecretIds: z.array(z.string().min(1)).default([]),
  savedSecretRevisions: z.array(z.object({ resourceId: z.string().min(1), expectedRevision: revision }).strict()).default([]),
}).strict().superRefine((mutation, context) => {
  if (mutation.expectedRevision === 'absent' && (mutation.sourceSettingsVersion === undefined || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'First authority requires captured source currentness' });
  }
  if (mutation.sourceSettingsVersion !== undefined && (mutation.expectedRevision !== 'absent' || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Source admission initializes authority only' });
  }
}));
export type McpServerCatalogRowMutationV1 = z.infer<typeof McpServerCatalogRowMutationV1Schema>;
export const McpServerCatalogRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision, cursor: revision }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
  z.object({ status: z.literal('settings-conflict'), revision }).strict(), McpServerCatalogRowFailureV1Schema,
]));
export type McpServerCatalogRowMutationResponseV1 = z.infer<typeof McpServerCatalogRowMutationResponseV1Schema>;
/** The already-captured Home/Account identity, not a transport endpoint or new id. */
export const McpServerCatalogScopeV1Schema = lazyZodSchema(() => z.object({
  serverId: z.string().min(1), accountId: z.string().min(1),
}).strict());
export type McpServerCatalogScopeV1 = z.infer<typeof McpServerCatalogScopeV1Schema>;

/** An exact enabled-state reversal carries no binding configuration or credentials. */
export const McpServerBindingEnabledReversalV1Schema = lazyZodSchema(() => z.object({
  scope: McpServerCatalogScopeV1Schema, bindingId: z.string().min(1), before: z.boolean(), applied: z.boolean(), revision,
}).strict());
export type McpServerBindingEnabledReversalV1 = z.infer<typeof McpServerBindingEnabledReversalV1Schema>;

/** Semantic receipts extend the domain result, never the durable row HTTP response. */
export const McpServerCatalogMutationResponseV1Schema = lazyZodSchema(() => z.union([
  McpServerCatalogRowMutationResponseV1Schema.options[0].extend({ reversal: McpServerBindingEnabledReversalV1Schema.optional() })
    .strict().superRefine((result, context) => {
      if (result.reversal && result.reversal.revision !== result.revision) {
        context.addIssue({ code: 'custom', path: ['reversal', 'revision'], message: 'Reversal requires the committed row revision' });
      }
    }),
  McpServerCatalogRowMutationResponseV1Schema.options[1],
  McpServerCatalogRowMutationResponseV1Schema.options[2],
  McpServerCatalogRowMutationResponseV1Schema.options[3],
]));
export type McpServerCatalogMutationResponseV1 = z.infer<typeof McpServerCatalogMutationResponseV1Schema>;
export const AccountEncryptionMigrateMcpServerCatalogDirectiveV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: revision, content: McpServerCatalogMigrationContentV1Schema.nullable(),
}).strict());
export type AccountEncryptionMigrateMcpServerCatalogDirectiveV1 = z.infer<typeof AccountEncryptionMigrateMcpServerCatalogDirectiveV1Schema>;
export const AccountEncryptionMigrateMcpServerCatalogResultV1Schema = lazyZodSchema(() => z.object({
  revision, content: StoredMcpServerCatalogContentV1Schema.nullable(),
}).strict());
export type AccountEncryptionMigrateMcpServerCatalogResultV1 = z.infer<typeof AccountEncryptionMigrateMcpServerCatalogResultV1Schema>;

export const McpServerCatalogCreateBatchV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('server-create-batch'), entries: z.array(z.object({
    entry: McpServerCatalogEntryV1Schema, bindings: z.array(McpServerBindingV1Schema),
  }).strict()),
}).strict());

export const McpServerCatalogMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server-create'), entry: McpServerCatalogEntryV1Schema,
    bindings: z.array(McpServerBindingV1Schema).default([]) }).strict(),
  McpServerCatalogCreateBatchV1Schema,
  z.object({ kind: z.literal('server-update'), entry: McpServerCatalogEntryV1Schema,
    bindings: z.array(McpServerBindingV1Schema).default([]) }).strict(),
  z.object({ kind: z.literal('server-upsert'), entry: McpServerCatalogEntryV1Schema,
    bindings: z.array(McpServerBindingV1Schema).default([]) }).strict(),
  z.object({ kind: z.literal('server-duplicate'), serverId: z.string().min(1),
    entry: McpServerCatalogEntryV1Schema, bindings: z.array(McpServerBindingV1Schema).default([]) }).strict(),
  z.object({ kind: z.literal('server-remove'), serverId: z.string().min(1), removeBindings: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('binding-create'), binding: McpServerBindingV1Schema }).strict(),
  z.object({ kind: z.literal('binding-update'), binding: McpServerBindingV1Schema }).strict(),
  z.object({ kind: z.literal('binding-upsert'), binding: McpServerBindingV1Schema }).strict(),
  z.object({ kind: z.literal('binding-remove'), bindingId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('binding-enabled'), bindingId: z.string().min(1), enabled: z.boolean(),
    captureBefore: z.boolean().optional(), expectedEnabled: z.boolean().optional(),
    expectedScope: McpServerCatalogScopeV1Schema.optional() }).strict(),
]));

export type McpServerCatalogMutationV1 = z.infer<typeof McpServerCatalogMutationV1Schema>;

const unavailableReasons = ['account-not-found', 'account-inconsistent', 'account-mode-mismatch',
  'encryption-material-unavailable', 'invalid-stored-content', 'invalid-reference', 'unauthorized', 'forbidden',
  'unsupported', 'unreachable', 'scope-retired', 'cancelled', 'source-version-conflict', 'authority-not-confirmed'] as const;

export type McpServerCatalogUnavailableReasonV1 = typeof unavailableReasons[number];

export const unavailableReasonSchema = lazyZodSchema(() => z.enum(unavailableReasons));

export type McpServerCatalogSourceCleanupV1 = Readonly<{ status: 'complete' }> | Readonly<{
  status: 'cleanup-pending'; reason: 'source-unavailable' | 'source-conflict' | 'history-incomplete' | 'cancelled';
}>;

type OpenedCatalog = Readonly<{ catalog: McpServerCatalogV1; revision: number | 'absent'; authority: 'active' | 'inactive';
  diagnostics: readonly McpServerCatalogDiagnosticV1[]; cleanup?: McpServerCatalogSourceCleanupV1 }>;

export type McpServerCatalogSnapshotV1 = Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'unavailable'; reason: McpServerCatalogUnavailableReasonV1 }>
  | (OpenedCatalog & Readonly<{ status: 'ready' }>) | (OpenedCatalog & Readonly<{ status: 'partial' }>);

export const McpServerCatalogSnapshotV1Schema = lazyZodSchema(() => {
  const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const opened = z.object({ catalog: McpServerCatalogV1Schema, revision: z.union([revision, z.literal('absent')]),
    authority: z.enum(['active', 'inactive']), diagnostics: z.array(McpServerCatalogDiagnosticV1Schema),
    cleanup: z.discriminatedUnion('status', [
      z.object({ status: z.literal('complete') }).strict(),
      z.object({ status: z.literal('cleanup-pending'),
        reason: z.enum(['source-unavailable', 'source-conflict', 'history-incomplete', 'cancelled']) }).strict(),
    ]).optional(),
  }).strict();
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('loading') }).strict(),
    z.object({ status: z.literal('unavailable'), reason: unavailableReasonSchema }).strict(),
    opened.extend({ status: z.literal('ready') }).strict(),
    opened.extend({ status: z.literal('partial') }).strict(),
  ]);
});
