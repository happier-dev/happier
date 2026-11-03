import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionMachineRpcExecution } from '@/app/auth/externalActionExecutionAuthorization';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createNativeSessionTeamCredentialFixture, TEST_AUTHENTICATION } from '@/app/teams/credentials/sessionBinding.testkit';
import { writeSessionTeamCredentialBindingsInTx, stampSessionTeamCredentialNativeDeliveryInTx } from '@/app/teams/credentials/sessionBinding';
import { readSessionTeamCredentialNativeSelectionInTx } from '@/app/teams/credentials/nativeDeliveryRead';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { ExternalActionMachineRpcExecutionV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1, type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { prepareLayout1SessionCreate } from '@/app/session/create/prepareLayout1SessionCreate';
import { createOrRejoinLayout1SessionByTagInTx } from '@/app/session/create/createOrRejoinLayout1SessionByTag';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';

describe('spawn-owned native credential child', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-native-spawn-child-', initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: `srv_${'a'.repeat(32)}`, AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('admits only the exact signed birth binding and current controller (%s)', async mode => {
        const f = await createNativeSessionTeamCredentialFixture();
        const accountBinding = mode === 'e2ee' ? createSignedAccountContentBinding(nacl.box.keyPair().publicKey) : null;
        await db.account.update({ where: { id: f.creator.id }, data: { encryptionMode: mode,
            ...(accountBinding ? { publicKey: accountBinding.publicKey,
                contentPublicKey: new Uint8Array(accountBinding.contentPublicKey),
                contentPublicKeySig: new Uint8Array(accountBinding.contentPublicKeySig) } : {}) } });
        await db.session.update({ where: { id: f.session.id }, data: { active: true, encryptionMode: mode } });
        const keys = nacl.sign.keyPair();
        for (const machine of [f.guest, f.controller]) await db.machine.update({ where: { id: machine.id }, data: {
            active: true, installationPublicKey: new Uint8Array(keys.publicKey),
            metadata: mode === 'e2ee' && machine.id === f.guest.id ? 'opaque-owned-machine-metadata'
                : encodePlainMachineStoredContent({ host: 'native', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/home/native', happyHomeDir: '/home/native/.happier' }),
            dataEncryptionKey: mode === 'e2ee' && machine.id === f.guest.id ? null
                : decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        } });
        const rootInput = { executionTarget: { serverId: await getOrCreateServerIdentityId(), machineId: f.guest.id },
                teamCredentialBindings: [f.intent],
                directory: { kind: 'path', path: '/workspace' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        // Ciphertext is the genuine installed-source network boundary: Home
        // cannot open it; the CLI signer suite proves the reviewed plaintext.
        const rootTarget = { kind: 'machine' as const, machineId: f.guest.id };
        const rootRequestId = crypto.randomUUID();
        const envelope: ExternalActionRequestEnvelope = mode === 'plain'
            ? { v: 1, requestId: rootRequestId, target: rootTarget, input: rootInput }
            : { v: 2, requestId: rootRequestId, target: rootTarget,
                payload: { t: 'encrypted', c: 'opaque-reviewed-spawn' } };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: f.creator.id,
            serverIdentityId: await getOrCreateServerIdentityId(), authentication: { kind: 'account', tokenEpoch: f.creator.tokenEpoch },
            actionId: 'session.spawn_new', machineId: f.guest.id, target: rootTarget, requestId: rootRequestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) });
        const preparation = prepareLayout1SessionCreate({ accountId: f.creator.id, tag: crypto.randomUUID(),
            metadata: mode === 'plain' ? JSON.stringify({ v: 1 }) : 'opaque-shared-ciphertext',
            ownerMetadata: mode === 'plain' ? { t: 'plain', v: { v: 1 } }
                : { t: 'encrypted', c: 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==' },
            agentState: null, dataEncryptionKey: null, requestedEncryptionMode: undefined,
            requestedStorageState: undefined, organizationPlacement: undefined,
            teamCredentialBindings: [f.intent], accountEncryptionMode: mode,
            storagePolicy: 'optional', defaultAccountMode: 'e2ee' });
        if (!preparation.ok) throw new Error(preparation.rejection.reason);
        const birth = await inTx(tx => createOrRejoinLayout1SessionByTagInTx(tx,
            preparation.prepared, TEST_AUTHENTICATION, authorization.binding));
        if (birth.kind !== 'created') throw new Error(`Unexpected birth: ${birth.kind === 'rejected' ? birth.rejection.reason : birth.kind}`);
        f.session = birth.session;
        await db.session.update({ where: { id: f.session.id }, data: { active: true } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: f.creator.id,
            machineId: f.guest.id, sessionId: f.session.id, data: 'native-spawn-child-session-key' }))).toMatchObject({ ok: true });
        expect(await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }))).toMatchObject({ ok: true });
        const selected = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id }));
        if (!selected.ok) throw new Error(selected.code);
        const request = { homeId: f.homeId, managedId: f.row.id, sessionId: f.session.id,
            bindingKey: selected.binding.safeFacet.bindingKey, expectedResourceRevision: selected.binding.resourceRevision,
            expectedSourceRevision: selected.binding.safeFacet.sourceRevision,
            expectedProviderTicket: selected.binding.safeFacet.providerTicket };
        const method = `${f.controller.id}:machines.managed.credentials.install`;
        const requestId = crypto.randomUUID();
        const managedAdmission = { actionId: 'machines.managed.credentials.install' as const, input: request };
        const params = mode === 'plain' ? request : 'opaque-reviewed-native-install';
        const signed = { authorizationToken: authorization.token, effectActionId: managedAdmission.actionId,
            target: authorization.binding.target, installationId: authorization.binding.installationId,
            method, requestId, params, managedAdmission };
        const execution = { v: 1 as const, authorization, effectActionId: managedAdmission.actionId,
            target: authorization.binding.target, installationId: authorization.binding.installationId, managedAdmission,
            machineSignature: signExternalActionMachineRpcRequestV1({ ...signed, privateKey: keys.secretKey }) };
        const verify = async (value: unknown = execution) => {
            const parsed = ExternalActionMachineRpcExecutionV1Schema.safeParse(value);
            return parsed.success ? verifyExternalActionMachineRpcExecution(parsed.data,
                { method, requestId, params, originalActionEnvelope: envelope,
                    nativeCredentialSpawnChildIssuance: true }) : null;
        };
        expect(await verify()).toMatchObject({ binding: { actionId: 'session.spawn_new' },
            effectActionId: 'machines.managed.credentials.install' });
        expect(await verifyExternalActionMachineRpcExecution(execution,
            { method, requestId, params, originalActionEnvelope: envelope })).toBeNull();
        const differentBinding = { ...request, bindingKey: crypto.randomUUID() };
        const differentAdmission = { ...managedAdmission, input: differentBinding };
        const differentParams = mode === 'plain' ? differentBinding : 'opaque-other-native-install';
        expect(await verifyExternalActionMachineRpcExecution({ ...execution, managedAdmission: differentAdmission,
            machineSignature: signExternalActionMachineRpcRequestV1({ ...signed, managedAdmission: differentAdmission,
                params: differentParams, privateKey: keys.secretKey }) },
        { method, requestId, params: differentParams, originalActionEnvelope: envelope,
            nativeCredentialSpawnChildIssuance: true })).toBeNull();
        const otherEffect = 'machines.managed.delete' as const;
        expect(await verify({ ...execution, effectActionId: otherEffect,
            machineSignature: signExternalActionMachineRpcRequestV1({ ...signed,
                effectActionId: otherEffect, privateKey: keys.secretKey }) })).toBeNull();
        expect(await verify({ ...execution, machineSignature: 'A'.repeat(86) })).toBeNull();
        if (envelope.v === 1) {
            const unselectedEnvelope = { ...envelope, requestId: crypto.randomUUID(),
                input: { ...rootInput, teamCredentialBindings: [] } };
            const unselectedAuthorization = await auth.mintExternalActionExecutionAuthorization({ accountId: f.creator.id,
                serverIdentityId: f.homeId, authentication: { kind: 'account', tokenEpoch: f.creator.tokenEpoch },
                actionId: 'session.spawn_new', machineId: f.guest.id, target: rootTarget,
                requestId: unselectedEnvelope.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(unselectedEnvelope) });
            const laterSelectionBirth = await inTx(tx => createOrRejoinLayout1SessionByTagInTx(tx,
                { ...preparation.prepared, tag: crypto.randomUUID() }, TEST_AUTHENTICATION, unselectedAuthorization.binding));
            if (laterSelectionBirth.kind !== 'created') throw new Error(`Unexpected birth: ${laterSelectionBirth.kind}`);
            const sessionId = laterSelectionBirth.session.id;
            await db.session.update({ where: { id: sessionId }, data: { active: true } });
            expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: f.creator.id,
                machineId: f.guest.id, sessionId, data: 'later-selected-session-key' }))).toMatchObject({ ok: true });
            expect(await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId,
                accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }))).toMatchObject({ ok: true });
            const later = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId }));
            if (!later.ok) throw new Error(later.code);
            const laterRequest = { ...request, sessionId, bindingKey: later.binding.safeFacet.bindingKey };
            const laterAdmission = { ...managedAdmission, input: laterRequest };
            const laterExecution = { ...execution, authorization: unselectedAuthorization, managedAdmission: laterAdmission,
                machineSignature: signExternalActionMachineRpcRequestV1({ ...signed,
                    authorizationToken: unselectedAuthorization.token, params: laterRequest,
                    managedAdmission: laterAdmission, privateKey: keys.secretKey }) };
            expect(await verifyExternalActionMachineRpcExecution(laterExecution, { method, requestId,
                params: laterRequest, originalActionEnvelope: unselectedEnvelope,
                nativeCredentialSpawnChildIssuance: true })).toBeNull();
        }
        const writeStored = (stored: unknown) => db.sessionTeamCredentialBinding.updateMany({
            where: { sessionId: f.session.id }, data: { nativeDeliveryJson: JSON.stringify(stored) } });
        // A minted root and an accepted birth are insufficient without the
        // authenticated post-approval installed-source signature.
        const { creationAuthorization: _birth, ...withoutBirth } = selected.stored;
        await writeStored(withoutBirth);
        expect(await verify()).toBeNull();
        await writeStored(selected.stored);
        const { source: _source, model: _model, ...unconfirmed } = selected.stored;
        await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: { enabled: false } });
        expect(await verify()).toBeNull();
        await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: { enabled: true } });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        let sourceAvailable = true;
        let sourceCompatible = true;
        const incompatibleResponse = f.sourceResponse;
        if (incompatibleResponse.status !== 'success') throw new Error('Expected available native source fixture');
        Object.assign(incompatibleResponse.groups[0]!.rows[0]!.compatibility!, { result: {
            status: 'incompatible', reasons: ['no_compatible_protocol'],
        }, confirmed: false });
        app.decorate('forwardRpcForUser', async (call: { method: string }) => !sourceAvailable
            ? { ok: false, error: 'source_unavailable' } : ({ ok: true, result:
            call.method.endsWith(':machines.provisioners.check')
                ? { available: true, nativeCredentialDelivery: { status: 'supported' } }
                : sourceCompatible ? f.sourceResponse : incompatibleResponse }));
        registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Issuance cannot dispatch an effect'); } });
        const token = await auth.createToken(f.creator.id, undefined, { kind: 'account', authority: 'present_user' });
        await app.ready();
        try {
            const childTarget = { kind: 'machine' as const, machineId: f.controller.id };
            const childEnvelope: ExternalActionRequestEnvelope = mode === 'plain'
                ? { v: 1, requestId, target: childTarget, input: request }
                : { v: 2, requestId, target: childTarget, managedAdmission,
                    payload: { t: 'encrypted', c: 'opaque-reviewed-native-install' } };
            const issue = (packet: unknown) => app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.credentials.install'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: f.controller.id,
                    envelope: childEnvelope, nativeCredentialSpawnChild: packet } });
            const packet = { externalActionExecution: execution, method, requestId, params, originalActionEnvelope: envelope };
            expect((await issue({ ...packet, externalActionExecution: { ...execution, machineSignature: 'A'.repeat(86) } })).statusCode).toBe(403);
            // Production birth is prepared, not pre-stamped. The existing
            // issuer must obtain the actual authenticated custodian response
            // before it can mint any controller effect authorization.
            await writeStored(unconfirmed);
            sourceAvailable = false;
            expect((await issue(packet)).statusCode).not.toBe(200);
            sourceAvailable = true;
            sourceCompatible = false;
            expect((await issue(packet)).statusCode).not.toBe(200);
            sourceCompatible = true;
            const issued = await issue(packet);
            expect(issued.statusCode, issued.body).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(issued.json()).binding).toMatchObject({
                actionId: 'machines.managed.credentials.install', machineId: f.controller.id,
                installationId: f.controller.installationId, managedAdmission,
                nativeCredentialSpawnChild: { requestId: authorization.binding.requestId,
                    requestEnvelopeDigest: authorization.binding.requestEnvelopeDigest },
            });
            expect(issued.body).not.toContain(Buffer.from(keys.secretKey).toString('base64'));
        } finally { await app.close(); }
        await db.machine.update({ where: { id: f.controller.id }, data: { installationId: crypto.randomUUID() } });
        expect(await verify()).toBeNull();
        await db.machine.update({ where: { id: f.controller.id }, data: { installationId: f.controller.installationId } });
        await db.machine.update({ where: { id: f.controller.id }, data: { revokedAt: new Date() } });
        expect(await verify()).toBeNull();
    });

    it('does not downgrade malformed installed effect proof to a prepared no-effect binding', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).toEqual({ ok: true });
        const read = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id }));
        if (!read.ok) throw new Error(read.code);
        await db.sessionTeamCredentialBinding.updateMany({ where: { sessionId: f.session.id },
            data: { nativeDeliveryJson: JSON.stringify({ ...read.stored, installation: 'confirmed' }) } });
        expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id })))
            .toEqual({ ok: false, code: 'resource_changed' });
    });
});
