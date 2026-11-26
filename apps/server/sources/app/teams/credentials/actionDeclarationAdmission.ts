import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { isProjectFiniteActionIdV1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
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
import type { ProviderBrokerActionDeclarationRefusalV3 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { hasCurrentPluginDeclarationSelectionTx, resolveCurrentPluginDeclarationTx, type CurrentPluginDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { db } from '@/storage/db';
import type { Tx } from '@/storage/inTx';

export type TeamCredentialActionDeclarationAdmission =
    | Readonly<{ ok: true; declaration: Readonly<{ version: string; manifestDigestSha256: PluginUiArtifactDigestV1 }>;
        action: PluginActionContributionV2; manifest: ParsedPluginManifestV2 }>
    | Readonly<{ ok: false; reason: ProviderBrokerActionDeclarationRefusalV3 }>;

type TeamCredentialDeclarationRead = Readonly<{
    accountId: string;
    machineId: string;
    machineInstallationId?: string;
    consumer: TeamCredentialActionOperationConsumerV1;
}>;

type TeamCredentialDeclarationAdmissionInput = TeamCredentialDeclarationRead & Readonly<{
    rootActionId: string;
    admittedReviewedChildActionId?: string;
    pluginVersion: string;
    source: TeamCredentialSourceBindingV1;
    /** Read before the Account lock. */
    preparedDeclaration: CurrentPluginDeclarationV1 | null;
}>;

function readProjectSystemToolIdentity(rootActionId: string | undefined, consumer: TeamCredentialActionOperationConsumerV1) {
    return rootActionId === consumer.actionId && isProjectFiniteActionIdV1(rootActionId) ? consumer.purpose.consumer : null;
}

/** Reads the consumer's selected declaration body before the caller takes its
 * Account serialization lock; admission rechecks only its identity under it. */
export async function readTeamCredentialActionDeclaration(input: TeamCredentialDeclarationRead & Readonly<{
    directRootActionId?: string;
}>): Promise<CurrentPluginDeclarationV1 | null> {
    const identity = readProjectSystemToolIdentity(input.directRootActionId, input.consumer)
        ?? parseQualifiedPluginActionId(input.consumer.actionId);
    if (!identity) return null;
    return await resolveCurrentPluginDeclarationTx({ tx: db, accountId: input.accountId,
        pluginId: identity.pluginId, version: input.consumer.pluginVersion,
        machineId: input.machineId, machineInstallationId: input.machineInstallationId });
}

async function readCurrentPreparedDeclaration(tx: Tx, input: TeamCredentialDeclarationAdmissionInput, pluginId: string) {
    if (input.consumer.pluginVersion !== input.pluginVersion || !input.preparedDeclaration) return null;
    // Selection is current only if it still names the prepared body's identity.
    return await resolveCurrentPluginDeclarationTx({ tx, accountId: input.accountId,
        pluginId, version: input.pluginVersion,
        machineId: input.machineId, machineInstallationId: input.machineInstallationId,
        admittedDeclaration: input.preparedDeclaration });
}

function readConnectedService(source: TeamCredentialSourceBindingV1) {
    if (source.kind === 'provider_connection') return null;
    return source.kind === 'connected_account' ? source.target.account.service : source.target.service;
}

async function admitProjectSystemToolDeclarationInTx(tx: Tx, input: TeamCredentialDeclarationAdmissionInput,
    tool: Readonly<{ pluginId: string; localId: string }>): Promise<boolean> {
    const declaration = await readCurrentPreparedDeclaration(tx, input, tool.pluginId);
    const launch = declaration?.manifest.contributes.systemTools.find(candidate => candidate.id === tool.localId)?.connectedAccountLaunch;
    if (!launch || launch.purpose !== input.consumer.purpose.purpose) return false;
    const declaredService = typeof launch.service === 'string' ? { pluginId: tool.pluginId, localId: launch.service } : launch.service;
    const service = readConnectedService(input.source);
    return service?.pluginId === declaredService.pluginId && service.localId === declaredService.localId;
}

/**
 * Direct material for a finite Action, or a Project system-tool launch under
 * its signed root, read from the executing installation's declaration. A
 * refusal names a missing installation declaration separately.
 */
export async function admitTeamCredentialDirectActionDeclarationInTx(tx: Tx, input: TeamCredentialDeclarationAdmissionInput & Readonly<{
    machineInstallationId: string;
}>): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: 'plugin_declaration_not_found' | 'not_declared' }>> {
    const tool = readProjectSystemToolIdentity(input.rootActionId, input.consumer);
    const admitted = tool ? await admitProjectSystemToolDeclarationInTx(tx, input, tool)
        : (await admitTeamCredentialActionDeclarationInTx(tx, input)).ok;
    if (admitted) return { ok: true };
    // Only the refusal reads the body-free selection to name its cause.
    const pluginId = tool?.pluginId ?? parseQualifiedPluginActionId(input.consumer.actionId)?.pluginId;
    const selected = pluginId !== undefined && await hasCurrentPluginDeclarationSelectionTx({ tx, accountId: input.accountId,
        pluginId, machineId: input.machineId, machineInstallationId: input.machineInstallationId });
    return { ok: false, reason: pluginId !== undefined && !selected ? 'plugin_declaration_not_found' : 'not_declared' };
}

/** The Team operation owner admits declared credential use once, from Home's
 * selected declaration. Executing hosts consume the signed result. */
export async function admitTeamCredentialActionDeclarationInTx(tx: Tx, input: TeamCredentialDeclarationAdmissionInput): Promise<TeamCredentialActionDeclarationAdmission> {
    const identity = parseQualifiedPluginActionId(input.consumer.actionId);
    if (!identity) return { ok: false, reason: 'action_not_declared' };
    const declaration = await readCurrentPreparedDeclaration(tx, input, identity.pluginId);
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
    const service = readConnectedService(input.source);
    if (!service || !request.scope.serviceRefs.some(reference => typeof reference === 'string'
        ? service.pluginId === identity.pluginId && service.localId === reference
        : service.pluginId === reference.pluginId && service.localId === reference.localId)) {
        return { ok: false, reason: 'source_not_declared' };
    }
    return { ok: true, declaration: { version: declaration.manifest.version, manifestDigestSha256: computePluginUiArtifactSha256DigestV1(new TextEncoder().encode(createCanonicalJsonSigningInput(declaration.manifest))) },
        action, manifest: declaration.manifest };
}
