import { z } from 'zod/mini';
import { ThemeProfileIdSchema, ThemeProfileV1Schema, isReservedThemeProfileId } from '@happier-dev/protocol/account/settings/themeProfiles';
import { mergeThemeProfileLibraries } from './themeProfileLibraryComposition';
import type { ThemeProfileMigrationEdit, ThemeProfileMigrationIntent, ThemeProfilesLocalStateV1, ThemeProfileV1 } from './themeProfileTypes';

const customId = ThemeProfileIdSchema.check(z.refine(id => !isReservedThemeProfileId(id)));
const intentSchema = z.strictObject({
    edits: z.array(z.strictObject({ target: z.strictObject({ kind: z.enum(['account', 'legacy']), id: customId }), profile: z.nullable(ThemeProfileV1Schema) })),
    legacyProfileIds: z.record(customId, customId),
    representedLegacyProfileIds: z.optional(z.record(customId, customId)),
    attemptedLegacyProfileIds: z.optional(z.record(customId, customId)),
    acknowledged: z.optional(z.literal(true)),
    replaceLibrary: z.optional(z.literal(true)),
});
export function parseThemeProfileMigrationIntent(value: unknown): ThemeProfileMigrationIntent | null {
    if (value === undefined) return null;
    const parsed = intentSchema.safeParse(value);
    if (!parsed.success) throw new Error('Invalid pending theme migration intent');
    return parsed.data;
}

export function applyThemeProfileMigrationEdits(profiles: readonly ThemeProfileV1[], edits: readonly ThemeProfileMigrationEdit[], legacyProfileIds: ReadonlyMap<string, string>): readonly ThemeProfileV1[] {
    let next = [...profiles];
    for (const edit of edits) {
        const id = edit.target.kind === 'legacy' ? legacyProfileIds.get(edit.target.id) : edit.target.id;
        if (!id) throw new Error('Pending theme migration target is unavailable');
        const index = next.findIndex(profile => profile.id === id);
        if (edit.profile === null) next = next.filter(profile => profile.id !== id);
        else if (index < 0) next.push({ ...edit.profile, id });
        else next[index] = { ...edit.profile, id };
    }
    return next;
}

/** Apply edits at their captured authority before importing the immutable backup. */
export function projectThemeProfileMigration(
    profiles: readonly ThemeProfileV1[], legacy: ThemeProfilesLocalStateV1,
    intent: ThemeProfileMigrationIntent | null | undefined, pendingProfiles?: readonly ThemeProfileV1[],
): Readonly<{ profiles: readonly ThemeProfileV1[]; legacyProfileIds: ReadonlyMap<string, string>; legacy: ThemeProfilesLocalStateV1 }> {
    if (!intent) return legacy.profiles.length
        ? { ...mergeThemeProfileLibraries(profiles, legacy), legacy }
        : { profiles, legacyProfileIds: new Map(), legacy };
    if (intent.acknowledged || intent.replaceLibrary) {
        if (intent.replaceLibrary && !intent.acknowledged && !pendingProfiles) throw new Error('Pending theme replacement library is unavailable');
        const checkpoint = pendingProfiles ?? profiles;
        const ids = new Set(checkpoint.map(profile => profile.id));
        return { profiles: checkpoint, legacy: { ...legacy, profiles: [] }, legacyProfileIds: new Map([...Object.entries(intent.representedLegacyProfileIds ?? {}), ...Object.entries(intent.legacyProfileIds)].filter(([, id]) => ids.has(id))) };
    }
    const accountEdits = intent.edits.filter(edit => edit.target.kind === 'account');
    const accountTargets = new Set(accountEdits.map(edit => edit.target.id));
    const consumed = new Map([...Object.entries(intent.representedLegacyProfileIds ?? {}), ...Object.entries(intent.legacyProfileIds).filter(([, id]) => accountTargets.has(id))]);
    const backup = legacy.profiles.filter(profile => !consumed.has(profile.id));
    const originalIds = new Map(legacy.profiles.map(profile => [profile.id, profile.id]));
    const projectedLegacy = { ...legacy, profiles: applyThemeProfileMigrationEdits(backup, intent.edits.filter(edit => edit.target.kind === 'legacy' && !consumed.has(edit.target.id)), originalIds) };
    const merged = mergeThemeProfileLibraries(profiles, projectedLegacy, intent.attemptedLegacyProfileIds ?? intent.legacyProfileIds);
    const result = applyThemeProfileMigrationEdits(merged.profiles, accountEdits, merged.legacyProfileIds);
    const ids = new Set(result.map(profile => profile.id));
    const actualIds = new Map([...merged.legacyProfileIds, ...consumed]);
    for (const [original, id] of actualIds) if (!ids.has(id)) actualIds.delete(original);
    return { profiles: result, legacy: projectedLegacy, legacyProfileIds: actualIds };
}
