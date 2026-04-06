import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import { resolveSessionProjectGroupingKeyParts } from '../../domains/session/listing/sessionListProjectGroupingKeys';
import {
    resolveBestMachineDisplayRenderableForHost,
    getMachineDisplaySubtitle,
    type MachineDisplayRenderable,
} from '../../domains/machines/machineDisplayRenderable';

export type MachineSessionListViewDataImpact = Readonly<{
    needsSessionListViewDataRebuild: boolean;
    needsProjectManagerUpdate: boolean;
}>;

export function resolveMachineSessionListViewDataImpact(params: Readonly<{
    sessions: ReadonlyArray<SessionListRenderableSession>;
    previousMachineDisplays: Record<string, MachineDisplayRenderable>;
    nextMachineDisplays: Record<string, MachineDisplayRenderable>;
    usesProjectGrouping: boolean;
}>): MachineSessionListViewDataImpact {
    if (!params.usesProjectGrouping) {
        return {
            needsSessionListViewDataRebuild: false,
            needsProjectManagerUpdate: false,
        };
    }

    const referencedGroupIds = new Set<string>();

    const resolveMachineGroupId = (
        parts: ReturnType<typeof resolveSessionProjectGroupingKeyParts>,
        machinesById: Record<string, MachineDisplayRenderable>,
    ): string => {
        const machine = parts.machineId ? machinesById[parts.machineId] : undefined;
        const host = parts.host ?? machine?.metadata?.host ?? null;
        return host ? `host:${host}` : parts.machineId ? `id:${parts.machineId}` : 'unknown';
    };

    const resolveSubtitleForGroup = (
        groupId: string,
        machinesById: Record<string, MachineDisplayRenderable>,
    ): string => {
        if (groupId.startsWith('host:')) {
            const host = groupId.slice('host:'.length);
            const machine = resolveBestMachineDisplayRenderableForHost(machinesById, host) ?? undefined;
            return getMachineDisplaySubtitle(machine, host);
        }
        if (groupId.startsWith('id:')) {
            const machineId = groupId.slice('id:'.length);
            return getMachineDisplaySubtitle(machinesById[machineId], machineId);
        }
        return 'unknown';
    };

    for (const session of params.sessions) {
        const parts = resolveSessionProjectGroupingKeyParts(session.metadata ?? null);
        if (!parts.pathKey) continue;

        const previousGroupId = resolveMachineGroupId(parts, params.previousMachineDisplays);
        const nextGroupId = resolveMachineGroupId(parts, params.nextMachineDisplays);
        referencedGroupIds.add(previousGroupId);
        referencedGroupIds.add(nextGroupId);
        if (previousGroupId !== nextGroupId) {
            return {
                needsSessionListViewDataRebuild: true,
                needsProjectManagerUpdate: true,
            };
        }
    }

    for (const groupId of referencedGroupIds) {
        const prevSubtitle = resolveSubtitleForGroup(groupId, params.previousMachineDisplays);
        const nextSubtitle = resolveSubtitleForGroup(groupId, params.nextMachineDisplays);
        if (prevSubtitle !== nextSubtitle) {
            return {
                needsSessionListViewDataRebuild: true,
                needsProjectManagerUpdate: true,
            };
        }
    }

    return {
        needsSessionListViewDataRebuild: false,
        needsProjectManagerUpdate: false,
    };
}
