import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import {
    buildQualifiedPluginContributionKey,
    parseQualifiedPluginContributionKey,
} from '../plugins/contributionIdentity.js';
import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
} from './generatedBuiltInLegacyConnectedAccountCompatibility.js';
import { QualifiedConnectedAccountRefSchema } from './qualifiedConnectedAccountPersistence.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

export const ConnectedServiceIdSchema = lazyZodSchema(() => z.enum([
    'openai-codex',
    'openai',
    'anthropic',
    'claude-subscription',
    'gemini',
    'github',
    'bitbucket',
]));

export type ConnectedServiceId = z.infer<typeof ConnectedServiceIdSchema>;

/** Exact qualified identity key for a current Connected Account service. */
export const ConnectedAccountServiceKeySchema = lazyZodSchema(() => z
    .string()
    .refine(
        (value) => parseQualifiedPluginContributionKey(value) !== null,
        'Invalid qualified Connected Account service key',
    ));

export type ConnectedAccountServiceKey = z.infer<typeof ConnectedAccountServiceKeySchema>;

/**
 * Wire/persisted ingress for one Connected Account service key. Qualified
 * Plugin contribution keys pass through unchanged; released bundled scalar
 * service ids normalize through the sole legacy normalizer above (provenance
 * and removal condition are documented there). All other inputs — malformed,
 * non-canonical, or unknown scalar ids — are rejected with a typed issue.
 * Current writers emit canonical qualified keys only.
 */
export const ConnectedAccountServiceKeyIngressSchema = lazyZodSchema(() => z
    .string()
    .transform((value, context) => {
        const canonical = readBuiltInLegacyConnectedAccountServiceKeyIngress(value);
        if (!canonical) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Invalid Connected Account service key',
            });
            return z.NEVER;
        }
        return canonical;
    }));

export type ConnectedAccountServiceKeyIngress = z.infer<typeof ConnectedAccountServiceKeyIngressSchema>;

export const ConnectedServiceProfileIdSchema = lazyZodSchema(() => z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$/, 'Invalid profile id'));

export type ConnectedServiceProfileId = z.infer<typeof ConnectedServiceProfileIdSchema>;

export const ConnectedServiceAuthGroupIdSchema = lazyZodSchema(() => z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, 'Invalid connected service account group id'));

export type ConnectedServiceAuthGroupId = z.infer<typeof ConnectedServiceAuthGroupIdSchema>;

const ConnectedServiceNativeBindingV1Schema = lazyZodSchema(() => z
    .object({
        source: z.literal('native'),
    })
    .passthrough());

const ConnectedServiceProfileBindingV1Schema = lazyZodSchema(() => z
    .object({
        source: z.literal('connected'),
        selection: z.literal('profile').optional().default('profile'),
        profileId: ConnectedServiceProfileIdSchema,
    })
    .passthrough());

const ConnectedServiceGroupBindingV1Schema = lazyZodSchema(() => z
    .object({
        source: z.literal('connected'),
        selection: z.literal('group'),
        groupId: ConnectedServiceAuthGroupIdSchema,
        profileId: ConnectedServiceProfileIdSchema.optional(),
    })
    .passthrough());

export const ConnectedServiceBindingSelectionV1Schema = lazyZodSchema(() => z.union([
    ConnectedServiceNativeBindingV1Schema,
    ConnectedServiceGroupBindingV1Schema,
    ConnectedServiceProfileBindingV1Schema,
]));

export type ConnectedServiceBindingSelectionV1 = z.infer<typeof ConnectedServiceBindingSelectionV1Schema>;

export const TeamResourceBrokeredConnectedServiceSelectionV2Schema = lazyZodSchema(() => z.object({
    source: z.literal('team_resource'),
    resourceId: z.string().trim().min(1).max(256),
    deliveryMode: z.literal('brokered'),
    disclosedMember: z.never().optional(),
}).strict());

export const TeamResourceDirectConnectedServiceSelectionV2Schema = lazyZodSchema(() => z.object({
    source: z.literal('team_resource'),
    resourceId: z.string().trim().min(1).max(256),
    deliveryMode: z.literal('direct'),
    disclosedMember: asProtocolZod(QualifiedConnectedAccountRefSchema),
}).strict());

/**
 * Session-owned Team resource selection. Brokered selection carries only the
 * resource identity. Direct Pool use adds the disclosed member chosen by the
 * recipient; transport/currentness facts stay with their canonical owners.
 */
export const TeamResourceConnectedServiceSelectionV2Schema = lazyZodSchema(() => z.union([
    TeamResourceDirectConnectedServiceSelectionV2Schema,
    TeamResourceBrokeredConnectedServiceSelectionV2Schema,
]));

export type TeamResourceConnectedServiceSelectionV2 = z.infer<
    typeof TeamResourceConnectedServiceSelectionV2Schema
>;

export const ConnectedServiceBindingSelectionV2Schema = lazyZodSchema(() => z.union([
    ConnectedServiceNativeBindingV1Schema.strict(),
    ConnectedServiceGroupBindingV1Schema.strict(),
    ConnectedServiceProfileBindingV1Schema.strict(),
    TeamResourceConnectedServiceSelectionV2Schema,
]));

export type ConnectedServiceBindingSelectionV2 = z.infer<
    typeof ConnectedServiceBindingSelectionV2Schema
>;

const ConnectedServiceBindingsByServiceIdV2Schema = lazyZodSchema(() => z
    .record(z.string(), ConnectedServiceBindingSelectionV2Schema)
    .superRefine((bindings, ctx) => {
        for (const serviceId of Object.keys(bindings)) {
            if (!ConnectedAccountServiceKeySchema.safeParse(serviceId).success) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Invalid qualified Connected Account service key',
                    path: [serviceId],
                });
            }
        }
    }));

export const ConnectedServiceBindingsV2Schema = lazyZodSchema(() => z.object({
    v: z.literal(2),
    bindingsByServiceId: ConnectedServiceBindingsByServiceIdV2Schema.default({}),
}).strict());

export type ConnectedServiceBindingsV2 = z.infer<typeof ConnectedServiceBindingsV2Schema>;

export const PersistedConnectedServiceBindingSelectionV1Schema = lazyZodSchema(() => z.union([
    ConnectedServiceNativeBindingV1Schema.strict(),
    ConnectedServiceProfileBindingV1Schema.strict(),
    ConnectedServiceGroupBindingV1Schema.strict(),
]));

export type PersistedConnectedServiceBindingSelectionV1 = z.infer<
    typeof PersistedConnectedServiceBindingSelectionV1Schema
>;

const ConnectedServiceBindingsByServiceIdV1Schema = lazyZodSchema(() => z
    .record(z.string(), ConnectedServiceBindingSelectionV1Schema)
    .superRefine((bindings, ctx) => {
        for (const serviceId of Object.keys(bindings)) {
            if (!ConnectedAccountServiceKeySchema.safeParse(serviceId).success) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Invalid qualified Connected Account service key',
                    path: [serviceId],
                });
            }
        }
    }));

export const ConnectedServiceBindingsV1Schema = lazyZodSchema(() => z
    .object({
        v: z.literal(1),
        bindingsByServiceId: ConnectedServiceBindingsByServiceIdV1Schema.default({}),
    })
    .strict());

export type ConnectedServiceBindingsV1 = z.infer<typeof ConnectedServiceBindingsV1Schema>;

/**
 * The exact released bundled scalar service id behind a qualified Connected
 * Account service identity, read from the sole generated built-in mapping
 * above. Novel external services have no scalar member and return `null` —
 * never manufacture one. This is the typed inverse of
 * {@link readBuiltInLegacyConnectedAccountServiceKeyIngress} for the narrow,
 * named seams where a legacy consumer (bundled Agent author facts, released
 * V2/V3 account lookups) still requires the scalar id.
 */
export function readBuiltInLegacyConnectedServiceIdForQualifiedService(
    service: Readonly<{ pluginId: string; localId: string }>,
): ConnectedServiceId | null {
    for (const legacyServiceId of ConnectedServiceIdSchema.options) {
        const compatibility = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[legacyServiceId];
        if (
            compatibility
            && compatibility.service.pluginId === service.pluginId
            && compatibility.service.localId === service.localId
        ) {
            return legacyServiceId;
        }
    }
    return null;
}

export function readBuiltInLegacyConnectedAccountServiceKeyIngress(
    value: unknown,
): ConnectedAccountServiceKey | null {
    if (typeof value !== 'string') return null;
    if (parseQualifiedPluginContributionKey(value)) return value;
    const compatibility = Reflect.get(
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
        value,
    ) as { service?: { pluginId?: unknown; localId?: unknown } } | undefined;
    if (
        typeof compatibility?.service?.pluginId !== 'string'
        || typeof compatibility.service.localId !== 'string'
    ) {
        return null;
    }
    return ConnectedAccountServiceKeySchema.parse(buildQualifiedPluginContributionKey({
        pluginId: compatibility.service.pluginId,
        localId: compatibility.service.localId,
    }));
}

/**
 * Released bundled Sessions persisted scalar service ids before Connected
 * Account services had qualified identities. This is the sole ingress for
 * those historical bindings; all current schemas and writers use qualified
 * keys and arbitrary bare local ids remain invalid.
 */
export const BuiltInLegacyConnectedServiceBindingsV1IngressSchema = lazyZodSchema(() => z
    .object({
        v: z.literal(1),
        bindingsByServiceId: z.record(z.string(), PersistedConnectedServiceBindingSelectionV1Schema),
    })
    .strict()
    .superRefine((value, context) => {
        const canonicalKeys = new Set<string>();
        for (const serviceId of Object.keys(value.bindingsByServiceId)) {
            const canonicalKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
            if (!canonicalKey) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Unknown bundled legacy Connected Account service id',
                    path: ['bindingsByServiceId', serviceId],
                });
                continue;
            }
            if (canonicalKeys.has(canonicalKey)) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Duplicate canonical Connected Account service binding',
                    path: ['bindingsByServiceId', serviceId],
                });
            }
            canonicalKeys.add(canonicalKey);
        }
    })
    .transform((value) => ConnectedServiceBindingsV1Schema.parse({
        v: 1,
        bindingsByServiceId: Object.fromEntries(
            Object.entries(value.bindingsByServiceId).map(([serviceId, binding]) => {
                const canonicalKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
                if (!canonicalKey) throw new Error('Invalid bundled legacy Connected Account service id');
                return [canonicalKey, binding];
            }),
        ),
    })));

export const PersistedConnectedServiceBindingsV1Schema = lazyZodSchema(() => z
    .object({
        v: z.literal(1),
        bindingsByServiceId: z.record(
            z.string(),
            PersistedConnectedServiceBindingSelectionV1Schema,
        ).superRefine((bindings, ctx) => {
            for (const serviceId of Object.keys(bindings)) {
                if (ConnectedAccountServiceKeySchema.safeParse(serviceId).success) continue;
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Invalid qualified Connected Account service key',
                    path: [serviceId],
                });
            }
        }),
    })
    .strict());

export type PersistedConnectedServiceBindingsV1 = z.infer<
    typeof PersistedConnectedServiceBindingsV1Schema
>;

export const ConnectedServiceBindingsV2IngressSchema = lazyZodSchema(() => z.union([
    ConnectedServiceBindingsV2Schema,
    PersistedConnectedServiceBindingsV1Schema.transform((value) =>
        ConnectedServiceBindingsV2Schema.parse({
            v: 2,
            bindingsByServiceId: value.bindingsByServiceId,
        })),
    BuiltInLegacyConnectedServiceBindingsV1IngressSchema.transform((value) =>
        ConnectedServiceBindingsV2Schema.parse({
            v: 2,
            bindingsByServiceId: value.bindingsByServiceId,
        })),
]));
