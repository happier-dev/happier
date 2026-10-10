import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '../../crypto/base64.js';
import { SessionActionRpcOriginV1Schema, WorkspaceSyncSourceRoutingV1Schema } from '../../rpc/socket.js';
import { ExternalActionExecutionAuthorizationV1Schema } from '../../actions/externalActionApi.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../../auth/apiTokenGrant.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { sealExternalActionRequestV2 } from '../../actions/externalActionEncryption.js';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '../../actions/externalActionExecutionAuthorization.js';
import {
    MachineInstallationIdentityV1Schema,
    MachineInstallationPublicKeySchema,
    MachineInstallationProofPayloadV1Schema,
    MachineInstallationProofV1Schema,
    buildMachineInstallationProofPayloadBytes,
    computeContentPublicKeyFingerprint,
    signMachineInstallationProof,
    verifyMachineInstallationProof,
} from './installationIdentity.js';

describe('machine installation identity protocol', () => {
    it.each([1, 2] as const)('retains the complete original Project envelope v%s in the existing physical SOURCE proof without inventing a Session', version => {
        const keys = tweetnacl.sign.keyPair();
        const homeId = `srv_${'a'.repeat(32)}`;
        const target = { kind: 'machine' as const, machineId: 'chosen-target' };
        const input = { serverId: homeId, machineId: target.machineId, source: { kind: 'workspace', workspaceId: 'source-ref' },
            materialization: { kind: 'sync', targetPath: '/child/target', workspaceAction: { kind: 'copy_once' } } };
        const originalActionEnvelope = version === 1 ? { v: 1 as const, requestId: 'original-open', target, input }
            : sealExternalActionRequestV2({ binding: { serverIdentityId: homeId, accountId: 'requester',
                credentialId: '11111111-1111-4111-8111-111111111111', actionId: 'projects.open', requestId: 'original-open', target },
                input, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(25) }, randomBytes: tweetnacl.randomBytes });
        const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'canonical-project-wire-root', binding: {
            accountId: 'requester', principalId: 'requester', credentialId: '11111111-1111-4111-8111-111111111111',
            grant: API_TOKEN_FULL_GRANT_V1, serverIdentityId: homeId, machineId: target.machineId,
            installationId: 'target-installation', custodianAccountId: 'target-custodian', actionId: 'projects.open',
            requestId: 'original-open', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope), target,
            accountEncryptionMode: version === 1 ? 'plain' : 'e2ee' } });
        const context = { actorAccountId: 'requester', custodianAccountId: 'source-custodian', machineId: 'source-child',
            installationId: 'source-installation', role: 'use' as const, encryptionMode: 'plain' as const };
        const workspaceSyncSourceRouting = { ...WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare',
            operationId: 'source-loan-independent-of-root', accountServerId: homeId, sourceMachineId: context.machineId,
            sourceRootPath: '/child/source', sourceContext: { machineAdmission: context, callerAuthority: 'account_automation' } }), originalActionEnvelope };
        const payload = { version: 1 as const, machineId: 'physical-writer', installationId: 'writer-installation', accountId: context.custodianAccountId,
            rpcAdmission: { context, method: `physical-writer:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`,
                workspaceSyncSourceRouting, callerInputAuthorization } };
        // The canonical builder, not handmade bytes, decides this new wire contract.
        expect(() => buildMachineInstallationProofPayloadBytes(payload)).not.toThrow();
        const proof = signMachineInstallationProof({ payload, privateKey: keys.secretKey });
        expect(verifyMachineInstallationProof({ payload, proof, publicKey: keys.publicKey })).toBe(true);
        const changed = { ...payload, rpcAdmission: { ...payload.rpcAdmission, workspaceSyncSourceRouting: {
            ...workspaceSyncSourceRouting, originalActionEnvelope: { ...originalActionEnvelope, requestId: 'substituted-open' } } } };
        expect(verifyMachineInstallationProof({ payload: changed, proof, publicKey: keys.publicKey })).toBe(false);
        expect(workspaceSyncSourceRouting).not.toHaveProperty('sourceSessionId');
        expect(callerInputAuthorization.binding).not.toHaveProperty('sessionActionOrigin');
        expect(workspaceSyncSourceRouting.operationId).not.toBe(callerInputAuthorization.binding.requestId);
    });
    it('binds the original installed TARGET packet adjacent to SOURCE routing in the existing installation proof', () => {
        const targetKey = tweetnacl.sign.keyPair();
        const writerKey = tweetnacl.sign.keyPair();
        // Canonical wire input only: the SQLite test separately proves genuine
        // Home issuance and current installed-D authentication.
        const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'wire-project-root', binding: {
            accountId: 'requester', principalId: 'requester', credentialId: '11111111-1111-4111-8111-111111111111',
            grant: API_TOKEN_FULL_GRANT_V1, serverIdentityId: `srv_${'a'.repeat(32)}`, machineId: 'chosen-target',
            installationId: 'target-installation', custodianAccountId: 'target-custodian', actionId: 'projects.open',
            requestId: 'root-request', requestEnvelopeDigest: 'b'.repeat(43), target: { kind: 'machine', machineId: 'chosen-target' } } });
        const context = { actorAccountId: 'requester', custodianAccountId: 'source-custodian', machineId: 'source-child',
            installationId: 'source-installation', role: 'use' as const, encryptionMode: 'plain' as const };
        const workspaceSyncSourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare',
            operationId: 'source-operation', accountServerId: callerInputAuthorization.binding.serverIdentityId,
            sourceMachineId: context.machineId, sourceRootPath: '/child/source',
            sourceContext: { machineAdmission: context, callerAuthority: 'account_automation' } });
        const method = `physical-writer:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
        const requestId = 'original-d-transport-request';
        const params = 'opaque-d-source-body';
        const signedRequest = { authorizationToken: callerInputAuthorization.token, effectActionId: 'projects.open',
            target: callerInputAuthorization.binding.target, installationId: 'target-installation', method, requestId, params,
            workspaceSyncSourceRouting };
        const externalActionExecution = { v: 1 as const, authorization: callerInputAuthorization, effectActionId: 'projects.open',
            target: callerInputAuthorization.binding.target, installationId: 'target-installation',
            machineSignature: signExternalActionMachineRpcRequestV1({ ...signedRequest, privateKey: targetKey.secretKey }) };
        const workspaceSyncSourceExecution = { method, requestId, params, externalActionExecution };
        const payload = { version: 1 as const, machineId: 'physical-writer', installationId: 'writer-installation', accountId: context.custodianAccountId,
            rpcAdmission: { context, method, workspaceSyncSourceRouting, callerInputAuthorization, workspaceSyncSourceExecution } };
        expect(() => buildMachineInstallationProofPayloadBytes(payload)).not.toThrow();
        const proof = signMachineInstallationProof({ payload, privateKey: writerKey.secretKey });
        expect(verifyMachineInstallationProof({ payload, proof, publicKey: writerKey.publicKey })).toBe(true);
        for (const packet of [
            { ...workspaceSyncSourceExecution, requestId: callerInputAuthorization.binding.requestId },
            { ...workspaceSyncSourceExecution, method: 'another-writer:materialize' },
            { ...workspaceSyncSourceExecution, params: 'another-source-body' },
            { ...workspaceSyncSourceExecution, externalActionExecution: { ...externalActionExecution, machineSignature: 'A'.repeat(86) } },
        ]) expect(verifyMachineInstallationProof({ payload: { ...payload, rpcAdmission: { ...payload.rpcAdmission,
            workspaceSyncSourceExecution: packet } }, proof, publicKey: writerKey.publicKey })).toBe(false);
        const { workspaceSyncSourceExecution: _packet, ...withoutPacket } = payload.rpcAdmission;
        expect(verifyMachineInstallationProof({ payload: { ...payload, rpcAdmission: withoutPacket }, proof, publicKey: writerKey.publicKey })).toBe(false);
        expect(MachineInstallationProofPayloadV1Schema.safeParse({ ...payload, rpcAdmission: { ...payload.rpcAdmission,
            workspaceSyncSourceExecution: { ...workspaceSyncSourceExecution, accountId: 'new-authority' } } }).success).toBe(false);
        expect(MachineInstallationProofPayloadV1Schema.safeParse({ ...payload, rpcAdmission: { ...payload.rpcAdmission,
            workspaceSyncSourceRouting: { ...workspaceSyncSourceRouting, workspaceSyncSourceExecution } } }).success).toBe(false);
        expect(MachineInstallationProofPayloadV1Schema.safeParse({ ...payload,
            rpcAdmission: { context, method: 'physical-writer:read', workspaceSyncSourceExecution } }).success).toBe(false);
        const targetContext = { machineAdmission: { ...context, machineId: 'chosen-target', installationId: 'target-installation',
            custodianAccountId: 'target-custodian' }, callerAuthority: 'account_automation' as const };
        const targetPhase = { v: 1 as const, phase: 'prepare' as const, operationId: 'target-operation',
            accountServerId: workspaceSyncSourceRouting.accountServerId, targetMachineId: 'chosen-target', targetRootPath: '/child/target' };
        const workspaceSyncSeedRouting = { v: 1 as const,
            sourceWriterTarget: { v: 1 as const, source: { ...workspaceSyncSourceRouting,
                sourceContext: { machineAdmission: context, callerAuthority: 'account_automation' as const } },
                target: targetPhase, sourceWriter: { machineId: 'physical-writer', installationId: 'writer-installation' } },
            target: { ...targetPhase, targetContext } };
        const seedPayload = { ...payload, machineId: 'physical-target', installationId: 'physical-target-installation', accountId: 'target-custodian',
            rpcAdmission: { context, method: `physical-writer:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`,
                callerInputAuthorization, workspaceSyncSourceExecution, workspaceSyncSeedRouting } };
        expect(() => buildMachineInstallationProofPayloadBytes(seedPayload)).not.toThrow();
        const seedProof = signMachineInstallationProof({ payload: seedPayload, privateKey: targetKey.secretKey });
        expect(verifyMachineInstallationProof({ payload: seedPayload, proof: seedProof, publicKey: targetKey.publicKey })).toBe(true);
        const changedSeedPayload = { ...seedPayload, rpcAdmission: { ...seedPayload.rpcAdmission,
            workspaceSyncSeedRouting: { ...workspaceSyncSeedRouting, target: { ...workspaceSyncSeedRouting.target,
                targetRootPath: '/child/other' } } } };
        expect(verifyMachineInstallationProof({ payload: changedSeedPayload, proof: seedProof, publicKey: targetKey.publicKey })).toBe(false);
        expect(MachineInstallationProofPayloadV1Schema.safeParse({ ...seedPayload, rpcAdmission: { ...seedPayload.rpcAdmission,
            workspaceSyncSeedRouting: { ...workspaceSyncSeedRouting, phase: 'release' } } }).success).toBe(false);
        expect(MachineInstallationProofPayloadV1Schema.safeParse({ ...seedPayload, rpcAdmission: { ...seedPayload.rpcAdmission,
            method: `physical-writer:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE}` } }).success).toBe(false);
    });
    it('binds the complete original handoff root in the existing physical SOURCE installation proof', () => {
        const keys = tweetnacl.sign.keyPair();
        // This is the canonical wire/crypto fixture, not a claim that this token
        // is Home-authenticated; the real issuer/HTTP test owns that boundary.
        const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-root', binding: {
            accountId: 'requester', principalId: 'requester', credentialId: '11111111-1111-4111-8111-111111111111',
            grant: { ...API_TOKEN_FULL_GRANT_V1, permissionModes: ['default'] }, serverIdentityId: `srv_${'a'.repeat(32)}`,
            machineId: 'source-child', installationId: 'child-installation', custodianAccountId: 'source-custodian',
            actionId: 'session.handoff', requestId: 'original-request', requestEnvelopeDigest: 'b'.repeat(43),
            target: { kind: 'machine', machineId: 'source-child' },
            handoffAdmission: { sessionId: 'moved-session', sourceMachineId: 'source-child', targetMachineId: 'chosen-target',
                sourceInstallationId: 'child-installation', targetInstallationId: 'target-installation' },
        } });
        const context = { actorAccountId: 'requester', custodianAccountId: 'source-custodian', machineId: 'source-child',
            installationId: 'child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
        const workspaceSyncSourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: 'source-loan',
            accountServerId: callerInputAuthorization.binding.serverIdentityId, sourceMachineId: context.machineId,
            sourceRootPath: '/child/source', sourceSessionId: 'moved-session', sourceContext: { machineAdmission: context,
                callerAuthority: 'account_automation', callerInputConstraints: { models: null, permissionModes: ['default'] } } });
        const payload = { version: 1 as const, machineId: 'physical-writer', installationId: 'writer-installation', accountId: context.custodianAccountId,
            rpcAdmission: { context, method: `physical-writer:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`,
                workspaceSyncSourceRouting, callerInputAuthorization } };
        expect(() => buildMachineInstallationProofPayloadBytes(payload)).not.toThrow();
        const proof = signMachineInstallationProof({ payload, privateKey: keys.secretKey });
        expect(verifyMachineInstallationProof({ payload, proof, publicKey: keys.publicKey })).toBe(true);
        if (!('grant' in callerInputAuthorization.binding)) throw new Error('Canonical PAT root grant required');
        for (const changedRoot of [
            { ...callerInputAuthorization, token: 'substituted-root' },
            { ...callerInputAuthorization, binding: { ...callerInputAuthorization.binding, accountId: 'another-requester' } },
            { ...callerInputAuthorization, binding: { ...callerInputAuthorization.binding, target: { kind: 'machine' as const, machineId: 'physical-writer' } } },
            { ...callerInputAuthorization, binding: { ...callerInputAuthorization.binding, requestEnvelopeDigest: 'c'.repeat(43) } },
            { ...callerInputAuthorization, binding: { ...callerInputAuthorization.binding,
                grant: { ...callerInputAuthorization.binding.grant, permissionModes: null } } },
        ]) {
            const changed = { ...payload, rpcAdmission: { ...payload.rpcAdmission, callerInputAuthorization: changedRoot } };
            expect(verifyMachineInstallationProof({ payload: changed, proof, publicKey: keys.publicKey })).toBe(false);
        }
        const { callerInputAuthorization: _root, ...withoutRoot } = payload.rpcAdmission;
        expect(verifyMachineInstallationProof({ payload: { ...payload, rpcAdmission: withoutRoot }, proof, publicKey: keys.publicKey })).toBe(false);
        expect(MachineInstallationProofPayloadV1Schema.safeParse({ ...payload,
            rpcAdmission: { context, method: 'source-child:read', callerInputAuthorization } }).success).toBe(false);
        expect(MachineInstallationProofPayloadV1Schema.safeParse({ ...payload,
            rpcAdmission: { context, purpose: { kind: 'requester_session_currentness', sessionId: 'moved-session' }, callerInputAuthorization } }).success).toBe(false);
    });
    it('binds requester Session currentness without granting a declared RPC method', () => {
        const keys = tweetnacl.sign.keyPair();
        const context = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
            installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
        const raw = { version: 1, installationId: 'installation', machineId: 'machine', accountId: 'alice',
            rpcAdmission: { context, purpose: { kind: 'requester_session_currentness', sessionId: 'bob-session' } } };
        const parsed = MachineInstallationProofPayloadV1Schema.safeParse(raw);
        expect(parsed.success).toBe(true);
        if (!parsed.success) throw new Error('Requester Session currentness must have an installation-signed purpose');
        const proof = signMachineInstallationProof({ payload: parsed.data, privateKey: keys.secretKey });
        expect(verifyMachineInstallationProof({ payload: parsed.data, proof, publicKey: keys.publicKey })).toBe(true);
        const changed = MachineInstallationProofPayloadV1Schema.parse({ ...raw,
            rpcAdmission: { ...raw.rpcAdmission, purpose: { ...raw.rpcAdmission.purpose, sessionId: 'different-session' } } });
        expect(verifyMachineInstallationProof({ payload: changed, proof, publicKey: keys.publicKey })).toBe(false);
        for (const extras of [{ method: 'machine:spawn-happy-session' }, { custodySubjectAccountId: 'bob' },
            { managedTarget: { homeId: 'home', managedId: 'managed', expectedRevision: 1,
                controller: { machineId: 'machine', installationId: 'installation' } } }]) {
            expect(MachineInstallationProofPayloadV1Schema.safeParse({ ...raw,
                rpcAdmission: { ...raw.rpcAdmission, ...extras } }).success).toBe(false);
        }
    });
    it('binds the actual Session Action origin to its exact installed controller and original acquisition envelope', () => {
        const keys = tweetnacl.sign.keyPair();
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: 'source', starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'turn',
            callerPermissionMode: 'safe-yolo', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'safe-yolo' },
            workspaceWrites: 'deny', requestId: 'original-request' });
        const payload = { version: 1 as const, machineId: 'controller', installationId: 'installation', accountId: 'requester',
            externalActionOrigin: { homeId: 'srv_home', actionId: 'machines.managed.acquire', requestId: 'original-request',
                requestEnvelopeDigest: 'a'.repeat(43), origin } };
        expect(MachineInstallationProofPayloadV1Schema.safeParse(payload).success).toBe(true);
        const proof = signMachineInstallationProof({ payload, privateKey: keys.secretKey });
        expect(verifyMachineInstallationProof({ payload, proof, publicKey: keys.publicKey })).toBe(true);
        for (const changed of [{ homeId: 'srv_other' }, { actionId: 'session.spawn_new' }, { requestId: 'another-request' },
            { requestEnvelopeDigest: 'b'.repeat(43) }, { origin: { ...origin, sourceTurnId: 'later-turn' } },
            { origin: { ...origin, causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const } } },
            { origin: { ...origin, caller: { ...origin.caller, turnDepth: 0 } } },
            { origin: { ...origin, workspaceWrites: 'allow' as const } }]) {
            expect(verifyMachineInstallationProof({ payload: { ...payload,
                externalActionOrigin: { ...payload.externalActionOrigin, ...changed } }, proof, publicKey: keys.publicKey })).toBe(false);
        }
        expect(verifyMachineInstallationProof({ payload: { ...payload, installationId: 'replacement' }, proof, publicKey: keys.publicKey })).toBe(false);
        expect(verifyMachineInstallationProof({ payload: { ...payload, machineId: 'another-controller' }, proof, publicKey: keys.publicKey })).toBe(false);
        expect(verifyMachineInstallationProof({ payload: { ...payload, accountId: 'another-requester' }, proof, publicKey: keys.publicKey })).toBe(false);
        expect(MachineInstallationProofPayloadV1Schema.safeParse({ ...payload,
            externalActionOrigin: { ...payload.externalActionOrigin, rawContext: {} } }).success).toBe(false);
        const { accountId: _requester, ...withoutRequester } = payload;
        expect(MachineInstallationProofPayloadV1Schema.safeParse(withoutRequester).success).toBe(false);
        expect(MachineInstallationProofPayloadV1Schema.safeParse({ ...payload,
            externalActionOrigin: { ...payload.externalActionOrigin,
                origin: { ...origin, requestId: 'different-origin-request' } } }).success).toBe(false);
    });
    it('binds committed guest idle evidence before automatic retention submission', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const context = { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'guest', installationId: 'guest-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
        const managedTarget = { homeId: 'home', managedId: 'retained', expectedRevision: 2, controller: { machineId: 'controller', installationId: 'controller-installation' } };
        const payload = { version: 1 as const, installationId: context.installationId, machineId: context.machineId, accountId: 'alice', rpcAdmission: { context, method: 'guest:managed.admission.drain.confirm', managedTarget, managedIdleDecision: { kind: 'idle' as const, since: 10, confirmedAt: 30 } } };
        const proof = signMachineInstallationProof({ payload, privateKey: keyPair.secretKey });
        expect(verifyMachineInstallationProof({ payload, proof, publicKey: keyPair.publicKey })).toBe(true);
        expect(verifyMachineInstallationProof({ payload: { ...payload, rpcAdmission: { ...payload.rpcAdmission, managedIdleDecision: { ...payload.rpcAdmission.managedIdleDecision, since: 0 } } }, proof, publicKey: keyPair.publicKey })).toBe(false);
    });
    it('binds exact managed currentness in the existing guest installation proof', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const context = { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'guest', installationId: 'guest-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
        const managedTarget = { homeId: 'home', managedId: 'retained', expectedRevision: 2, controller: { machineId: 'controller', installationId: 'controller-installation' } };
        const payload = { version: 1 as const, installationId: context.installationId, machineId: context.machineId, accountId: 'alice', rpcAdmission: { context, method: 'guest:managed.activity.read', managedTarget } };
        const proof = signMachineInstallationProof({ payload, privateKey: keyPair.secretKey });
        expect(verifyMachineInstallationProof({ payload, proof, publicKey: keyPair.publicKey })).toBe(true);
        for (const changed of [{ managedId: 'other' }, { expectedRevision: 3 }, { controller: { ...managedTarget.controller, installationId: 'replacement' } }]) {
            expect(verifyMachineInstallationProof({ payload: { ...payload, rpcAdmission: { ...payload.rpcAdmission, managedTarget: { ...managedTarget, ...changed } } }, proof, publicKey: keyPair.publicKey })).toBe(false);
        }
    });
    it('binds the access-loss subject in the existing installation proof', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const context = { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'machine',
            installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
        const payload = { version: 1 as const, installationId: 'installation', machineId: 'machine', accountId: 'alice',
            rpcAdmission: { context, method: 'machine:daemon.machineAccessLoss', custodySubjectAccountId: 'bob' } };
        const proof = signMachineInstallationProof({ payload, privateKey: keyPair.secretKey });
        expect(verifyMachineInstallationProof({ payload, proof, publicKey: keyPair.publicKey })).toBe(true);
        expect(verifyMachineInstallationProof({ payload: { ...payload,
            rpcAdmission: { ...payload.rpcAdmission, custodySubjectAccountId: 'cara' } }, proof,
            publicKey: keyPair.publicKey })).toBe(false);
    });
    it('rejects unknown routing fields rather than dropping them before signing', () => {
        expect(MachineInstallationProofPayloadV1Schema.safeParse({ version: 1, machineId: 'machine',
            installationId: 'installation', actorAccountId: 'forged' }).success).toBe(false);
    });
    it('binds requester, custodian, installation and method for final Machine admission', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const context = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
            installationId: 'installation', role: 'use' as const, encryptionMode: 'e2ee' as const };
        const payload = { version: 1 as const, installationId: 'installation', machineId: 'machine', accountId: 'alice',
            rpcAdmission: { context, method: 'machine:spawn-happy-session' } };
        const proof = signMachineInstallationProof({ payload, privateKey: keyPair.secretKey });
        expect(verifyMachineInstallationProof({ payload, proof, publicKey: keyPair.publicKey })).toBe(true);
        for (const contextChange of [
            { actorAccountId: 'cara' }, { custodianAccountId: 'bob' }, { machineId: 'other' },
            { installationId: 'replacement' }, { role: 'manage' as const }, { encryptionMode: 'plain' as const },
        ]) {
            expect(verifyMachineInstallationProof({
                payload: { ...payload, rpcAdmission: { ...payload.rpcAdmission, context: { ...context, ...contextChange } } },
                proof, publicKey: keyPair.publicKey,
            })).toBe(false);
        }
        expect(verifyMachineInstallationProof({ payload: { ...payload,
            rpcAdmission: { ...payload.rpcAdmission, method: 'machine:stop-daemon' } }, proof, publicKey: keyPair.publicKey })).toBe(false);
        expect(MachineInstallationProofPayloadV1Schema.safeParse({ ...payload,
            rpcAdmission: { ...payload.rpcAdmission, context: { ...context, canManage: true } } }).success).toBe(false);
    });

    it('rejects a forged proof and public-key admission for an Ed25519 identity point', () => {
        const identityPoint = new Uint8Array(32);
        identityPoint[0] = 1;
        const forgedSignature = new Uint8Array(64);
        forgedSignature[0] = 1;
        const publicKey = encodeBase64(identityPoint, 'base64url');
        const params = {
            payload: { version: 1, installationId: 'installation', machineId: 'machine', accountId: 'account' },
            proof: { version: 1, algorithm: 'ed25519', signature: encodeBase64(forgedSignature, 'base64url') },
        } as const;
        expect(verifyMachineInstallationProof({ ...params, publicKey })).toBe(false);
        expect(verifyMachineInstallationProof({ ...params, publicKey: identityPoint })).toBe(false);
        expect(MachineInstallationPublicKeySchema.safeParse(publicKey).success).toBe(false);
    });

    it('validates persisted installation key material lengths at parse time', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const valid = {
            version: 1,
            installationId: 'installation-1',
            createdAt: 1,
            publicKey: encodeBase64(keyPair.publicKey, 'base64url'),
            privateKey: encodeBase64(keyPair.secretKey, 'base64url'),
        };

        expect(MachineInstallationIdentityV1Schema.safeParse(valid).success).toBe(true);
        expect(MachineInstallationIdentityV1Schema.safeParse({
            ...valid,
            publicKey: encodeBase64(new Uint8Array(tweetnacl.sign.publicKeyLength - 1), 'base64url'),
        }).success).toBe(false);
        expect(MachineInstallationIdentityV1Schema.safeParse({
            ...valid,
            privateKey: encodeBase64(new Uint8Array(tweetnacl.sign.secretKeyLength - 1), 'base64url'),
        }).success).toBe(false);
    });

    it('builds deterministic proof payload bytes independent of input key order', () => {
        const left = buildMachineInstallationProofPayloadBytes({
            version: 1,
            installationId: 'installation-1',
            machineId: 'machine-1',
            accountId: 'account-1',
            contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
            replacesMachineId: 'machine-old',
            replacementReason: 'reauth',
        });
        const right = buildMachineInstallationProofPayloadBytes({
            machineId: 'machine-1',
            replacesMachineId: 'machine-old',
            replacementReason: 'reauth',
            contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
            accountId: 'account-1',
            installationId: 'installation-1',
            version: 1,
        });

        expect(new TextDecoder().decode(left)).toBe(new TextDecoder().decode(right));
        expect(new TextDecoder().decode(left)).toBe(JSON.stringify({
            version: 1,
            installationId: 'installation-1',
            machineId: 'machine-1',
            replacesMachineId: 'machine-old',
            replacementReason: 'reauth',
            contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
            accountId: 'account-1',
        }));
    });

    it('verifies proof signatures and rejects changed bound fields', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const payload = MachineInstallationProofPayloadV1Schema.parse({
            version: 1,
            installationId: 'installation-1',
            machineId: 'machine-1',
            replacesMachineId: 'machine-old',
            replacementReason: 'reauth',
            contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
            accountId: 'account-1',
        });
        const proof = MachineInstallationProofV1Schema.parse(signMachineInstallationProof({
            payload,
            privateKey: keyPair.secretKey,
        }));
        const publicKey = encodeBase64(keyPair.publicKey, 'base64url');

        expect(verifyMachineInstallationProof({ payload, proof, publicKey })).toBe(true);
        expect(verifyMachineInstallationProof({ payload: { ...payload, machineId: 'machine-2' }, proof, publicKey })).toBe(false);
        expect(verifyMachineInstallationProof({ payload: { ...payload, replacesMachineId: 'machine-other' }, proof, publicKey })).toBe(false);
        expect(verifyMachineInstallationProof({ payload: { ...payload, replacementReason: 'rotation' }, proof, publicKey })).toBe(false);
    });

    it('validates proof signatures as unpadded base64url encoded Ed25519 signatures', () => {
        const validSignature = encodeBase64(new Uint8Array(tweetnacl.sign.signatureLength), 'base64url');

        expect(MachineInstallationProofV1Schema.safeParse({
            version: 1,
            algorithm: 'ed25519',
            signature: validSignature,
        }).success).toBe(true);
        expect(MachineInstallationProofV1Schema.safeParse({
            version: 1,
            algorithm: 'ed25519',
            signature: `+${validSignature.slice(1)}`,
        }).success).toBe(false);
        expect(MachineInstallationProofV1Schema.safeParse({
            version: 1,
            algorithm: 'ed25519',
            signature: encodeBase64(new Uint8Array(tweetnacl.sign.signatureLength - 1), 'base64url'),
        }).success).toBe(false);
    });

    it('strictly validates string keys passed to proof helpers before decoding them', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const payload = MachineInstallationProofPayloadV1Schema.parse({
            version: 1,
            installationId: 'installation-1',
            machineId: 'machine-1',
            replacesMachineId: 'machine-old',
            replacementReason: 'reauth',
            accountId: 'account-1',
        });
        const privateKey = encodeBase64(keyPair.secretKey, 'base64url');
        const publicKey = encodeBase64(keyPair.publicKey, 'base64url');
        const proof = signMachineInstallationProof({ payload, privateKey });

        expect(verifyMachineInstallationProof({ payload, proof, publicKey })).toBe(true);
        expect(() => signMachineInstallationProof({ payload, privateKey: `+${privateKey.slice(1)}` })).toThrow(/base64url/i);
        expect(verifyMachineInstallationProof({ payload, proof, publicKey: `/${publicKey.slice(1)}` })).toBe(false);
    });

    it('returns false instead of throwing for invalid verification payloads', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const payload = MachineInstallationProofPayloadV1Schema.parse({
            version: 1,
            installationId: 'installation-1',
            machineId: 'machine-1',
            accountId: 'account-1',
        });
        const proof = signMachineInstallationProof({ payload, privateKey: keyPair.secretKey });
        const publicKey = encodeBase64(keyPair.publicKey, 'base64url');

        expect(verifyMachineInstallationProof({
            payload: {
                ...payload,
                contentPublicKeyFingerprint: 'content-public-key-sha256:not-valid',
            },
            proof,
            publicKey,
        })).toBe(false);
    });

    it('computes a stable account keyspace fingerprint without treating it as installation identity', () => {
        const fingerprint = computeContentPublicKeyFingerprint(new Uint8Array([1, 2, 3, 4]));

        expect(fingerprint).toMatch(/^content-public-key-sha256:[a-f0-9]{64}$/u);
        expect(computeContentPublicKeyFingerprint(new Uint8Array([1, 2, 3, 4]))).toBe(fingerprint);
        expect(computeContentPublicKeyFingerprint(new Uint8Array([4, 3, 2, 1]))).not.toBe(fingerprint);
    });
});
