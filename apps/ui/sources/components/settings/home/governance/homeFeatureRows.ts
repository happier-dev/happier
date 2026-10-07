import { FEATURE_IDS, isFeatureServerRepresented, type FeatureId } from '@happier-dev/protocol/features/catalog';
import { listFeatureDependents } from '@happier-dev/protocol/features/featureDecisionEngine';
import type { FeatureDecision } from '@happier-dev/protocol/features/decision';
import type { HomeSettingEntryV1, HomeSettingsProjectionV1 } from '@happier-dev/protocol/home/governance';

import { isHomeSettingWritable } from './homeSettingDeclaration';

/**
 * The Features page's reading of a Home's settings (plan §3.8).
 *
 * Every server feature is a registry switch (`section: 'features'`, `featureId`, boolean
 * `…__ENABLED`); the same family's other `features` keys are its limits and modes. Why a feature is
 * on or off is the Home's `featureDecisions` — build policy, the switch, then dependency closure with
 * a typed `blockingDependencyId` — read as given: the page never recomputes the closure (I9).
 */

/** The approved Common ten, in the order the console lists them. */
export const HOME_COMMON_FEATURE_IDS = [
    'teams',
    'sharing.session',
    'automations',
    'workflows',
    'search',
    'voice',
    'machines.pools',
    'sessions.ephemeralRunner',
    'plugins',
    'teams.credentialResources',
] as const satisfies readonly FeatureId[];

/** Families with one member are listed together under "Other". */
export const HOME_OTHER_FEATURE_FAMILY = 'other';

export type HomeFeatureRowState =
    | Readonly<{ kind: 'on' }>
    | Readonly<{ kind: 'off' }>
    /** The Home owner turned it off. */
    | Readonly<{ kind: 'offHome' }>
    /** The deployment set the key; the switch is locked. */
    | Readonly<{ kind: 'fixed'; key: string; on: boolean }>
    | Readonly<{ kind: 'notInBuild' }>
    | Readonly<{ kind: 'needs'; dependencyId: FeatureId }>
    /** Its switch is on, but the Home cannot offer it for another reason. */
    /**
     * Off on the server for a reason the owner's switch does not decide (e.g. a service the deployment
     * does not provide). `switchable: false` when the Home has no switch for it: then only the
     * deployment's setup can change it, and the row shows no control.
     */
    | Readonly<{ kind: 'unavailable'; switchable: boolean }>
    /**
     * The Home projects no switch for it (no registry key): whether it is on is the build's and the
     * server's answer, and nothing on this page can change it.
     */
    | Readonly<{ kind: 'noHomeSwitch'; on: boolean }>;

export type HomeFeatureSwitchRow = Readonly<{
    featureId: FeatureId;
    family: string;
    entry: HomeSettingEntryV1 | null;
    decision: FeatureDecision | null;
    state: HomeFeatureRowState;
}>;

export type HomeFeatureFamily = Readonly<{
    /** The id's first segment, or `other` for the singletons. */
    id: string;
    switches: readonly HomeFeatureSwitchRow[];
    /** The family's limit and mode keys, rendered after its switches. */
    limits: readonly HomeSettingEntryV1[];
}>;

export type HomeFeatureRows = Readonly<{
    common: readonly HomeFeatureSwitchRow[];
    advanced: readonly HomeFeatureFamily[];
    advancedCount: number;
    /** Where each rendered feature sits, for opening a dependency's row. */
    familyByFeature: ReadonlyMap<FeatureId, string>;
    decisionsById: ReadonlyMap<FeatureId, FeatureDecision>;
}>;

const COMMON = new Set<FeatureId>(HOME_COMMON_FEATURE_IDS);

function familyOf(featureId: string): string {
    return featureId.split('.')[0] ?? featureId;
}

function isFeatureSwitch(entry: HomeSettingEntryV1): boolean {
    const declaration = entry.declaration;
    return declaration?.section === 'features'
        && declaration.type === 'boolean'
        && typeof declaration.featureId === 'string'
        && entry.key.endsWith('__ENABLED');
}

export function homeFeatureRowState(entry: HomeSettingEntryV1 | null, decision: FeatureDecision | null): HomeFeatureRowState {
    const switchOn = entry?.value === true;
    if (entry?.fixed) return { kind: 'fixed', key: entry.key, on: decision ? decision.state === 'enabled' : switchOn };
    if (decision) {
        if (decision.state === 'enabled') return entry ? { kind: 'on' } : { kind: 'noHomeSwitch', on: true };
        if (decision.blockedBy === 'build_policy') return { kind: 'notInBuild' };
        if (decision.blockedBy === 'dependency' && decision.blockingDependencyId) {
            return { kind: 'needs', dependencyId: decision.blockingDependencyId };
        }
        if (!entry) return { kind: 'unavailable', switchable: false };
        if (!switchOn) return entry.source === 'home' ? { kind: 'offHome' } : { kind: 'off' };
        return { kind: 'unavailable', switchable: true };
    }
    // A Home that sends no decisions: its switch value is all there is to say.
    if (!entry) return { kind: 'noHomeSwitch', on: false };
    if (switchOn) return { kind: 'on' };
    return entry.source === 'home' ? { kind: 'offHome' } : { kind: 'off' };
}

/**
 * The saved value of a switch the running server reads only at start (`apply: 'restart'`, D-12) that
 * differs from what it started with: `true`/`false` until the next start, else `null`. Until then the
 * Home's decisions still describe the running value, so the row shows the saved one as pending.
 */
export function homeFeaturePendingRestartValue(row: HomeFeatureSwitchRow): boolean | null {
    const entry = row.entry;
    if (!entry || entry.fixed || entry.apply !== 'restart' || entry.applied?.pending !== true) return null;
    return entry.value === true;
}

/** Whether the owner can flip this row's switch now. */
export function isHomeFeatureToggleable(row: HomeFeatureSwitchRow): boolean {
    if (!isHomeSettingWritable(row.entry ?? undefined)) return false;
    if (homeFeaturePendingRestartValue(row) !== null) return true;
    return row.state.kind === 'on' || row.state.kind === 'off' || row.state.kind === 'offHome'
        || (row.state.kind === 'unavailable' && row.state.switchable);
}

/** Whether the row's switch shows as on: a saved value pending a restart, else the Home's decision. */
export function isHomeFeatureShownOn(row: HomeFeatureSwitchRow): boolean {
    const pending = homeFeaturePendingRestartValue(row);
    if (pending !== null) return pending;
    if (row.state.kind === 'on') return true;
    if (row.state.kind === 'unavailable') return row.entry?.value === true;
    if (row.state.kind === 'noHomeSwitch') return row.state.on;
    return false;
}

export function selectHomeFeatureRows(settings: HomeSettingsProjectionV1): HomeFeatureRows {
    const switches = new Map<FeatureId, HomeSettingEntryV1>();
    const limitsByFamily = new Map<string, HomeSettingEntryV1[]>();
    for (const entry of settings.entries) {
        const declaration = entry.declaration;
        if (declaration?.section !== 'features') continue;
        if (isFeatureSwitch(entry)) {
            const featureId = declaration.featureId as FeatureId;
            if (!switches.has(featureId)) {
                switches.set(featureId, entry);
                continue;
            }
        }
        const family = declaration.family ?? (declaration.featureId ? familyOf(declaration.featureId) : null);
        if (!family) continue;
        const limits = limitsByFamily.get(family) ?? [];
        limits.push(entry);
        limitsByFamily.set(family, limits);
    }
    const decisionsById = new Map<FeatureId, FeatureDecision>(
        (settings.featureDecisions ?? []).map((decision) => [decision.featureId, decision]),
    );

    const rows: HomeFeatureSwitchRow[] = [];
    for (const featureId of FEATURE_IDS) {
        if (!isFeatureServerRepresented(featureId)) continue;
        const entry = switches.get(featureId) ?? null;
        const decision = decisionsById.get(featureId) ?? null;
        if (!entry && !decision) continue;
        rows.push(Object.freeze({
            featureId,
            family: familyOf(featureId),
            entry,
            decision,
            state: homeFeatureRowState(entry, decision),
        }));
    }

    const commonById = new Map(rows.filter((row) => COMMON.has(row.featureId)).map((row) => [row.featureId, row]));
    const common = HOME_COMMON_FEATURE_IDS.flatMap((id) => commonById.get(id) ?? []);

    const byFamily = new Map<string, HomeFeatureSwitchRow[]>();
    for (const row of rows) {
        if (COMMON.has(row.featureId)) continue;
        const list = byFamily.get(row.family) ?? [];
        list.push(row);
        byFamily.set(row.family, list);
    }
    for (const family of limitsByFamily.keys()) {
        if (!byFamily.has(family)) byFamily.set(family, []);
    }

    const advanced: HomeFeatureFamily[] = [];
    const other: HomeFeatureSwitchRow[] = [];
    for (const [family, familyRows] of byFamily) {
        const limits = limitsByFamily.get(family) ?? [];
        if (familyRows.length === 1 && limits.length === 0) {
            other.push(familyRows[0]!);
            continue;
        }
        advanced.push(Object.freeze({ id: family, switches: familyRows, limits }));
    }
    if (other.length > 0) advanced.push(Object.freeze({ id: HOME_OTHER_FEATURE_FAMILY, switches: other, limits: [] }));

    const familyByFeature = new Map<FeatureId, string>();
    for (const family of advanced) for (const row of family.switches) familyByFeature.set(row.featureId, family.id);

    return Object.freeze({
        common,
        advanced,
        advancedCount: rows.length - common.length,
        familyByFeature,
        decisionsById,
    });
}

/**
 * The features that follow `featureId` off: every dependent in the catalog's closure that is on
 * right now. Read from the protocol engine's edges, so the preview names what the Home will do.
 */
export function homeFeatureDependentsTurningOff(
    featureId: FeatureId,
    decisionsById: ReadonlyMap<FeatureId, FeatureDecision>,
): readonly FeatureId[] {
    return listFeatureDependents(featureId).filter((id) => decisionsById.get(id)?.state === 'enabled');
}
