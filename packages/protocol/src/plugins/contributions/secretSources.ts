import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/** Value-free declaration. Native acquisition belongs to the executing Machine. */
export const PluginSecretSourceContributionV1Schema = lazyZodSchema(() => z.strictObject({
    id: asProtocolZod(PluginContributionLocalIdSchema),
    title: z.string().check(z.trim(), z.minLength(1)),
    capabilities: z.optional(z.strictObject({ list: z.optional(z.literal(true)), store: z.optional(z.literal(true)) })),
}));
export type PluginSecretSourceContributionV1 = z.infer<typeof PluginSecretSourceContributionV1Schema>;

export const PluginSecretSourceFailureV1Schema = lazyZodSchema(() => z.strictObject({
    ok: z.literal(false),
    code: z.enum(['source_unavailable', 'native_unavailable', 'authentication_required', 'access_denied', 'not_found', 'cancelled', 'acquisition_failed']),
    repair: z.optional(z.enum(['install', 'unlock', 'configure', 'retry'])),
}));
export type PluginSecretSourceFailureV1 = z.infer<typeof PluginSecretSourceFailureV1Schema>;
export const PluginSecretSourceOperationFailureV1Schema = lazyZodSchema(() => z.union([
    PluginSecretSourceFailureV1Schema, z.strictObject({ ok: z.literal(false), code: z.literal('unsupported') }),
]));
export type PluginSecretSourceOperationFailureV1 = z.infer<typeof PluginSecretSourceOperationFailureV1Schema>;

/** Metadata only. Native field values never belong in this envelope. */
export const PluginSecretSourceFieldV1Schema = lazyZodSchema(() => z.strictObject({
    account: z.string().check(z.minLength(1)), reference: z.string().check(z.minLength(1)),
    vault: z.strictObject({ id: z.string().check(z.minLength(1)), name: z.string() }),
    item: z.strictObject({ id: z.string().check(z.minLength(1)), title: z.string() }),
    field: z.strictObject({ id: z.string().check(z.minLength(1)), title: z.string(), kind: z.string() }),
}));
export type PluginSecretSourceFieldV1 = z.infer<typeof PluginSecretSourceFieldV1Schema>;
export const PluginSecretSourceListRequestV1Schema = lazyZodSchema(() => z.strictObject({
    account: z.string().check(z.minLength(1)), vaultId: z.optional(z.string().check(z.minLength(1))),
    itemId: z.optional(z.string().check(z.minLength(1))),
}));
export type PluginSecretSourceListRequestV1 = z.infer<typeof PluginSecretSourceListRequestV1Schema>;
export const PluginSecretSourceListResultV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ ok: z.literal(true), fields: z.readonly(z.array(PluginSecretSourceFieldV1Schema)),
        vaults: z.optional(z.readonly(z.array(PluginSecretSourceFieldV1Schema.shape.vault))) }),
    PluginSecretSourceOperationFailureV1Schema,
]));
export type PluginSecretSourceListResultV1 = z.infer<typeof PluginSecretSourceListResultV1Schema>;
/** Private request: never accepted as public Action input or recorded in history. */
export const PluginSecretSourceStoreRequestV1Schema = lazyZodSchema(() => z.strictObject({
    account: z.string().check(z.minLength(1)), vaultId: z.string().check(z.minLength(1)),
    title: z.string(), value: z.string(),
}));
export type PluginSecretSourceStoreRequestV1 = z.infer<typeof PluginSecretSourceStoreRequestV1Schema>;
export const PluginSecretSourceStoreResultV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ ok: z.literal(true), account: z.string().check(z.minLength(1)), reference: z.string().check(z.minLength(1)) }),
    PluginSecretSourceOperationFailureV1Schema,
]));
export type PluginSecretSourceStoreResultV1 = z.infer<typeof PluginSecretSourceStoreResultV1Schema>;
