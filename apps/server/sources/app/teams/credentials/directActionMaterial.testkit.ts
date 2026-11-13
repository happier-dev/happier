import { PluginManifestV2Schema, type PluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { computeCanonicalDomainSeparatedDigest, encodePlainMachineStoredContent, decodeBase64,
    MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1, computeTeamCredentialConnectedAccountSourceVersionV1,
    computeTeamCredentialSourceMemberKeyV1, createTeamCredentialDirectMaterialStoredV1 } from '@happier-dev/protocol/teams';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { createServiceAccountTokenIdentityFields } from '@/app/api/routes/connect/qualifiedConnectedAccounts/identity';
import { mutateQualifiedConnectedServiceCredential } from '@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { readCurrentTeamCredentialRecipientMaterialInTx, upsertTeamCredentialRecipientMaterialInTx } from './recipientMaterial';
import { createTeamCredentialResourceInTx } from './resourceCreate';
import { readTeamOperationAuthenticationFromRequest } from '../actorContext';

/** Real two-Account sharing fixture; the containing SQLite harness owns cleanup. */
export async function createTeamDirectActionMaterialFixture(options: Readonly<{
    manifest?: PluginManifestV2;
    actionId?: string;
    purposeId?: string;
    serviceId?: string;
    authenticationModeId?: string;
    deliveryMode?: 'direct' | 'brokered';
    homeServerIdentityId?: string;
}> = {}) {
    const custodian = await db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
    const recipient = await db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
    const team = await db.team.create({ data: { name: 'Finite Action sharing' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
    const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
    const machineContent = { host: 'controller', platform: 'linux', happyCliVersion: '0.3.0',
        homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' };
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: recipient.id,
        metadata: encodePlainMachineStoredContent(machineContent), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), active: true,
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64) } } } });
    const declareManifest = (serviceRef: string) => PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'example.cloud', version: '1.0.0',
        displayName: 'Cloud', engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
        hostAccess: { required: [{ id: 'cloud-api', capability: 'connectedAccounts', reason: 'Provision Machines',
            scope: { serviceRefs: [serviceRef], operations: ['use'] } }], optional: [] },
        contributes: { actions: [{ id: 'options', title: 'Options', scopes: ['machine'], surfaces: ['plugin'],
            dangerLevel: 'safe', execution: { target: 'daemon' }, hostAccess: ['cloud-api'],
            inputSchema: { type: 'object' }, resultSchema: { type: 'object' } }] } });
    const manifest = PluginManifestV2Schema.parse(options.manifest ?? declareManifest('cloud'));
    const deliveryMode = options.deliveryMode ?? 'direct';
    const authenticationModeId = options.authenticationModeId ?? 'api-key';
    const setDeclaredService = async (serviceRef: string) => await db.accountPluginIntent.update({
        where: { accountId_pluginId: { accountId: recipient.id, pluginId: manifest.id } },
        data: { releaseLessDeclaration: createReleaseLessDeclarationV1(declareManifest(serviceRef)) } });
    await db.accountPluginIntent.create({ data: { accountId: recipient.id, pluginId: manifest.id, enabled: true, writableCollections: [],
        desiredVersion: null, releaseLessDeclaration: createReleaseLessDeclarationV1(manifest) } });
    const sourceAccount = { service: { pluginId: manifest.id, localId: options.serviceId ?? 'cloud' }, accountId: 'custodian-cloud' };
    const contributionContractVersion = 'artifact-example-1';
    const written = await mutateQualifiedConnectedServiceCredential({ accountId: custodian.id,
        ref: sourceAccount, authenticationModeId, expectedCredentialRevision: null,
        content: { t: 'plain', v: { v: 1, values: { token: 'shared-token' } } }, metadata: { scopes: [] },
        directExportContract: TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
        contributionContractVersion });
    if (written.status !== 'written') throw new Error(`Fixture credential creation refused: ${written.status}`);
    const credentialRevision = written.credentialRevision;
    const credential = await db.serviceAccountToken.findFirstOrThrow({ where: { accountId: custodian.id,
        ...createServiceAccountTokenIdentityFields({ ref: sourceAccount, authenticationModeId }) } });
    const broker = deliveryMode === 'brokered' ? await db.machine.create({ data: {
        id: crypto.randomUUID(), accountId: custodian.id, metadata: encodePlainMachineStoredContent(machineContent),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), active: true,
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1, 3] },
            irohMachineEndpoint: { protocolVersions: [1], endpointId: 'b'.repeat(64) } },
    } }) : null;
    const shared = await inTx(tx => createTeamCredentialResourceInTx(tx, {
        actorAccountId: custodian.id, authentication: readTeamOperationAuthenticationFromRequest({
            authAuthority: 'present_user', authTokenAuthenticationEvidence: [] }),
        resourceId: crypto.randomUUID(), teamId: team.id, displayName: 'Shared cloud',
        source: { v: 1, kind: 'connected_account', target: { kind: 'account', account: sourceAccount }, credentialIncarnation: credential.id },
        deliveryPolicy: { preferredAllowedModes: [deliveryMode] },
        brokerPlacement: broker ? { kind: 'machine', machineId: broker.id } : null,
        sessionUsePolicy: 'personal_allowed', requestPolicy: null, allMembersAllowedRoutes: null,
        groupGrants: [], memberGrants: [{ teamMembershipId: membership.id, allowedRoutes: [deliveryMode] }], usageLimits: [],
    }));
    if (!shared.ok) throw new Error(`Fixture sharing refused: ${shared.error}`);
    const resource = await db.teamCredentialResource.findUniqueOrThrow({ where: { id: shared.resourceId } });
    const sourceMember = { kind: 'connected_account' as const, service: sourceAccount.service, connectedAccountId: sourceAccount.accountId };
    const sourceVersion = computeTeamCredentialConnectedAccountSourceVersionV1({ sourceAccountId: sourceAccount.accountId,
        credentialIncarnation: credential.id, sourceMember, credentialRevision, configurationRevision: null,
        authenticationModeId, contributionContractVersion: computeCanonicalDomainSeparatedDigest(
            TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1, [contributionContractVersion]) });
    const payload = { v: 1 as const, domain: 'happier.team-credential-direct-material' as const,
        homeServerIdentityId: options.homeServerIdentityId ?? 'home', teamId: team.id, resourceId: resource.id, resourceRevision: resource.revision,
        recipientAccountId: recipient.id, sourceMember, sourceVersion,
        material: { kind: 'qualified_connected_account' as const, credential: { v: 1 as const, values: { token: 'shared-token' } },
            configuration: null, authenticationModeId } };
    const stored = createTeamCredentialDirectMaterialStoredV1({ payload, recipientMode: 'plain' });
    const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);
    const published = deliveryMode === 'direct' ? await inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, { actorAccountId: custodian.id,
        resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey, sourceVersion, recipientMode: 'plain',
        recipientContentPublicKeyFingerprint: null, stored, expectedResourceRevision: resource.revision,
        expectedStoredSourceVersion: null, expectedPublishedSourceVersion: null })) : { ok: true as const };
    if (!published.ok) throw new Error(`Fixture publication refused: ${published.reason}`);
    const purpose = { consumer: { pluginId: manifest.id, localId: options.actionId ?? 'options' }, purpose: options.purposeId ?? 'cloud-api' };
    const consumer = { kind: 'action_operation' as const, operationId: 'finite-request',
        actionId: `${manifest.id}/actions/${purpose.consumer.localId}` as const, pluginVersion: manifest.version, purpose };
    // The owner admits any root Action id; refusal cases substitute non-plugin roots.
    const actionAdmission: NonNullable<Parameters<typeof readCurrentTeamCredentialRecipientMaterialInTx>[1]['actionAdmission']> = {
        rootActionId: consumer.actionId, machineId: machine.id };
    const input = { teamId: team.id, resourceId: resource.id, recipientAccountId: recipient.id,
        slot: { kind: 'connected_service_purpose' as const, purpose }, disclosedMember: sourceAccount, consumer,
        actionAdmission,
        sessionAuthentication: { env: process.env, authority: 'present_user' as const, authenticationEvidence: [] },
        authentication: { authenticationAuthority: 'present_user' as const } };
    const readCurrent = (override: Partial<typeof input> = {}) => inTx(tx => readCurrentTeamCredentialRecipientMaterialInTx(tx, { ...input, ...override }));
    return { custodian, recipient, team, membership, machine, broker, manifest, resource, sourceAccount, sourceMemberKey,
        sourceVersion, payload, stored, purpose, consumer, input, readCurrent, setDeclaredService };
}
