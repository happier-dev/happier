import tweetnacl from 'tweetnacl';
import { computeRunnerAuthoringCommitmentV1, type RunnerPreparedAuthoringV1 } from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import { RunnerActivationProjectionV1Schema } from '@happier-dev/protocol/ephemeralRunner/projection';
import { encodeBase64 } from '@/encryption/base64';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Accepted HTTP projection fixture; cryptographic proof verification belongs to the activation producer. */
export function createMaterializedRunnerProjectionFixture(input: Readonly<{
    scope: ServerAccountScope;
    activationId: string;
    draftId: string;
    sessionId: string;
    machineId: string;
    preparedAuthoring: RunnerPreparedAuthoringV1;
}>) {
    const activationKey = tweetnacl.sign.keyPair();
    const installationKey = tweetnacl.sign.keyPair();
    const runnerBox = tweetnacl.box.keyPair();
    const signature = encodeBase64(new Uint8Array(64), 'base64url');
    const launchManifestCommitment = encodeBase64(new Uint8Array(32).fill(7), 'base64url');
    const binding = {
        activationId: input.activationId, homeServerIdentityId: input.scope.serverId,
        creatorAccountId: input.scope.accountId, creatorTokenEpoch: 1, activationExpiresAt: null,
        workspace: { kind: 'choose_on_endpoint' as const }, sessionId: input.sessionId, machineId: input.machineId,
        activationSigningPublicKey: encodeBase64(activationKey.publicKey, 'base64url'),
        authoringCommitment: computeRunnerAuthoringCommitmentV1(input.preparedAuthoring),
        artifact: { product: 'happier-runner' as const, version: '0.3.0', target: 'linux-x64' as const, sha256: 'a'.repeat(64) },
        endpointFactsRecipient: { mode: 'plain' as const, creatorAccountId: input.scope.accountId },
    };
    const claimPayload = {
        v: 1 as const, purpose: 'happier.ephemeral-session-runner.claim' as const, binding,
        runnerBoxPublicKey: encodeBase64(runnerBox.publicKey, 'base64url'),
        installation: { installationId: 'runner-installation', publicKey: encodeBase64(installationKey.publicKey, 'base64url'),
            proof: { version: 1 as const, algorithm: 'ed25519' as const, signature } },
        protocolEpoch: 1 as const,
    };
    const credentialSelectionBinding = {
        v: 1 as const, resourceId: 'resource-a', brokerMachineId: 'broker-machine-a', revision: 1,
        application: { agentTargetKey: 'agent:happier.codex/codex',
            implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
            endpointTemplateId: 'responses', protocol: 'openai-responses' as const }, sourceRevision: 'source-a',
    };
    const review = {
        sealedLaunchManifest: 'sealed-launch-manifest', authoringCommitment: binding.authoringCommitment, launchManifestCommitment,
        endpointFactsProof: { activationSignature: signature, installationSignature: signature },
        agentTargetKey: 'agent:happier.codex/codex', machineContentKeyBinding: null, credentialSelectionBinding,
        displayFacts: { v: 1 as const, homeId: input.scope.serverId, homeName: 'Runner Home',
            requesterId: input.scope.accountId, requesterName: 'Creator', teamId: 'team-a', teamName: 'Team' },
    };
    const brokerReadinessRequest = {
        v: 1 as const, kind: 'provider_broker_readiness' as const, homeServerIdentityId: input.scope.serverId,
        activationId: input.activationId, launchManifestCommitment, resourceId: credentialSelectionBinding.resourceId,
        agentTargetKey: review.agentTargetKey, modelId: 'gpt-5', protocol: 'openai-responses' as const,
        initiator: { installationId: 'runner-installation', endpointId: 'a'.repeat(64) },
        target: { machineId: credentialSelectionBinding.brokerMachineId, endpointId: 'b'.repeat(64) },
        activationSignature: signature, installationSignature: signature,
    };
    return RunnerActivationProjectionV1Schema.parse({
        ...binding, draftId: input.draftId, state: 'materialized', closeReason: null, progressPhase: null,
        claim: { payload: claimPayload, signature }, endpointFacts: null, review,
        consent: { payload: { v: 1, purpose: 'happier.ephemeral-session-runner.consent', allow: true,
            claim: claimPayload, launchManifestCommitment }, activationSignature: signature, installationSignature: signature },
        readiness: { payload: { v: 1, purpose: 'happier.ephemeral-session-runner.readiness', claim: claimPayload,
            launchManifestCommitment, installation: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.codex', localId: 'codex' } },
                agentRuntimeId: 'codex', executablePath: '/runner/codex', authoritativeVersion: null,
            }, credentialSelectionBinding, brokerReadinessRequest }, activationSignature: signature, installationSignature: signature },
        materialization: { sessionId: binding.sessionId, machineId: binding.machineId },
    });
}
