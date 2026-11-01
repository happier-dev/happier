import { isReservedThemeProfileId, isRouteSafeThemeProfileId } from './themeProfileImportExport';
import { parseThemeProfile } from './themeProfilePersistence';
import type { ThemeProfileMigrationEdit, ThemeProfileMigrationIntent, ThemeProfileV1 } from './themeProfileTypes';

const key = (edit: ThemeProfileMigrationEdit) => `${edit.target.kind}:${edit.target.id}`;
const isRecord = (value: unknown): value is Record<string, unknown> => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
);

function parseLegacyProfileIds(value: unknown): Readonly<Record<string, string>> {
    if (!isRecord(value)) throw new Error('Invalid pending legacy theme identities');
    const entries = Object.entries(value).map(([id, displayed]): [string, string] => {
        if (!isRouteSafeThemeProfileId(id) || isReservedThemeProfileId(id)
            || typeof displayed !== 'string' || !isRouteSafeThemeProfileId(displayed) || isReservedThemeProfileId(displayed)) {
            throw new Error('Invalid pending legacy theme identity');
        }
        return [id, displayed];
    });
    return Object.fromEntries(entries);
}

/** Pending-record metadata is never an account preference or part of the server document. */
export function parseThemeProfileMigrationIntent(value: unknown): ThemeProfileMigrationIntent | null {
    if (value === undefined) return null;
    if (!isRecord(value) || !Array.isArray(value.edits) || !isRecord(value.legacyProfileIds)) {
        throw new Error('Invalid pending theme migration intent');
    }
    const legacyProfileIds = parseLegacyProfileIds(value.legacyProfileIds);
    const representedLegacyProfileIds = value.representedLegacyProfileIds === undefined ? {}
        : parseLegacyProfileIds(value.representedLegacyProfileIds);
    const attemptedLegacyProfileIds = value.attemptedLegacyProfileIds === undefined ? {}
        : parseLegacyProfileIds(value.attemptedLegacyProfileIds);
    const edits = value.edits.map((entry): ThemeProfileMigrationEdit => {
        if (!isRecord(entry) || !isRecord(entry.target)
            || (entry.target.kind !== 'account' && entry.target.kind !== 'legacy')
            || typeof entry.target.id !== 'string' || !isRouteSafeThemeProfileId(entry.target.id)
            || isReservedThemeProfileId(entry.target.id)) throw new Error('Invalid pending theme migration target');
        const profile = entry.profile === null ? null : parseThemeProfile(entry.profile)?.profile;
        if (profile === undefined) throw new Error('Invalid pending theme migration profile');
        return { target: { kind: entry.target.kind, id: entry.target.id }, profile };
    });
    if (value.acknowledged !== undefined && value.acknowledged !== true) {
        throw new Error('Invalid pending theme migration acknowledgement');
    }
    return { edits, legacyProfileIds, representedLegacyProfileIds, attemptedLegacyProfileIds,
        ...(value.acknowledged === true ? { acknowledged: true } : {}) };
}

export function mergeThemeProfileMigrationEdits(
    previous: readonly ThemeProfileMigrationEdit[], next: readonly ThemeProfileMigrationEdit[],
): readonly ThemeProfileMigrationEdit[] {
    const edits = new Map(previous.map(edit => [key(edit), edit]));
    for (const edit of next) edits.set(key(edit), edit);
    return [...edits.values()];
}

export function applyThemeProfileMigrationEdits(
    profiles: readonly ThemeProfileV1[], edits: readonly ThemeProfileMigrationEdit[],
    legacyProfileIds: ReadonlyMap<string, string>,
): readonly ThemeProfileV1[] {
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

export function removeCommittedThemeProfileMigrationEdits(
    current: readonly ThemeProfileMigrationEdit[], submitted: readonly ThemeProfileMigrationEdit[],
): readonly ThemeProfileMigrationEdit[] {
    const committed = new Map(submitted.map(edit => [key(edit), JSON.stringify(edit)]));
    return current.filter(edit => committed.get(key(edit)) !== JSON.stringify(edit));
}

export function rebaseThemeProfileMigrationEdits(
    edits: readonly ThemeProfileMigrationEdit[], legacyProfileIds: ReadonlyMap<string, string>,
): readonly ThemeProfileMigrationEdit[] {
    return edits.map((edit): ThemeProfileMigrationEdit => {
        if (edit.target.kind === 'account') return edit;
        const id = legacyProfileIds.get(edit.target.id);
        if (!id) throw new Error('Pending theme migration target is unavailable');
        return { target: { kind: 'account', id }, profile: edit.profile ? { ...edit.profile, id } : null };
    });
}
