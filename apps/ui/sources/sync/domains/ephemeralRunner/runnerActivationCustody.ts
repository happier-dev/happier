import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { RunnerActivationBindingV1Schema, type RunnerActivationBindingV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import { RunnerActivationProjectionV1Schema, runnerActivationProjectionBindingV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import { verifyRunnerClaimV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { parseHappierRunnerActivationFileV1 } from '@happier-dev/protocol/ephemeralRunner/activationFile';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    readRunnerActivationSigningKey,
    removeRunnerActivationKeyCustody,
    removeRunnerActivationKeyCustodyByActivationId,
    type RunnerActivationKeyCustody,
} from './runnerActivationKeyCustody';

export type RunnerActivationCustody = Readonly<{
    scope: ServerAccountScope;
    key: RunnerActivationKeyCustody;
    /** Locally accepted creation binding, never overwritten by a fetched projection. */
    binding: RunnerActivationBindingV1;
}>;

/**
 * Retire creator-only signing custody only after the Home projection proves the
 * endpoint claim against the immutable binding previously accepted locally
 * **and** carries the creator-authenticated review this key had to sign.
 *
 * The activation signing identity is the proof root for the scoped Machine
 * content key, so retiring it at claim would destroy the key the review must
 * still be signed with. Custody is therefore held through successful review
 * publication, which is the first projection fact that proves the creator's own
 * proof reached the Home. The exact activation-id removal remains idempotent
 * for remount/retry.
 */
export async function retireRunnerActivationKeyCustodyAfterVerifiedClaim(input: Readonly<{
    scope: ServerAccountScope;
    expectedBinding: RunnerActivationBindingV1;
    projection: unknown;
}>): Promise<void> {
    const expectedBinding = RunnerActivationBindingV1Schema.safeParse(input.expectedBinding);
    const projection = RunnerActivationProjectionV1Schema.safeParse(input.projection);
    if (!expectedBinding.success || !projection.success
        || expectedBinding.data.activationId !== projection.data.activationId
        || expectedBinding.data.creatorAccountId !== input.scope.accountId
        || createCanonicalJsonSigningInput(runnerActivationProjectionBindingV1(projection.data))
            !== createCanonicalJsonSigningInput(expectedBinding.data)) {
        throw new Error('runner_activation_binding_mismatch');
    }
    if (projection.data.claim === null
        || !verifyRunnerClaimV1({ claim: projection.data.claim, expectedBinding: expectedBinding.data })) {
        throw new Error('runner_activation_invalid_claim');
    }
    if (projection.data.review === null) {
        throw new Error('runner_activation_review_unpublished');
    }
    await removeRunnerActivationKeyCustodyByActivationId(input.scope, expectedBinding.data.activationId);
}

export async function readRunnerActivationExportFile(input: Readonly<{
    custody: RunnerActivationCustody;
    home: HomeConnectionDescriptorV1;
    projection: unknown;
}>) {
    const binding = RunnerActivationBindingV1Schema.safeParse(input.custody.binding);
    const projection = RunnerActivationProjectionV1Schema.safeParse(input.projection);
    if (!binding.success || !projection.success
        || input.custody.scope.accountId !== binding.data.creatorAccountId
        || input.custody.key.activationId !== binding.data.activationId
        || input.custody.key.activationSigningPublicKey !== binding.data.activationSigningPublicKey
        || input.home.homeServerIdentityId !== binding.data.homeServerIdentityId
        || createCanonicalJsonSigningInput(runnerActivationProjectionBindingV1(projection.data)) !== createCanonicalJsonSigningInput(binding.data)) {
        throw new Error('runner_activation_binding_mismatch');
    }
    if (projection.data.claim !== null) {
        if (!verifyRunnerClaimV1({ claim: projection.data.claim, expectedBinding: binding.data })) {
            throw new Error('runner_activation_invalid_claim');
        }
        throw new Error('runner_activation_already_claimed');
    }
    if (projection.data.state === 'closed') {
        await removeRunnerActivationKeyCustody(input.custody.scope, input.custody.key);
        throw new Error('runner_activation_closed');
    }
    if (projection.data.state !== 'pending') throw new Error('runner_activation_export_unavailable');
    if (binding.data.activationExpiresAt !== null && binding.data.activationExpiresAt <= Date.now()) {
        throw new Error('runner_activation_expired');
    }
    const activationFile = parseHappierRunnerActivationFileV1({
        v: 1,
        home: input.home,
        activation: {
            id: binding.data.activationId,
            signingPrivateKeyBase64Url: await readRunnerActivationSigningKey(input.custody.scope, input.custody.key),
            creatorAccountId: binding.data.creatorAccountId,
            creatorTokenEpoch: binding.data.creatorTokenEpoch,
            activationExpiresAt: binding.data.activationExpiresAt,
            workspace: binding.data.workspace,
            sessionId: binding.data.sessionId,
            machineId: binding.data.machineId,
            authoringCommitment: binding.data.authoringCommitment,
            artifact: binding.data.artifact,
            endpointFactsRecipient: binding.data.endpointFactsRecipient,
        },
    });
    if (!activationFile) throw new Error('runner_package_invalid_activation');
    return activationFile;
}
