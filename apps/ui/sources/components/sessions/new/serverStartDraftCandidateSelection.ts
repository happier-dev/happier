import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { resolveExactServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachines';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

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
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
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
        machineListStatusByServerId: params.machineListStatusByServerId,
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

/**
 * What a placement candidate row says: the folder (its label, else its path relative to the
 * machine's home) and the machine's name. Raw machine and server ids are never shown; a machine this
 * device cannot resolve simply goes unnamed.
 */
export function presentSessionServerStartCandidate(params: Readonly<{
    candidate: Candidate;
    activeServerId: string;
    activeMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>): Readonly<{ title: string; subtitle: string | undefined }> {
    const machine = resolveExactServerScopedMachine({
        machineId: params.candidate.machineId,
        serverId: params.candidate.serverId,
        activeServerId: params.activeServerId,
        activeMachines: params.activeMachines,
        machineListByServerId: params.machineListByServerId,
        machineListStatusByServerId: params.machineListStatusByServerId,
    });
    return {
        title: params.candidate.label
            ?? formatSessionPath(params.candidate.rootPath, machine?.metadata?.homeDir ?? undefined),
        subtitle: getMachineDisplayName(machine) ?? undefined,
    };
}
