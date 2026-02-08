import { z } from 'zod';

const AcpSessionModeOptionSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
});

const AcpSessionModesStateSchema = z.object({
    v: z.literal(1),
    provider: z.string().trim().min(1),
    updatedAt: z.number(),
    currentModeId: z.string().trim().min(1),
    availableModes: z.array(AcpSessionModeOptionSchema).default([]),
});

const AcpSessionModelSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
});

const AcpSessionModelsStateSchema = z.object({
    v: z.literal(1),
    provider: z.string().trim().min(1),
    updatedAt: z.number(),
    currentModelId: z.string().trim().min(1),
    availableModels: z.array(AcpSessionModelSchema).default([]),
});

const AcpConfigOptionSelectOptionSchema = z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
});

const AcpConfigOptionSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    type: z.string().trim().min(1),
    currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    options: z.array(AcpConfigOptionSelectOptionSchema).default([]),
});

const AcpConfigOptionsStateSchema = z.object({
    v: z.literal(1),
    provider: z.string().trim().min(1),
    updatedAt: z.number(),
    configOptions: z.array(AcpConfigOptionSchema).default([]),
});

const AcpConfigOptionOverridesSchema = z.object({
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

const AcpSessionModeOverrideSchema = z.object({
    v: z.literal(1),
    updatedAt: z.number(),
    modeId: z.string().trim().min(1),
});

export type AcpSessionModesState = z.infer<typeof AcpSessionModesStateSchema>;
export type AcpSessionModelsState = z.infer<typeof AcpSessionModelsStateSchema>;
export type AcpConfigOptionsState = z.infer<typeof AcpConfigOptionsStateSchema>;
export type AcpConfigOptionOverridesState = z.infer<typeof AcpConfigOptionOverridesSchema>;
export type AcpSessionModeOverrideState = z.infer<typeof AcpSessionModeOverrideSchema>;

export function parseAcpSessionModesState(raw: unknown): AcpSessionModesState | null {
    const parsed = AcpSessionModesStateSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export function parseAcpSessionModelsState(raw: unknown): AcpSessionModelsState | null {
    const parsed = AcpSessionModelsStateSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export function parseAcpConfigOptionsState(raw: unknown): AcpConfigOptionsState | null {
    const parsed = AcpConfigOptionsStateSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export function parseAcpConfigOptionOverridesState(raw: unknown): AcpConfigOptionOverridesState | null {
    const parsed = AcpConfigOptionOverridesSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export function parseAcpSessionModeOverrideState(raw: unknown): AcpSessionModeOverrideState | null {
    const parsed = AcpSessionModeOverrideSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}
