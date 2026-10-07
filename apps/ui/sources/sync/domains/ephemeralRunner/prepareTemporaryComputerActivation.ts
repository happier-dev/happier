import {
    RunnerPreparedAuthoringV1Schema,
    computeRunnerAuthoringCommitmentV1,
    type RunnerPreparedAuthoringV1,
    type RunnerReviewedFileV1,
} from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import type { VerifiedRunnerArtifactV1 } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import type { ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import type { ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { SessionAuthoringValueV1 } from '@happier-dev/protocol/sessions/authoring/index';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import type { ExpectedMarketplaceListingV1 } from '@happier-dev/protocol/marketplace/internal';
import { RunnerEndpointFactsRecipientV1Schema, type RunnerEndpointFactsRecipientV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import type { RunnerMcpMaterialV1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';

import {
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
    isTokenOnlyAuthCredentials,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';
import type { RunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { Encryption } from '@/sync/encryption/encryption';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { RunnerActivationKeyCustody } from './runnerActivationKeyCustody';
import {
    findRunnerUnsupportedAuthoringField,
    type RunnerUnsupportedAuthoringField,
} from './runnerAuthoringCompatibility';

export type PreparedTemporaryComputerActivation = Readonly<{
    request: Parameters<RunnerActivationClient['create']>[0];
    custody: RunnerActivationKeyCustody;
    preparedAuthoring: RunnerPreparedAuthoringV1;
}>;

export type RunnerAgentPluginDistributionErrorCode =
    /** The Agent comes from an installed plugin the endpoint cannot acquire exactly. */
    | 'runner_agent_plugin_distribution_unavailable'
    /** A distribution was supplied for an Agent the Runner artifact already carries. */
    | 'runner_agent_plugin_distribution_unexpected';

/**
 * A Temporary computer starts with only the bundled Runner generation. An
 * external Agent therefore reaches it exactly once — as the reviewed
 * distribution commitment the endpoint acquires through the canonical plugin
 * change owner. Neither half may be fabricated or omitted here.
 */
export class RunnerAgentPluginDistributionError extends Error {
    constructor(readonly code: RunnerAgentPluginDistributionErrorCode) {
        super(code);
        this.name = 'RunnerAgentPluginDistributionError';
    }
}

export type RunnerCreatorRecipientAuthorityErrorCode =
    | 'runner_creator_scope_mismatch'
    | 'runner_creator_recipient_mismatch'
    | 'runner_account_encryption_mismatch'
    | 'runner_account_signing_authority_unavailable';

export class RunnerCreatorRecipientAuthorityError extends Error {
    constructor(readonly code: RunnerCreatorRecipientAuthorityErrorCode) {
        super(code);
        this.name = 'RunnerCreatorRecipientAuthorityError';
    }
}

/**
 * A selected ordinary authoring feature may reach Runner only after its
 * canonical owner can produce exact activation-scoped runtime material. The
 * endpoint deliberately has no Account settings or credential fallback.
 */
export class RunnerAuthoringIncompatibilityError extends Error {
    constructor(readonly field: RunnerUnsupportedAuthoringField) {
        super(`runner_authoring_${field}_unsupported`);
        this.name = 'RunnerAuthoringIncompatibilityError';
    }
}

function assertRunnerAuthoringMaterializationAvailable(
    authoring: SessionAuthoringValueV1,
    selectedAgentProviderOwnedEnvironmentKeys: readonly string[],
): void {
    const field = findRunnerUnsupportedAuthoringField(authoring, selectedAgentProviderOwnedEnvironmentKeys);
    if (field !== null) throw new RunnerAuthoringIncompatibilityError(field);
}

/**
 * A Temporary computer carries the bundled Runner generation and nothing else,
 * so provenance decides whether an acquisition commitment belongs in the sealed
 * submission: a bundled Agent must carry none, and an Agent contributed by an
 * installed plugin must carry exactly the one the creator resolved.
 */
function assertRunnerAgentPluginDistribution(
    agentTarget: SessionAuthoringValueV1['agentTarget'],
    distribution: ExpectedMarketplaceListingV1 | null,
): ExpectedMarketplaceListingV1 | null {
    // An absent Agent target is the reviewed submission's own error; it is
    // rejected by the strict schema below rather than misreported here.
    if (agentTarget === null) return null;
    if (resolveBundledAgentIdFromContributionIdentity(agentTarget.identity) !== null) {
        if (distribution !== null) {
            throw new RunnerAgentPluginDistributionError('runner_agent_plugin_distribution_unexpected');
        }
        return null;
    }
    if (distribution === null) {
        throw new RunnerAgentPluginDistributionError('runner_agent_plugin_distribution_unavailable');
    }
    return distribution;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function deriveCreatorEndpointFactsRecipient(input: Readonly<{
    scope: ServerAccountScope;
    credentials: AuthCredentials;
    encryption: Encryption | null;
    /** The Home's projection of this Account's own published recipient. */
    homeRecipient: RunnerEndpointFactsRecipientV1;
}>): Promise<RunnerEndpointFactsRecipientV1> {
    // The three credential shapes are mutually exclusive, but token-only is a
    // structural supertype of both key-bearing shapes, so only the exact
    // key-bearing checks narrow. They therefore run before the token-only
    // remainder; the accepted outcome per shape is unchanged.
    if (isLegacyAuthCredentials(input.credentials)) {
        if (!input.encryption) {
            throw new RunnerCreatorRecipientAuthorityError('runner_account_encryption_mismatch');
        }
        const seed = decodeBase64(input.credentials.secret, 'base64url');
        if (seed.length !== 32) {
            seed.fill(0);
            throw new RunnerCreatorRecipientAuthorityError('runner_account_signing_authority_unavailable');
        }
        try {
            const rederivedEncryption = await Encryption.create(seed);
            if (!equalBytes(input.encryption.contentDataKey, rederivedEncryption.contentDataKey)) {
                throw new RunnerCreatorRecipientAuthorityError('runner_account_encryption_mismatch');
            }
            const signingKeyPair = sodium.crypto_sign_seed_keypair(seed);
            try {
                const signature = signAccountContentKeyBindingV1({
                    accountSigningSecretKey: signingKeyPair.privateKey,
                    contentPublicKey: rederivedEncryption.contentDataKey,
                });
                return RunnerEndpointFactsRecipientV1Schema.parse({
                    mode: 'e2ee',
                    creatorAccountId: input.scope.accountId,
                    accountSigningPublicKey: encodeBase64(signingKeyPair.publicKey, 'base64url'),
                    contentPublicKey: encodeBase64(rederivedEncryption.contentDataKey, 'base64url'),
                    contentPublicKeySignature: encodeBase64(signature, 'base64url'),
                    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(rederivedEncryption.contentDataKey),
                });
            } finally {
                signingKeyPair.privateKey.fill(0);
            }
        } finally {
            seed.fill(0);
        }
    }
    if (isDataKeyAuthCredentials(input.credentials)) {
        // A data-key Account keeps no Account signing key on the device, so this
        // creator cannot re-sign its own content-key binding. It does not have to:
        // that binding is public material the Account already published, and the
        // Home merely carries it. `RunnerEndpointFactsRecipientV1Schema` verifies
        // the signature and its fingerprint, and the decisive creator-side fact is
        // checked here — the bound content key must be the one this device
        // actually holds, which is exactly what a substituted recipient cannot
        // satisfy. Nothing downstream trusts the carried signing key as an
        // authority: every proof verifier resolves the activation signing identity
        // from its own scope.
        if (!input.encryption) {
            throw new RunnerCreatorRecipientAuthorityError('runner_account_encryption_mismatch');
        }
        if (
            input.homeRecipient.mode !== 'e2ee'
            || input.homeRecipient.creatorAccountId !== input.scope.accountId
        ) {
            throw new RunnerCreatorRecipientAuthorityError('runner_creator_recipient_mismatch');
        }
        if (!equalBytes(
            decodeBase64(input.homeRecipient.contentPublicKey, 'base64url'),
            input.encryption.contentDataKey,
        )) {
            throw new RunnerCreatorRecipientAuthorityError('runner_account_encryption_mismatch');
        }
        return input.homeRecipient;
    }
    if (!isTokenOnlyAuthCredentials(input.credentials) || input.encryption !== null) {
        throw new RunnerCreatorRecipientAuthorityError('runner_account_encryption_mismatch');
    }
    return RunnerEndpointFactsRecipientV1Schema.parse({
        mode: 'plain',
        creatorAccountId: input.scope.accountId,
    });
}

/** Builds the one protocol-owned reviewed submission and binds its device-local key. */
export async function prepareTemporaryComputerActivation(input: Readonly<{
    client: RunnerActivationClient;
    /** Existing verified activation-local identity allocated before durable attachment staging. */
    custody: RunnerActivationKeyCustody;
    scope: ServerAccountScope;
    credentials: AuthCredentials;
    encryption: Encryption | null;
    draftId: string;
    homeServerIdentityId: string;
    artifact: VerifiedRunnerArtifactV1;
    authoring: SessionAuthoringValueV1;
    composer: ComposerSnapshotV1;
    reviewComments?: RunnerPreparedAuthoringV1['reviewComments'];
    files: readonly RunnerReviewedFileV1[];
    attachmentDestination: RunnerPreparedAuthoringV1['attachmentDestination'];
    /** Exact normalized Account policy reviewed for this launch. */
    actionsSettings: ActionsSettingsV1;
    /** Explicit reviewed MCP material; null means no managed MCP servers. */
    mcpMaterial: RunnerMcpMaterialV1 | null;
    /** Canonical provider-owned keys declared by the exact selected Agent. */
    selectedAgentProviderOwnedEnvironmentKeys: readonly string[];
    /**
     * Exact reviewed distribution for an Agent contributed by an installed
     * external plugin, resolved from the marketplace index of the machine whose
     * Agent catalog the creator chose from. Omitted for a bundled Agent.
     */
    agentPluginDistribution?: ExpectedMarketplaceListingV1 | null;
    /** One-shot explicit creator consent for this exact activation only. */
    authorizeUnattendedTeamAccess?: boolean;
    /** Preparation cancellation. It reaches only the safe Home currentness read. */
    signal?: AbortSignal;
}>): Promise<PreparedTemporaryComputerActivation> {
    assertRunnerAuthoringMaterializationAvailable(
        input.authoring,
        input.selectedAgentProviderOwnedEnvironmentKeys,
    );
    const agentPluginDistribution = assertRunnerAgentPluginDistribution(
        input.authoring.agentTarget,
        input.agentPluginDistribution ?? null,
    );
    const preparedAuthoring = RunnerPreparedAuthoringV1Schema.parse({
        v: 1,
        actionsSettings: input.actionsSettings,
        mcpMaterial: input.mcpMaterial,
        authoring: {
            targetType: input.authoring.targetType,
            executionTarget: input.authoring.executionTarget,
            agentTarget: input.authoring.agentTarget,
            permissionMode: input.authoring.permissionMode,
            modelSelection: input.authoring.modelSelection,
            transcriptStorage: input.authoring.transcriptStorage,
            profileId: input.authoring.profileId,
            environmentVariables: input.authoring.environmentVariables,
            mcpSelection: input.authoring.mcpSelection,
            connectedServices: input.authoring.connectedServices,
            checkoutCreationDraft: input.authoring.checkoutCreationDraft,
            resumeSessionId: input.authoring.resumeSessionId,
            terminal: input.authoring.terminal,
            windowsRemoteSessionLaunchMode: input.authoring.windowsRemoteSessionLaunchMode,
            windowsRemoteSessionConsole: input.authoring.windowsRemoteSessionConsole,
            windowsTerminalWindowName: input.authoring.windowsTerminalWindowName,
            acpSessionModeId: input.authoring.acpSessionModeId,
            sessionConfigOptionOverrides: input.authoring.sessionConfigOptionOverrides,
            access: input.authoring.access,
            primaryTeamId: input.authoring.primaryTeamId,
            organizationPlacement: input.authoring.organizationPlacement,
        },
        agentPluginDistribution,
        composer: {
            text: input.composer.text,
            references: input.composer.references,
            attachments: input.composer.attachments.map(({ availability: _availability, content: _content, ...reviewed }) => reviewed),
        },
        reviewComments: input.reviewComments ?? null,
        files: input.files,
        attachmentDestination: input.attachmentDestination,
    });
    // For a creator that can re-derive its own binding the Home is only a
    // currentness/equality witness and never selects the recipient. A data-key
    // creator holds no Account signing key, so the Home carries the Account's own
    // published binding instead; that arm checks it against the content key this
    // device holds before returning it, and the equality below is then its own
    // trivial witness.
    const homeRecipient = RunnerEndpointFactsRecipientV1Schema.parse(await input.client.readCreatorRecipient(input.signal));
    const recipient = await deriveCreatorEndpointFactsRecipient({ ...input, homeRecipient });
    if (createCanonicalJsonSigningInput(homeRecipient) !== createCanonicalJsonSigningInput(recipient)) {
        throw new RunnerCreatorRecipientAuthorityError('runner_creator_recipient_mismatch');
    }
    input.signal?.throwIfAborted();
    const executionTarget = preparedAuthoring.authoring.executionTarget;
    if (executionTarget?.kind !== 'temporary_computer') {
        throw new Error('runner_temporary_computer_execution_target_required');
    }
    return {
        custody: input.custody,
        preparedAuthoring,
        request: {
            v: 1,
            activationId: input.custody.activationId,
            draftId: input.draftId,
            ...(input.authorizeUnattendedTeamAccess ? { authorizeUnattendedTeamAccess: true as const } : {}),
            homeServerIdentityId: input.homeServerIdentityId,
            activationSigningPublicKey: input.custody.activationSigningPublicKey,
            // Absent expiry is the product default (Never). The author's
            // explicit absolute instant is carried by the reviewed
            // execution target, so the activation row and the reviewed
            // submission can never disagree about when the package dies.
            activationExpiresAt: input.authoring.executionTarget?.kind === 'temporary_computer'
                ? input.authoring.executionTarget.packageExpiresAt ?? null
                : null,
            workspace: executionTarget.workspace,
            authoringCommitment: computeRunnerAuthoringCommitmentV1(preparedAuthoring),
            artifact: input.artifact.identity,
            endpointFactsRecipient: recipient,
        },
    };
}
