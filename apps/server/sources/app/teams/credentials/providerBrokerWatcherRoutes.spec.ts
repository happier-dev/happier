import { expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { AutomationSourceSelectorIdV1Schema, AutomationTriggerIdSchema, sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol';
import {
    GITHUB_BROKER_WATCHER_V1,
    PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
    ProviderBrokerWatcherOpenRequestV1Schema,
    ProviderBrokerWatcherOpenResponseV1Schema,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';

import { createServiceAccountTokenIdentityFields } from '@/app/api/routes/connect/qualifiedConnectedAccounts/identity';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { disableAutomationInTx } from '@/app/automations/automationCrudService';
import { resolvePeerMediationGrantSigningConfig } from '@/app/machines/peer/mediation/mintDirectRouteGrantV1';
import { signProviderBrokerRouteGrantV1, verifyProviderBrokerRouteGrantSignatureV1 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createEnvPatcher, peerMediationGrantSigningEnv } from '@/testkit/env';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedPluginInstallationPublisherHeader, createTrustedMachineInstallation } from '@/testkit/pluginInstallationPublisherTestkit';

import { PROVIDER_BROKER_ROUTE_GRANT_TTL_MS } from './providerBrokerAdmission';
import { registerTeamCredentialProviderBrokerRoutes } from './providerBrokerRoutes';

it('refreshes a recently expired watcher only while its Event trigger and Team entitlement are current', async () => {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'watcher-broker-open-', initAuth: false });
    const app = createAuthenticatedTestApp();
    const signingVars = { ...peerMediationGrantSigningEnv(), HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1' };
    const env = createEnvPatcher(Object.keys(signingVars));
    env.setMany(signingVars);
    try {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Watcher Team' } });
        const requesterMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: requester.id, role: 'member' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
        const initiatorMachineId = 'github-watcher';
        const installationId = 'watcher-installation';
        const materializationId = 'watcher-materialization';
        const initiatorEndpointId = 'a'.repeat(64);
        const brokerEndpointId = 'b'.repeat(64);
        const keyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({ accountId: requester.id, machineId: initiatorMachineId, installationId, keyPair });
        await db.machine.update({ where: { id: initiatorMachineId }, data: {
            pluginMaterializationRevision: 1n,
            operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: initiatorEndpointId } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const broker = await db.machine.create({ data: {
            id: 'github-custodian-broker', accountId: custodian.id, metadata: '{}', kind: 'persistent',
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: brokerEndpointId },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
        const manifest = PluginManifestV2Schema.parse(PLUGIN_MANIFEST);
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: requester.id, pluginId: manifest.id,
            enabled: true, desiredVersion: null, writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: {
            accountId: requester.id, serverIdentityId: await getOrCreateServerIdentityId(process.env),
            machineId: initiatorMachineId, materializationId, pluginId: manifest.id, version: manifest.version,
            sourceClass: 'bundledFirstParty', portableRelease: false, uiArtifacts: [], enabled: true,
            trustState: 'trusted', observedAt: new Date(),
        } });
        const ref = { service: GITHUB_BROKER_WATCHER_V1.service, accountId: 'custodian-github-account' };
        const credential = await db.serviceAccountToken.create({ data: {
            accountId: custodian.id, ...createServiceAccountTokenIdentityFields({ ref, authenticationModeId: 'device' }),
            token: Buffer.from('fixture'), metadata: { v: 4, storage: 'stored_envelope_v1', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', values: {} },
        } });
        const source = { v: 1, kind: 'connected_account', target: { kind: 'account', account: ref }, credentialIncarnation: credential.id };
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: 'Repository credential',
            enabled: true, revision: 1, disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify(source), brokerMachineId: broker.id,
            memberGrants: { create: { teamMembershipId: requesterMembership.id, deliveryMode: 'brokered' } },
        } });
        const automation = await db.automation.create({ data: {
            accountId: requester.id, name: 'Repository Automation', templateCiphertext: '{}',
        } });
        const triggerId = AutomationTriggerIdSchema.parse(crypto.randomUUID());
        const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(crypto.randomUUID());
        const eventLocalId = manifest.contributes.events[0]!.id;
        const trigger = await db.automationTrigger.create({ data: {
            id: triggerId, automationId: automation.id, kind: 'pluginEvent', eventPluginId: manifest.id, eventLocalId,
            sourceSelectorId, sourceContractVersion: 1, observationTransport: 'checkpointedPull',
            watcherMachineId: initiatorMachineId, watcherMachineInstallationId: installationId, watcherPluginId: manifest.id,
            watcherMaterializationId: materializationId,
            definitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: 'plain',
                binding: { v: 1, automationId: automation.id, triggerId, triggerRevision: 0, triggerKind: 'pluginEvent',
                    eventRef: { pluginId: manifest.id, localId: eventLocalId }, sourceSelectorId },
                definition: { v: 1, sourceInstanceId: 'fixture-source', sourceConfig: {}, displayLabel: 'Fixture source',
                    filter: null, maximumObservationAgeMs: null },
            })),
        } });
        const activation = {
            automationId: automation.id, triggerId: trigger.id, triggerRevision: trigger.revision, sourceSelectorId,
        };
        let advertisePresence = true;
        app.decorate('machineDaemonPresence', { in: () => ({ fetchSockets: async () => advertisePresence ? [
            { data: { clientType: 'machine-scoped', userId: requester.id, machineId: initiatorMachineId } },
            { data: { clientType: 'machine-scoped', userId: custodian.id, machineId: broker.id } },
        ] : [] }) });
        registerTeamCredentialProviderBrokerRoutes(app);

        const body = ProviderBrokerWatcherOpenRequestV1Schema.parse({
            v: 1,
            scope: 'automation_event_watcher',
            resourceId: resource.id,
            initiatorMachineId,
            caller: {
                pluginId: manifest.id,
                contributionLocalId: GITHUB_BROKER_WATCHER_V1.backgroundServiceId,
                occurrenceId: 'live-watcher-occurrence',
                materialization: { pluginId: manifest.id, machineId: initiatorMachineId, materializationId },
                sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'watcher-generation' } },
            },
        });
        const proof = (payload: unknown) => createSignedPluginInstallationPublisherHeader({
            keyPair, machineId: initiatorMachineId, installationId, path: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
            body: payload, nonce: crypto.randomUUID(),
        });
        const open = <Payload extends typeof body>(payload: Payload, header = proof(payload)) => app.inject({
            method: 'POST', url: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
            headers: { 'x-test-user-id': requester.id, [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: header },
            payload,
        });
        const response = await open({ ...body, activation });
        expect({ status: response.statusCode, body: response.json() }).toMatchObject({ status: 200, body: { ok: true } });
        const result = ProviderBrokerWatcherOpenResponseV1Schema.parse(response.json());
        if (!result.ok) throw new Error(result.reasonCode);
        expect(result.authority.payload).toMatchObject({
            scope: 'automation_event_watcher', teamId: team.id, resourceId: resource.id, resourceRevision: resource.revision,
            source,
            consumer: { occurrenceId: body.caller.occurrenceId, purpose: {
                consumer: { pluginId: manifest.id, localId: GITHUB_BROKER_WATCHER_V1.attemptActionId },
                purpose: GITHUB_BROKER_WATCHER_V1.purposeId,
            } },
            initiator: { accountId: requester.id, machineId: initiatorMachineId, endpointId: initiatorEndpointId },
            target: { custodianAccountId: custodian.id, machineId: broker.id, endpointId: brokerEndpointId },
        });
        expect(result.target).toMatchObject({ custodianAccountId: custodian.id, brokerMachineId: broker.id, endpointId: brokerEndpointId });
        expect(result.authority.payload.expiresAt - result.authority.payload.issuedAt).toBe(PROVIDER_BROKER_ROUTE_GRANT_TTL_MS);
        const signing = resolvePeerMediationGrantSigningConfig(process.env);
        if (!signing.ok) throw new Error(signing.reasonCode);
        const verifies = () => verifyProviderBrokerRouteGrantSignatureV1({
            authority: result.authority, signingCapability: signing.capability, nowMs: result.authority.payload.issuedAt,
        });
        expect(verifies()).toBe(true);
        expect((await open({ ...body, caller: { ...body.caller, occurrenceId: 'different-occurrence' } }, proof(body))).json())
            .toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        expect((await open({ ...body, initiatorMachineId: broker.id })).json())
            .toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        expect((await open({ ...body, caller: { ...body.caller, contributionLocalId: 'wrong-service' } })).json())
            .toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        const previousAuthority = (elapsedTtls: number) => signProviderBrokerRouteGrantV1({
            signingKey: { keyId: signing.keyId, secretKey: signing.secretKey },
            payload: { ...result.authority.payload,
                issuedAt: result.authority.payload.issuedAt - elapsedTtls * PROVIDER_BROKER_ROUTE_GRANT_TTL_MS,
                expiresAt: result.authority.payload.expiresAt - elapsedTtls * PROVIDER_BROKER_ROUTE_GRANT_TTL_MS },
        });
        const expired = previousAuthority(1.5);
        const refresh = { ...body, activation, refreshAuthority: expired };
        expect((await open({ ...refresh, resourceId: 'different-resource' })).json())
            .toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        expect((await open({ ...refresh, activation: { ...activation, sourceSelectorId: crypto.randomUUID() } })).json())
            .toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        expect((await open({ ...refresh, refreshAuthority: { ...expired, payload: { ...expired.payload, resourceRevision: 42 } } })).json())
            .toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        advertisePresence = false;
        const refreshResponse = (await open(refresh)).json();
        advertisePresence = true;
        expect(Object.keys(refreshResponse)).toEqual(['ok', 'authority']);
        expect(refreshResponse).toMatchObject({ ok: true, authority: { payload: {
            ...expired.payload,
            grantId: expect.not.stringMatching(expired.payload.grantId),
            issuedAt: expect.any(Number),
            expiresAt: expect.any(Number),
        } } });
        expect(refreshResponse.authority.payload.expiresAt - refreshResponse.authority.payload.issuedAt)
            .toBe(PROVIDER_BROKER_ROUTE_GRANT_TTL_MS);
        expect(verifyProviderBrokerRouteGrantSignatureV1({
            authority: refreshResponse.authority, signingCapability: signing.capability, nowMs: Date.now(),
        })).toBe(true);
        const expectRefreshRefused = async (reason: string, payload = refresh) => {
            const response = await open(payload);
            expect.soft({ status: response.statusCode, body: response.json() }, reason)
                .toEqual({ status: 200, body: { ok: false, reasonCode: 'resource_forbidden' } });
        };
        await expectRefreshRefused('previous grant expired more than one TTL ago', { ...refresh, refreshAuthority: previousAuthority(3) });
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { revision: { increment: 1 } } });
        await expectRefreshRefused('resource revision changed');
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { revision: resource.revision } });
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { memberGrants: { deleteMany: {} } } });
        await expectRefreshRefused('resource grant withdrawn while membership remains');
        expect((await open(body)).json()).toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: {
            memberGrants: { create: { teamMembershipId: requesterMembership.id, deliveryMode: 'brokered' } },
        } });
        expect((await open(refresh)).json()).toMatchObject({ ok: true });
        await db.teamMembership.delete({ where: { id: requesterMembership.id } });
        await expectRefreshRefused('Team membership removed while the watcher remains active');
        await db.teamMembership.create({ data: {
            id: requesterMembership.id, teamId: team.id, accountId: requester.id, role: 'member',
        } });
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: {
            memberGrants: { create: { teamMembershipId: requesterMembership.id, deliveryMode: 'brokered' } },
        } });
        await inTx(tx => disableAutomationInTx(tx, { accountId: requester.id, automationId: automation.id }));
        expect((await open(refresh)).json()).toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        expect((await open({ ...body, activation })).json()).toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        await db.pluginMachineMaterialization.update({ where: { machineId_materializationId: { machineId: initiatorMachineId, materializationId } },
            data: { enabled: false } });
        expect((await open(body)).json()).toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        await db.pluginMachineMaterialization.update({ where: { machineId_materializationId: { machineId: initiatorMachineId, materializationId } },
            data: { enabled: true } });
        expect(verifies()).toBe(true);
    } finally {
        env.restore();
        await app.close();
        await harness.close();
    }
}, 180_000);
