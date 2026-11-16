import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

import { createDockerMembershipStep } from './dockerMembership.js';
import { createDockerRootlessSteps } from './dockerRootless.js';

type DaemonUsername = string | { kind: 'targetFact'; fact: 'daemon.username' };
type FileStep = Extract<MachineRecipeStepV1, { kind: 'file' }>;
export const dockerEngineAccessModeInputSchema = {
    type: 'string' as const, enum: ['rootless' as const, 'group' as const] satisfies [string, string], default: 'rootless' as const,
    description: 'Rootless is recommended. Docker group access is compatible but close to administrator power.',
};
export type DockerEngineSetupFacts<T extends DaemonUsername = string> = Readonly<{
    distribution: 'ubuntu' | 'debian'; daemonUsername: T; enginePresent: boolean;
}> & (Readonly<{ mode: 'rootless'; daemonConfig?: never }> | Readonly<{
    mode?: 'group'; daemonConfig?: Extract<NonNullable<FileStep['content']>, { kind: 'jsonMerge' }>['value'];
}>);
type DockerEngineSetupStep<T extends DaemonUsername> =
    | Extract<MachineRecipeStepV1, { kind: 'package' | 'serviceUnit' | 'file' }>
    | ReturnType<typeof createDockerMembershipStep<T>>;

/** Server presence preserves an existing CE install; the service owner decides readiness. */
export const dockerEnginePresenceCheck = {
    id: 'docker-engine-present', kind: 'command' as const, executable: 'which', args: ['dockerd'],
    check: { executable: 'which', args: ['dockerd'], unsatisfiedExitCodes: [1] },
};

export function createDockerEngineSetupSteps<T extends DaemonUsername>(input: DockerEngineSetupFacts<T>): (DockerEngineSetupStep<T> | ReturnType<typeof createDockerRootlessSteps<T>>[number])[] {
    const packages = input.enginePresent ? [] : [{ id: `docker-packages-${input.distribution}`, kind: 'package' as const, manager: 'apt',
        packages: ['docker.io', 'docker-buildx', input.distribution === 'ubuntu' ? 'docker-compose-v2' : 'docker-compose'].map(name => ({ name })) }];
    if (input.mode === 'rootless') return [...packages, ...createDockerRootlessSteps(input.daemonUsername)];
    return [
        ...packages,
        createDockerMembershipStep(input.daemonUsername),
        ...(input.daemonConfig === undefined ? [] : [{ id: 'docker-daemon-config', kind: 'file' as const,
            path: '/etc/docker/daemon.json', owner: 'root', group: 'root', mode: 0o644,
            content: { kind: 'jsonMerge' as const, value: input.daemonConfig }, validate: 'docker' as const,
            onChange: { serviceStepId: 'docker-service', action: 'restart' as const } }]),
        { id: 'docker-service', kind: 'serviceUnit' as const, unit: 'docker.service', enabled: true, running: true },
    ];
}
