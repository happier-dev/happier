import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/v1';
import { environmentSecretBindingIdentityV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { DeploymentSecretRevisionFactV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';

/** Value-free comparison of an evidenced running generation with the saved-resource catalog. */
export function readDeploymentSecretRevisionFacts(
    input: Readonly<{ bindings: readonly EnvironmentSecretBindingV1[]; runningBindings?: readonly EnvironmentSecretBindingV1[];
        savedSecretRevisions?: Readonly<NonNullable<DeploymentEnvironmentDetailV1['savedSecretRevisions']>> }>,
): readonly DeploymentSecretRevisionFactV1[] {
    const running = new Map(input.runningBindings?.map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
    const saved = new Map(input.savedSecretRevisions?.map(resource => [formatSharedSavedSecretRefV1(resource.resourceId), resource.revision]));
    return input.bindings.flatMap((binding): DeploymentSecretRevisionFactV1[] => {
        if (binding.purpose !== 'variable' || binding.source.kind !== 'secret') return [];
        const launch = running.get(environmentSecretBindingIdentityV1(binding));
        // Destination approval does not prove which Secret built a promoted or reused image.
        const runningRevision = binding.phase === 'runtime' && launch?.purpose === 'variable'
            && launch.source.kind === 'secret' && launch.source.ref === binding.source.ref
            ? launch.source.resourceRevision : null;
        const currentRevision = saved.get(binding.source.ref) ?? null;
        const fact = { name: binding.name, phase: binding.phase, ref: binding.source.ref, runningRevision, currentRevision };
        if (currentRevision === null) return [{ ...fact,
            status: input.savedSecretRevisions === undefined ? 'unknown' : 'unavailable',
            reason: input.savedSecretRevisions === undefined ? 'saved_secret_revision_unrecorded' : 'saved_secret_unavailable' }];
        if (binding.phase === 'build') return [{ ...fact, status: 'unknown', reason: 'build_secret_revision_unrecorded' }];
        if (runningRevision === null) return [{ ...fact, status: 'unknown', reason: 'running_secret_revision_unrecorded' }];
        if (runningRevision < currentRevision) return [{ ...fact, status: 'redeploy_required' }];
        if (runningRevision === currentRevision) return [{ ...fact, status: 'unchanged' }];
        return [{ ...fact, status: 'unknown', reason: 'running_secret_revision_ahead' }];
    });
}
