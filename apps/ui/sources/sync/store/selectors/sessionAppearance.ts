import type { SessionOrganizationLabel, SessionOrganizationSessionAppearance } from '@happier-dev/protocol';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveSessionDisplayTarget } from '@/sync/domains/machines/identity/resolveSessionMachineTargets';
import { resolveSessionWorkspacePresentation, type SessionWorkspacePresentationMetadata } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization/keys';
import { readSessionAppearanceColorFromDisplay, resolveEffectiveSessionAppearanceColor, type SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import { resolveServerWorkspaceDisplay } from '@/sync/domains/session/organization/workspaceDisplay';

export type SessionAppearanceSelectorState = Readonly<{
    machines?: Readonly<Record<string, Machine>>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
    sessionOrganizationAppearancesBySessionKey?: Readonly<Record<string, SessionOrganizationSessionAppearance>>;
    sessionOrganizationLabelsByLabelKey?: Readonly<Record<string, SessionOrganizationLabel>>;
    sessionOrganizationSessionAppearancesSupportedByServerId?: Readonly<Record<string, boolean>>;
}>;

const EMPTY_MACHINES = Object.freeze({});

export function selectSessionAppearancesSupported(state: SessionAppearanceSelectorState, serverId: string | null | undefined): boolean {
    return !!serverId && state.sessionOrganizationSessionAppearancesSupportedByServerId?.[serverId.trim()] === true;
}

/** The session's own override (not the inherited workspace colour); what its colour menu marks and removes. */
export function selectSessionAppearanceColor(state: SessionAppearanceSelectorState, params: Readonly<{
    serverId: string;
    sessionId: string;
}>): SessionAppearanceColor | null {
    return readSessionAppearanceColorFromDisplay(
        state.sessionOrganizationAppearancesBySessionKey?.[buildSessionOrganizationServerKey(params.serverId, params.sessionId)]?.display,
    );
}

/** Server-scoped and row-local: unrelated labels/appearances do not change this selected value. */
export function selectEffectiveSessionAppearanceColor(state: SessionAppearanceSelectorState, params: Readonly<{
    serverId: string;
    sessionId: string;
    metadata: SessionWorkspacePresentationMetadata;
    active?: boolean;
    activeServerId?: string | null;
}>): SessionAppearanceColor | null {
    const canReadActiveProject = params.activeServerId === undefined || params.activeServerId === params.serverId;
    const project = canReadActiveProject ? state.getProjectForSession?.(params.sessionId) : null;
    const target = resolveSessionDisplayTarget({
        sessionActive: params.active,
        sessionMachineId: typeof params.metadata?.machineId === 'string' ? params.metadata.machineId : null,
        sessionPath: typeof params.metadata?.path === 'string' ? params.metadata.path : null,
        projectMachineId: project?.key?.machineId,
        projectPath: project?.key?.path,
        machines: state.machines ?? EMPTY_MACHINES,
    });
    const workspace = resolveSessionWorkspacePresentation({ metadata: params.metadata, target, machines: state.machines ?? EMPTY_MACHINES });
    const display = resolveServerWorkspaceDisplay(state.sessionOrganizationLabelsByLabelKey, params.serverId, workspace.workspaceKey);
    return resolveEffectiveSessionAppearanceColor({
        sessionColor: selectSessionAppearanceColor(state, params),
        workspaceColor: display.color,
    });
}

/** Instantiate once per picker/consumer. Stable sorted hex values, deduplicated across both owners. */
export function createCustomSessionAppearanceColorsSelector(serverId?: string | null) {
    let previousAppearances: SessionAppearanceSelectorState['sessionOrganizationAppearancesBySessionKey'];
    let previousLabels: SessionAppearanceSelectorState['sessionOrganizationLabelsByLabelKey'];
    let previous: readonly `#${string}`[] = Object.freeze([]);
    return (state: SessionAppearanceSelectorState): readonly `#${string}`[] => {
        if (previousAppearances === state.sessionOrganizationAppearancesBySessionKey && previousLabels === state.sessionOrganizationLabelsByLabelKey) return previous;
        previousAppearances = state.sessionOrganizationAppearancesBySessionKey;
        previousLabels = state.sessionOrganizationLabelsByLabelKey;
        const colors = new Set<`#${string}`>();
        const prefix = serverId ? `${serverId.trim()}:` : null;
        for (const [key, appearance] of Object.entries(previousAppearances ?? {})) {
            if (prefix && !key.startsWith(prefix)) continue;
            const color = readSessionAppearanceColorFromDisplay(appearance.display);
            if (color?.kind === 'custom') colors.add(color.hex);
        }
        for (const [key, label] of Object.entries(previousLabels ?? {})) {
            if ((prefix && !key.startsWith(prefix)) || label.labelKind !== 'workspace' || label.archivedAt != null) continue;
            const color = readSessionAppearanceColorFromDisplay(label.display);
            if (color?.kind === 'custom') colors.add(color.hex);
        }
        const next = [...colors].sort();
        if (previous.length !== next.length || next.some((color, index) => previous[index] !== color)) previous = next;
        return previous;
    };
}
