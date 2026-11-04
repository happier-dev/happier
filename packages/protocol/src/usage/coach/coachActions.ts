import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { UsageQuerySchema } from '../../inputs/usageQuery.js';
import { SettingsDeclarationMutationReversalV1Schema, SettingsDeclarationValueV1Schema } from '../../actions/settingsDeclarationActionFamily.js';
import { SessionModelMutationReversalV1Schema } from '../../sessions/control/modelTransitionV1.js';
import { McpRulesSetItemResultV1Schema } from '../../actions/specs/capabilityRules.js';
import { UsageCoachRemedySchema } from './coachRemedy.js';
import { UsageCoachSuppressionV1Schema } from '../../account/settings/usageCoachPreferencesV1.js';

export const USAGE_COACH_SUPPRESSIONS_KV_KEY = 'workspace:usage-coach:suppressions';
export const UsageCoachSuppressionStateV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), suppressions: z.array(UsageCoachSuppressionV1Schema),
}));
export type UsageCoachSuppressionStateV1 = z.infer<typeof UsageCoachSuppressionStateV1Schema>;
/** Extract retained dismissal data independently of obsolete preference fields. */
export function readLegacyUsageCoachSuppressions(value: unknown): UsageCoachSuppressionStateV1['suppressions'] {
    const suppressions = value !== null && typeof value === 'object' && 'suppressions' in value ? value.suppressions : undefined;
    return suppressions === undefined ? [] : UsageCoachSuppressionStateV1Schema.parse({ v: 1, suppressions }).suppressions;
}
export type UsageCoachSuppressionEdit = Readonly<{ evidenceKey: string } & ({ dismissed: boolean } | { untilMs: number | null })>;
export type UsageCoachSuppressionPort = Readonly<{
    read(): Promise<UsageCoachSuppressionStateV1>;
    convertLegacy(): Promise<void>;
    edit(request: UsageCoachSuppressionEdit): Promise<void>;
}>;

/** Reuse Account JSON KV's mode-aware CAS transport; the Coach owns conversion and edits. */
export function createUsageCoachSuppressionPort(input: Readonly<{
    transport: {
        read(): Promise<Readonly<{ value: unknown | null; version: number }>>;
        compareAndSet(value: unknown, version: number): Promise<Readonly<{ success: true; version: number }>
            | Readonly<{ success: false; value: unknown | null; version: number }>>;
    };
    readLegacy(): Promise<readonly z.infer<typeof UsageCoachSuppressionV1Schema>[]>;
}>): UsageCoachSuppressionPort {
    const read = async () => {
        const row = await input.transport.read();
        // An explicit empty current record is authoritative after Restore.
        return { version: row.version, state: row.value === null
            ? { v: 1 as const, suppressions: [...await input.readLegacy()] }
            : UsageCoachSuppressionStateV1Schema.parse(row.value), legacy: row.value === null };
    };
    const write = async (state: UsageCoachSuppressionStateV1, version: number) => {
        const result = await input.transport.compareAndSet(state, version);
        if (!result.success) throw Object.assign(new Error('Coach suppressions changed; retry the edit'), { code: 'version_mismatch' });
    };
    return {
        async read() {
            const row = await read();
            return row.state;
        },
        async convertLegacy() {
            const row = await read();
            // A deliberate preference edit may replace the legacy container.
            if (row.legacy && row.state.suppressions.length) await write(row.state, row.version);
        },
        async edit(request) {
            const row = await read();
            const suppressions = row.state.suppressions.filter(item => item.evidenceKey !== request.evidenceKey);
            if ('dismissed' in request && request.dismissed) suppressions.push({ kind: 'dismissed', evidenceKey: request.evidenceKey });
            if ('untilMs' in request && request.untilMs !== null)
                suppressions.push({ kind: 'snoozed', evidenceKey: request.evidenceKey, untilMs: request.untilMs });
            await write({ v: 1, suppressions }, row.version);
        },
    };
}

const identity = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const reference = lazyZodSchema(() => z.strictObject({ query: UsageQuerySchema, evidenceKey: identity }));
/** Stateless owner results; each owner validates its own atomic restore contract. */
export const UsageCoachReversalSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('setting'), anchor: identity, appliedValue: SettingsDeclarationValueV1Schema,
        owner: SettingsDeclarationMutationReversalV1Schema }),
    z.strictObject({ kind: z.literal('model'), sessionId: identity, owner: SessionModelMutationReversalV1Schema }),
    z.strictObject({ kind: z.literal('mcp_binding'), owner: McpRulesSetItemResultV1Schema,
        appliedRevision: z.number().check(z.int(), z.nonnegative(), z.int()) }),
]));
export type UsageCoachReversal = z.infer<typeof UsageCoachReversalSchema>;
export const UsageCoachApplyInputSchema = reference;
export const UsageCoachUndoInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(reference, { reversal: UsageCoachReversalSchema })));
export const UsageCoachDismissInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(reference, { dismissed: z.boolean() })));
export const UsageCoachSnoozeInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(reference, { untilMs: z.nullable(z.number().check(z.int(), z.nonnegative(), z.int())) })));
export const UsageCoachApplyResultSchema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('applied'), evidenceKey: identity, remedy: UsageCoachRemedySchema,
    reversal: z.optional(UsageCoachReversalSchema),
    spawnedSessionId: z.optional(identity),
    reversalUnavailableReason: z.optional(z.enum(['not_reversible', 'no_change'])),
}));
export const UsageCoachUndoResultSchema = lazyZodSchema(() => z.strictObject({ kind: z.literal('undone'), evidenceKey: identity }));
export const UsageCoachPreferenceResultSchema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('preference_updated'), evidenceKey: identity,
    dismissed: z.optional(z.boolean()), untilMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative(), z.int()))),
}));
