import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { isManagedProvisionerOperationActionForRootV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { isScmHostingOperationActionForRootV1 } from '@happier-dev/protocol/actions/scmHostingActionIdsV1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { resolvePluginActionConnectedAccountUseRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import type { ParsedPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import type { PluginActionContributionV2 } from '@happier-dev/protocol/plugins/actions/v2';
import type { TeamCredentialActionOperationConsumerV1 } from '@happier-dev/protocol/teams/credentials/actionOperationV1';
import type { TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import type { PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { resolveCurrentPluginDeclarationTx, type CurrentPluginDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { db } from '@/storage/db';
import type { Tx } from '@/storage/inTx';

export type TeamCredentialActionDeclarationAdmission =
    | Readonly<{ ok: true; declaration: Readonly<{ version: string; manifestDigestSha256: PluginUiArtifactDigestV1 }>;
        action: PluginActionContributionV2; manifest: ParsedPluginManifestV2 }>
    | Readonly<{ ok: false; reason: 'action_not_declared' | 'purpose_not_declared' | 'source_not_declared' }>;

/** Reads the consumer's selected declaration body before the caller takes its
 * Account serialization lock; admission rechecks only its identity under it. */
export async function readTeamCredentialActionDeclaration(input: Readonly<{
    accountId: string;
    machineId: string;
    consumer: TeamCredentialActionOperationConsumerV1;
}>): Promise<CurrentPluginDeclarationV1 | null> {
    const identity = parseQualifiedPluginActionId(input.consumer.actionId);
    if (!identity) return null;
    return await resolveCurrentPluginDeclarationTx({ tx: db, accountId: input.accountId,
        pluginId: identity.pluginId, version: input.consumer.pluginVersion, machineId: input.machineId });
}

/** The Team operation owner admits declared credential use once, from Home's
 * selected declaration. Executing hosts consume the signed result. */
export async function admitTeamCredentialActionDeclarationInTx(tx: Tx, input: Readonly<{
    accountId: string;
    rootActionId: string;
    admittedReviewedChildActionId?: string;
    machineId: string;
    pluginVersion: string;
    consumer: TeamCredentialActionOperationConsumerV1;
    source: TeamCredentialSourceBindingV1;
    /** From `readTeamCredentialActionDeclaration`, read before the Account lock. */
    preparedDeclaration: CurrentPluginDeclarationV1 | null;
}>): Promise<TeamCredentialActionDeclarationAdmission> {
    const identity = parseQualifiedPluginActionId(input.consumer.actionId);
    if (!identity || input.consumer.pluginVersion !== input.pluginVersion || !input.preparedDeclaration) {
        return { ok: false, reason: 'action_not_declared' };
    }
    // Selection is current only if it still names the prepared body's identity.
    const declaration = await resolveCurrentPluginDeclarationTx({ tx, accountId: input.accountId,
        pluginId: identity.pluginId, version: input.pluginVersion, machineId: input.machineId,
        admittedDeclaration: input.preparedDeclaration });
    if (!declaration || (input.rootActionId !== input.consumer.actionId
        && !(input.rootActionId === ACTION_INVOKE_ACTION_ID_V1 && input.admittedReviewedChildActionId === input.consumer.actionId)
        && !isManagedProvisionerOperationActionForRootV1(input.rootActionId, identity, declaration.manifest)
        && !isScmHostingOperationActionForRootV1(input.rootActionId, identity, declaration.manifest))) {
        return { ok: false, reason: 'action_not_declared' };
    }
    const requests = resolvePluginActionConnectedAccountUseRequestsV2(declaration.manifest, identity.localId);
    const action = declaration.manifest.contributes.actions.find(candidate => candidate.id === identity.localId);
    if (!requests || !action) return { ok: false, reason: 'action_not_declared' };
    const purpose = input.consumer.purpose;
    const request = purpose.consumer.pluginId === identity.pluginId && purpose.consumer.localId === identity.localId
        ? requests.find(candidate => candidate.request.id === purpose.purpose)?.request : undefined;
    if (!request) return { ok: false, reason: 'purpose_not_declared' };
    const source = input.source;
    if (source.kind === 'provider_connection') return { ok: false, reason: 'source_not_declared' };
    const service = source.kind === 'connected_account' ? source.target.account.service : source.target.service;
    if (!request.scope.serviceRefs.some(reference => typeof reference === 'string'
        ? service.pluginId === identity.pluginId && service.localId === reference
        : service.pluginId === reference.pluginId && service.localId === reference.localId)) {
        return { ok: false, reason: 'source_not_declared' };
    }
    return { ok: true, declaration: { version: declaration.manifest.version, manifestDigestSha256: computePluginUiArtifactSha256DigestV1(new TextEncoder().encode(createCanonicalJsonSigningInput(declaration.manifest))) },
        action, manifest: declaration.manifest };
}
