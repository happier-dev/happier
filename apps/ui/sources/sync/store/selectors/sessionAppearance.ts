import type { UiSessionOrganizationLabel, UiSessionOrganizationSessionAppearance } from '@/sync/domains/session/organization/types';
import { buildSessionOrganizationLabelKey, buildSessionOrganizationSessionKey, sessionOrganizationTupleKeyBelongsToServer } from '@/sync/domains/session/organization/keys';
import { readSessionAppearanceColorFromDisplay, resolveEffectiveSessionAppearanceColor, type SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';

export type SessionAppearanceSelectorState = Readonly<{
    sessionOrganizationAppearancesBySessionKey?: Readonly<Record<string, UiSessionOrganizationSessionAppearance>>;
    sessionOrganizationLabelsByLabelKey?: Readonly<Record<string, UiSessionOrganizationLabel>>;
    sessionOrganizationSessionAppearancesSupportedByServerId?: Readonly<Record<string, boolean>>;
}>;

export function selectSessionAppearancesSupported(state: SessionAppearanceSelectorState, serverId: string | null | undefined): boolean {
    return !!serverId && state.sessionOrganizationSessionAppearancesSupportedByServerId?.[serverId.trim()] === true;
}

export function selectSessionAppearanceColor(state: SessionAppearanceSelectorState, params: Readonly<{ serverId: string; sessionId: string }>): SessionAppearanceColor | null {
    const appearance = state.sessionOrganizationAppearancesBySessionKey?.[buildSessionOrganizationSessionKey(params.serverId, params.sessionId)];
    return readSessionAppearanceColorFromDisplay(appearance?.display, appearance?.displayState);
}

/** The caller supplies the canonical list/workspace owner identity, never a path-derived alias. */
export function selectEffectiveSessionAppearanceColor(state: SessionAppearanceSelectorState, params: Readonly<{
    serverId: string;
    sessionId: string;
    workspaceKey?: string | null;
    workspaceColor?: SessionAppearanceColor | null;
}>): SessionAppearanceColor | null {
    const label = params.workspaceKey ? state.sessionOrganizationLabelsByLabelKey?.[buildSessionOrganizationLabelKey({
        serverId: params.serverId, labelKind: 'workspace', scopeKey: params.workspaceKey,
    })] : undefined;
    return resolveEffectiveSessionAppearanceColor({
        sessionColor: selectSessionAppearanceColor(state, params),
        workspaceColor: params.workspaceColor ?? (label?.archivedAt == null ? readSessionAppearanceColorFromDisplay(label?.display, label?.displayState) : null),
    });
}

export function createEffectiveSessionAppearanceColorsSelector(targets: readonly Readonly<{
    serverId: string;
    sessionId: string;
    workspaceKey?: string | null;
    workspaceColor?: SessionAppearanceColor | null;
}>[]) {
    let previousAppearances: SessionAppearanceSelectorState['sessionOrganizationAppearancesBySessionKey'];
    let previousLabels: SessionAppearanceSelectorState['sessionOrganizationLabelsByLabelKey'];
    let previous: ReadonlyMap<string, SessionAppearanceColor> = new Map();
    let initialized = false;
    return (state: SessionAppearanceSelectorState): ReadonlyMap<string, SessionAppearanceColor> => {
        if (initialized && previousAppearances === state.sessionOrganizationAppearancesBySessionKey && previousLabels === state.sessionOrganizationLabelsByLabelKey) return previous;
        initialized = true;
        previousAppearances = state.sessionOrganizationAppearancesBySessionKey;
        previousLabels = state.sessionOrganizationLabelsByLabelKey;
        const next = new Map<string, SessionAppearanceColor>();
        for (const target of targets) {
            const color = selectEffectiveSessionAppearanceColor(state, target);
            if (color) next.set(buildSessionOrganizationSessionKey(target.serverId, target.sessionId), color);
        }
        if (next.size !== previous.size || [...next].some(([key, value]) => previous.get(key) !== value)) previous = next;
        return previous;
    };
}

/** Instantiate per open consumer; equal colour sets retain their array identity. */
export function createCustomSessionAppearanceColorsSelector(serverId?: string | null) {
    let previousAppearances: SessionAppearanceSelectorState['sessionOrganizationAppearancesBySessionKey'];
    let previousLabels: SessionAppearanceSelectorState['sessionOrganizationLabelsByLabelKey'];
    let previous: readonly `#${string}`[] = Object.freeze([]);
    return (state: SessionAppearanceSelectorState): readonly `#${string}`[] => {
        if (previousAppearances === state.sessionOrganizationAppearancesBySessionKey && previousLabels === state.sessionOrganizationLabelsByLabelKey) return previous;
        previousAppearances = state.sessionOrganizationAppearancesBySessionKey;
        previousLabels = state.sessionOrganizationLabelsByLabelKey;
        const colors = new Set<`#${string}`>();
        for (const [key, appearance] of Object.entries(previousAppearances ?? {})) {
            if (serverId && !sessionOrganizationTupleKeyBelongsToServer(key, serverId)) continue;
            const color = readSessionAppearanceColorFromDisplay(appearance.display, appearance.displayState);
            if (color?.kind === 'custom') colors.add(color.hex);
        }
        for (const [key, label] of Object.entries(previousLabels ?? {})) {
            if ((serverId && !sessionOrganizationTupleKeyBelongsToServer(key, serverId)) || label.labelKind !== 'workspace' || label.archivedAt != null) continue;
            const color = readSessionAppearanceColorFromDisplay(label.display, label.displayState);
            if (color?.kind === 'custom') colors.add(color.hex);
        }
        const next = [...colors].sort();
        if (previous.length !== next.length || next.some((color, index) => color !== previous[index])) previous = next;
        return previous;
    };
}
