import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { auth } from '@/app/auth/auth';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedPluginInstallationPublisherHeader, createTrustedMachineInstallation } from '@/testkit/pluginInstallationPublisherTestkit';
import { PluginInstallationPublisherProofError, verifyPluginInstallationPublisherHeader } from './publisherProof';
import { createPluginAvailabilityOperations } from '@/app/plugins/availability/operations';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAutomationEventRoutes } from '@/app/api/routes/automations/registerAutomationEventRoutes';
import { AutomationEventStoredDefinitionsReadHttpRequestV1Schema } from '@happier-dev/protocol/automations/event';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/protocol/automations/event-setup-result';
import { reportAutomationEventSourceStatusV1 } from '@/app/automations/automationEventSourceStatusService';

describe('admitted requester Event publisher', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-requester-event-', initAuth: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('spends the existing %s requester root while retaining the installed custodian publisher', async encryptionMode => {
        const requester = await db.account.create({ data: { id: randomUUID(), encryptionMode,
            ...(encryptionMode === 'e2ee' ? createSignedAccountContentBinding(tweetnacl.box.keyPair().publicKey) : { publicKey: null }) } });
        const custodian = await db.account.create({ data: { id: randomUUID(), publicKey: null, encryptionMode: 'plain' } });
        const machineId = randomUUID();
        const installationId = randomUUID();
        const keyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({ accountId: custodian.id, machineId, installationId, keyPair });
        await db.machine.update({ where: { id: machineId }, data: {
            metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/custodian', happyHomeDir: '/home/custodian/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        } });
        const grant = await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
            machineId, principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
        expect(grant.kind).toBe('saved');
        const admission = await resolveMachineAdmission({ actorAccountId: requester.id, machineId, requiredRole: 'use' });
        expect(admission).toMatchObject({ kind: 'admitted' });
        if (admission.kind !== 'admitted') throw new Error(`Expected genuine requester Machine admission: ${admission.code}`);
        const target = { kind: 'machine' as const, machineId };
        const requestId = randomUUID();
        const envelope = { v: 1 as const, requestId, target, input: {} };
        // This is the production Home mint, not a fabricated decoded binding.
        const authorization = await auth.mintExternalActionExecutionAuthorization({
            serverIdentityId: await getOrCreateServerIdentityId(), accountId: requester.id,
            authentication: { kind: 'account', tokenEpoch: requester.tokenEpoch },
            machineId, admittedMachineRole: admission.role, actionId: 'scm.worktree.remove', requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target,
        });
        const requesterOperation = { authorizationToken: authorization.token, requestId };
        const path = '/v1/automations/events/stored-definitions/read';
        const verify = async (operation = requesterOperation, publisherAccountId = custodian.id) => {
            const body = { caller: { requesterOperation: operation } };
            return await verifyPluginInstallationPublisherHeader({ accountId: publisherAccountId,
                requesterOperation: operation, path, required: true,
                request: { method: 'POST', body, headers: {
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                        keyPair, machineId, installationId, path, body,
                    }),
                } },
            });
        };
        await expect(verify()).resolves.toEqual({ machineId, installationId,
            requesterOperation: { accountId: requester.id, custodianAccountId: custodian.id, requestId } });
        await expect(verify({ ...requesterOperation, requestId: randomUUID() }))
            .rejects.toBeInstanceOf(PluginInstallationPublisherProofError);
        await expect(verify(requesterOperation, requester.id))
            .rejects.toBeInstanceOf(PluginInstallationPublisherProofError);

        const pluginId = 'com.acme.requester-event';
        const materializationId = randomUUID();
        const availability = createPluginAvailabilityOperations();
        await availability.claimCollectionWriters({ accountId: custodian.id, input: { manifest: {
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Requester Event fixture',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './dist/index.js' }, contributes: {
                actions: [{ id: 'setup', title: 'Choose source', scopes: ['global'], surfaces: ['plugin'],
                    dangerLevel: 'safe', readOnly: true, execution: { target: 'daemon' },
                    inputSchema: { type: 'object', additionalProperties: false },
                    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, { type: 'object', additionalProperties: false }) }],
                events: [{ id: 'settled', kind: 'event', title: 'Settled', payloadSchema: { type: 'object', additionalProperties: false },
                    automation: { v: 1, eligible: true, source: { sourceContractVersion: 1,
                        supportedObservationTransports: ['checkpointedPull'], sourceConfigSchema: { type: 'object', additionalProperties: false },
                        setupActionRef: { pluginId, localId: 'setup' } } } }],
            },
        } } });
        await availability.reportMaterializations({ accountId: custodian.id, publisherMachineId: machineId, input: {
            expectedRevision: null, snapshot: { serverIdentityId: authorization.binding.serverIdentityId, machineId,
                materializations: [{ serverIdentityId: authorization.binding.serverIdentityId, machineId, pluginId,
                    materializationId, version: '1.0.0', sourceClass: 'bundledFirstParty', portableRelease: false,
                    uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: Date.now() }] },
        } });
        await db.automationEventCatalogState.create({ data: { accountId: requester.id, eventSourceDefinitionsRevision: 7n } });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerAutomationEventRoutes(app);
        try {
            const custodianBearer = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const caller = { pluginId, materialization: { machineId, materializationId, pluginId },
                occurrenceId: 'installed-occurrence', sourceCustody: { kind: 'bundled_first_party',
                    packagedRuntime: { kind: 'cli_version_root', versionRootId: 'fixture-cli' } }, requesterOperation };
            const read = async (operation = requesterOperation, signedInstallationId = installationId) => {
                const body = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse({ v: 1, caller: { ...caller, requesterOperation: operation }, input: { transport: { kind: 'checkpointedPull' } } });
                return app.inject({ method: 'POST', url: path, payload: body, headers: {
                    Authorization: `Bearer ${custodianBearer}`,
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                        keyPair, machineId, installationId: signedInstallationId, path, body }),
                } });
            };
            const result = await read();
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json()).toMatchObject({ kind: 'page', revision: '7', definitions: [] });
            expect((await read({ ...requesterOperation, requestId: randomUUID() })).statusCode).toBe(401);
            expect((await read(requesterOperation, randomUUID())).statusCode).toBe(401);
            await reportAutomationEventSourceStatusV1({ accountId: requester.id,
                caller: { pluginId, machineId, machineInstallationId: installationId, materializationId,
                    materializationAccountId: custodian.id, occurrenceId: caller.occurrenceId,
                    sourceCustody: caller.sourceCustody },
                input: { kind: 'catalogReconciliation', scope: { kind: 'checkpointedPull' }, observedRevision: '7',
                    adoptedRevision: '7', state: 'current', scanStartedAt: null, nextRetryAt: null } });
            expect(await db.automationEventSourceCatalogStatus.findFirst({ where: { accountId: requester.id } }))
                .toMatchObject({ accountId: requester.id, reporterMachineId: machineId,
                    reporterMachineInstallationId: installationId, reporterMaterializationId: materializationId });
            expect(await db.automationEventSourceCatalogStatus.count({ where: { accountId: custodian.id } })).toBe(0);
        } finally { await app.close(); }
    });
});
