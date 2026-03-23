import { z } from 'zod';

const SessionModeOptionSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
});

const SessionModesStateSchema = z.object({
    v: z.literal(1),
    provider: z.string().trim().min(1),
    updatedAt: z.number(),
    currentModeId: z.string().trim().min(1),
    availableModes: z.array(SessionModeOptionSchema).default([]),
});

const SessionModelOptionChoiceSchema = z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
});

const SessionModelOptionSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    type: z.string().trim().min(1),
    currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    options: z.array(SessionModelOptionChoiceSchema).default([]),
});

const SessionModelSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    modelOptions: z.array(SessionModelOptionSchema).default([]),
});

const SessionModelsStateSchema = z.object({
    v: z.literal(1),
    provider: z.string().trim().min(1),
    updatedAt: z.number(),
    currentModelId: z.string().trim().min(1),
    availableModels: z.array(SessionModelSchema).default([]),
});

const SessionConfigOptionSelectOptionSchema = z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
});

const SessionConfigOptionSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    type: z.string().trim().min(1),
    currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    options: z.array(SessionConfigOptionSelectOptionSchema).default([]),
});

const SessionConfigOptionsStateSchema = z.object({
    v: z.literal(1),
    provider: z.string().trim().min(1),
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
