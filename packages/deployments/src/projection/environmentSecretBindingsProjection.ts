import { environmentSecretBindingIdentityV1, type DeploymentEnvironmentHeaderV1, type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';

export type EnvironmentSecretBindingProjectionV1 = Readonly<{
    identity: string;
    /** The canonical binding contains refs or deliberately public values, never secret bodies. */
    binding: EnvironmentSecretBindingV1;
    hasPhaseControl: boolean;
    masked: boolean;
    bakedIntoImage: boolean;
    /** Linking delivers secret material to Machine controllers, not just the configuring person. */
    secretDisclosure: Readonly<{ kind: 'environmentMachines' } | { kind: 'teamEnvironmentMachines'; teamId: string }> | null;
}>;

/** Purpose-row projection at its producer; equal echoes retain keyed row identities. */
export function projectEnvironmentSecretBindingsV1(
    bindings: readonly EnvironmentSecretBindingV1[],
    previous: readonly EnvironmentSecretBindingProjectionV1[] = [],
    environmentOwner?: DeploymentEnvironmentHeaderV1['owner'],
): readonly EnvironmentSecretBindingProjectionV1[] {
    const byIdentity = new Map(previous.map(row => [row.identity, row]));
    const machineDisclosure: NonNullable<EnvironmentSecretBindingProjectionV1['secretDisclosure']> = environmentOwner?.kind === 'team'
        ? { kind: 'teamEnvironmentMachines', teamId: environmentOwner.teamId } : { kind: 'environmentMachines' };
    const next = bindings.map(binding => {
        const identity = environmentSecretBindingIdentityV1(binding);
        const retained = byIdentity.get(identity);
        const secretDisclosure = binding.source.kind === 'secret' ? machineDisclosure : null;
        if (retained && JSON.stringify(retained.binding) === JSON.stringify(binding)
            && JSON.stringify(retained.secretDisclosure) === JSON.stringify(secretDisclosure)) return retained;
        return { identity, binding, hasPhaseControl: binding.purpose === 'variable',
            masked: binding.source.kind === 'secret',
            secretDisclosure,
            bakedIntoImage: binding.purpose === 'variable' && binding.phase === 'build' && binding.source.kind !== 'secret' };
    });
    return next.length === previous.length && next.every((row, index) => row === previous[index]) ? previous : next;
}
