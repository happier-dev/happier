import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

import { createDockerMembershipStep } from './dockerMembership.js';

type DaemonUsername = string | { kind: 'targetFact'; fact: 'daemon.username' };
export type DockerEngineSetupFacts<T extends DaemonUsername = string> = Readonly<{
    distribution: 'ubuntu' | 'debian'; daemonUsername: T; enginePresent: boolean;
}>;
type DockerEngineSetupStep<T extends DaemonUsername> =
    | Extract<MachineRecipeStepV1, { kind: 'package' | 'serviceUnit' }>
    | ReturnType<typeof createDockerMembershipStep<T>>;

/** Presence is separate from daemon membership: an existing CE install is retained. */
export const dockerEnginePresenceCheck = {
    id: 'docker-engine-present', kind: 'command' as const, executable: 'which', args: ['docker'],
    check: { executable: 'which', args: ['docker'], unsatisfiedExitCodes: [1] },
};

export function createDockerEngineSetupSteps<T extends DaemonUsername>(input: DockerEngineSetupFacts<T>): DockerEngineSetupStep<T>[] {
    return [
        ...(input.enginePresent ? [] : [{ id: `docker-packages-${input.distribution}`, kind: 'package' as const, manager: 'apt',
            packages: ['docker.io', 'docker-buildx', input.distribution === 'ubuntu' ? 'docker-compose-v2' : 'docker-compose'].map(name => ({ name })) }]),
        createDockerMembershipStep(input.daemonUsername),
        ...(input.enginePresent ? [] : [{ id: 'docker-service', kind: 'serviceUnit' as const, unit: 'docker.service', enabled: true, running: true }]),
    ];
}
