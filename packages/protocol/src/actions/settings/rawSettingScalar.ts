import { SettingsDeclarationMutationReversalV1Schema } from '../settingsDeclarationActionFamily.js';

/** Exact raw presence for conditional Undo, distinct from a recovered preference default. */
export function readRawSettingScalarV1(raw: Readonly<Record<string, unknown>>, key: string) {
    const parsed = SettingsDeclarationMutationReversalV1Schema.shape.before.safeParse(
        Object.hasOwn(raw, key) ? { value: raw[key] } : { unset: true },
    );
    return parsed.success ? parsed.data : null;
}
