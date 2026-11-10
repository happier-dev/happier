import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
    buildQualifiedPluginContributionKey,
    parseQualifiedPluginContributionKey,
} from '../plugins/contributionIdentity.js';
import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    type BuiltInLegacyConnectedAccountOperation,
    type BuiltInLegacyConnectedServiceId,
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

export type QualifiedConnectedAccountLegacyPeerClass =
    | "exact_v0_2_1"
    | "revisioned_v2_v3";

/** The generated released-peer projection is the sole operation authority. */
export function isBuiltInLegacyConnectedAccountPeerOperationSupported(
    params: Readonly<{
        serviceId: string;
        peerClass: QualifiedConnectedAccountLegacyPeerClass;
        operation: BuiltInLegacyConnectedAccountOperation;
    }>,
): boolean {
    const compatibility =
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
            params.serviceId as BuiltInLegacyConnectedServiceId
        ];
    if (!compatibility) return false;
    const operations: readonly BuiltInLegacyConnectedAccountOperation[] =
        params.peerClass === "exact_v0_2_1"
            ? compatibility.peerOperations.exactV0_2_1
            : compatibility.peerOperations.revisionedV2V3;
    return operations.includes(params.operation);
}

/** Exact qualified identity key for a current Connected Account service. */
export const ConnectedAccountServiceKeySchema = lazyZodSchema(() => z
    .string().check(z.refine((value) => parseQualifiedPluginContributionKey(value) !== null, 'Invalid qualified Connected Account service key')));

export type ConnectedAccountServiceKey = z.infer<typeof ConnectedAccountServiceKeySchema>;

/**
 * Wire/persisted ingress for one Connected Account service key. Qualified
 * Plugin contribution keys pass through unchanged; released bundled scalar
 * service ids normalize through the sole legacy normalizer above (provenance
 * and removal condition are documented there). All other inputs — malformed,
 * non-canonical, or unknown scalar ids — are rejected with a typed issue.
 * Current writers emit canonical qualified keys only.
 */
export const ConnectedAccountServiceKeyIngressSchema = lazyZodSchema(() => z.pipe(z
    .string(), z.transform((value, context) => {
        const canonical = readBuiltInLegacyConnectedAccountServiceKeyIngress(value);
        if (!canonical) {
            context.issues.push({
                code: "custom",
                message: 'Invalid Connected Account service key', input: context.value });
            return z.NEVER;
        }
        return canonical;
    })));

export type ConnectedAccountServiceKeyIngress = z.infer<typeof ConnectedAccountServiceKeyIngressSchema>;

export const ConnectedServiceProfileIdSchema = lazyZodSchema(() => z
    .string().check(z.minLength(1), z.maxLength(64), z.regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$/, 'Invalid profile id')));

export type ConnectedServiceProfileId = z.infer<typeof ConnectedServiceProfileIdSchema>;

export const ConnectedServiceAuthGroupIdSchema = lazyZodSchema(() => z
    .string().check(z.trim(), z.minLength(1), z.maxLength(64), z.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, 'Invalid connected service account group id')));

export type ConnectedServiceAuthGroupId = z.infer<typeof ConnectedServiceAuthGroupIdSchema>;

const ConnectedServiceNativeBindingV1Schema = lazyZodSchema(() => z.looseObject({
        source: z.literal('native'),
    }));

const ConnectedServiceProfileBindingV1Schema = lazyZodSchema(() => z.looseObject({
        source: z.literal('connected'),
        selection: z._default(z.optional(z.literal('profile')), 'profile'),
        profileId: ConnectedServiceProfileIdSchema,
    }));

const ConnectedServiceGroupBindingV1Schema = lazyZodSchema(() => z.looseObject({
        source: z.literal('connected'),
        selection: z.literal('group'),
        groupId: ConnectedServiceAuthGroupIdSchema,
        profileId: z.optional(ConnectedServiceProfileIdSchema),
        appliedProfileId: z.optional(ConnectedServiceProfileIdSchema),
    }));

export const ConnectedServiceBindingSelectionV1Schema = lazyZodSchema(() => z.union([
    ConnectedServiceNativeBindingV1Schema,
    ConnectedServiceGroupBindingV1Schema,
    ConnectedServiceProfileBindingV1Schema,
]));

export type ConnectedServiceBindingSelectionV1 = z.infer<typeof ConnectedServiceBindingSelectionV1Schema>;

export const TeamResourceBrokeredConnectedServiceSelectionV2Schema = lazyZodSchema(() => z.strictObject({
    source: z.literal('team_resource'),
    resourceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    deliveryMode: z.literal('brokered'),
}));

export const TeamResourceDirectConnectedServiceSelectionV2Schema = lazyZodSchema(() => z.strictObject({
    source: z.literal('team_resource'),
    resourceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    deliveryMode: z.literal('direct'),
    disclosedMember: asProtocolZod(QualifiedConnectedAccountRefSchema),
}));

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

/** The exact Session/recipient selection identity, independent of absent optional wire fields. */
export function teamResourceConnectedServiceSelectionKey(binding: TeamResourceConnectedServiceSelectionV2): string {
    return JSON.stringify([
        binding.resourceId,
        binding.deliveryMode,
        binding.deliveryMode === 'direct' ? buildQualifiedPluginContributionKey(binding.disclosedMember.service) : null,
        binding.deliveryMode === 'direct' ? binding.disclosedMember.accountId : null,
    ]);
}

export function areTeamResourceConnectedServiceSelectionsEqual(
    left: TeamResourceConnectedServiceSelectionV2,
    right: TeamResourceConnectedServiceSelectionV2,
): boolean {
    return teamResourceConnectedServiceSelectionKey(left) === teamResourceConnectedServiceSelectionKey(right);
}

export const ConnectedServiceBindingSelectionV2Schema = lazyZodSchema(() => z.union([
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ConnectedServiceNativeBindingV1Schema),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ConnectedServiceGroupBindingV1Schema),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ConnectedServiceProfileBindingV1Schema),
    TeamResourceConnectedServiceSelectionV2Schema,
]));

export type ConnectedServiceBindingSelectionV2 = z.infer<
    typeof ConnectedServiceBindingSelectionV2Schema
>;

const ConnectedServiceBindingsByServiceIdV2Schema = lazyZodSchema(() => z
    .record(z.string(), ConnectedServiceBindingSelectionV2Schema).check(z.superRefine((bindings, ctx) => {
        for (const serviceId of Object.keys(bindings)) {
            if (!ConnectedAccountServiceKeySchema.safeParse(serviceId).success) {
                ctx.addIssue({
                    code: "custom",
                    message: 'Invalid qualified Connected Account service key',
                    path: [serviceId],
                });
            }
        }
    })));

export const ConnectedServiceBindingsV2Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(2),
    bindingsByServiceId: z._default(ConnectedServiceBindingsByServiceIdV2Schema, {}),
}));

export type ConnectedServiceBindingsV2 = z.infer<typeof ConnectedServiceBindingsV2Schema>;

/** Reuse selection identities, never a Pool's currently materialized member. */
export function projectConnectedServiceBindingsForChild(bindings: ConnectedServiceBindingsV2): ConnectedServiceBindingsV2 {
    const parsed = ConnectedServiceBindingsV2Schema.parse(bindings);
    return { v: 2, bindingsByServiceId: Object.fromEntries(Object.entries(parsed.bindingsByServiceId).map(([serviceId, binding]) => [
        serviceId, binding.source === 'connected' && binding.selection === 'group'
            ? { source: 'connected' as const, selection: 'group' as const, groupId: binding.groupId }
            : binding,
    ] as const)) };
}

/** Caller ingress owns explicit selections; only omitted same-Agent choices inherit. */
export function resolveConnectedServiceBindingsForChild<T>(input: Readonly<{
    explicitSelection: T;
    resolvedTargetKey: string | null | undefined;
    originTargetKey: string | null | undefined;
    originBindings: ConnectedServiceBindingsV2 | null | undefined;
}>): T | ConnectedServiceBindingsV2 | null | undefined {
    if (input.explicitSelection !== undefined) return input.explicitSelection;
    if (!input.resolvedTargetKey || input.resolvedTargetKey !== input.originTargetKey
        || input.originBindings === undefined) return undefined;
    return input.originBindings === null ? null : projectConnectedServiceBindingsForChild(input.originBindings);
}

export const PersistedConnectedServiceBindingSelectionV1Schema = lazyZodSchema(() => z.union([
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ConnectedServiceNativeBindingV1Schema),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ConnectedServiceProfileBindingV1Schema),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ConnectedServiceGroupBindingV1Schema),
]));

export type PersistedConnectedServiceBindingSelectionV1 = z.infer<
    typeof PersistedConnectedServiceBindingSelectionV1Schema
>;

const ConnectedServiceBindingsByServiceIdV1Schema = lazyZodSchema(() => z
    .record(z.string(), ConnectedServiceBindingSelectionV1Schema).check(z.superRefine((bindings, ctx) => {
        for (const serviceId of Object.keys(bindings)) {
            if (!ConnectedAccountServiceKeySchema.safeParse(serviceId).success) {
                ctx.addIssue({
                    code: "custom",
                    message: 'Invalid qualified Connected Account service key',
                    path: [serviceId],
                });
            }
        }
    })));

export const ConnectedServiceBindingsV1Schema = lazyZodSchema(() => z.strictObject({
        v: z.literal(1),
        bindingsByServiceId: z._default(ConnectedServiceBindingsByServiceIdV1Schema, {}),
    }));

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
export const BuiltInLegacyConnectedServiceBindingsV1IngressSchema = lazyZodSchema(() => z.pipe(z.strictObject({
        v: z.literal(1),
        bindingsByServiceId: z.record(z.string(), PersistedConnectedServiceBindingSelectionV1Schema),
    }).check(z.superRefine((value, context) => {
        const canonicalKeys = new Set<string>();
        for (const serviceId of Object.keys(value.bindingsByServiceId)) {
            const canonicalKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
            if (!canonicalKey) {
                context.addIssue({
                    code: "custom",
                    message: 'Unknown bundled legacy Connected Account service id',
                    path: ['bindingsByServiceId', serviceId],
                });
                continue;
            }
            if (canonicalKeys.has(canonicalKey)) {
                context.addIssue({
                    code: "custom",
                    message: 'Duplicate canonical Connected Account service binding',
                    path: ['bindingsByServiceId', serviceId],
                });
            }
            canonicalKeys.add(canonicalKey);
        }
    })), z.transform((value) => ConnectedServiceBindingsV1Schema.parse({
        v: 1,
        bindingsByServiceId: Object.fromEntries(
            Object.entries(value.bindingsByServiceId).map(([serviceId, binding]) => {
                const canonicalKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
                if (!canonicalKey) throw new Error('Invalid bundled legacy Connected Account service id');
                return [canonicalKey, binding];
            }),
        ),
    }))));

export const PersistedConnectedServiceBindingsV1Schema = lazyZodSchema(() => z.strictObject({
        v: z.literal(1),
        bindingsByServiceId: z.record(
            z.string(),
            PersistedConnectedServiceBindingSelectionV1Schema,
        ).check(z.superRefine((bindings, ctx) => {
            for (const serviceId of Object.keys(bindings)) {
                if (ConnectedAccountServiceKeySchema.safeParse(serviceId).success) continue;
                ctx.addIssue({
                    code: "custom",
                    message: 'Invalid qualified Connected Account service key',
                    path: [serviceId],
                });
            }
        })),
    }));

export type PersistedConnectedServiceBindingsV1 = z.infer<
    typeof PersistedConnectedServiceBindingsV1Schema
>;

export const ConnectedServiceBindingsV2IngressSchema = lazyZodSchema(() => z.union([
    ConnectedServiceBindingsV2Schema,
    z.pipe(PersistedConnectedServiceBindingsV1Schema, z.transform((value) =>
        ConnectedServiceBindingsV2Schema.parse({
            v: 2,
            bindingsByServiceId: value.bindingsByServiceId,
        }))),
    z.pipe(BuiltInLegacyConnectedServiceBindingsV1IngressSchema, z.transform((value) =>
        ConnectedServiceBindingsV2Schema.parse({
            v: 2,
            bindingsByServiceId: value.bindingsByServiceId,
        }))),
]));
