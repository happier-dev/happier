import { expect, it } from 'vitest';
import nacl from 'tweetnacl';
import type { Server } from 'socket.io';
import { decodeBase64 } from 'privacy-kit';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodePlainMachineStoredContent, encodePlainMachineStoredContent,
    sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { openExternalActionRequestV2, prepareExternalActionResponseV2, sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { ExternalActionDaemonDispatchRequestSchema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1,
    createExternalActionDaemonDispatchResponseV1, prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { SessionTeamCredentialBindingIntentV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { verifyExternalActionMachineRpcExecution } from '@/app/auth/externalActionExecutionAuthorization';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { admitManagedAcquire } from '@/app/machines/managed/managedAcquire';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';
import { createNativeSessionTeamCredentialFixture, TEST_AUTHENTICATION } from '@/app/teams/credentials/sessionBinding.testkit';
import { stampSessionTeamCredentialNativeDeliveryInTx } from '@/app/teams/credentials/sessionBinding';
import { readSessionTeamCredentialNativeSelectionInTx } from '@/app/teams/credentials/nativeDeliveryRead';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { prepareLayout1SessionCreate } from '@/app/session/create/prepareLayout1SessionCreate';
import { createOrRejoinLayout1SessionByTagInTx } from '@/app/session/create/createOrRejoinLayout1SessionByTag';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createExternalActionMachineRpcExecution, createExternalActionSourceMachineRpcExecution,
    dispatchManagedMachineAgentIsolation, projectExternalActionRequesterHttpAuthorization } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { createMachineContentCodec } from '../../../../../../cli/src/api/machine/machineStoredContent';
import { createReviewedChildAuthorizationFixture } from './reviewedChildAuthorization.composed.testkit';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

/** Register under the caller's real disposable SQLite/Auth harness. */
export function registerManagedChildAuthorizationCharacterization(): void {
    it.each(['plain', 'e2ee'] as const)('admits the real Acquire isolation child and refuses a freshly signed different effect (%s)', async mode => {
        const f = await createReviewedChildAuthorizationFixture();
        const material = { type: 'dataKey' as const, machineKey: nacl.randomBytes(32) };
        const codec = createMachineContentCodec(mode === 'plain' ? { encryptionMode: 'plain' }
            : { encryptionKey: material.machineKey, encryptionVariant: 'dataKey' });
        const content = codec.mode === 'plain' ? { mode: 'plain' as const } : { mode: 'e2ee' as const,
            cipher: { encryptRaw: async (value: unknown) => codec.encodeRpc(value),
                decryptRaw: async (value: string) => codec.decodeRpc(value) } };
        const serverId = await getOrCreateServerIdentityId();
        const controller = { machineId: f.machine.id, installationId: f.machine.installationId! };
        const guestKeys = nacl.sign.keyPair();
        const guest = await db.machine.create({ data: { ...f.machine, id: crypto.randomUUID(),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(guestKeys.publicKey), active: true,
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        let admittedChildren = 0;
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io: {} as Server, forwardRpc: async request => {
            // Native guest delivery is the boundary. Home has already issued
            // the independent continuation; the CLI signs its actual RPC.
            const packet = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            const authorization = packet.executionAuthorization;
            if (!authorization) throw new Error('managed_child_authorization_required');
            expect(authorization.binding).toMatchObject({ actionId: 'machines.agentIsolation.preview', machineId: guest.id,
                managedContinuation: { controller, creationRequestId: authorization.binding.requestId } });
            const context = { externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target };
            const binding = authorization.binding;
            if (!('authentication' in binding)) throw new Error('managed_child_account_binding_required');
            const encryptionBinding = { serverIdentityId: binding.serverIdentityId, accountId: binding.accountId,
                actionId: binding.actionId, requestId: binding.requestId, target: binding.target,
                authentication: { kind: binding.authentication.kind, tokenEpoch: binding.authentication.tokenEpoch } };
            expect(packet.envelope.v).toBe(mode === 'plain' ? 1 : 2);
            const input = packet.envelope.v === 1 ? packet.envelope.input : openExternalActionRequestV2({
                projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                envelope: packet.envelope, binding: encryptionBinding, material })?.input;
            expect(input).toMatchObject({ serverId, machineId: guest.id, enabled: true });
            const method = `${guest.id}:machines.agentIsolation.preview`;
            const requestId = crypto.randomUUID();
            const callId = crypto.randomUUID().replaceAll('-', '');
            const params = await socketRpcCodec.encodeParams(content, input, { method, callId });
            if (mode === 'e2ee') expect(typeof params).toBe('string');
            expect(await socketRpcCodec.decodeRequestParams(content, params, method)).toMatchObject({ params: input });
            const execution = createExternalActionMachineRpcExecution({ context, effectActionId: 'machines.agentIsolation.preview',
                installationId: guest.installationId!, method, requestId, params,
                privateKey: guestKeys.secretKey });
            if (!execution) throw new Error('managed_child_rpc_required');
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params }))
                .toMatchObject({ effectActionId: 'machines.agentIsolation.preview' });
            const otherMethod = `${guest.id}:machines.command.run`;
            const unauthorizedParams = await socketRpcCodec.encodeParams(content, input, { method: otherMethod, callId });
            const unauthorized = createExternalActionMachineRpcExecution({ context, effectActionId: 'machines.command.run',
                installationId: guest.installationId!, method: otherMethod, requestId, params: unauthorizedParams, privateKey: guestKeys.secretKey });
            if (!unauthorized) throw new Error('managed_child_refusal_packet_required');
            expect(await verifyExternalActionMachineRpcExecution(unauthorized, { method: otherMethod, requestId, params: unauthorizedParams })).toBeNull();
            admittedChildren++;
            if (packet.envelope.v === 2) return { ok: true, result: createExternalActionDaemonDispatchResponseV1(
                prepareExternalActionResponseV2({ request: packet.envelope, binding: encryptionBinding, material,
                    executedMachineId: guest.id, randomBytes: nacl.randomBytes, execution: { ok: true, result: null } })) };
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({ v: 1,
                actionId: packet.actionId, requestId: packet.envelope.requestId, execution: { ok: true, result: null } })) };
        } }) });
        registerManagedMachineRoutes(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            const provisioner = await createNativeSessionTeamCredentialFixture();
            const declaration = await db.accountPluginIntent.findFirstOrThrow({ where: { accountId: provisioner.custodian.id,
                pluginId: provisioner.launch.provider.pluginId } });
            const materialization = await db.pluginMachineMaterialization.findFirstOrThrow({ where: { machineId: provisioner.controller.id } });
            await db.accountPluginIntent.create({ data: { accountId: f.account.id, pluginId: declaration.pluginId,
                enabled: true, writableCollections: [], releaseLessDeclaration: declaration.releaseLessDeclaration! } });
            await db.pluginMachineMaterialization.create({ data: { ...materialization, id: crypto.randomUUID(), accountId: f.account.id,
                serverIdentityId: serverId, machineId: controller.machineId, materializationId: controller.installationId } });
            await db.machine.update({ where: { id: f.machine.id }, data: { pluginMaterializationRevision: 1n } });
            const input = ManagedAcquireInputV1Schema.parse({
                enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' },
                selection: { kind: 'one-off', homeId: serverId, controller, launch: provisioner.launch,
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
            let root = await f.root('machines.managed.acquire', input);
            if (mode === 'e2ee') {
                const contentKeys = nacl.box.keyPair();
                await db.account.update({ where: { id: f.account.id }, data: {
                    encryptionMode: 'e2ee', ...createSignedAccountContentBinding(contentKeys.publicKey) } });
                await db.machine.updateMany({ where: { id: { in: [f.machine.id, guest.id] } }, data: {
                    metadata: codec.encodeStored(decodePlainMachineStoredContent(f.machine.metadata)),
                    dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: material.machineKey,
                        recipientPublicKey: contentKeys.publicKey, randomBytes: nacl.randomBytes }) } });
                const binding = root.binding;
                if (!('authentication' in binding)) throw new Error('managed_acquire_account_binding_required');
                const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                    binding: { serverIdentityId: binding.serverIdentityId, accountId: binding.accountId,
                        actionId: binding.actionId, requestId: crypto.randomUUID(), target: binding.target,
                        authentication: { kind: binding.authentication.kind, tokenEpoch: binding.authentication.tokenEpoch } },
                    input, material, randomBytes: nacl.randomBytes });
                const issued = await f.app.inject({ method: 'POST',
                    url: bindExternalActionExecutionAuthorizationHttpPathV1(binding.actionId),
                    headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: { v: 1, machineId: f.machine.id, envelope } });
                expect(issued.statusCode, issued.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
                const projected = await projectExternalActionRequesterHttpAuthorization({ authorization,
                    serverId, serverIdentityId: serverId, serverHttpBaseUrl: f.origin, target: authorization.binding.target,
                    installationId: controller.installationId, privateKey: f.keyPair.secretKey });
                if (!projected) throw new Error('encrypted_acquire_http_projection_required');
                root = projected;
            }
            const admitted = await admitManagedAcquire({ custodianAccountId: f.account.id, requesterAccountId: f.account.id,
                requestEnvelopeDigest: root.binding.requestEnvelopeDigest,
                input: { input, requestId: root.binding.requestId, continuationPresent: false } });
            // Allocation/enrollment stand for the real native provider boundary.
            await db.managedMachine.update({ where: { id: admitted.machine.id }, data: { allocation: 'bound', enrolledMachineId: guest.id,
                resource: { contributionRef: input.selection.kind === 'one-off' ? input.selection.launch.provider : {},
                    schemaVersion: 1, value: { id: 'native-guest' } } } });
            const childInput = { serverId, machineId: guest.id, enabled: true };
            const homeTarget = resolveHomeTargetFromDescriptor({ authority: 'current_connection', descriptor: { v: 1,
                homeServerIdentityId: serverId, canonicalServerUrl: origin, revision: 1, endpoints: [{ kind: 'https', url: origin }] } });
            const result = await f.child(root, { actionId: 'machines.managed.acquire', input },
                { action: 'machines.agentIsolation.preview', role: 'machines.agentIsolation.preview', input: childInput }, async context =>
                    dispatchManagedMachineAgentIsolation({ context, actionId: 'machines.agentIsolation.preview', input: childInput,
                        serverId, authorization: root, installationId: controller.installationId, privateKey: f.keyPair.secretKey,
                        ...(mode === 'e2ee' ? { material } : {}),
                        serverHttpBaseUrl: origin, homeTarget,
                        continuation: { managedId: admitted.machine.id, creationRequestId: root.binding.requestId, expectedIntentRevision: 0 } }));
            expect(result).toMatchObject({ ok: true });
            expect(admittedChildren).toBe(1);
        } finally { await app.close(); await f.app.close(); }
    });

    it('issues the real Spawn native-credential child and refuses a freshly signed different binding', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        const native = await createNativeSessionTeamCredentialFixture();
        const homeId = await getOrCreateServerIdentityId();
        const controllerKeys = nacl.sign.keyPair();
        if (native.intent.resourceId === null) throw new Error('native_provider_selection_required');
        const intent = SessionTeamCredentialBindingIntentV1Schema.parse({ ...native.intent,
            providerModelSelection: { ...native.intent.providerModelSelection, executionMachineId: f.machine.id } });
        await db.teamMembership.update({ where: { id: native.membership.id }, data: { accountId: f.account.id } });
        await db.managedMachine.update({ where: { id: native.row.id }, data: { homeId, enrolledMachineId: f.machine.id,
            admittedInput: { enrollmentAccountId: f.account.id } } });
        await db.pluginMachineMaterialization.updateMany({ where: { machineId: native.controller.id }, data: { serverIdentityId: homeId } });
        await db.machine.update({ where: { id: native.controller.id }, data: { installationPublicKey: new Uint8Array(controllerKeys.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'native-controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        // Authenticated native provider RPC is the external system boundary.
        app.decorate('forwardRpcForUser', async (call: { method: string }) => ({ ok: true, result:
            call.method.endsWith(':machines.provisioners.check') ? { available: true, nativeCredentialDelivery: { status: 'supported' } }
                : native.sourceResponse }));
        registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Issuance cannot dispatch native effects'); } });
        await app.ready();
        try {
            const input = { executionTarget: { serverId: homeId, machineId: f.machine.id }, teamCredentialBindings: [intent],
                directory: { kind: 'path', path: '/workspace' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
            const root = await f.root('session.spawn_new', input);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: root.binding.requestId,
                target: root.binding.target, input });
            const prepared = prepareLayout1SessionCreate({ accountId: f.account.id, tag: crypto.randomUUID(),
                metadata: JSON.stringify({ v: 1 }), ownerMetadata: { t: 'plain', v: { v: 1 } }, agentState: null, dataEncryptionKey: null,
                requestedEncryptionMode: undefined, requestedStorageState: undefined, organizationPlacement: undefined,
                teamCredentialBindings: [intent], accountEncryptionMode: 'plain', storagePolicy: 'optional', defaultAccountMode: 'e2ee' });
            if (!prepared.ok) throw new Error(prepared.rejection.reason);
            const birth = await inTx(tx => createOrRejoinLayout1SessionByTagInTx(tx, prepared.prepared, TEST_AUTHENTICATION, root.binding));
            if (birth.kind !== 'created') throw new Error('native_child_session_birth_required');
            await db.session.update({ where: { id: birth.session.id }, data: { active: true } });
            expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: f.account.id,
                machineId: f.machine.id, sessionId: birth.session.id, data: 'native-child-session-access' }))).toMatchObject({ ok: true });
            expect(await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: birth.session.id,
                accountId: f.account.id, response: native.sourceResponse, authentication: TEST_AUTHENTICATION }))).toMatchObject({ ok: true });
            const selected = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: birth.session.id }));
            if (!selected.ok) throw new Error(selected.code);
            const request = { homeId, managedId: native.row.id, sessionId: birth.session.id,
                bindingKey: selected.binding.safeFacet.bindingKey, expectedResourceRevision: selected.binding.resourceRevision,
                expectedSourceRevision: selected.binding.safeFacet.sourceRevision, expectedProviderTicket: selected.binding.safeFacet.providerTicket };
            const method = `${native.controller.id}:machines.managed.credentials.install`;
            const issue = async (params: typeof request) => {
                const requestId = crypto.randomUUID();
                const managedAdmission = { actionId: 'machines.managed.credentials.install' as const, input: params };
                const execution = createExternalActionSourceMachineRpcExecution({ authorization: root, target: root.binding.target,
                    sourceMachineId: f.machine.id, sourceInstallationId: f.machine.installationId!, effectActionId: managedAdmission.actionId,
                    method, requestId, params, managedAdmission, privateKey: f.keyPair.secretKey });
                if (!execution) throw new Error('native_child_cli_packet_required');
                const packet = { externalActionExecution: execution, method, requestId, params, originalActionEnvelope: envelope };
                return app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(managedAdmission.actionId),
                    headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: { v: 1, machineId: native.controller.id,
                        envelope: { v: 1, requestId, target: { kind: 'machine', machineId: native.controller.id }, input: params },
                        nativeCredentialSpawnChild: packet } });
            };
            const issued = await issue(request);
            expect(issued.statusCode, issued.body).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(issued.json()).binding).toMatchObject({
                actionId: 'machines.managed.credentials.install', machineId: native.controller.id,
                nativeCredentialSpawnChild: { requestId: root.binding.requestId, requestEnvelopeDigest: root.binding.requestEnvelopeDigest } });
            const refused = await issue({ ...request, bindingKey: crypto.randomUUID() });
            expect(refused.statusCode, refused.body).toBe(403);
        } finally { await app.close(); await f.app.close(); }
    });
}
