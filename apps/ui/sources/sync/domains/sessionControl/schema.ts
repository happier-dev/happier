import { AgentModelOptionOverrideRuleReadSchema } from '@happier-dev/protocol';
import { z } from 'zod';

const SessionModeOptionSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
});

const SessionModesStateSchema = z.object({
    v: z.literal(1),
    agentId: z.string().trim().min(1),
    updatedAt: z.number(),
    currentModeId: z.string().trim().min(1),
    availableModes: z.array(SessionModeOptionSchema).default([]),
});

const SessionModelOptionChoiceSchema = z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
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
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    type: z.string().trim().min(1),
    currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    options: z.array(SessionModelOptionChoiceSchema).default([]),
    overridesWhenOn: SessionOptionOverrideRuleSchema.optional(),
});

const SessionModelSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    extendedContextModelId: z.string().trim().min(1).optional(),
    modelOptions: z.array(SessionModelOptionSchema).default([]),
});

const SessionModelsStateSchema = z.object({
    v: z.literal(1),
    agentId: z.string().trim().min(1),
    updatedAt: z.number(),
    currentModelId: z.string().trim().min(1),
    availableModels: z.array(SessionModelSchema).default([]),
});

const SessionConfigOptionSelectOptionSchema = z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
});

const SessionConfigOptionSelectGroupSchema = z.object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    options: z.array(SessionConfigOptionSelectOptionSchema),
});

const SessionConfigOptionSchema = z.object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    type: z.string().trim().min(1),
    currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    options: z.array(SessionConfigOptionSelectOptionSchema).optional(),
    groups: z.array(SessionConfigOptionSelectGroupSchema).optional(),
    overridesWhenOn: SessionOptionOverrideRuleSchema.optional(),
});

const SessionConfigOptionsStateSchema = z.object({
    v: z.literal(1),
    agentId: z.string().trim().min(1),
    updatedAt: z.number(),
    configOptions: z.array(SessionConfigOptionSchema).default([]),
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
    modeId: z.string().trim().min(1),
});

export type SessionModesState = z.infer<typeof SessionModesStateSchema>;
export type SessionModelsState = z.infer<typeof SessionModelsStateSchema>;
export type SessionConfigOptionsState = z.infer<typeof SessionConfigOptionsStateSchema>;
export type SessionConfigOptionOverridesState = z.infer<typeof SessionConfigOptionOverridesSchema>;
export type SessionModeOverrideState = z.infer<typeof SessionModeOverrideSchema>;

export function parseSessionModesState(raw: unknown): SessionModesState | null {
    const parsed = SessionModesStateSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
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
