import { PERSONAL_SAVED_SECRET_ACTION_IDS_V1 } from './personalSavedSecretActionIdsV1.js';
export { PERSONAL_SAVED_SECRET_ACTION_IDS_V1 } from './personalSavedSecretActionIdsV1.js';
import { z } from 'zod/mini';
import { AccountSettingsSavedSecretReferenceSchema, type AccountSettingsSavedSecretReference } from './savedSecretMutationOwner.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ActionExecuteFailureSchema } from '../../actions/actionExecutionResult.js';
import { SavedSecretResourceSourceV1Schema, SavedSecretExternalSourceV1Schema, type SavedSecretExternalSourceV1 } from './savedSecretResourceContentSchemaV1.js';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SAVED_SECRET_NAME_MAX_LENGTH, SavedSecretSchema } from '../../profiles/backendProfileSchema.js';
import { PluginSecretSourceContributionV1Schema, PluginSecretSourceFieldV1Schema, PluginSecretSourceListResultV1Schema, PluginSecretSourceStoreResultV1Schema, type PluginSecretSourceFieldV1, type PluginSecretSourceContributionV1 } from '../../plugins/contributions/secretSources.js';
export type PersonalSavedSecretActionIdV1 = typeof PERSONAL_SAVED_SECRET_ACTION_IDS_V1[number];
const identity = () => z.string().check(z.minLength(1));
const name = () => z.string().check(z.trim(), z.minLength(1), z.maxLength(SAVED_SECRET_NAME_MAX_LENGTH));
const kind = () => SavedSecretSchema.shape.kind._zod.def.innerType;
/** Native kinds remain metadata; only established Saved Secret kinds select scalar behavior. */
export function createSavedSecretVaultLinkDraftV1(contribution: PluginContributionIdentityV1, field: PluginSecretSourceFieldV1) {
  const parsedKind = kind().safeParse(field.field.kind);
  return { name: `${field.item.title || field.item.id} / ${field.field.title || field.field.id}`.trim().slice(0, SAVED_SECRET_NAME_MAX_LENGTH),
    kind: parsedKind.success ? parsedKind.data : 'other' as const,
    source: { kind: 'external' as const, contribution, account: field.account, reference: field.reference,
      metadata: { vault: field.vault, item: field.item, field: field.field } } };
}
// These established Action field names carry the private resource's revision,
// an opaque concurrency token, rather than an invented wall-clock timestamp.
const revision = () => z.number().check(z.int(), z.positive());
const vaultFields = () => ({ contribution: asProtocolZod(PluginContributionIdentityV1Schema), account: identity(), machineId: z.optional(identity()) });
export const SavedSecretVaultTargetV1Schema = lazyZodSchema(() => z.strictObject({ ...vaultFields(), vaultId: identity() }));
export const SavedSecretVaultQueryV1Schema = lazyZodSchema(() => z.strictObject({ ...vaultFields(), vaultId: z.optional(identity()), itemId: z.optional(identity()) }));
export type SavedSecretVaultTargetV1 = z.infer<typeof SavedSecretVaultTargetV1Schema>;
export type SavedSecretVaultQueryV1 = z.infer<typeof SavedSecretVaultQueryV1Schema>;
export const SavedSecretVaultInvocationV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list'), source: z.omit(SavedSecretVaultQueryV1Schema, { machineId: true }), accountEncryptionMode: z.enum(['plain', 'e2ee']) }),
  z.strictObject({ operation: z.literal('store'), target: z.omit(SavedSecretVaultTargetV1Schema, { machineId: true }), title: name(), value: identity(), accountEncryptionMode: z.enum(['plain', 'e2ee']) }),
]));
export const SavedSecretVaultInvocationResultV1Schema = lazyZodSchema(() => z.union([
  PluginSecretSourceListResultV1Schema, PluginSecretSourceStoreResultV1Schema,
]));
export type SavedSecretVaultInvocationV1 = z.infer<typeof SavedSecretVaultInvocationV1Schema>;
export type SavedSecretVaultInvocationResultV1 = z.infer<typeof SavedSecretVaultInvocationResultV1Schema>;
const linkedSecret = () => z.strictObject({ secretId: identity(), secretRef: identity() });
/** Composable fields; create admission below owns the cross-field constraints. */
export const PersonalSavedSecretCreateInputObjectV1Schema = lazyZodSchema(() => z.strictObject({
  name: name(), kind: z.optional(kind()), value: z.optional(identity()),
  source: z.optional(SavedSecretResourceSourceV1Schema),
  storeIn: z.optional(SavedSecretVaultTargetV1Schema),
}));
export const PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1 = {
  'secrets.list': lazyZodSchema(() => z.strictObject({ source: z.optional(SavedSecretVaultQueryV1Schema), secretId: z.optional(identity()) })),
  'secrets.create': lazyZodSchema(() => PersonalSavedSecretCreateInputObjectV1Schema.check(
      z.refine(input => (input.value === undefined) !== (input.source === undefined), 'Expected one secret value or source'),
      z.refine(input => input.storeIn === undefined || input.value !== undefined, 'Store requires a secret value'),
      z.refine(input => input.source?.kind !== 'passkey' || input.kind === undefined || input.kind === 'other', 'Passkeys use the other secret kind'))),
  'secrets.update': lazyZodSchema(() => z.strictObject({ secretId: identity(), name: z.optional(name()), value: z.optional(identity()),
    source: z.optional(SavedSecretExternalSourceV1Schema), expectedUpdatedAt: revision() }).check(z.refine(input => input.value === undefined || input.source === undefined, 'Expected one secret value or source'))),
  'secrets.delete': lazyZodSchema(() => z.strictObject({ secretId: identity(), expectedUpdatedAt: revision() })),
  'secrets.link': lazyZodSchema(() => z.strictObject({ source: SavedSecretVaultQueryV1Schema, itemIds: z.optional(z.array(identity())) })),
  'secrets.export': lazyZodSchema(() => z.strictObject({ target: SavedSecretVaultTargetV1Schema,
    secrets: z.array(z.strictObject({ secretId: identity(), expectedUpdatedAt: revision() })).check(z.minLength(1)) })),
};
export const PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 = {
  'secrets.list': lazyZodSchema(() => z.strictObject({ secrets: z.array(z.strictObject({ secretId: identity(), name: name(), kind: kind(),
    updatedAt: revision(), source: z.optional(SavedSecretExternalSourceV1Schema) })), sources: z.optional(z.array(z.strictObject({
      contribution: asProtocolZod(PluginContributionIdentityV1Schema), title: identity(),
      capabilities: PluginSecretSourceContributionV1Schema.shape.capabilities,
    }))), fields: z.optional(z.array(PluginSecretSourceFieldV1Schema)),
    vaults: z.optional(z.array(PluginSecretSourceFieldV1Schema.shape.vault)),
    usedBy: z.optional(z.nullable(z.array(AccountSettingsSavedSecretReferenceSchema))) })),
  'secrets.create': lazyZodSchema(() => z.strictObject({ secretId: identity(), secretRef: identity() })),
  'secrets.update': lazyZodSchema(() => z.strictObject({ secretId: identity(), updatedAt: revision() })),
  'secrets.delete': lazyZodSchema(() => z.strictObject({ deleted: z.literal(true) })),
  'secrets.link': lazyZodSchema(() => z.strictObject({ secrets: z.array(linkedSecret()) })),
  'secrets.export': lazyZodSchema(() => z.strictObject({ results: z.array(z.discriminatedUnion('status', [
    z.strictObject({ ...linkedSecret().shape, status: z.literal('exported'), updatedAt: revision() }),
    z.strictObject({ ...linkedSecret().shape, status: z.literal('failed'), code: identity(), repair: z.optional(z.enum(['install', 'unlock', 'configure', 'retry'])) }),
  ])) })),
};

export type PersonalSavedSecretMetadataV1 = Readonly<{ secretId: string; name: string; kind: z.infer<ReturnType<typeof kind>>; revision: number; source?: SavedSecretExternalSourceV1 }>;
/** Hosts adapt the incumbent private-resource writer, never a Settings writer. */
export type PersonalSavedSecretActionPortV1 = Readonly<{
  list(): Promise<readonly PersonalSavedSecretMetadataV1[]>;
  /** One selected secret; null means the host does not hold complete census coverage. */
  usedBy?(secretId: string): Promise<readonly AccountSettingsSavedSecretReference[] | null>;
  sources?(): readonly Readonly<{ contribution: PluginContributionIdentityV1; title: string; capabilities?: PluginSecretSourceContributionV1['capabilities'] }>[];
  browse?(input: SavedSecretVaultQueryV1): Promise<Pick<Extract<z.infer<typeof PluginSecretSourceListResultV1Schema>, { ok: true }>, 'fields' | 'vaults'>>;
  link?(input: z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.link']>): Promise<z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.link']>>;
  export?(input: z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.export']>): Promise<z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.export']>>;
  create(input: z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.create']>): Promise<Readonly<{ secretId: string; secretRef: string }>>;
  update(input: z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.update']>): Promise<Readonly<{ revision: number }>>;
  delete(input: z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.delete']>): Promise<void>;
}>;
export function createPersonalSavedSecretActionExecuteV1(port: PersonalSavedSecretActionPortV1) {
  return async (actionId: PersonalSavedSecretActionIdV1, raw: unknown): Promise<unknown> => {
    try {
    switch (actionId) {
      case 'secrets.list': {
        const input = PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[actionId].parse(raw);
        if (input.source && !port.browse) throw Object.assign(new Error('unsupported_action'), { code: 'unsupported_action' });
        return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse({ secrets: (await port.list())
          .filter(secret => input.secretId === undefined || secret.secretId === input.secretId)
          .map(({ revision, ...secret }) => ({ ...secret, updatedAt: revision })),
          ...(input.secretId ? { usedBy: await port.usedBy?.(input.secretId) ?? null } : {}),
          ...(port.sources ? { sources: port.sources() } : {}), ...(input.source ? await port.browse!(input.source) : {}) });
      }
      case 'secrets.link':
      case 'secrets.export': {
        const execute = port[actionId === 'secrets.link' ? 'link' : 'export'];
        if (!execute) throw Object.assign(new Error('unsupported_action'), { code: 'unsupported_action' });
        if (actionId === 'secrets.link') return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(await port.link!(PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[actionId].parse(raw)));
        return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(await port.export!(PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[actionId].parse(raw)));
      }
      case 'secrets.create':
        return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(await port.create(PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[actionId].parse(raw)));
      case 'secrets.update': {
        const input = PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[actionId].parse(raw);
        if (input.name === undefined && input.value === undefined && input.source === undefined) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
        const result = await port.update(input);
        return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse({ secretId: input.secretId, updatedAt: result.revision });
      }
      case 'secrets.delete':
        await port.delete(PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[actionId].parse(raw));
        return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse({ deleted: true });
    }
    } catch (error) {
      // Hosts report typed private-resource refusals. Preserve their admitted
      // code/details at this family owner, not in separate client adapters.
      const refusal = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? ActionExecuteFailureSchema.safeParse({ ok: false, errorCode: error.code, error: error.message || error.code,
            ...('details' in error && error.details !== undefined ? { details: error.details } : {}) }) : null;
      if (refusal?.success) return refusal.data;
      throw error;
    }
  };
}
