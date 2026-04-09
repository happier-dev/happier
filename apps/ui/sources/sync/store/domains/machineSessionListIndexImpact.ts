import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import { resolveSessionProjectGroupingKeyParts } from '../../domains/session/listing/sessionListProjectGroupingKeys';
import {
    resolveBestMachineDisplayRenderableForHost,
    getMachineDisplaySubtitle,
    type MachineDisplayRenderable,
} from '../../domains/machines/machineDisplayRenderable';

export type MachineSessionListIndexImpact = Readonly<{
    needsSessionListIndexRebuild: boolean;
    needsProjectManagerUpdate: boolean;
}>;

function areMachineDisplayRenderablesEqual(
    previous: MachineDisplayRenderable | null | undefined,
    next: MachineDisplayRenderable | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;

    return previous.id === next.id
        && previous.metadataVersion === next.metadataVersion
        && (previous.metadata?.displayName ?? null) === (next.metadata?.displayName ?? null)
        && (previous.metadata?.host ?? null) === (next.metadata?.host ?? null)
        && (previous.metadata?.homeDir ?? null) === (next.metadata?.homeDir ?? null);
}

export function resolveMachineSessionListIndexImpact(params: Readonly<{
    sessions: ReadonlyArray<SessionListRenderableSession>;
    previousMachineDisplays: Record<string, MachineDisplayRenderable>;
    nextMachineDisplays: Record<string, MachineDisplayRenderable>;
    usesProjectGrouping: boolean;
}>): MachineSessionListIndexImpact {
    if (!params.usesProjectGrouping) {
        return {
            needsSessionListIndexRebuild: false,
            needsProjectManagerUpdate: false,
        };
    }

    const referencedGroupIds = new Set<string>();

    for (const session of params.sessions) {
        const parts = resolveSessionProjectGroupingKeyParts(session.metadata ?? null);
        if (!parts.pathKey) continue;

        const previousGroupId = parts.host
            ? `host:${parts.host}`
            : parts.machineId
                ? `id:${parts.machineId}`
                : 'unknown';
        const nextGroupId = (() => {
            const machine = parts.machineId ? params.nextMachineDisplays[parts.machineId] : undefined;
            const host = parts.host ?? machine?.metadata?.host ?? null;
            return host ? `host:${host}` : parts.machineId ? `id:${parts.machineId}` : 'unknown';
        })();
        referencedGroupIds.add(previousGroupId);
        referencedGroupIds.add(nextGroupId);
        if (parts.machineId) {
            referencedGroupIds.add(`id:${parts.machineId}`);
        }
        if (previousGroupId !== nextGroupId) {
            return {
                needsSessionListIndexRebuild: true,
                needsProjectManagerUpdate: true,
            };
        }
    }

    for (const groupId of referencedGroupIds) {
        if (groupId.startsWith('host:')) {
            const host = groupId.slice('host:'.length);
            const previousMachine = resolveBestMachineDisplayRenderableForHost(params.previousMachineDisplays, host) ?? undefined;
            const nextMachine = resolveBestMachineDisplayRenderableForHost(params.nextMachineDisplays, host) ?? undefined;
            if (!areMachineDisplayRenderablesEqual(previousMachine, nextMachine)) {
                return {
                    needsSessionListIndexRebuild: true,
                    needsProjectManagerUpdate: false,
                };
            }
        }
        if (groupId.startsWith('id:')) {
            const machineId = groupId.slice('id:'.length);
            const previousMachine = params.previousMachineDisplays[machineId];
            const nextMachine = params.nextMachineDisplays[machineId];
            if (!areMachineDisplayRenderablesEqual(previousMachine, nextMachine)) {
                return {
                    needsSessionListIndexRebuild: true,
                    needsProjectManagerUpdate: false,
                };
            }
        }

        const prevSubtitle = groupId.startsWith('host:')
            ? getMachineDisplaySubtitle(
                resolveBestMachineDisplayRenderableForHost(params.previousMachineDisplays, groupId.slice('host:'.length)) ?? undefined,
                groupId.slice('host:'.length),
            )
            : groupId.startsWith('id:')
                ? getMachineDisplaySubtitle(
                    params.previousMachineDisplays[groupId.slice('id:'.length)],
                    groupId.slice('id:'.length),
                )
                : 'unknown';
        const nextSubtitle = groupId.startsWith('host:')
            ? getMachineDisplaySubtitle(
                resolveBestMachineDisplayRenderableForHost(params.nextMachineDisplays, groupId.slice('host:'.length)) ?? undefined,
                groupId.slice('host:'.length),
            )
            : groupId.startsWith('id:')
                ? getMachineDisplaySubtitle(
                    params.nextMachineDisplays[groupId.slice('id:'.length)],
                    groupId.slice('id:'.length),
                )
                : 'unknown';
        if (prevSubtitle !== nextSubtitle) {
            return {
                needsSessionListIndexRebuild: true,
                needsProjectManagerUpdate: true,
            };
        }
    }

    return {
        needsSessionListIndexRebuild: false,
        needsProjectManagerUpdate: false,
    };
}
