import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { TeamOperationAuthenticationContext } from '../actorContext';
import { validatePlannedSessionTeamCredentialResourceInTx } from "./sessionBinding";
import { createCreatorFixture } from '@/app/machines/managed/managedCreatorAccess.testkit';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema,
    MachineProvisionerPowerResultV1Schema,
    MachineProvisionerNativeCredentialApplyResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { ProviderBindingAuthorizationTicketV1Schema, projectProviderBindingAuthorizationTicketReferenceV1 } from '@happier-dev/protocol/providers/grants/v1';
import { SessionModelSelectionV2Schema, sessionModelSelectionV2TeamBindingIntent } from '@happier-dev/protocol/providers/selection/v2';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from 'privacy-kit';

export const TEST_AUTHENTICATION = {
    env: process.env,
    authority: "present_user",
    authenticationEvidence: [],
} as const satisfies SessionAccessAuthentication;

export const TEST_TEAM_AUTHENTICATION = {
    env: TEST_AUTHENTICATION.env,
    authenticationAuthority: TEST_AUTHENTICATION.authority,
    authenticationEvidence: TEST_AUTHENTICATION.authenticationEvidence,
} as const satisfies TeamOperationAuthenticationContext;

export async function createPlannedSessionTeamCredentialFixture(sessionUsePolicy: "personal_allowed" | "team_context_required" | "team_visibility_required") {
    const custodian = await db.account.create({ data: { encryptionMode: "plain" } });
    const creator = await db.account.create({ data: { encryptionMode: "plain" } });
    const team = await db.team.create({ data: { name: `Planned selection ${crypto.randomUUID()}` } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
    const creatorMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: creator.id, role: "member" } });
    const broker = await db.machine.create({ data: {
        id: crypto.randomUUID(),
        accountId: custodian.id,
        active: true,
        kind: "persistent",
        metadata: "{}",
        metadataVersion: 1,
        operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
        operationProtocolCapabilitiesRevision: 1,
    } });
    const resource = await db.teamCredentialResource.create({ data: {
        teamId: team.id,
        custodianAccountId: custodian.id,
        displayName: "Shared Provider",
        disclosureCeiling: "brokered_only",
        sessionUsePolicy,
        brokerMachineId: broker.id,
        sourceBindingJson: JSON.stringify({
            v: 1,
            kind: "provider_connection",
            connectionId: "pc_runner",
            connectionSecurityFingerprint: "connection-security:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            credentialSlotId: "apiKey",
        }),
        memberGrants: { create: { teamMembershipId: creatorMembership.id, deliveryMode: "brokered" } },
    } });
    const validate = (plannedSession: Readonly<{ primaryTeamId: string | null; teamVisibilityTeamIds: readonly string[] }>) =>
        inTx(tx => validatePlannedSessionTeamCredentialResourceInTx(tx, {
            accountId: creator.id,
            resourceId: resource.id,
            expectedResourceRevision: resource.revision,
            deliveryMode: "brokered",
            expectedBrokerMachineId: broker.id,
            plannedSession,
            authentication: TEST_AUTHENTICATION,
        }));
    return { custodian, creator, creatorMembership, team, broker, resource, validate };
}

/** Real accepted-selection/managed-declaration fixture shared with install admission. */
export async function createNativeSessionTeamCredentialFixture() {
    const fixture = await createCreatorFixture();
    const { custodian, creator, controller, row, homeId } = fixture;
    const launch = defineProtocolObject({}, { policy: 'closed' });
    const resource = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
    const roles = defineMachineProvisionerSchemas({ launch, resource });
    const actions = [
        { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
        { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
        { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
        { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
        { id: 'destroy', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        { id: 'native-apply', inputSchema: roles.nativeCredentialApplyInput.jsonSchema,
            resultSchema: MachineProvisionerNativeCredentialApplyResultV1Schema.jsonSchema },
    ];
    const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: fixture.launch.provider.pluginId,
        version: '1.0.0', displayName: 'Compute', description: 'Native credential fixture', engines: { happier: '^1.0.0' },
        runtime: { apiVersion: 1 }, contributes: {
            machineProvisioners: [{ id: fixture.launch.provider.localId, title: 'Compute', icon: 'machine', resourceKind: 'VM', schemaVersion: 1,
                launchSchema: launch.jsonSchema, resourceSchema: resource.jsonSchema, platforms: ['linux'], prerequisites: [],
                billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
                nativeCredentialDelivery: { apply: 'native-apply', transports: ['https_headers'], preservesEndpoint: true, perBindingMatching: true },
                actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } }],
            actions: actions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' },
                surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })),
        } });
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.machine.update({ where: { id: controller.id }, data: { active: true, pluginMaterializationRevision: BigInt(1) } });
    await db.accountPluginIntent.create({ data: { accountId: custodian.id, pluginId: manifest.id,
        enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
    await db.pluginMachineMaterialization.create({ data: { accountId: custodian.id, serverIdentityId: homeId,
        machineId: controller.id, materializationId: controller.installationId!, pluginId: manifest.id, version: manifest.version,
        sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
        uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
    const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: creator.id,
        metadata: encodePlainMachineStoredContent({ host: 'native', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/native', happyHomeDir: '/home/native/.happier' }),
        dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        installationId: crypto.randomUUID(), active: true } });
    await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: guest.id,
        allocation: 'bound', resource: { contributionRef: fixture.launch.provider, schemaVersion: 1, value: { id: 'native-guest' } } } });
    const team = await db.team.create({ data: { name: `Native selection ${crypto.randomUUID()}` } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
    const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: creator.id, role: 'member' } });
    const credential = await db.teamCredentialResource.create({ data: { teamId: team.id, custodianAccountId: custodian.id,
        displayName: 'Shared Gateway', sessionUsePolicy: 'personal_allowed',
        disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ['vendor-native'] }, experimentalBindingConfirmations: [] }),
        sourceBindingJson: JSON.stringify({ v: 1, kind: 'provider_connection', connectionId: 'pc_native',
            connectionSecurityFingerprint: 'connection-security:v1:native', credentialSlotId: 'apiKey' }),
        memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: '["vendor-native"]' } } } });
    const session = await db.session.create({ data: { accountId: creator.id, tag: crypto.randomUUID(),
        metadata: '{}', encryptionMode: 'plain' } });
    const authorizationTicket = ProviderBindingAuthorizationTicketV1Schema.parse({ connectionId: 'pc_native', connectionRevision: 1,
        machineId: controller.id, connectionSecurityFingerprint: 'connection-security:v1:native',
        bindingSecurityFingerprint: 'binding:native', grantFingerprint: 'grant:native',
        selectedSecretBindingId: 'saved-native', selectedSecretRecordFingerprint: 'saved-native:1' });
    const nativeSource = { sourceRevision: 'source-native:1', providerTicket: projectProviderBindingAuthorizationTicketReferenceV1(authorizationTicket) };
    const application = { agentTargetKey: 'backend:codex', implementationIdentity: { pluginId: 'fixture.gateway', localId: 'gateway' },
        endpointTemplateId: 'responses', protocol: 'openai-responses' as const };
    const intent = sessionModelSelectionV2TeamBindingIntent(SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 1,
        ref: { source: 'team_resource', teamId: team.id, resourceId: credential.id, expectedResourceRevision: credential.revision,
            deliveryMode: 'vendor-native', agentTargetKey: application.agentTargetKey, modelId: 'shared-model' } }),
    { application, executionMachineId: guest.id, nativeSource });
    // Authenticated daemon-RPC boundary fixture, consumed by the real Home
    // projection/stamp owner rather than forging a private binding row.
    const readSourceResponse = () => DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success',
        agentTargetKey: application.agentTargetKey, groups: [{ connectionId: authorizationTicket.connectionId,
            providerName: 'Gateway', connectionName: 'Shared', connectionRole: 'named', connectionDisplayNameMode: 'custom',
            connectionRevision: authorizationTicket.connectionRevision, sourceRevision: nativeSource.sourceRevision,
            sourceAuthority: { provider: { identity: application.implementationIdentity, definitionRevision: 1 },
                connectionSecurityFingerprint: authorizationTicket.connectionSecurityFingerprint },
            modelLoadAction: 'available', modelLoadPreflightPolicy: null, authorization: { authorized: true },
            manualModelPolicy: 'allowed', supportsFreeformModelIds: false, suppressedConnectedServiceIds: [],
            rows: [{ ref: { agentTargetKey: application.agentTargetKey, providerConnectionId: authorizationTicket.connectionId,
                modelId: 'shared-model' }, descriptor: { id: 'shared-model', name: 'Shared model' }, application,
                sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                compatibility: { result: { status: 'verified', selectedProtocol: application.protocol,
                    evidence: { sourceUrls: ['https://docs.example.test/gateway'], verifiedAt: '2026-10-28' } },
                    compatibilityFingerprint: 'compatibility:v1:native-fixture', confirmed: false },
                nativeSource: { authorizationTicket, providerTicket: nativeSource.providerTicket,
                    endpoint: { endpointTemplateId: application.endpointTemplateId, normalizedUrl: 'https://api.example.test/v1',
                        protocol: application.protocol, publicHeaders: {} },
                    credentialTransport: { id: 'api-key', protocols: [application.protocol], uses: ['runtime'],
                        destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } } },
                endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible' }],
        }] });
    return { ...fixture, guest, team, membership, credential, session, intent, authorizationTicket, nativeSource, application,
        get sourceResponse() { return readSourceResponse(); } };
}
