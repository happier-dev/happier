import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { SessionOwnerMetadataV1Schema } from '../sessions/metadata/sessionMetadataSchemasV1.js';
import { isApiTokenGrantActionAllowedV1, type ApiTokenGrantV1 } from '../auth/apiTokenGrant.js';
import { SessionModelSetResultV1Schema } from '../sessions/control/modelTransitionV1.js';
import { projectSessionModelSelectionV2ToV1 } from '../providers/selection/v2.js';
import { parseSessionPermissionModeAlias } from '../sessions/metadata/sessionPermissionModes.js';

/** The input consumed by the existing Session model/config-option readers, never a complete owner view. */
export const ComposerOptionsInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.pick(SessionOwnerMetadataV1Schema.shape.runtime._zod.def.innerType, {
    sessionModelsV1: true,
    acpSessionModelsV1: true,
    modelSelectionIntentV1: true,
    modelOverrideV1: true,
    sessionConfigOptionOverridesV1: true,
    acpConfigOptionOverridesV1: true,
    sessionConfigOptionsV1: true,
    acpConfigOptionsV1: true,
    permissionMode: true,
    permissionModeUpdatedAt: true,
})));

export type ComposerOptionsInputV1 = z.infer<typeof ComposerOptionsInputV1Schema>;

/** Select before parsing: unrelated owner metadata never enters the transported projection. */
export function projectComposerOptionsInputV1(metadata: unknown, grant?: ApiTokenGrantV1 | null): ComposerOptionsInputV1 {
    const record = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : {};
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(ComposerOptionsInputV1Schema.shape)) {
        if (grant !== undefined) {
            const control = key === 'permissionMode' || key === 'permissionModeUpdatedAt' ? 'session.permission_mode.set'
                : key === 'modelOverrideV1' || key === 'modelSelectionIntentV1' || key === 'sessionModelsV1' || key === 'acpSessionModelsV1'
                    ? 'session.model.set' : null;
            if (control && (!grant || !isApiTokenGrantActionAllowedV1(grant, control))) continue;
        }
        if (record[key] !== undefined) projected[key] = record[key];
    }
    return ComposerOptionsInputV1Schema.parse(projected);
}

/** Acknowledged control facts replace only this bound Session's in-memory projection. */
export function applyComposerControlAcknowledgementV1(input: Readonly<{
    sessionId: string;
    options: ComposerOptionsInputV1;
    actionId: string;
    result: unknown;
}>): ComposerOptionsInputV1 {
    const result = input.result !== null && typeof input.result === 'object' && !Array.isArray(input.result)
        ? input.result as Record<string, unknown> : null;
    if (result?.ok !== true || result.sessionId !== input.sessionId) return input.options;
    if (input.actionId === 'session.permission_mode.set') {
        const mode = typeof result.permissionMode === 'string' ? parseSessionPermissionModeAlias(result.permissionMode) : null;
        if (!mode || typeof result.updatedAt !== 'number' || !Number.isFinite(result.updatedAt) || result.updatedAt < 0) return input.options;
        return ComposerOptionsInputV1Schema.parse({ ...input.options, permissionMode: mode, permissionModeUpdatedAt: result.updatedAt });
    }
    if (input.actionId !== 'session.model.set') return input.options;
    const parsed = SessionModelSetResultV1Schema.safeParse(result);
    if (!parsed.success) return input.options;
    const model = parsed.data;
    const selection = model.status === 'intent_updated'
        ? 'ref' in model.selection ? projectSessionModelSelectionV2ToV1(model.selection)?.ref : model.selection
        : model.activeSelection;
    if (!selection) return input.options;
    // Active acknowledgements have no intent clock. Retain the existing clock rather
    // than inventing a local timestamp; an armed result reports the still-active model.
    const updatedAt = model.status === 'intent_updated' ? model.updatedAt
        : input.options.modelSelectionIntentV1?.updatedAt ?? input.options.modelOverrideV1?.updatedAt ?? 0;
    const { modelOverrideV1: _legacyOverride, ...options } = input.options;
    return ComposerOptionsInputV1Schema.parse({ ...options, modelSelectionIntentV1: { v: 1, selection, updatedAt } });
}

/** Closed V1 frame projection. Session binding is checked again after authenticated opening. */
export const EmbedSessionOptionsV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    owner: ComposerOptionsInputV1Schema,
}));

export type EmbedSessionOptionsV1 = z.infer<typeof EmbedSessionOptionsV1Schema>;
