import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { resolveSessionWorkspacePresentation } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

type SessionReachableDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: 'head' | 'tail';
}>;

export type SessionListReachabilityModels = Readonly<{
    reachableSessionDisplayById: Map<string, SessionReachableDisplay>;
    hasMultipleMachines: boolean;
}>;

const EMPTY_REACHABILITY_MODELS: SessionListReachabilityModels = {
    reachableSessionDisplayById: new Map<string, SessionReachableDisplay>(),
    hasMultipleMachines: false,
};

export function buildSessionListReachabilityModels(input: Readonly<{
    items: ReadonlyArray<SessionListViewItem> | null | undefined;
    machinesById: Readonly<Record<string, MachineDisplayRenderable>>;
    workspaceLabelsV1: Readonly<Record<string, string>>;
}>): SessionListReachabilityModels {
    const items = input.items;
    if (!items || items.length === 0) {
        return EMPTY_REACHABILITY_MODELS;
    }

    const reachableSessionDisplayById = new Map<string, SessionReachableDisplay>();
    const machineIds = new Set<string>();

    for (const item of items) {
        if (item.type !== 'session') continue;
        const target = readMachineTargetForSession(item.session.id);
        const workspace = resolveSessionWorkspacePresentation({
            metadata: item.session?.metadata ?? null,
            machines: input.machinesById,
            target,
            workspaceLabelsV1: input.workspaceLabelsV1,
        });

        reachableSessionDisplayById.set(item.session.id, {
            machineId: workspace.machineId,
            machineLabel: workspace.machineLabel,
            workspaceSubtitle: workspace.displayTitle,
            workspaceSubtitleEllipsizeMode: workspace.hasCustomLabel ? 'tail' : 'head',
        });

        const machineKey = workspace.machineId ?? workspace.machineLabel ?? '';
        if (machineKey) machineIds.add(machineKey);
    }

    if (reachableSessionDisplayById.size === 0) {
        return EMPTY_REACHABILITY_MODELS;
    }

    return {
        reachableSessionDisplayById,
        hasMultipleMachines: machineIds.size > 1,
    };
}
