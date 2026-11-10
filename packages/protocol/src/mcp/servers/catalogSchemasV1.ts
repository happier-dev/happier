import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { McpServerCatalogEntryV1Schema, McpServerRuleV1Schema, McpServerPluginSettingsMapV1Schema,
  McpServerToolSettingsPatchV1Schema, McpServerToolsSnapshotV1Schema, refineMcpServerCatalogV1 } from './settingsV1.js';
import { ReachRuleV1Schema } from '../../reach/reachRuleV1.js';
import { ReachRulesChangeV1Schema, type ReachRulesChangeV1 } from '../../reach/reachRulesChangeV1.js';


export const McpServerCatalogV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), servers: z.array(McpServerCatalogEntryV1Schema), bindings: z.array(McpServerRuleV1Schema),
  pluginServers: z.optional(McpServerPluginSettingsMapV1Schema),
}).check(z.superRefine(refineMcpServerCatalogV1)));
export type McpServerCatalogV1 = z.infer<typeof McpServerCatalogV1Schema>;
export const StoredMcpServerCatalogV1Schema = createStoredReadSchema(McpServerCatalogV1Schema);
export const McpServerCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: McpServerCatalogV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type McpServerCatalogContentV1 = z.infer<typeof McpServerCatalogContentV1Schema>;
// Preserve the original JSON until the domain opener has diagnosed individual
// entries and recognizable reference carriers; projecting here loses evidence.
export const StoredMcpServerCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.catchall(z.object({ t: z.literal('plain'), v: StrictJsonValueSchema }), StrictJsonValueSchema),
  z.catchall(z.object({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }), StrictJsonValueSchema),
]));
export type StoredMcpServerCatalogContentV1 = z.infer<typeof StoredMcpServerCatalogContentV1Schema>;
/** Account conversion carries retained JSON, rather than newly authored declarations. */
export const McpServerCatalogMigrationContentV1Schema = StoredMcpServerCatalogContentV1Schema;
export type McpServerCatalogDiagnosticV1 = Readonly<{ path: string; reason: 'invalid-stored-content' | 'unclassified-reference' }>;
export const McpServerCatalogDiagnosticV1Schema = lazyZodSchema(() => z.strictObject({
  path: z.string(), reason: z.enum(['invalid-stored-content', 'unclassified-reference']),
}));
export type McpServerCatalogOpenResultV1 = Readonly<{ status: 'opened'; catalog: McpServerCatalogV1 }>
  | Readonly<{ status: 'partial'; catalog: McpServerCatalogV1; diagnostics: readonly McpServerCatalogDiagnosticV1[] }>
  | Readonly<{ status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content' }>;

const revision = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
export const McpServerCatalogRowFailureV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content', 'invalid-reference']),
  reason: z.optional(z.string()),
}));
export const McpServerCatalogRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('present'), revision, content: StoredMcpServerCatalogContentV1Schema }),
  z.strictObject({ status: z.literal('absent') }), z.strictObject({ status: z.literal('deleted'), revision }),
  McpServerCatalogRowFailureV1Schema,
]));
export type McpServerCatalogRowReadResponseV1 = z.infer<typeof McpServerCatalogRowReadResponseV1Schema>;
export const McpServerCatalogRowMutationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.union([revision, z.literal('absent')]), content: z.nullable(McpServerCatalogContentV1Schema),
  sourceSettingsVersion: z.optional(revision), referencedSavedSecretIds: z._default(z.array(z.string().check(z.minLength(1))), []),
  savedSecretRevisions: z._default(z.array(z.strictObject({ resourceId: z.string().check(z.minLength(1)), expectedRevision: revision })), []),
}).check(z.superRefine((mutation, context) => {
  if (mutation.expectedRevision === 'absent' && (mutation.sourceSettingsVersion === undefined || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'First authority requires captured source currentness' });
  }
  if (mutation.sourceSettingsVersion !== undefined && (mutation.expectedRevision !== 'absent' || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Source admission initializes authority only' });
  }
})));
export type McpServerCatalogRowMutationV1 = z.infer<typeof McpServerCatalogRowMutationV1Schema>;
export const McpServerCatalogRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('updated'), revision, cursor: revision }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int(), z.minimum(-1)) }),
  z.strictObject({ status: z.literal('settings-conflict'), revision }), McpServerCatalogRowFailureV1Schema,
]));
export type McpServerCatalogRowMutationResponseV1 = z.infer<typeof McpServerCatalogRowMutationResponseV1Schema>;
/** The already-captured Home/Account identity, not a transport endpoint or new id. */
export const McpServerCatalogScopeV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.minLength(1)), accountId: z.string().check(z.minLength(1)),
}));
export type McpServerCatalogScopeV1 = z.infer<typeof McpServerCatalogScopeV1Schema>;

/** Semantic receipts extend the domain result, never the durable row HTTP response. */
export const McpServerCatalogMutationResponseV1Schema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpServerCatalogRowMutationResponseV1Schema._zod.def.options[0], { items: z.optional(z.array(z.strictObject({ serverId: z.string().check(z.minLength(1)),
    rules: z.array(ReachRuleV1Schema), previous: z.array(ReachRuleV1Schema) }))) })),
  McpServerCatalogRowMutationResponseV1Schema._zod.def.options[1],
  McpServerCatalogRowMutationResponseV1Schema._zod.def.options[2],
  McpServerCatalogRowMutationResponseV1Schema._zod.def.options[3],
]));
export type McpServerCatalogMutationResponseV1 = z.infer<typeof McpServerCatalogMutationResponseV1Schema>;
export const AccountEncryptionMigrateMcpServerCatalogDirectiveV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: revision, content: z.nullable(McpServerCatalogMigrationContentV1Schema),
}));
export type AccountEncryptionMigrateMcpServerCatalogDirectiveV1 = z.infer<typeof AccountEncryptionMigrateMcpServerCatalogDirectiveV1Schema>;
export const AccountEncryptionMigrateMcpServerCatalogResultV1Schema = lazyZodSchema(() => z.strictObject({
  revision, content: z.nullable(StoredMcpServerCatalogContentV1Schema),
}));
export type AccountEncryptionMigrateMcpServerCatalogResultV1 = z.infer<typeof AccountEncryptionMigrateMcpServerCatalogResultV1Schema>;

export const McpServerCatalogCreateBatchV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('server-create-batch'), entries: z.array(z.strictObject({
    entry: McpServerCatalogEntryV1Schema, rules: z.array(McpServerRuleV1Schema),
  })),
}));

export const McpServerCatalogMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('server-create'), entry: McpServerCatalogEntryV1Schema,
    rules: z.array(McpServerRuleV1Schema) }),
  McpServerCatalogCreateBatchV1Schema,
  z.strictObject({ kind: z.literal('server-update'), entry: McpServerCatalogEntryV1Schema }),
  z.strictObject({ kind: z.literal('server-upsert'), entry: McpServerCatalogEntryV1Schema }),
  z.strictObject({ kind: z.literal('server-duplicate'), serverId: z.string().check(z.minLength(1)),
    entry: McpServerCatalogEntryV1Schema, rules: z.array(McpServerRuleV1Schema) }),
  z.strictObject({ kind: z.literal('server-remove'), serverId: z.string().check(z.minLength(1)), removeBindings: z._default(z.boolean(), false) }),
  z.strictObject({ kind: z.literal('rules-change'), serverIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)), change: ReachRulesChangeV1Schema }),
  z.strictObject({ kind: z.literal('tools-change'), serverId: z.string().check(z.minLength(1)), settings: McpServerToolSettingsPatchV1Schema }),
  z.strictObject({ kind: z.literal('tools-snapshot'), serverId: z.string().check(z.minLength(1)), snapshot: McpServerToolsSnapshotV1Schema }),
  z.strictObject({ kind: z.literal('plugin-defaults'), serverIds: z.array(z.string().check(z.minLength(1))) }),
]));

export type McpServerCatalogMutationV1 = Exclude<z.infer<typeof McpServerCatalogMutationV1Schema>, { kind: 'rules-change' }>
  | Readonly<{ kind: 'rules-change'; serverIds: readonly string[]; change: ReachRulesChangeV1 }>;

const unavailableReasons = ['account-not-found', 'account-inconsistent', 'account-mode-mismatch',
  'encryption-material-unavailable', 'invalid-stored-content', 'invalid-reference', 'unauthorized', 'forbidden',
  'unsupported', 'unreachable', 'database_transaction_conflict_exhausted', 'scope-retired', 'cancelled', 'source-version-conflict', 'authority-not-confirmed'] as const;

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
  const revision = z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER));
  const opened = z.strictObject({ catalog: McpServerCatalogV1Schema, revision: z.union([revision, z.literal('absent')]),
    authority: z.enum(['active', 'inactive']), diagnostics: z.array(McpServerCatalogDiagnosticV1Schema),
    cleanup: z.optional(z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('complete') }),
      z.strictObject({ status: z.literal('cleanup-pending'),
        reason: z.enum(['source-unavailable', 'source-conflict', 'history-incomplete', 'cancelled']) }),
    ])),
  });
  return z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('loading') }),
    z.strictObject({ status: z.literal('unavailable'), reason: unavailableReasonSchema }),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(opened, { status: z.literal('ready') })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(opened, { status: z.literal('partial') })),
  ]);
});
