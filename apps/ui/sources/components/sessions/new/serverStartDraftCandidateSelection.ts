import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { resolveExactServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachines';

import type {
    SessionServerStartDraftSeed,
    SessionServerStartDraftTarget,
} from './serverStartDraftComposer';

type Candidate = NonNullable<SessionServerStartDraftSeed['candidates']>[number];

export function resolveSessionServerStartCandidateSelection(params: Readonly<{
    mountedTarget: SessionServerStartDraftTarget;
    selectedCandidate?: Candidate;
    activeServerId: string;
    activeMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
}>): Readonly<{
    candidate?: Candidate;
    target: SessionServerStartDraftTarget;
    machine: Machine | null;
    directory?: string;
    machineReady: boolean;
}> {
    const target = params.selectedCandidate === undefined
        ? params.mountedTarget
        : {
            serverId: params.selectedCandidate.serverId,
            machineId: params.selectedCandidate.machineId,
        };
    const machine = resolveExactServerScopedMachine({
        machineId: target.machineId,
        serverId: target.serverId,
        activeServerId: params.activeServerId,
        activeMachines: params.activeMachines,
        machineListByServerId: params.machineListByServerId,
    });

    return {
        ...(params.selectedCandidate === undefined ? {} : { candidate: params.selectedCandidate }),
        target,
        machine,
        ...(params.selectedCandidate === undefined ? {} : { directory: params.selectedCandidate.rootPath }),
        machineReady: resolveMachineSpawnReadiness({
            machine,
            selectedMachineId: target.machineId,
        }).status === 'ready',
    };
}
