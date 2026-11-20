import { AgentModelOptionOverrideRuleReadSchema } from '@happier-dev/protocol/models/descriptor';
import { NonBlankOpaqueIdentifierSchema } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { readSessionModesMetadata, type SessionOwnerModeCatalogV2 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { z } from 'zod/mini';
import { optional } from 'zod/mini';

const NonBlankStringSchema = z.string().check(z.refine((value) => value.trim().length > 0));

const SessionModelOptionChoiceSchema = z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    name: NonBlankStringSchema,
    description: z.optional(z.string()),
});

const SessionConfigOptionSelectGroupSchema = z.object({
    id: NonBlankStringSchema,
    name: NonBlankStringSchema,
    options: z.array(SessionModelOptionChoiceSchema),
});

/**
 * Producer-declared rule: while this boolean option is effectively on, `optionIds` are not
 * user-controllable and (when `forcedValue` is present) actually run at that value. Zod strips
 * unknown keys by default, so this must stay declared on every option schema or the fact
 * silently disappears between the agent that authored it and the control the user sees.
 *
 * This is the canonical read-side schema itself, not a restatement of it:
 * `AgentModelOptionOverrideRuleReadSchema` owns the bounds AND the unknown-key policy (see its
 * doc comment in `packages/protocol/src/models/descriptor.ts`), shared with the CLI's fork-side
 * reader so the two cannot drift. `sync/domains/state/storageTypes` and
 * `sessionControl/configOptionsControl` both consume this binding rather than validating again.
 */
export const SessionOptionOverrideRuleSchema = AgentModelOptionOverrideRuleReadSchema;

const SessionModelOptionSchema = z.object({
    id: NonBlankStringSchema,
    name: NonBlankStringSchema,
    description: z.optional(z.string()),
    category: z.optional(z.string()),
    type: z.string().check(z.trim(), z.minLength(1)),
    currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    options: z._default(z.array(SessionModelOptionChoiceSchema), []),
    groups: z.optional(z.array(SessionConfigOptionSelectGroupSchema)),
    overridesWhenOn: optional(SessionOptionOverrideRuleSchema),
});

const SessionModelSchema = z.object({
    id: NonBlankStringSchema,
    name: NonBlankStringSchema,
    description: z.optional(z.string()),
    extendedContextModelId: z.optional(NonBlankOpaqueIdentifierSchema),
    modelOptions: z._default(z.array(SessionModelOptionSchema), []),
});

const SessionModelsStateSchema = z.object({
    v: z.literal(1),
    agentId: z.string().check(z.trim(), z.minLength(1)),
    updatedAt: z.number(),
    currentModelId: z.string().check(z.trim(), z.minLength(1)),
    availableModels: z._default(z.array(SessionModelSchema), []),
});

const SessionConfigOptionSchema = z.object({
    id: z.string().check(z.minLength(1)),
    name: NonBlankStringSchema,
    description: z.optional(z.string()),
    category: z.optional(z.string()),
    type: z.string().check(z.trim(), z.minLength(1)),
    currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    options: z.optional(z.array(SessionModelOptionChoiceSchema)),
    groups: z.optional(z.array(SessionConfigOptionSelectGroupSchema)),
    overridesWhenOn: optional(SessionOptionOverrideRuleSchema),
});

const SessionConfigOptionsStateSchema = z.object({
    v: z.literal(1),
    agentId: z.string().check(z.trim(), z.minLength(1)),
    updatedAt: z.number(),
    modelConfigOptionId: z.optional(NonBlankStringSchema),
    configOptions: z._default(z.array(SessionConfigOptionSchema), []),
});

const SessionConfigOptionOverridesSchema = z.object({
    v: z.literal(1),
    updatedAt: z.number(),
    overrides: z.record(
        z.string(),
        z.object({
            updatedAt: z.number(),
            value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        }),
    ),
});

const SessionModeOverrideSchema = z.object({
    v: z.literal(1),
    updatedAt: z.number(),
    modeId: z.string().check(z.trim(), z.minLength(1)),
});

export type SessionModesState = SessionOwnerModeCatalogV2;
export type SessionModelsState = z.infer<typeof SessionModelsStateSchema>;
export type SessionConfigOptionsState = z.infer<typeof SessionConfigOptionsStateSchema>;
export type SessionConfigOptionOverridesState = z.infer<typeof SessionConfigOptionOverridesSchema>;
export type SessionModeOverrideState = z.infer<typeof SessionModeOverrideSchema>;

export function parseSessionModesState(raw: unknown): SessionModesState | null {
    const isV2 = typeof raw === 'object' && raw !== null && 'v' in raw && raw.v === 2;
    return readSessionModesMetadata(isV2 ? { sessionModesV2: raw } : { sessionModesV1: raw });
}

export function parseSessionModelsState(raw: unknown): SessionModelsState | null {
    const parsed = SessionModelsStateSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export function parseSessionConfigOptionsState(raw: unknown): SessionConfigOptionsState | null {
    const parsed = SessionConfigOptionsStateSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export function parseSessionConfigOptionOverridesState(raw: unknown): SessionConfigOptionOverridesState | null {
    const parsed = SessionConfigOptionOverridesSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export function parseSessionModeOverrideState(raw: unknown): SessionModeOverrideState | null {
    const parsed = SessionModeOverrideSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export type AcpSessionModesState = SessionModesState;
export type AcpSessionModelsState = SessionModelsState;
export type AcpConfigOptionsState = SessionConfigOptionsState;
export type AcpConfigOptionOverridesState = SessionConfigOptionOverridesState;
export type AcpSessionModeOverrideState = SessionModeOverrideState;

export const parseAcpSessionModesState = parseSessionModesState;
export const parseAcpSessionModelsState = parseSessionModelsState;
export const parseAcpConfigOptionsState = parseSessionConfigOptionsState;
export const parseAcpConfigOptionOverridesState = parseSessionConfigOptionOverridesState;
export const parseAcpSessionModeOverrideState = parseSessionModeOverrideState;
