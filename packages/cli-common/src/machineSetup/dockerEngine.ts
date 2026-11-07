import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

import { createDockerMembershipStep } from './dockerMembership.js';

type DaemonUsername = string | { kind: 'targetFact'; fact: 'daemon.username' };
export type DockerEngineSetupFacts<T extends DaemonUsername = string> = Readonly<{
    distribution: 'ubuntu' | 'debian'; daemonUsername: T; enginePresent: boolean;
}>;
type DockerEngineSetupStep<T extends DaemonUsername> =
    | Extract<MachineRecipeStepV1, { kind: 'package' | 'serviceUnit' }>
    | ReturnType<typeof createDockerMembershipStep<T>>;

/** Server presence preserves an existing CE install; the service owner decides readiness. */
export const dockerEnginePresenceCheck = {
    id: 'docker-engine-present', kind: 'command' as const, executable: 'which', args: ['dockerd'],
    check: { executable: 'which', args: ['dockerd'], unsatisfiedExitCodes: [1] },
};

export function createDockerEngineSetupSteps<T extends DaemonUsername>(input: DockerEngineSetupFacts<T>): DockerEngineSetupStep<T>[] {
    return [
        ...(input.enginePresent ? [] : [{ id: `docker-packages-${input.distribution}`, kind: 'package' as const, manager: 'apt',
            packages: ['docker.io', 'docker-buildx', input.distribution === 'ubuntu' ? 'docker-compose-v2' : 'docker-compose'].map(name => ({ name })) }]),
        createDockerMembershipStep(input.daemonUsername),
        { id: 'docker-service', kind: 'serviceUnit', unit: 'docker.service', enabled: true, running: true },
    ];
}
