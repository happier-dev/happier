import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER, computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import * as access from './machineAccess';
import { applyMachineReplacement } from './applyMachineReplacement';
import { validateMachineReplacement } from './validateMachineReplacement';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { SOCKET_RPC_EVENTS, SessionActionRpcOriginV1Schema, SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { rpcHandler } from '@/app/api/socket/rpcHandler';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { evaluateAccountStoredContentCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { registerPeerMediationGrantRoutes } from '@/app/api/routes/machines/peer/mediation/registerPeerMediationGrantRoutes';
import { registerMachineAdmissionRoutes } from '@/app/api/routes/machines/registerMachineAdmissionRoutes';
import { createRouteTestBuilder } from '@/app/api/testkit/routeTestBuilder';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { FEATURE_ENV_KEYS } from '@/app/features/catalog/featureEnvSchema';
import { NpmRegistryProfileActionOutputSchemasV1 } from '@happier-dev/protocol/actions/npmRegistryProfileActionFamily';
import { resolveExternalActionExecutionMachineAdmissionInTx } from '@/app/auth/externalActionExecutionAuthorization';

describe('Machine current access (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-machine-access-', initAuth: false }); }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });
    async function account(mode: 'plain' | 'e2ee' = 'plain') {
        const keys = tweetnacl.box.keyPair();
        const row = await db.account.create({ data: { encryptionMode: mode, ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        return { ...row, keys };
    }
    async function fixture(mode: 'plain' | 'e2ee' = 'plain') {
        const owner = await account(mode);
        const key = tweetnacl.randomBytes(32);
        const envelope = mode === 'plain' ? null : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: owner.keys.publicKey, randomBytes: tweetnacl.randomBytes }));
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: mode === 'plain' ? encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }) : 'metadata',
            daemonState: mode === 'plain' ? encodePlainMachineStoredContent({ status: 'running' }) : 'state', installationId: 'install', active: false,
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
            dataEncryptionKey: mode === 'plain' ? new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) : envelope } });
        return { owner, machine, key };
    }
    const grant = async (actorAccountId: string, machineId: string, accountId: string, level: 'view' | 'admin' = 'view') => {
        await makeShareEligibleForTest(actorAccountId, accountId);
        return inTx(tx => access.setMachineAccessGrantInTx(tx, { actorAccountId, machineId, principal: { kind: 'account', accountId }, level }));
    };

    it('admits Machine storage administration and skill installation for Manage, refusing Use and foreign Accounts', async () => {
        const f = await fixture();
        const viewer = await account();
        const manager = await account();
        const foreign = await account();
        await grant(f.owner.id, f.machine.id, viewer.id, 'view');
        await grant(f.owner.id, f.machine.id, manager.id, 'admin');
        // Both the public Action and raw RPC reach the same current grant owner.
        for (const rpcMethod of [RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_LIST, RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE,
            RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH, RPC_METHODS.DAEMON_STORAGE_WORKTREES_LIST,
            RPC_METHODS.DAEMON_STORAGE_SCAN_START, RPC_METHODS.DAEMON_STORAGE_SCAN_GET,
            RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, RPC_METHODS.DAEMON_STORAGE_SCAN_SKIP,
            RPC_METHODS.DAEMON_STORAGE_PROTECTED_ADD, RPC_METHODS.DAEMON_STORAGE_PROTECTED_REMOVE,
            RPC_METHODS.DAEMON_STORAGE_DOCKER_PRUNE, RPC_METHODS.SKILLS_MACHINE_INSTALL, RPC_METHODS.SKILLS_MACHINE_UNINSTALL]) {
            for (const actorAccountId of [f.owner.id, manager.id]) {
                expect(await access.resolveMachineAdmission({ actorAccountId, machineId: f.machine.id, rpcMethod }), rpcMethod)
                    .toMatchObject({ kind: 'admitted', role: 'manage', actorAccountId, custodianAccountId: f.owner.id });
            }
            for (const actorAccountId of [viewer.id, foreign.id]) {
                expect(await access.resolveMachineAdmission({ actorAccountId, machineId: f.machine.id, rpcMethod }), rpcMethod)
                    .toEqual({ kind: 'denied', code: 'access_denied' });
            }
        }
        for (const actionId of ['machines.storage.scan.start', 'machines.storage.protected.add', 'machines.storage.docker.prune',
            'skills.machine.install', 'skills.machine.uninstall']) {
            expect(await access.resolveMachineAdmission({ actorAccountId: manager.id, machineId: f.machine.id, actionId }), actionId)
                .toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: f.owner.id });
            expect(await access.resolveMachineAdmission({ actorAccountId: viewer.id, machineId: f.machine.id, actionId }), actionId)
                .toEqual({ kind: 'denied', code: 'access_denied' });
        }
    });

    it('does not carry a Manage grant on one Machine to another Machine', async () => {
        const granted = await fixture();
        const other = await fixture();
        const manager = await account();
        await grant(granted.owner.id, granted.machine.id, manager.id, 'admin');
        for (const operation of [{ rpcMethod: RPC_METHODS.SKILLS_MACHINE_INSTALL }, { actionId: 'machines.storage.docker.prune' }]) {
            expect(await access.resolveMachineAdmission({ actorAccountId: manager.id, machineId: granted.machine.id, ...operation }))
                .toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: granted.owner.id });
            expect(await access.resolveMachineAdmission({ actorAccountId: manager.id, machineId: other.machine.id, ...operation }))
                .toEqual({ kind: 'denied', code: 'access_denied' });
        }
    });

    it('admits machine-scoped plugin daemon Actions for Manage through authenticated ingress, refusing Can use', async () => {
        const f = await fixture();
        const requester = await account();
        await grant(f.owner.id, f.machine.id, requester.id, 'admin');
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true } });
        const accountStoredContentCompatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
            declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
        // Only the daemon network boundary is replaced; Home routing, current
        // grants and the public Action admission owner remain real.
        const emitWithAck = vi.fn(async (_event: string, _payload: unknown) => ({ installed: true }));
        const target = { id: 'plugin-install-daemon',
            data: { clientType: 'machine-scoped', machineId: f.machine.id, verifiedMachineInstallationId: 'install', accountStoredContentCompatibility },
            timeout: () => ({ emitWithAck }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === target.id
            || room === `rpc:${f.owner.id}:${f.machine.id}:action.invoke` ? [target] : []);
        const call = async (actorAccountId: string) => {
            const socket = createAuthenticatedFakeSocket({ data: { accountStoredContentCompatibility, authAuthority: 'present_user' } });
            rpcHandler(actorAccountId, socket as unknown as Socket, { io });
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method: `${f.machine.id}:action.invoke`,
                params: { action: { pluginId: 'happier.machine.crabbox', localId: 'install' }, input: {} } }, reply);
            return reply;
        };
        expect(await call(f.owner.id)).toHaveBeenCalledWith({ ok: true, result: { installed: true } });
        expect(await call(requester.id)).toHaveBeenCalledWith({ ok: true, result: { installed: true } });
        expect(emitWithAck.mock.calls.at(-1)?.[1]).toMatchObject({ machineAdmission: {
            actorAccountId: requester.id, custodianAccountId: f.owner.id, machineId: f.machine.id, role: 'manage',
        } });
        expect(await inTx(tx => resolveExternalActionExecutionMachineAdmissionInTx(tx, {
            actorAccountId: requester.id, machineId: f.machine.id, actionId: 'action.invoke',
            authentication: { authenticationAuthority: 'present_user' },
        }))).toMatchObject({ kind: 'admitted', role: 'manage', actorAccountId: requester.id, custodianAccountId: f.owner.id });
        await grant(f.owner.id, f.machine.id, requester.id, 'view');
        emitWithAck.mockClear();
        expect(await call(requester.id)).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(emitWithAck).not.toHaveBeenCalled();
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'account', accountId: requester.id } }));
        expect(await call(requester.id)).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(emitWithAck).not.toHaveBeenCalled();
    });

    it.each(['plain', 'e2ee'] as const)('refuses raw structured plugin Actions before daemon delivery while preserving Session composer Use and raw Manage (%s)', async mode => {
        const f = await fixture(mode);
        const requester = await account(mode);
        await grant(f.owner.id, f.machine.id, requester.id, 'view');
        if (mode === 'e2ee') {
            const census = await inTx(tx => access.readMachineRecipientCensusInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id }));
            if ('kind' in census) throw new Error(census.code);
            expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, {
                actorAccountId: f.owner.id, machineId: f.machine.id,
                expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
                expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!,
                expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
                recipientKeyEnvelopes: [{ recipientAccountId: requester.id,
                    encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: f.key,
                        recipientPublicKey: requester.keys.publicKey, randomBytes: tweetnacl.randomBytes })),
                    recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(requester.keys.publicKey) }],
            }))).toMatchObject({ appliedRecipientAccountIds: [requester.id] });
        }
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true } });
        const installation = tweetnacl.sign.keyPair();
        await db.machine.update({ where: { id: f.machine.id }, data: { installationPublicKey: new Uint8Array(installation.publicKey) } });
        const session = await db.session.create({ data: { accountId: requester.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain', active: true } });
        const accountStoredContentCompatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
            declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
        // The real Home admission and current grants run; only daemon IO is replaced.
        const emitWithAck = vi.fn(async (_event: string, _payload: unknown) => ({ ok: true, result: { executed: true } }));
        const target = { id: 'plugin-daemon', data: { clientType: 'machine-scoped', machineId: f.machine.id,
            verifiedMachineInstallationId: 'install', accountStoredContentCompatibility }, timeout: () => ({ emitWithAck }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === target.id
            || room.startsWith(`rpc:${f.owner.id}:${f.machine.id}:`) ? [target] : []);
        const call = async (method: string, params: unknown, routing?: unknown) => {
            const socket = createAuthenticatedFakeSocket({ data: { accountStoredContentCompatibility, authAuthority: 'present_user' } });
            rpcHandler(requester.id, socket as unknown as Socket, { io });
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method: `${f.machine.id}:${method}`, params, ...(routing === undefined ? {} : { structuredMessageRouting: routing }) }, reply);
            return reply;
        };
        const raw = { machineId: f.machine.id, qualifiedActionId: 'happier.machine.crabbox/install',
            expectedContributorOccurrenceId: 'crabbox-current', executionSurface: 'ui', input: {}, presentUserIntent: 'confirmed' };
        expect(await call(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, raw))
            .toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(emitWithAck).not.toHaveBeenCalled();
        const ownersSession = await db.session.create({ data: { accountId: f.owner.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true } });
        expect(await call(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, { ...raw,
            qualifiedActionId: 'acme.composer/submit', invocation: { kind: 'hostPresentedComposer',
                currentComposerIntent: { composer: { kind: 'session', sessionId: ownersSession.id }, revision: 1 } } }))
            .toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(emitWithAck).not.toHaveBeenCalled();
        const privateMessageRequest = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({ ...raw,
            executionSurface: 'cli', resolveClientMessageContext: true,
            messageActionReference: { v: 1, sessionId: ownersSession.id, messageId: 'private-message', observedRevision: '1' },
            invocation: { kind: 'clientPluginAction', clientActionBinding: {
                pluginId: 'acme.composer', contributionLocalId: 'submit', occurrenceId: 'composer-current',
            } } });
        expect(await call(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, privateMessageRequest))
            .toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(emitWithAck).not.toHaveBeenCalled();
        const watch = { machineId: f.machine.id, callerPluginId: 'acme.composer', expectedCallerOccurrenceId: 'composer-current',
            subscriptionId: 'action-read', resource: { actionRead: { ...privateMessageRequest,
                qualifiedActionId: 'acme.composer/submit', expectedContributorOccurrenceId: 'composer-current', requiredReadOnly: true } } };
        expect(await call(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, watch))
            .toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(await call(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
            { ...watch, resource: { pluginId: 'acme.composer', localId: 'ordinary-resource' } }))
            .toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
        expect(emitWithAck.mock.calls.at(-1)?.[1]).not.toHaveProperty('machineAdmission.structuredMessageRouting');
        emitWithAck.mockClear();
        expect(await call(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, { ...raw,
            qualifiedActionId: 'acme.composer/submit', sessionId: session.id, invocation: { kind: 'hostPresentedComposer',
                currentComposerIntent: { composer: { kind: 'session', sessionId: session.id }, revision: 1 } } }))
            .toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
        expect(emitWithAck.mock.calls.at(-1)?.[1]).toMatchObject({ machineAdmission: {
            actorAccountId: requester.id, custodianAccountId: f.owner.id, role: 'use',
        } });
        emitWithAck.mockClear();
        // Home sees only the routing projection; the complete Action stays ciphertext.
        const composerRequest = { ...raw, qualifiedActionId: 'acme.composer/submit', sessionId: session.id,
            invocation: { kind: 'hostPresentedComposer', currentComposerIntent: {
                composer: { kind: 'session', sessionId: session.id }, revision: 1 } } };
        const nonce = tweetnacl.randomBytes(tweetnacl.secretbox.nonceLength);
        const ciphertext = encodeBase64(tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(composerRequest)), nonce, f.key));
        expect(await call(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, ciphertext))
            .toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(await call(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, ciphertext,
            { v: 1, machineId: f.machine.id, sessionIds: [ownersSession.id] }))
            .toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(await call(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, composerRequest,
            { v: 1, machineId: f.machine.id, sessionIds: [] }))
            .toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(await call(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, ciphertext,
            { v: 1, machineId: f.machine.id, sessionIds: [session.id] }))
            .toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
        expect(emitWithAck.mock.calls.at(-1)?.[1]).toMatchObject({ params: ciphertext, machineAdmission: {
            actorAccountId: requester.id, role: 'use', structuredMessageRouting: { v: 1, machineId: f.machine.id, sessionIds: [session.id] },
        } });
        const forwarded = emitWithAck.mock.calls.at(-1)?.[1];
        const context = SocketRpcMachineAdmissionContextV1Schema.parse(
            forwarded && typeof forwarded === 'object' && 'machineAdmission' in forwarded ? forwarded.machineAdmission : undefined);
        const method = `${f.machine.id}:${RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE}`;
        const proofPayload = { version: 1 as const, machineId: f.machine.id, installationId: 'install', accountId: f.owner.id,
            rpcAdmission: { context, method } };
        const verifier = createRouteTestBuilder({ method: 'POST', path: '/v1/machines/:id/admission/verify',
            registerRoutes: registerMachineAdmissionRoutes });
        const verified = await verifier.invoke({ userId: f.owner.id, params: { id: f.machine.id },
            body: { v: 1, context, method, proof: signMachineInstallationProof({ payload: proofPayload, privateKey: installation.secretKey }) } });
        expect(verified.reply.statusCode).toBe(200);
        expect(verified.reply.send).toHaveBeenCalledWith({ v: 1, ok: true });
        emitWithAck.mockClear();
        await grant(f.owner.id, f.machine.id, requester.id, 'admin');
        expect(await call('action.invoke', { action: { pluginId: 'happier.machine.crabbox', localId: 'install' }, input: {} }))
            .toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
        expect(emitWithAck.mock.calls.at(-1)?.[1]).toMatchObject({ machineAdmission: {
            actorAccountId: requester.id, custodianAccountId: f.owner.id, role: 'manage',
        } });
        expect(await access.resolveMachineAdmission({ actorAccountId: requester.id, machineId: f.machine.id,
            actionId: 'localServices.actions.copyUrl' })).toMatchObject({ kind: 'admitted', role: 'manage' });
        await grant(f.owner.id, f.machine.id, requester.id, 'view');
        expect(await access.resolveMachineAdmission({ actorAccountId: requester.id, machineId: f.machine.id,
            actionId: 'localServices.actions.copyUrl' })).toMatchObject({ kind: 'admitted', role: 'use' });
    });

    it('distinguishes custodian-only policy from a daemon upgrade requirement', async () => {
        const f = await fixture();
        const requester = await account();
        await grant(f.owner.id, f.machine.id, requester.id);
        expect(await access.resolveMachineAdmission({ actorAccountId: requester.id, machineId: f.machine.id,
            rpcMethod: RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST })).toEqual({ kind: 'denied', code: 'custodian_only' });
        await db.machine.update({ where: { id: f.machine.id }, data: { operationProtocolCapabilities: {} } });
        expect(await access.resolveMachineAdmission({ actorAccountId: requester.id, machineId: f.machine.id,
            actionId: 'session.spawn_new' })).toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
        expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id,
            rpcMethod: RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST })).toMatchObject({ kind: 'admitted', actorAccountId: f.owner.id });
    });

    it('admits an installed plugin read, watch and finite Action through Use without granting plugin installation', async () => {
        const f = await fixture();
        const requester = await account();
        const actor = { actorAccountId: requester.id, machineId: f.machine.id };
        await grant(f.owner.id, f.machine.id, requester.id);
        const methods = [
            RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
            RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
            RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT,
            RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE,
            RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
        ];
        for (const rpcMethod of methods) {
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }), rpcMethod)
                .toMatchObject({ kind: 'admitted', role: 'use', actorAccountId: requester.id,
                    custodianAccountId: f.owner.id, machineId: f.machine.id });
        }
        expect(await access.resolveMachineAdmission({ ...actor, actionId: 'plugins.install' }))
            .toEqual({ kind: 'denied', code: 'unsupported_operation' });
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'account', accountId: requester.id } }));
        for (const rpcMethod of methods) {
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }), rpcMethod)
                .toEqual({ kind: 'denied', code: 'access_denied' });
        }
    });

    it('admits host Computer controls and raw relay Start only for the custodian and Manage grantees', async () => {
        const f = await fixture();
        const viewer = await account();
        const manager = await account();
        await grant(f.owner.id, f.machine.id, viewer.id, 'view');
        await grant(f.owner.id, f.machine.id, manager.id, 'admin');
        for (const rpcMethod of [RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE, RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START]) {
            expect(await access.resolveMachineAdmission({ actorAccountId: viewer.id, machineId: f.machine.id, rpcMethod }))
                .toEqual({ kind: 'denied', code: 'access_denied' });
            expect(await access.resolveMachineAdmission({ actorAccountId: manager.id, machineId: f.machine.id, rpcMethod }))
                .toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: f.owner.id });
            expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id, rpcMethod }))
                .toMatchObject({ kind: 'admitted', role: 'manage' });
        }
    });

    it('admits extension discovery with Use and profile mutations only with Manage', async () => {
        const f = await fixture();
        const viewer = await account();
        const manager = await account();
        await grant(f.owner.id, f.machine.id, viewer.id, 'view');
        await grant(f.owner.id, f.machine.id, manager.id, 'admin');
        for (const operation of ['install', 'update', 'enable', 'disable', 'remove']) {
            const actionId = `browser.extensions.${operation}`;
            expect(await access.resolveMachineAdmission({ actorAccountId: viewer.id, machineId: f.machine.id, actionId }))
                .toEqual({ kind: 'denied', code: 'access_denied' });
            for (const actorAccountId of [f.owner.id, manager.id]) {
                expect(await access.resolveMachineAdmission({ actorAccountId, machineId: f.machine.id, actionId }))
                    .toMatchObject({ kind: 'admitted', role: 'manage' });
            }
        }
        for (const operation of ['list', 'openActionPopup', 'openOptions']) {
            expect(await access.resolveMachineAdmission({ actorAccountId: viewer.id, machineId: f.machine.id,
                actionId: `browser.extensions.${operation}` })).toMatchObject({ kind: 'admitted', role: 'use' });
        }
    });

    it('uses npm profile Manage admission once for public plugin publication', async () => {
        const f = await fixture();
        const viewer = await account();
        const manager = await account();
        await grant(f.owner.id, f.machine.id, viewer.id, 'view');
        await grant(f.owner.id, f.machine.id, manager.id, 'admin');
        const profileMutations = Object.keys(NpmRegistryProfileActionOutputSchemasV1)
            .filter(actionId => actionId !== 'plugins.npm_registry_profiles.list');
        for (const actionId of [...profileMutations, 'plugins.dev.publication.inspect', 'plugins.dev.publication.prepare', 'plugins.dev.publish', 'plugins.dev.publication.status']) {
            expect(await access.resolveMachineAdmission({ actorAccountId: viewer.id, machineId: f.machine.id,
                actionId })).toEqual({ kind: 'denied', code: 'access_denied' });
            for (const actorAccountId of [f.owner.id, manager.id]) {
                expect(await access.resolveMachineAdmission({ actorAccountId, machineId: f.machine.id,
                    actionId })).toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: f.owner.id });
            }
        }
        for (const actorAccountId of [viewer.id, manager.id]) {
            expect(await access.resolveMachineAdmission({ actorAccountId, machineId: f.machine.id,
                actionId: 'plugins.npm_registry_profiles.list' })).toEqual({ kind: 'denied', code: 'custodian_only' });
        }
        expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id,
            actionId: 'plugins.npm_registry_profiles.list' })).toMatchObject({ kind: 'admitted', role: 'manage' });
    });

    it('admits Use guests to their personal desktop only on requester-isolated daemons', async () => {
        const f = await fixture();
        const guest = await account();
        const outsider = await account();
        await grant(f.owner.id, f.machine.id, guest.id, 'view');
        const rpcMethod = 'daemon.computer.personal.actions.execute';
        expect(await access.resolveMachineAdmission({ actorAccountId: guest.id, machineId: f.machine.id, rpcMethod }))
            .toMatchObject({ kind: 'admitted', actorAccountId: guest.id, custodianAccountId: f.owner.id, role: 'use' });
        expect(await access.resolveMachineAdmission({ actorAccountId: outsider.id, machineId: f.machine.id, rpcMethod }))
            .toMatchObject({ kind: 'denied' });
        expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id, rpcMethod }))
            .toMatchObject({ kind: 'admitted', actorAccountId: f.owner.id, role: 'manage' });
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true } });
        const accountStoredContentCompatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
            declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
        const emitWithAck = vi.fn(async (_event: string, _payload: unknown) => ({ protocolVersion: 1, result: { status: 'personal-desktop' } }));
        const target = { id: 'personal-computer-daemon', data: { clientType: 'machine-scoped', machineId: f.machine.id,
            verifiedMachineInstallationId: 'install', accountStoredContentCompatibility }, timeout: () => ({ emitWithAck }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === target.id
            || room === `rpc:${f.owner.id}:${f.machine.id}:${rpcMethod}` ? [target] : []);
        const caller = createAuthenticatedFakeSocket({ data: { accountStoredContentCompatibility, authAuthority: 'present_user' } });
        rpcHandler(guest.id, caller as unknown as Socket, { io });
        const reply = vi.fn();
        await getSocketHandler(caller, SOCKET_RPC_EVENTS.CALL)({ method: `${f.machine.id}:${rpcMethod}`,
            params: { sessionId: 'guest-session', actionId: 'computer.targets.list', input: { machineId: f.machine.id } } }, reply);
        expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
        expect(emitWithAck.mock.calls[0]?.[1]).toMatchObject({
            callerAuthority: 'present_user', machineAdmission: { actorAccountId: guest.id, custodianAccountId: f.owner.id, role: 'use' },
        });
        await db.machine.update({ where: { id: f.machine.id }, data: { operationProtocolCapabilities: {} } });
        expect(await access.resolveMachineAdmission({ actorAccountId: guest.id, machineId: f.machine.id, rpcMethod }))
            .toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
    });

    it('mints personal viewer grants only from the installed own-source admission for that guest and Home', async () => {
        const f = await fixture();
        const guest = await account();
        const other = await account();
        await grant(f.owner.id, f.machine.id, guest.id, 'view');
        const installation = tweetnacl.sign.keyPair();
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true, installationPublicKey: new Uint8Array(installation.publicKey) } });
        const homeServerIdentityId = await getOrCreateServerIdentityId();
        if (!homeServerIdentityId) throw new Error('Home identity unavailable');
        const payload = { version: 1 as const, machineId: f.machine.id, installationId: 'install', accountId: f.owner.id,
            liveStreamSourceAdmission: { homeServerIdentityId, actorAccountId: guest.id,
                streamFamily: 'screen', sourceId: 'guest-source', sourceOccurrenceId: 'guest-occurrence' } };
        const sourceAdmission = { payload, proof: signMachineInstallationProof({ payload, privateKey: installation.secretKey }) };
        const signing = tweetnacl.sign.keyPair();
        const body = { machineId: f.machine.id, targetMachineId: f.machine.id, flowKind: 'live_stream', routeKind: 'server_relay',
            ttlMs: 60_000, viewerSocketId: 'guest-tab', sourceAdmission,
            scope: { kind: 'live_stream', streamId: 'personal-stream', streamFamily: 'screen', sourceId: 'guest-source' } };
        const route = createRouteTestBuilder({ method: 'POST', path: '/v1/machines/peer/mediation/route-grants',
            defaultRequest: { body }, registerRoutes: app => registerPeerMediationGrantRoutes(app, { env: {
                [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedEnabled]: 'true',
                [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxBitrateBps]: '64000',
                [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFramesPerSecond]: '12',
                [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFrameBytes]: '32000',
                [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxDurationMs]: '60000',
                [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxTotalBytes]: '128000',
                [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerAccount]: '2',
                [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerSocket]: '1',
                [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerMachine]: '1',
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: 'personal-stream-key',
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: Buffer.from(signing.secretKey).toString('base64url'),
            }, verifyViewerSocketOwnership: async ({ accountId, socketId }) => accountId === guest.id && socketId === 'guest-tab' }) });
        const invoke = async (changed: Partial<typeof body> = {}, userId = guest.id) =>
            (await route.invoke({ userId, authAuthority: 'present_user', body: { ...body, ...changed } })).response;
        expect(await invoke()).toMatchObject({ ok: true, relayAuthorization: { payload: { v: 2, accountId: f.owner.id,
            viewerAccountId: guest.id, sourceMachineInstallationId: 'install', personalSourceAdmission: payload.liveStreamSourceAdmission } } });
        for (const sourceId of ['owner-source', 'other-person-source']) {
            expect(await invoke({ scope: { ...body.scope, sourceId } })).toMatchObject({ ok: false, reasonCode: 'capture_source_denied' });
        }
        expect(await invoke({}, other.id)).toMatchObject({ ok: false });
        const changedPayload = { ...payload, liveStreamSourceAdmission: { ...payload.liveStreamSourceAdmission, actorAccountId: other.id } };
        expect(await invoke({ sourceAdmission: { payload: changedPayload, proof: sourceAdmission.proof } }))
            .toMatchObject({ ok: false, reasonCode: 'capture_source_denied' });
        const wrongHome = { ...payload, liveStreamSourceAdmission: { ...payload.liveStreamSourceAdmission, homeServerIdentityId: 'another-home' } };
        expect(await invoke({ sourceAdmission: { payload: wrongHome, proof: signMachineInstallationProof({ payload: wrongHome, privateKey: installation.secretKey }) } }))
            .toMatchObject({ ok: false, reasonCode: 'capture_source_denied' });
        await db.machine.update({ where: { id: f.machine.id }, data: { installationId: 'replacement' } });
        expect(await invoke()).toMatchObject({ ok: false, reasonCode: 'capture_source_denied' });
    });

    it('publishes a validated replacement without replaying: one write-boundary read and no terminal rereads', async () => {
        const f = await fixture();
        const replacement = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.owner.id,
            metadata: f.machine.metadata, daemonState: f.machine.daemonState, dataEncryptionKey: f.machine.dataEncryptionKey,
            installationId: f.machine.installationId } });
        expect(validateMachineReplacement({ accountId: f.owner.id, oldMachine: f.machine, replacementMachine: replacement,
            replacementMachineId: replacement.id, source: 'automatic' })).toEqual({ ok: true });
        const reads: string[] = [];
        await inTx(async tx => {
            const observed = observePrismaReads(tx, ['machine']);
            await applyMachineReplacement({ tx: observed.tx, accountId: f.owner.id, oldMachineId: f.machine.id,
                replacementMachineId: replacement.id, source: 'automatic', reason: 'machine_rotation', actorUserId: null });
            reads.push(...observed.reads);
        });
        expect((await db.machine.findUniqueOrThrow({ where: { id: f.machine.id } })).replacedByMachineId).toBe(replacement.id);
        expect(reads).toEqual(['machine.findMany']);
    });

    it('refuses old-client protected requests before dispatch to a daemon without requester isolation enforcement', async () => {
        const f = await fixture();
        const requester = await account();
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true, operationProtocolCapabilities: {} } });
        // Observed producers: cli-v0.2.17 / cli-v0.2.17-preview.1 at
        // a2c45c86804b24e60ac0b76146a3ef36dfcaa15b; moving ../0.2 at
        // 285ee7c5acb3bea1489896a254e4445f2483a213. Those daemons have no
        // requesterExecutionIsolation leaf. Their callers supply no new authority.
        const vectors = [
            { method: 'bash', params: { command: 'printf synthetic-private-probe', cwd: '/tmp' } },
            { method: 'readFile', params: { path: '/tmp/synthetic-private-file' } },
            { method: 'daemon.filesystem.readFile', params: { rootPath: '/tmp', path: 'synthetic-private-file' } },
            { method: 'daemon.terminal.ensure', params: { terminalKey: 'old-client', cwd: '/tmp', initialCommand: 'true' } },
            { method: 'daemon.mcpServers.test', params: { t: 'draft', machineId: f.machine.id, directory: '/tmp',
                server: { id: 'probe', name: 'probe', transport: 'stdio', stdio: { command: 'true', args: [] }, env: {},
                    createdAt: 1, updatedAt: 1 } } },
        ];
        const accountStoredContentCompatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
            declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
        const emitWithAck = vi.fn(async () => ({ status: 'old-daemon-effect' }));
        const target = { id: 'predecessor-daemon', data: { clientType: 'machine-scoped', machineId: f.machine.id,
            verifiedMachineInstallationId: 'install', accountStoredContentCompatibility }, timeout: () => ({ emitWithAck }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === target.id || vectors.some(vector =>
            room === `rpc:${f.owner.id}:${f.machine.id}:${vector.method}`) ? [target] : []);
        const call = async (actorAccountId: string, vector: typeof vectors[number],
            authAuthority: 'present_user' | 'account_automation' = 'present_user') => {
            // Socket authentication, not the RPC body, supplies this authority.
            const socket = createAuthenticatedFakeSocket({ data: { accountStoredContentCompatibility, authAuthority } });
            rpcHandler(actorAccountId, socket as unknown as Socket, { io });
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method: `${f.machine.id}:${vector.method}`, params: vector.params }, reply);
            return reply;
        };
        for (const level of ['view', 'admin'] as const) {
            await grant(f.owner.id, f.machine.id, requester.id, level);
            for (const vector of vectors) {
                expect(await call(requester.id, vector), vector.method).toHaveBeenCalledWith(expect.objectContaining({
                    ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
                }));
                expect(emitWithAck, vector.method).not.toHaveBeenCalled();
            }
            for (const actionId of ['session.spawn_new', 'session.open']) {
                expect(await access.resolveMachineAdmission({ actorAccountId: requester.id, machineId: f.machine.id, actionId }))
                    .toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
                expect(await access.resolveMachineAdmission({ actorAccountId: requester.id, machineId: f.machine.id,
                    actionId, callerAuthority: 'account_automation' }))
                    .toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
            }
        }
        expect(await call(f.owner.id, vectors[0]!, 'account_automation')).toHaveBeenCalledWith({
            ok: true, result: { status: 'old-daemon-effect' },
        });
        expect(emitWithAck).toHaveBeenCalledTimes(1);
        const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: crypto.randomUUID(), starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'verified-source-turn', callerPermissionMode: null, requestId: crypto.randomUUID() });
        // An old receiver cannot enforce genuine Session source custody.
        // Ordinary owner automation remains available; the Agent raw deputy does not.
        expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id,
            rpcMethod: RPC_METHODS.BASH, callerAuthority: 'present_user', sessionActionOrigin }))
            .toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
        for (const actionId of ['session.spawn_new', 'session.open']) {
            expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id,
                actionId, callerAuthority: 'account_automation', sessionActionOrigin })).toMatchObject({ kind: 'admitted' });
            expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id,
                actionId, operationRpcMethod: RPC_METHODS.BASH, callerAuthority: 'account_automation', sessionActionOrigin }))
                .toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
            expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id,
                actionId, rpcMethod: RPC_METHODS.BASH, callerAuthority: 'account_automation', sessionActionOrigin }))
                .toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
        }
        expect(await call(f.owner.id, vectors[0]!)).toHaveBeenCalledWith({ ok: true, result: { status: 'old-daemon-effect' } });
        expect(emitWithAck).toHaveBeenCalledTimes(2);
        expect(await access.resolveMachineAdmission({ actorAccountId: requester.id, machineId: f.machine.id,
            rpcMethod: RPC_METHODS.CAPABILITIES_DESCRIBE })).toMatchObject({ kind: 'admitted' });
        // The supported predecessor also retains an owned pre-installation
        // user-scoped carrier. Missing member support does not block its owner.
        await db.machine.update({ where: { id: f.machine.id }, data: { installationId: null } });
        target.data.clientType = 'user-scoped';
        expect(await call(f.owner.id, vectors[0]!, 'account_automation')).toHaveBeenCalledWith({
            ok: true, result: { status: 'old-daemon-effect' },
        });
        expect(emitWithAck).toHaveBeenCalledTimes(3);
        expect(await call(f.owner.id, vectors[0]!)).toHaveBeenCalledWith({ ok: true, result: { status: 'old-daemon-effect' } });
        expect(emitWithAck).toHaveBeenCalledTimes(4);
    });

    it('refuses protected predecessor Session RPC on a foreign physical Machine before dispatch', async () => {
        const f = await fixture();
        const requester = await account();
        await grant(f.owner.id, f.machine.id, requester.id);
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true, operationProtocolCapabilities: {} } });
        const accountStoredContentCompatibility = evaluateAccountStoredContentCompatibility({ status: 'missing' });
        const createSessionTarget = async (accountId: string) => {
            const session = await db.session.create({ data: { id: crypto.randomUUID(), accountId, tag: crypto.randomUUID(),
                metadata: '{}', encryptionMode: 'plain', active: true } });
            await db.accessKey.create({ data: { accountId, machineId: f.machine.id, sessionId: session.id,
                data: MACHINE_PLAIN_DATA_KEY_MARKER } });
            const emitWithAck = vi.fn(async () => ({ status: 'predecessor-session-effect' }));
            const target = { id: `session-${session.id}`, data: { clientType: 'session-scoped', userId: accountId,
                sessionId: session.id, sessionScopedBinding: { sessionId: session.id, machineId: f.machine.id, proof: 'machine-access-key' },
                accountStoredContentCompatibility }, timeout: () => ({ emitWithAck }) };
            const io = createSocketRoomDiscoveryHarness(async room => room === target.id ||
                room.startsWith(`rpc:${accountId}:${session.id}:`) ? [target] : []);
            const call = async (rpcMethod: string, options: Readonly<{ transferRouting?: boolean; sessionOrigin?: boolean;
                authority?: 'present_user' | 'account_automation' }> = {}) => {
                const socket = createAuthenticatedFakeSocket({ data: { accountStoredContentCompatibility, clientType: 'user-scoped',
                    authAuthority: options.authority ?? 'present_user',
                    ...(options.sessionOrigin ? { clientType: 'session-scoped', sessionId: session.id,
                        sessionScopedBinding: target.data.sessionScopedBinding } : {}) } });
                rpcHandler(accountId, socket as unknown as Socket, { io });
                const reply = vi.fn();
                await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method: `${session.id}:${rpcMethod}`,
                    params: {}, ...(options.transferRouting ? { transferRouting: { method: rpcMethod,
                        t: 'session_attachment_download_v1', sessionId: session.id } } : {}) }, reply);
                return reply;
            };
            return { call, emitWithAck };
        };
        // These handlers are installed by the actual predecessor's
        // rpc/handlers/registerSessionHandlers.ts, independently of fresh spawn.
        const foreign = await createSessionTarget(requester.id);
        for (const method of [RPC_METHODS.BASH, 'ripgrep', RPC_METHODS.DIFFTASTIC]) {
            expect(await foreign.call(method), method).toHaveBeenCalledWith(expect.objectContaining({
                ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
            }));
            expect(foreign.emitWithAck).not.toHaveBeenCalled();
        }
        expect(await foreign.call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, { transferRouting: true })).toHaveBeenCalledWith(
            expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(foreign.emitWithAck).not.toHaveBeenCalled();
        expect(await foreign.call(RPC_METHODS.CAPABILITIES_DESCRIBE)).toHaveBeenCalledWith({
            ok: true, result: { status: 'predecessor-session-effect' },
        });
        // The daemon may upgrade while this older Session process survives.
        // Its new Machine advertisement is not evidence about this receiver.
        await db.machine.update({ where: { id: f.machine.id }, data: {
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
        } });
        expect(await foreign.call(RPC_METHODS.BASH)).toHaveBeenCalledWith(expect.objectContaining({
            ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
        }));
        expect(foreign.emitWithAck).toHaveBeenCalledTimes(1);
        const owned = await createSessionTarget(f.owner.id);
        expect(await owned.call(RPC_METHODS.BASH, { sessionOrigin: true })).toHaveBeenCalledWith(expect.objectContaining({
            ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
        }));
        expect(owned.emitWithAck).not.toHaveBeenCalled();
        for (const authority of ['present_user', 'account_automation'] as const) {
            expect(await owned.call(RPC_METHODS.BASH, { authority })).toHaveBeenCalledWith({
                ok: true, result: { status: 'predecessor-session-effect' },
            });
        }
        expect(owned.emitWithAck).toHaveBeenCalledTimes(2);
    });

    it('withdraws only protected member operations and reads their enforcement capability in the existing admission query', async () => {
        const f = await fixture();
        const requester = await account();
        await db.machine.update({ where: { id: f.machine.id }, data: { operationProtocolCapabilities: {} } });
        await grant(f.owner.id, f.machine.id, requester.id, 'admin');
        const actor = { actorAccountId: requester.id, machineId: f.machine.id };
        const methods = [
            RPC_METHODS.BASH,
            RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_LIST,
            RPC_METHODS.DAEMON_TERMINAL_STREAM_READ, RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
            RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK, RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
            RPC_METHODS.DAEMON_TERMINAL_INPUT, RPC_METHODS.DAEMON_TERMINAL_RESIZE,
            RPC_METHODS.DAEMON_TERMINAL_RESTART, RPC_METHODS.DAEMON_TERMINAL_CLOSE,
            RPC_METHODS.READ_FILE, RPC_METHODS.WRITE_FILE, RPC_METHODS.STAT_FILE,
            RPC_METHODS.LIST_DIRECTORY, RPC_METHODS.GET_DIRECTORY_TREE, RPC_METHODS.CREATE_DIRECTORY,
            RPC_METHODS.RENAME_PATH, RPC_METHODS.DELETE_PATH, RPC_METHODS.COPY_PATH,
            RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS, RPC_METHODS.DAEMON_FILESYSTEM_READ_FILE,
            RPC_METHODS.DAEMON_FILESYSTEM_WRITE_FILE, RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
            RPC_METHODS.DAEMON_FILESYSTEM_GET_DIRECTORY_TREE, RPC_METHODS.DAEMON_FILESYSTEM_CREATE_DIRECTORY,
            RPC_METHODS.DAEMON_FILESYSTEM_RENAME, RPC_METHODS.DAEMON_FILESYSTEM_DELETE,
            RPC_METHODS.DAEMON_FILESYSTEM_COPY, RPC_METHODS.DAEMON_FILESYSTEM_UPLOAD,
            RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD, RPC_METHODS.DAEMON_FILESYSTEM_TRANSFER_CANCEL,
            RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
            RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
            RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
            RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
            RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST, RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH,
            RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW, RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY,
            RPC_METHODS.DAEMON_LSP_SYNC, RPC_METHODS.DAEMON_LSP_QUERY, RPC_METHODS.DAEMON_LSP_WATCH,
            RPC_METHODS.DAEMON_LSP_RESTART, RPC_METHODS.DAEMON_LSP_RENAME_APPLY,
            RPC_METHODS.DAEMON_LSP_FILE_RENAME_APPLY, RPC_METHODS.DAEMON_LSP_CODE_ACTION_APPLY,
            RPC_METHODS.DAEMON_LSP_FORMAT_APPLY, RPC_METHODS.DAEMON_LSP_IMPORTS_ORGANIZE_APPLY,
            RPC_METHODS.SCM_FILE_READ, RPC_METHODS.DIFFTASTIC, RPC_METHODS.DAEMON_MCP_SERVERS_TEST,
            RPC_METHODS.DAEMON_PROJECTS_PREPARE, RPC_METHODS.DAEMON_PROJECTS_SCRIPT_RUN,
            RPC_METHODS.DAEMON_PROJECTS_COMPUTE_EXEC,
        ];
        for (const rpcMethod of methods) {
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }), rpcMethod)
                .toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
        }
        await db.machine.update({ where: { id: f.machine.id }, data: {
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        for (const rpcMethod of methods) {
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }), rpcMethod).toMatchObject({ kind: 'admitted' });
        }
        const admitted = await inTx(async tx => {
            const observed = observePrismaReads(tx, ['machine']);
            const value = await access.resolveMachineAdmissionInTx(observed.tx, { ...actor, rpcMethod: RPC_METHODS.BASH });
            return { value, reads: observed.reads };
        });
        expect(admitted).toMatchObject({ value: { kind: 'admitted' }, reads: ['machine.findMany', 'machine.findMany'] });
        await db.machine.update({ where: { id: f.machine.id }, data: {
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [2] }, sessionSpawn: { protocolVersions: [1] } },
        } });
        expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: RPC_METHODS.BASH }))
            .toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
        expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: RPC_METHODS.CAPABILITIES_DESCRIBE }))
            .toMatchObject({ kind: 'admitted' });
    });

    it('keeps reviewed composite role separate from actual Session child operation support', async () => {
        const f = await fixture();
        const requester = await account();
        await grant(f.owner.id, f.machine.id, requester.id);
        await db.machine.update({ where: { id: f.machine.id }, data: { operationProtocolCapabilities: {} } });
        const operation = { machineId: f.machine.id, requiredRole: 'use' as const };
        for (const operationRpcMethod of [RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
            RPC_METHODS.SESSION_SPAWN_NEW, RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
            RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE]) {
            expect(await access.resolveMachineAdmission({ ...operation, actorAccountId: requester.id, operationRpcMethod }), operationRpcMethod)
                .toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
            expect(await access.resolveMachineAdmission({ ...operation, actorAccountId: f.owner.id, operationRpcMethod }))
                .toMatchObject({ kind: 'admitted' });
        }
        await db.machine.update({ where: { id: f.machine.id }, data: {
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
        } });
        expect(await access.resolveMachineAdmission({ ...operation, actorAccountId: requester.id,
            operationRpcMethod: RPC_METHODS.SESSION_SPAWN_NEW })).toMatchObject({ kind: 'admitted' });
    });

    it('admits reachability inspect (native firewall CHECK) only for the custodian and Manage grantees', async () => {
        const f = await fixture();
        const user = await account();
        const manager = await account();
        await grant(f.owner.id, f.machine.id, user.id, 'view');
        await grant(f.owner.id, f.machine.id, manager.id, 'admin');
        for (const request of [{ rpcMethod: RPC_METHODS.MACHINES_REACHABILITY_INSPECT }, { actionId: 'machines.reachability.inspect' }]) {
            expect(await access.resolveMachineAdmission({ actorAccountId: user.id, machineId: f.machine.id, ...request }))
                .toEqual({ kind: 'denied', code: 'access_denied' });
            expect(await access.resolveMachineAdmission({ actorAccountId: manager.id, machineId: f.machine.id, ...request }))
                .toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: f.owner.id });
            expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id, ...request }))
                .toMatchObject({ kind: 'admitted', role: 'manage' });
        }
    });

    it('keeps owned and foreign admission decisions in one mixed batch, including refusals', async () => {
        const owned = await fixture();
        const shared = await fixture();
        const hidden = await fixture();
        await grant(shared.owner.id, shared.machine.id, owned.owner.id);
        const revoked = await db.machine.create({ data: { ...owned.machine, id: crypto.randomUUID(), revokedAt: new Date() } });
        const missingId = crypto.randomUUID();
        const read = () => inTx(tx => access.resolveMachineAdmissionsInTx(tx, { actorAccountId: owned.owner.id,
            machineIds: [owned.machine.id, shared.machine.id, hidden.machine.id, revoked.id, missingId] }));
        const admitted = await read();
        expect(admitted.get(owned.machine.id)).toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: owned.owner.id });
        expect(admitted.get(shared.machine.id)).toMatchObject({ kind: 'admitted', role: 'use', custodianAccountId: shared.owner.id });
        expect(admitted.get(hidden.machine.id)).toEqual({ kind: 'denied', code: 'access_denied' });
        expect(admitted.get(revoked.id)).toEqual({ kind: 'denied', code: 'machine_unavailable' });
        expect(admitted.get(missingId)).toEqual({ kind: 'denied', code: 'access_denied' });
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: shared.owner.id,
            machineId: shared.machine.id, principal: { kind: 'account', accountId: owned.owner.id } }));
        await db.account.update({ where: { id: owned.owner.id }, data: { status: 'suspended' } });
        const refused = await read();
        expect(refused.get(owned.machine.id)).toEqual({ kind: 'denied', code: 'access_denied' });
        expect(refused.get(shared.machine.id)).toEqual({ kind: 'denied', code: 'access_denied' });
    });

    it('admits Workflow Start through external Action ingress with Can use while retaining custodian-only neighbors', async () => {
        const f = await fixture();
        const requester = await account();
        await grant(f.owner.id, f.machine.id, requester.id);
        const admit = (actorAccountId: string, actionId = 'workflow.run.start') => inTx(tx =>
            resolveExternalActionExecutionMachineAdmissionInTx(tx, {
                actorAccountId, machineId: f.machine.id, actionId,
                authentication: { authenticationAuthority: 'present_user' },
            }));
        expect(await admit(f.owner.id)).toMatchObject({ kind: 'admitted', role: 'manage' });
        expect(await admit(requester.id)).toMatchObject({ kind: 'admitted', role: 'use',
            actorAccountId: requester.id, custodianAccountId: f.owner.id, machineId: f.machine.id });
        expect(await access.resolveMachineAdmission({ actorAccountId: requester.id, machineId: f.machine.id,
            rpcMethod: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE }))
            .toEqual({ kind: 'denied', code: 'custodian_only' });
        await db.machine.update({ where: { id: f.machine.id }, data: { operationProtocolCapabilities: {} } });
        expect(await admit(requester.id)).toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
        expect(await admit(f.owner.id)).toMatchObject({ kind: 'admitted', role: 'manage' });
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id,
            machineId: f.machine.id, principal: { kind: 'account', accountId: requester.id } }));
        expect(await admit(requester.id)).toEqual({ kind: 'denied', code: 'access_denied' });
    });

    it('admits Machine execution and control only for Manage while retaining Project and Session Use execution', async () => {
        const f = await fixture();
        const requester = await account();
        const actor = { actorAccountId: requester.id, machineId: f.machine.id };
        const machineMethods = [RPC_METHODS.BASH, RPC_METHODS.MACHINES_SERVICE_EXEC, RPC_METHODS.MACHINES_SERVICE_CONTROL,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE, RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_TERMINATE_DETECTED,
            RPC_METHODS.MACHINES_REBOOT, RPC_METHODS.MACHINE_ADMIN_ACCESS_SET, RPC_METHODS.MACHINES_REACHABILITY_CONFIGURE,
            RPC_METHODS.MACHINES_GUARD_ACTIVITY_UNDO, RPC_METHODS.MACHINES_GUARD_SESSION_CEILING_SET,
            RPC_METHODS.MACHINES_RESOURCES_POLICY_SET, 'machines.setup.plan', 'machines.setup.apply', 'machines.setup.remove'];
        await grant(f.owner.id, f.machine.id, requester.id);
        for (const rpcMethod of machineMethods) {
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }), rpcMethod)
                .toEqual({ kind: 'denied', code: 'access_denied' });
        }
        for (const actionId of ['projects.script.run', 'projects.compute.exec', 'session.spawn_new', 'session.open']) {
            expect(await access.resolveMachineAdmission({ ...actor, actionId }), actionId).toMatchObject({
                kind: 'admitted', actorAccountId: requester.id, custodianAccountId: f.owner.id, role: 'use',
            });
        }
        await grant(f.owner.id, f.machine.id, requester.id, 'admin');
        for (const rpcMethod of machineMethods) {
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }), rpcMethod).toMatchObject({
                kind: 'admitted', actorAccountId: requester.id, custodianAccountId: f.owner.id, role: 'manage',
            });
            expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id, rpcMethod }), rpcMethod)
                .toMatchObject({ kind: 'admitted', actorAccountId: f.owner.id, role: 'manage' });
        }
        expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE }))
            .toEqual({ kind: 'denied', code: 'custodian_only' });
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'account', accountId: requester.id } }));
        expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: RPC_METHODS.BASH }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
    });

    it('requires Manage for installation and command Actions while preserving Use capability discovery', async () => {
        const f = await fixture();
        const requester = await account();
        const actor = { actorAccountId: requester.id, machineId: f.machine.id };
        await grant(f.owner.id, f.machine.id, requester.id);
        for (const actionId of ['machines.agents.install', 'machines.agents.uninstall', 'machines.capabilities.install', 'machines.command.run']) {
            expect(await access.resolveMachineAdmission({ ...actor, actionId }), actionId)
                .toEqual({ kind: 'denied', code: 'access_denied' });
        }
        expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: RPC_METHODS.DAEMON_AGENTS_INSTALL_START }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
        expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: RPC_METHODS.CAPABILITIES_INVOKE }))
            .toMatchObject({ kind: 'admitted', role: 'use', actorAccountId: requester.id });
        await grant(f.owner.id, f.machine.id, requester.id, 'admin');
        for (const actionId of ['machines.agents.install', 'machines.agents.uninstall', 'machines.capabilities.install', 'machines.command.run']) {
            expect(await access.resolveMachineAdmission({ ...actor, actionId }), actionId)
                .toMatchObject({ kind: 'admitted', role: 'manage', actorAccountId: requester.id, custodianAccountId: f.owner.id });
        }
    });

    it('preserves passive service Use and verified composite admission beside Manage-only raw mutations', async () => {
        const f = await fixture();
        const requester = await account();
        const actor = { actorAccountId: requester.id, machineId: f.machine.id };
        await grant(f.owner.id, f.machine.id, requester.id);
        for (const rpcMethod of [RPC_METHODS.MACHINES_SERVICE_LIST, RPC_METHODS.MACHINES_SERVICE_DISCOVERY,
            RPC_METHODS.MACHINES_SERVICE_DETAIL]) {
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }), rpcMethod)
                .toMatchObject({ kind: 'admitted', role: 'use', actorAccountId: requester.id });
        }
        for (const rpcMethod of [RPC_METHODS.MACHINES_SERVICE_WATCH, RPC_METHODS.MACHINES_SERVICE_UNWATCH,
            RPC_METHODS.DAEMON_DEPLOYMENT_CHILD]) {
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }), rpcMethod)
                .toEqual({ kind: 'denied', code: 'access_denied' });
        }
        // The socket owner supplies this form only after the original composite
        // root and exact child have been verified. Raw RPCs take the branch above.
        expect(await access.resolveMachineAdmission({ ...actor, requiredRole: 'use',
            operationRpcMethod: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD })).toMatchObject({ kind: 'admitted', role: 'use' });
        await grant(f.owner.id, f.machine.id, requester.id, 'admin');
        for (const rpcMethod of [RPC_METHODS.MACHINES_SERVICE_WATCH, RPC_METHODS.MACHINES_SERVICE_UNWATCH,
            RPC_METHODS.DAEMON_DEPLOYMENT_CHILD]) {
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }), rpcMethod)
                .toMatchObject({ kind: 'admitted', role: 'manage', actorAccountId: requester.id });
        }
    });

    it('admits the requester-owned spawn Action for Can use while refusing raw private spawn RPCs', async () => {
        const f = await fixture();
        const requester = await account();
        const outsider = await account();
        await grant(f.owner.id, f.machine.id, requester.id);
        const actor = { actorAccountId: requester.id, machineId: f.machine.id };
        for (const actionId of ['session.spawn_new', 'session.open', 'template.instantiate']) {
            expect(await access.resolveMachineAdmission({ ...actor, actionId })).toMatchObject({
                kind: 'admitted', actorAccountId: requester.id, custodianAccountId: f.owner.id, role: 'use',
            });
        }
        for (const rpcMethod of [RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, RPC_METHODS.SESSION_SPAWN_NEW]) {
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }))
                .toEqual({ kind: 'denied', code: 'custodian_only' });
            for (const actionId of ['session.spawn_new', 'template.instantiate']) {
                expect(await access.resolveMachineAdmission({ ...actor, actionId, rpcMethod }))
                    .toEqual({ kind: 'denied', code: 'custodian_only' });
            }
        }
        for (const actionId of ['session.spawn_new', 'template.instantiate']) {
            expect(await access.resolveMachineAdmission({ actorAccountId: outsider.id, machineId: f.machine.id, actionId }))
                .toEqual({ kind: 'denied', code: 'access_denied' });
        }
        expect(await access.resolveMachineAdmission({ ...actor, actionId: 'template.instantiate', requiredRole: 'manage' }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
        expect(await access.resolveMachineAdmission({ ...actor, actionId: 'plugins.npm_registry_profiles.list' }))
            .toEqual({ kind: 'denied', code: 'custodian_only' });
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'account', accountId: requester.id } }));
        for (const actionId of ['session.spawn_new', 'template.instantiate']) {
            expect(await access.resolveMachineAdmission({ ...actor, actionId }))
                .toEqual({ kind: 'denied', code: 'access_denied' });
        }
    });

    it('admits Provider reads through their actual RPC policy without lending private mutation authority', async () => {
        const f = await fixture();
        const requester = await account();
        await grant(f.owner.id, f.machine.id, requester.id);
        const actor = { actorAccountId: requester.id, machineId: f.machine.id };
        for (const actionId of ['providers.models.projection', 'providers.models.refresh']) {
            expect(await access.resolveMachineAdmission({ ...actor, actionId }), actionId).toMatchObject({
                kind: 'admitted', actorAccountId: requester.id, custodianAccountId: f.owner.id, role: 'use',
            });
        }
        for (const actionId of ['providers.connections.describe', 'providers.connections.start_local', 'providers.connections.secrets.bind']) {
            expect(await access.resolveMachineAdmission({ ...actor, actionId }), actionId)
                .toEqual({ kind: 'denied', code: 'custodian_only' });
        }
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'account', accountId: requester.id } }));
        expect(await access.resolveMachineAdmission({ ...actor, actionId: 'providers.models.projection' }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
    });

    it('excludes revoked owned Machines from discovery while retaining explicit historical candidates', async () => {
        const f = await fixture();
        const offline = await db.machine.create({ data: { ...f.machine, id: crypto.randomUUID() } });
        await db.machine.update({ where: { id: f.machine.id }, data: { revokedAt: new Date(), active: false } });
        expect(await inTx(tx => access.listMachineCandidatesInTx(tx, f.owner.id))).toEqual([offline.id]);
        expect(await inTx(tx => access.listMachineCandidatesInTx(tx, f.owner.id, { includeRevokedOwned: true })))
            .toEqual([f.machine.id, offline.id].sort());
    });

    it.each([
        ['providers.legacy.prepare', RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREPARE_SOURCE],
        ['providers.models.list', RPC_METHODS.DAEMON_PROVIDERS_MODELS],
        ['providers.probe', RPC_METHODS.DAEMON_PROVIDERS_PROBE],
        ['providers.binding.status', RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS],
        ['providers.models.load', RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD],
        ['providers.models.experimental.confirm', RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE],
    ])('keeps private Provider %s with its custodian for both Use and Manage grants', async (actionId, rpcMethod) => {
        const f = await fixture();
        const requester = await account();
        for (const level of ['admin', 'view'] as const) {
            await grant(f.owner.id, f.machine.id, requester.id, level);
            const actor = { actorAccountId: requester.id, machineId: f.machine.id };
            expect(await access.resolveMachineAdmission({ ...actor, actionId }))
                .toEqual({ kind: 'denied', code: 'custodian_only' });
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod }))
                .toEqual({ kind: 'denied', code: 'custodian_only' });
        }
        const owner = { actorAccountId: f.owner.id, machineId: f.machine.id };
        expect(await access.resolveMachineAdmission({ ...owner, actionId }))
            .toMatchObject({ kind: 'admitted', role: 'manage' });
        expect(await access.resolveMachineAdmission({ ...owner, rpcMethod }))
            .toMatchObject({ kind: 'admitted', role: 'manage' });
    });

    it.each([
        RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_REQUEST_POLICY_SUPPORT,
        RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_RESOURCE_TEST_CANDIDATE,
        RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY,
        RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME,
    ])('refuses raw private Provider and connected-service operations to Use and Manage grantees: %s', async rpcMethod => {
        const f = await fixture();
        const requester = await account();
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true } });
        const accountStoredContentCompatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
            declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
        const emitWithAck = vi.fn(async () => ({ status: 'source-result' }));
        const target = { id: 'source-daemon',
            data: { clientType: 'machine-scoped', machineId: f.machine.id, verifiedMachineInstallationId: 'install', accountStoredContentCompatibility },
            timeout: () => ({ emitWithAck }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === `rpc:${f.owner.id}:${f.machine.id}:${rpcMethod}` || room === target.id ? [target] : []);
        const call = async (actorAccountId: string) => {
            const socket = createAuthenticatedFakeSocket({ data: { accountStoredContentCompatibility } });
            rpcHandler(actorAccountId, socket as unknown as Socket, { io });
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method: `${f.machine.id}:${rpcMethod}`, params: {} }, reply);
            return reply;
        };
        for (const level of ['view', 'admin'] as const) {
            await grant(f.owner.id, f.machine.id, requester.id, level);
            expect(await call(requester.id)).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
            expect(emitWithAck).not.toHaveBeenCalled();
            expect(await access.resolveMachineAdmission({ actorAccountId: requester.id, machineId: f.machine.id, rpcMethod }))
                .toEqual({ kind: 'denied', code: 'custodian_only' });
        }
        expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id, rpcMethod }))
            .toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: f.owner.id });
        expect(await call(f.owner.id)).toHaveBeenCalledWith({ ok: true, result: { status: 'source-result' } });
    });

    it('delivers Machine-wide run inventory only for the owner and current Manage grantees', async () => {
        const f = await fixture();
        const requester = await account();
        await grant(f.owner.id, f.machine.id, requester.id);
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true } });
        const accountStoredContentCompatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
            declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
        const inventory = { runs: [] };
        const emitWithAck = vi.fn(async () => inventory);
        const rpcMethod = RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST;
        const target = { id: 'run-inventory-daemon',
            data: { clientType: 'machine-scoped', machineId: f.machine.id, verifiedMachineInstallationId: 'install', accountStoredContentCompatibility },
            timeout: () => ({ emitWithAck }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === `rpc:${f.owner.id}:${f.machine.id}:${rpcMethod}` || room === target.id ? [target] : []);
        const call = async (actorAccountId: string) => {
            const socket = createAuthenticatedFakeSocket({ data: { accountStoredContentCompatibility } });
            rpcHandler(actorAccountId, socket as unknown as Socket, { io });
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method: `${f.machine.id}:${rpcMethod}`, params: {} }, reply);
            return reply;
        };
        expect(await call(f.owner.id)).toHaveBeenCalledWith({ ok: true, result: inventory });
        const ownedReads = emitWithAck.mock.calls.length;
        expect(await call(requester.id)).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(emitWithAck).toHaveBeenCalledTimes(ownedReads);
        await grant(f.owner.id, f.machine.id, requester.id, 'admin');
        expect(await call(requester.id)).toHaveBeenCalledWith({ ok: true, result: inventory });
        await grant(f.owner.id, f.machine.id, requester.id, 'view');
        const managedReads = emitWithAck.mock.calls.length;
        expect(await call(requester.id)).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(emitWithAck).toHaveBeenCalledTimes(managedReads);
    });

    it('refuses native cookie reads to Use before daemon delivery and admits Manage', async () => {
        const f = await fixture();
        const requester = await account();
        await grant(f.owner.id, f.machine.id, requester.id);
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true } });
        const accountStoredContentCompatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
            declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
        const emitWithAck = vi.fn(async () => ({ status: 'source-result' }));
        const rpcMethod = RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ;
        const target = { id: 'cookie-source-daemon',
            data: { clientType: 'machine-scoped', machineId: f.machine.id, verifiedMachineInstallationId: 'install', accountStoredContentCompatibility },
            timeout: () => ({ emitWithAck }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === `rpc:${f.owner.id}:${f.machine.id}:${rpcMethod}` || room === target.id ? [target] : []);
        const call = async () => {
            const socket = createAuthenticatedFakeSocket({ data: { accountStoredContentCompatibility } });
            rpcHandler(requester.id, socket as unknown as Socket, { io });
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method: `${f.machine.id}:${rpcMethod}`, params: {} }, reply);
            return reply;
        };
        expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(emitWithAck).not.toHaveBeenCalled();
        await grant(f.owner.id, f.machine.id, requester.id, 'admin');
        expect(await call()).toHaveBeenCalledWith({ ok: true, result: { status: 'source-result' } });
        expect(emitWithAck).toHaveBeenCalledOnce();
    });

    it('admits requester-scoped operation reads and cancellation for current Machine Use and Manage', async () => {
        const f = await fixture();
        const requester = await account();
        const outsider = await account();
        const actor = { actorAccountId: requester.id, machineId: f.machine.id };
        for (const level of ['view', 'admin'] as const) {
            await grant(f.owner.id, f.machine.id, requester.id, level);
            for (const methods of [ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2]) {
                for (const rpcMethod of [methods.list, methods.get]) {
                    const admission = await access.resolveMachineAdmission({ ...actor, rpcMethod });
                    expect(admission, `${rpcMethod}: ${JSON.stringify(admission)}`).toMatchObject({
                        kind: 'admitted', actorAccountId: requester.id, custodianAccountId: f.owner.id,
                        machineId: f.machine.id, installationId: 'install', role: level === 'view' ? 'use' : 'manage',
                    });
                    expect(await access.resolveMachineAdmission({ actorAccountId: outsider.id, machineId: f.machine.id, rpcMethod }))
                        .toEqual({ kind: 'denied', code: 'access_denied' });
                }
            }
            expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: ACTION_OPERATION_RPC_METHODS_V1.cancel }))
                .toMatchObject({ kind: 'admitted', actorAccountId: requester.id, custodianAccountId: f.owner.id });
        }
        await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'account', accountId: requester.id } }));
        expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: ACTION_OPERATION_RPC_METHODS_V2.get }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
        expect(await access.resolveMachineAdmission({ ...actor, rpcMethod: ACTION_OPERATION_RPC_METHODS_V1.cancel }))
            .toEqual({ kind: 'denied', code: 'access_denied' });
    });

    it('projects safe current requester labels only to the custodian and current Manage holders', async () => {
        const f = await fixture();
        const requester = await account();
        const manager = await account();
        const member = await account();
        const outsider = await account();
        await db.account.update({ where: { id: requester.id }, data: { name: 'Bob Requester', firstName: 'Bob', lastName: 'Requester', username: 'bob', settings: 'private-settings' } });
        await db.account.update({ where: { id: manager.id }, data: { username: 'current-manager' } });
        await db.account.update({ where: { id: member.id }, data: { name: 'Team Requester', firstName: 'Team', lastName: 'Requester' } });
        await db.account.update({ where: { id: outsider.id }, data: { name: 'Never Admitted', firstName: 'Never', lastName: 'Admitted' } });
        await db.session.create({ data: { accountId: requester.id, tag: crypto.randomUUID(), metadata: 'private-requester-session' } });
        await grant(f.owner.id, f.machine.id, requester.id);
        await grant(f.owner.id, f.machine.id, manager.id, 'admin');
        const team = await db.team.create({ data: { name: 'Current requester Team' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: f.owner.id, role: 'member' } });
        await inTx(tx => access.setMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: 'team', teamId: team.id }, level: 'view' }));
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        const list = (actorAccountId: string) => inTx(tx => access.listMachineAccessGrantsInTx(tx, { actorAccountId, machineId: f.machine.id }));
        const ownerList = await list(f.owner.id);
        expect(ownerList).toMatchObject({ canManage: true, currentRequesterDisplayIdentities: expect.arrayContaining([
            { accountId: requester.id, displayName: 'Bob Requester' },
            { accountId: manager.id, displayName: 'current-manager' },
            { accountId: member.id, displayName: 'Team Requester' },
        ]) });
        if ('kind' in ownerList) throw new Error(ownerList.code);
        expect(ownerList.currentRequesterDisplayIdentities?.map(identity => identity.accountId).sort())
            .toEqual([f.owner.id, requester.id, manager.id, member.id].sort());
        for (const identity of ownerList.currentRequesterDisplayIdentities ?? []) {
            expect(Object.keys(identity).sort()).toEqual(['accountId', 'displayName']);
        }
        expect(await list(manager.id)).toMatchObject({ currentRequesterDisplayIdentities: ownerList.currentRequesterDisplayIdentities });
        expect(await list(requester.id)).not.toHaveProperty('currentRequesterDisplayIdentities');
        await db.teamMembership.delete({ where: { id: membership.id } });
        await db.account.update({ where: { id: requester.id }, data: { status: 'suspended' } });
        const current = await list(f.owner.id);
        if ('kind' in current) throw new Error(current.code);
        expect(current.currentRequesterDisplayIdentities?.map(identity => identity.accountId).sort()).toEqual([f.owner.id, manager.id].sort());
        expect(await list(outsider.id)).toEqual({ kind: 'refused', code: 'access_denied' });
    });

    it('uses persisted custodian mode and refuses contradictory or malformed material before disclosure or admission', async () => {
        const f = await fixture();
        await db.account.update({ where: { id: f.owner.id }, data: { ...createSignedAccountContentBinding(f.owner.keys.publicKey), encryptionMode: 'e2ee' } });
        const actor = { actorAccountId: f.owner.id, machineId: f.machine.id };
        expect(await inTx(tx => access.readAccessibleMachineAccessInTx(tx, actor))).toMatchObject({ resourceMode: 'e2ee', accessState: 'refused' });
        expect(await inTx(tx => access.readMachineDataKeyForCallerInTx(tx, actor))).toBeNull();
        expect(await access.resolveMachineAdmission(actor)).toEqual({ kind: 'denied', code: 'encryption_material_unavailable' });
        await db.machine.update({ where: { id: f.machine.id }, data: { metadata: 'opaque', daemonState: null, dataEncryptionKey: new Uint8Array([0, 1, 2]) } });
        expect(await access.resolveMachineAdmission(actor)).toEqual({ kind: 'denied', code: 'encryption_material_unavailable' });
        expect(await inTx(tx => access.readMachineDataKeyForCallerInTx(tx, actor))).toBeNull();
        const recipient = await account('e2ee');
        expect(await grant(f.owner.id, f.machine.id, recipient.id)).toEqual({ kind: 'refused', code: 'access_denied' });
        expect(await db.machineAccountGrant.count({ where: { machineId: f.machine.id } })).toBe(0);
    });

    it.each(['plain', 'e2ee'] as const)('Plain Machine admits %s recipients keylessly and Manage can administer offline', async mode => {
        const f = await fixture(); const recipient = await account(mode);
        expect(await grant(f.owner.id, f.machine.id, recipient.id)).toMatchObject({ kind: 'saved', readiness: 'ready' });
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBe('use');
        expect(await db.machineKeyEnvelope.count({ where: { machineId: f.machine.id } })).toBe(0);
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id, requiredRole: 'manage' })).toEqual({ kind: 'denied', code: 'access_denied' });
        await grant(f.owner.id, f.machine.id, recipient.id, 'admin');
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id, requiredRole: 'manage' })).toMatchObject({ kind: 'admitted', actorAccountId: recipient.id, custodianAccountId: f.owner.id, installationId: 'install', role: 'manage', encryptionMode: 'plain' });
        expect(await grant(recipient.id, f.machine.id, f.owner.id, 'admin')).toEqual({ kind: 'refused', code: 'custodian_protected' });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id, actionId: 'unknown.qualified.action' })).toEqual({ kind: 'denied', code: 'unsupported_operation' });
        expect(await access.resolveMachineAdmission({ actorAccountId: f.owner.id, machineId: f.machine.id, actionId: 'unknown.qualified.action' })).toMatchObject({ kind: 'admitted' });
    });

    it('reports unsafe retained Plain content as unpublished until actual custodian publication, without fabricating keys', async () => {
        const f = await fixture(); const recipient = await account();
        await db.machine.update({ where: { id: f.machine.id }, data: { daemonState: encodePlainMachineStoredContent({ status: 'running', workspaceSync: { relationships: [{ relationshipId: 'private', alphaPath: '/private' }] } }) } });
        expect(await grant(f.owner.id, f.machine.id, recipient.id)).toMatchObject({ kind: 'saved', readiness: 'refused' });
        expect(await inTx(tx => access.listMachineAccessGrantsInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id })))
            .toMatchObject({ grants: [{ audience: [{ accountId: recipient.id, readiness: 'refused',
                reason: 'content_unpublished', canPrepareKeys: false }] }] });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id })).toEqual({ kind: 'denied', code: 'content_unpublished' });
        expect(await inTx(tx => access.readAccessibleMachineAccessInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id })))
            .toMatchObject({ accessState: 'refused', reason: 'content_unpublished' });
        expect(await inTx(tx => access.readMachineRecipientCensusInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id }))).toEqual({ kind: 'refused', code: 'content_unpublished' });
        await db.machine.update({ where: { id: f.machine.id }, data: { daemonState: encodePlainMachineStoredContent({ status: 'running' }), daemonStateVersion: { increment: 1 } } });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id })).toMatchObject({ kind: 'admitted', encryptionMode: 'plain' });
        expect(await db.machineKeyEnvelope.count({ where: { machineId: f.machine.id } })).toBe(0);
    });

    it('current Team/group union follows late join, departure/rejoin and independent direct overlap without Session horizons', async () => {
        const f = await fixture(); const recipient = await account();
        const team = await db.team.create({ data: { name: 'Team' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: f.owner.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Group', nameKey: crypto.randomUUID() } });
        await inTx(tx => access.setMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id, principal: { kind: 'team', teamId: team.id }, level: 'view' }));
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBeNull();
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member', sessionAccessStartsAt: new Date('2099-01-01') } });
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBe('use');
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: member.id, nativeContribution: true } });
        await inTx(tx => access.setMachineAccessGrantInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id, principal: { kind: 'group', teamId: team.id, groupId: group.id }, level: 'admin' }));
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBe('manage');
        await grant(f.owner.id, f.machine.id, recipient.id);
        await grant(f.owner.id, f.machine.id, recipient.id);
        expect(await db.machineAccountGrant.count({ where: { machineId: f.machine.id, accountId: recipient.id } })).toBe(1);
        await db.teamMembership.delete({ where: { id: member.id } });
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBe('use');
        await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
        expect(await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id, principal: { kind: 'account', accountId: recipient.id }, leave: true }))).toEqual({ kind: 'inherited_access_remains', role: 'use' });
        expect(await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id, principal: { kind: 'account', accountId: recipient.id }, leave: true }))).toEqual({ kind: 'inherited_access_remains', role: 'use' });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        expect(await inTx(tx => access.resolveEffectiveMachineRoleInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toBeNull();
    });

    it('E2EE refuses Plain, derives pending until current tuple and rejects stale holder, owner and recipient bindings atomically', async () => {
        const f = await fixture('e2ee'); const plain = await account(); const recipient = await account('e2ee');
        // A native job supplies access authority, never recipient encryption material.
        const admittedOpening = async () => (await access.readAccessibleMachineOpeningsInTx(db, {
            actorAccountId: recipient.id, machineIds: [f.machine.id], admission: {
                actorAccountId: recipient.id, machineId: f.machine.id, custodianAccountId: f.owner.id,
                installationId: f.machine.installationId!, role: 'use', encryptionMode: 'e2ee',
            },
        })).get(f.machine.id);
        expect(await grant(f.owner.id, f.machine.id, plain.id)).toEqual({ kind: 'refused', code: 'recipient_encryption_incompatible' });
        expect(await db.machineAccountGrant.count({ where: { machineId: f.machine.id, accountId: plain.id } })).toBe(0);
        expect(await grant(f.owner.id, f.machine.id, recipient.id, 'admin')).toMatchObject({ kind: 'saved', readiness: 'key_pending' });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id })).toEqual({ kind: 'denied', code: 'recipient_key_pending' });
        expect(await admittedOpening()).toMatchObject({ access: { accessState: 'key_pending' }, callerDataEncryptionKey: null });
        const third = await account('e2ee');
        expect(await grant(recipient.id, f.machine.id, third.id, 'admin')).toMatchObject({ kind: 'saved', readiness: 'key_pending' });
        expect(await inTx(tx => access.readMachineRecipientCensusInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }))).toEqual({ kind: 'refused', code: 'access_denied' });
        expect(await inTx(tx => access.removeMachineAccessGrantInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id, principal: { kind: 'account', accountId: third.id } }))).toEqual({ kind: 'removed', effectiveAccess: 'none' });
        expect(await grant(recipient.id, f.machine.id, f.owner.id, 'admin')).toEqual({ kind: 'refused', code: 'custodian_protected' });
        const census = await inTx(tx => access.readMachineRecipientCensusInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id }));
        if ('kind' in census) throw new Error(census.code);
        const input = { actorAccountId: f.owner.id, machineId: f.machine.id, expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
            expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!, expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
            recipientKeyEnvelopes: [{ recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: f.key, recipientPublicKey: recipient.keys.publicKey, randomBytes: tweetnacl.randomBytes })), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipient.keys.publicKey) }] };
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input))).toMatchObject({ appliedRecipientAccountIds: [recipient.id] });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id })).toMatchObject({ kind: 'admitted', role: 'manage' });
        const opening = await admittedOpening();
        expect(opening?.access).toMatchObject({ role: 'use', accessState: 'ready' });
        expect(encodeBase64(opening!.callerDataEncryptionKey!)).toBe(input.recipientKeyEnvelopes[0].encryptedDataKey);
        const foreignCensus = await inTx(tx => access.readMachineRecipientCensusInTx(tx, { actorAccountId: recipient.id, machineId: f.machine.id }));
        expect(foreignCensus).not.toHaveProperty('dataEncryptionKey');
        expect(foreignCensus).not.toHaveProperty('machineOwnerDataEncryptionKey');
        if ('kind' in foreignCensus) throw new Error(foreignCensus.code);
        expect(foreignCensus.callerDataEncryptionKey).toBe(input.recipientKeyEnvelopes[0].encryptedDataKey);
        expect(await grant(recipient.id, f.machine.id, third.id, 'admin')).toMatchObject({ kind: 'saved', readiness: 'key_pending' });
        const managerCommit = { ...input, actorAccountId: recipient.id, expectedCallerDataEncryptionKey: foreignCensus.callerDataEncryptionKey!,
            recipientKeyEnvelopes: [{ recipientAccountId: third.id, encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: f.key, recipientPublicKey: third.keys.publicKey, randomBytes: tweetnacl.randomBytes })), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(third.keys.publicKey) }] };
        await grant(f.owner.id, f.machine.id, recipient.id, 'view');
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, managerCommit))).toEqual({ kind: 'refused', code: 'access_denied' });
        expect(await db.machineKeyEnvelope.count({ where: { machineId: f.machine.id, recipientAccountId: third.id } })).toBe(0);
        await grant(f.owner.id, f.machine.id, recipient.id, 'admin');
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, managerCommit))).toMatchObject({ appliedRecipientAccountIds: [third.id] });
        expect(await access.resolveMachineAdmission({ actorAccountId: third.id, machineId: f.machine.id, requiredRole: 'manage' })).toMatchObject({ kind: 'admitted', role: 'manage', custodianAccountId: f.owner.id });
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, { ...input, expectedDaemonStateVersion: 99 }))).toEqual({ kind: 'refused', code: 'machine_key_changed' });
        await db.account.update({ where: { id: recipient.id }, data: createSignedAccountContentBinding() });
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input))).toEqual({ kind: 'refused', code: 'recipient_binding_changed' });
        expect(await access.resolveMachineAdmission({ actorAccountId: recipient.id, machineId: f.machine.id })).toEqual({ kind: 'denied', code: 'recipient_key_pending' });
        expect(await admittedOpening()).toMatchObject({ access: { accessState: 'key_pending' }, callerDataEncryptionKey: null });
        await db.machine.update({ where: { id: f.machine.id }, data: { dataEncryptionKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: f.owner.keys.publicKey, randomBytes: tweetnacl.randomBytes })) } });
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input))).toEqual({ kind: 'refused', code: 'machine_key_changed' });
    });

    it('set-acquires recipient material while preserving exception paging and all-before-write refusal', async () => {
        const f = await fixture('e2ee');
        const recipients = (await Promise.all(Array.from({ length: 13 }, () => account('e2ee')))).sort((a, b) => a.id.localeCompare(b.id));
        await db.machineAccountGrant.createMany({ data: recipients.map(recipient => ({ machineId: f.machine.id,
            accountId: recipient.id, accessLevel: 'view', createdByAccountId: f.owner.id })) });
        const actor = { actorAccountId: f.owner.id, machineId: f.machine.id };
        const read = (cursor?: string, state: 'all' | 'action_required' = 'action_required') => inTx(async tx => {
            const observed = observePrismaReads(tx, ['account', 'machineKeyEnvelope']);
            // Observe the real relational acquisition as well as any duplicate
            // model reads: paging exceptions must not rescan per page chunk.
            let audienceQueries = 0;
            const traced = new Proxy(observed.tx, { get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property !== '$queryRawUnsafe') return typeof value === 'function' ? value.bind(target) : value;
                return (...args: unknown[]) => {
                    audienceQueries++;
                    return Reflect.apply(value, target, args);
                };
            } });
            const value = await access.readMachineRecipientCensusInTx(traced, { ...actor, query: { limit: 2, state, ...(cursor ? { cursor } : {}) } });
            if ('kind' in value) throw new Error(value.code);
            return { value, reads: observed.reads, audienceQueries };
        });
        const first = await read();
        expect(first.value.recipients.map(row => row.recipientAccountId)).toEqual(recipients.slice(0, 2).map(row => row.id));
        const pages = [first];
        while (pages[pages.length - 1].value.nextCursor) pages.push(await read(pages[pages.length - 1].value.nextCursor!));
        expect(pages.flatMap(page => page.value.recipients).map(row => row.recipientAccountId))
            .toEqual(recipients.map(row => row.id));
        const entries = recipients.map(recipient => ({ recipientAccountId: recipient.id,
            encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: f.key,
                recipientPublicKey: recipient.keys.publicKey, randomBytes: tweetnacl.randomBytes })),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipient.keys.publicKey) }));
        const input = { ...actor, expectedMachineOwnerEnvelopeFingerprint: first.value.machineOwnerEnvelopeFingerprint!,
            expectedCallerDataEncryptionKey: first.value.callerDataEncryptionKey!, expectedMetadataVersion: first.value.content.metadataVersion,
            expectedDaemonStateVersion: first.value.content.daemonStateVersion, recipientKeyEnvelopes: entries };
        const committed = await inTx(async tx => {
            const observed = observePrismaReads(tx, ['account']);
            const value = await access.commitMachineRecipientKeyEnvelopesInTx(observed.tx, input);
            return { value, reads: observed.reads };
        });
        expect(committed.value).toEqual({ appliedRecipientAccountIds: recipients.map(row => row.id), skippedRecipientAccountIds: [] });
        const healthy = await read();
        expect(healthy.value).toMatchObject({ recipients: [], nextCursor: null });
        const all = await read(undefined, 'all');
        expect(all.value.recipients.map(row => row.encryptedDataKey)).toEqual(entries.slice(0, 2).map(row => row.encryptedDataKey));
        const sparse = [3, 7, 8, 11].map(index => recipients[index].id);
        await db.machineKeyEnvelope.deleteMany({ where: { machineId: f.machine.id, recipientAccountId: { in: sparse } } });
        const sparseFirst = await read();
        const sparseLast = await read(sparseFirst.value.nextCursor!);
        expect([...sparseFirst.value.recipients, ...sparseLast.value.recipients].map(row => row.recipientAccountId)).toEqual(sparse);
        expect(sparseLast.value.nextCursor).toBeNull();
        await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input));
        const healthyTailExceptions = [0, 1, 11, 12].map(index => recipients[index].id);
        await db.machineKeyEnvelope.deleteMany({ where: { machineId: f.machine.id, recipientAccountId: { in: healthyTailExceptions } } });
        const healthyTail = await read();
        const healthyTailLast = await read(healthyTail.value.nextCursor!);
        expect([...healthyTail.value.recipients, ...healthyTailLast.value.recipients].map(row => row.recipientAccountId)).toEqual(healthyTailExceptions);
        expect(healthyTailLast.value.nextCursor).toBeNull();
        // A later stale binding must prevent even earlier valid entries from being written.
        await db.machineKeyEnvelope.deleteMany({ where: { machineId: f.machine.id } });
        await db.account.update({ where: { id: recipients[4].id }, data: createSignedAccountContentBinding() });
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input)))
            .toEqual({ kind: 'refused', code: 'recipient_binding_changed' });
        expect(await db.machineKeyEnvelope.count({ where: { machineId: f.machine.id } })).toBe(0);
        await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: f.machine.id, accountId: recipients[4].id } } });
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, input)))
            .toEqual({ kind: 'refused', code: 'access_denied' });
        expect(await db.machineKeyEnvelope.count({ where: { machineId: f.machine.id } })).toBe(0);
        for (const page of [...pages, healthy, all, sparseFirst, sparseLast, healthyTail, healthyTailLast]) {
            expect(page.audienceQueries).toBe(1);
            expect(page.reads).toEqual([]);
        }
        expect(committed.reads).toEqual(['account.findMany']);
    });

    it('preserves mixed Team member compatibility and key recoverability while allowing grant level edits', async () => {
        const f = await fixture('e2ee');
        const eligible = await account('e2ee');
        const incompatible = await account('plain');
        const unbound = await db.account.create({ data: { encryptionMode: 'e2ee', name: 'Unbound' } });
        const outsider = await account('e2ee');
        await db.account.update({ where: { id: eligible.id }, data: { name: 'Eligible' } });
        await db.account.update({ where: { id: incompatible.id }, data: { name: 'Plain member' } });
        const team = await db.team.create({ data: { name: 'Mixed Team' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: f.owner.id, role: 'member' } });
        const principal = { kind: 'team' as const, teamId: team.id };
        for (const accountId of [eligible.id, incompatible.id, unbound.id]) {
            await db.teamMembership.create({ data: { teamId: team.id, accountId, role: 'member' } });
        }
        const actor = { actorAccountId: f.owner.id, machineId: f.machine.id };
        expect(await inTx(tx => access.setMachineAccessGrantInTx(tx, { ...actor, principal, level: 'view' })))
            .toMatchObject({ kind: 'saved', readiness: 'refused', canPrepareKeys: true });
        const list = () => inTx(tx => access.listMachineAccessGrantsInTx(tx, actor));
        const actorAccountIds = [f.owner.id, eligible.id, incompatible.id, unbound.id, outsider.id, eligible.id];
        const readAudience = () => inTx(tx => access.resolveMachineAccessForActorsInTx(tx, {
            machineId: f.machine.id, actorAccountIds,
        }));
        const pendingAudience = await readAudience();
        expect([...pendingAudience.keys()]).toEqual([...new Set(actorAccountIds)]);
        expect(pendingAudience.get(f.owner.id)).toMatchObject({ role: 'manage', accessState: 'ready', owned: true });
        expect(pendingAudience.get(eligible.id)).toMatchObject({ role: 'use', accessState: 'key_pending', reason: 'recipient_key_pending', canPrepareKeys: true });
        expect(pendingAudience.get(incompatible.id)).toMatchObject({ accessState: 'refused', reason: 'recipient_encryption_incompatible', canPrepareKeys: false });
        expect(pendingAudience.get(unbound.id)).toMatchObject({ accessState: 'key_pending', reason: 'encryption_material_unavailable', canPrepareKeys: false });
        expect(pendingAudience.get(outsider.id)).toBeNull();
        expect(await list()).toMatchObject({ canManage: true, grants: [{ readiness: 'refused', audience: expect.arrayContaining([
            { accountId: eligible.id, displayName: 'Eligible', readiness: 'key_pending', reason: 'recipient_key_pending', canPrepareKeys: true },
            { accountId: incompatible.id, displayName: 'Plain member', readiness: 'refused', reason: 'recipient_encryption_incompatible', canPrepareKeys: false },
            { accountId: unbound.id, displayName: 'Unbound', readiness: 'key_pending', reason: 'encryption_material_unavailable', canPrepareKeys: false },
        ]) }] });
        const census = await inTx(tx => access.readMachineRecipientCensusInTx(tx, actor));
        if ('kind' in census) throw new Error(census.code);
        await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, { ...actor,
            expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
            expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!,
            expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
            recipientKeyEnvelopes: [{ recipientAccountId: eligible.id,
                encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: f.key, recipientPublicKey: eligible.keys.publicKey, randomBytes: tweetnacl.randomBytes })),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(eligible.keys.publicKey) }],
        }));
        expect(await inTx(tx => access.setMachineAccessGrantInTx(tx, { ...actor, principal, level: 'admin' })))
            .toMatchObject({ kind: 'saved', grant: { level: 'admin' }, canPrepareKeys: false });
        expect(await list()).toMatchObject({ grants: [{ level: 'admin', audience: expect.arrayContaining([
            { accountId: eligible.id, displayName: 'Eligible', readiness: 'ready', reason: null, canPrepareKeys: false },
            { accountId: incompatible.id, displayName: 'Plain member', readiness: 'refused', reason: 'recipient_encryption_incompatible', canPrepareKeys: false },
        ]) }] });
        expect(await access.resolveMachineAdmission({ actorAccountId: eligible.id, machineId: f.machine.id, requiredRole: 'manage' }))
            .toMatchObject({ kind: 'admitted', role: 'manage' });
        expect(await access.resolveMachineAdmission({ actorAccountId: incompatible.id, machineId: f.machine.id }))
            .toEqual({ kind: 'denied', code: 'recipient_encryption_incompatible' });
        const own = await inTx(tx => access.listMachineAccessGrantsInTx(tx, { actorAccountId: unbound.id, machineId: f.machine.id }));
        expect(own).toMatchObject({ canManage: true });
        const readyAudience = await readAudience();
        expect(readyAudience.get(eligible.id)).toMatchObject({ role: 'manage', accessState: 'ready', reason: null, canPrepareKeys: false });
        expect(readyAudience.get(incompatible.id)).toMatchObject({ accessState: 'refused', reason: 'recipient_encryption_incompatible' });
        expect(readyAudience.get(unbound.id)).toMatchObject({ accessState: 'key_pending', reason: 'encryption_material_unavailable' });
        await db.machine.update({ where: { id: f.machine.id }, data: { revokedAt: new Date() } });
        const revokedAudience = await readAudience();
        expect(revokedAudience.get(f.owner.id)).toMatchObject({ accessState: 'ready', owned: true });
        for (const accountId of [eligible.id, incompatible.id, unbound.id, outsider.id]) expect(revokedAudience.get(accountId)).toBeNull();
        await inTx(async tx => {
            const observed = observePrismaReads(tx, ['machine']);
            expect(await access.resolveMachineAccessForActorsInTx(observed.tx, { machineId: f.machine.id, actorAccountIds: [] })).toEqual(new Map());
            expect(observed.reads).toEqual([]);
            expect(await access.resolveMachineAccessForActorsInTx(tx, { machineId: crypto.randomUUID(), actorAccountIds }))
                .toEqual(new Map([...new Set(actorAccountIds)].map(accountId => [accountId, null])));
        });
    });
});
