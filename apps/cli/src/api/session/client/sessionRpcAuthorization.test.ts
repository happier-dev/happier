import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_TOKEN_FULL_GRANT_V1, FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionFailureCauseV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionTransferRpcMethodV1Schema } from '@happier-dev/protocol/socketRpc';
import type { MachineInstallationIdentityV1 } from '@happier-dev/protocol';
import { readdir } from 'node:fs/promises';
import { withTempDir } from '@/testkit/fs/tempDir';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';

describe('installed Session API-root authorization diagnostics', () => {
    let home: string;
    let identityPath: string;
    let installation: MachineInstallationIdentityV1;
    let createSessionRpcAuthorization: typeof import('./sessionRpcAuthorization').createSessionRpcAuthorization;
    let RpcHandlerManager: typeof import('@/api/rpc/RpcHandlerManager').RpcHandlerManager;
    beforeAll(async () => {
        home = mkdtempSync(join(tmpdir(), 'session-rpc-authorization-'));
        vi.stubEnv('HAPPIER_HOME_DIR', home);
        vi.resetModules();
        const { configuration } = await import('@/configuration');
        identityPath = configuration.installationIdentityFile;
        installation = await (await import('@/daemon/identity/store')).readOrCreateInstallationIdentity();
        ({ createSessionRpcAuthorization } = await import('./sessionRpcAuthorization'));
        ({ RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager'));
    });
    afterEach(() => { vi.restoreAllMocks(); });
    afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); rmSync(home, { recursive: true, force: true }); });

    function setup() {
        const state = { closed: false, machineId: 'never-log-machine', homeId: 'srv_session_diagnostic' };
        // Only Home HTTP and feature discovery are replaced; signing, identity storage,
        // origin resolution, admission and RPC failure projection are production code.
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(
            FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: state.homeId } } }),
        ), { status: 200 }));
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'never-log-root', binding: {
            accountId: 'never-log-requester', custodianAccountId: 'never-log-owner', principalId: 'never-log-requester',
            credentialId: 'never-log-credential', grant: API_TOKEN_FULL_GRANT_V1, accountEncryptionMode: 'plain',
            serverIdentityId: state.homeId, machineId: state.machineId, installationId: installation.installationId,
            actionId: 'session.agent.transition', requestId: 'never-log-request', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: state.machineId },
        } });
        const authorize = createSessionRpcAuthorization({ sessionId: 'session', get localMachineId() { return state.machineId; },
            serverUrl: 'https://session-diagnostic.test', isClosed: () => state.closed,
            readHomeServerIdentityId: () => state.homeId, readOwnerCredentials: async () => null });
        const request = { method: `session:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`, params: {},
            callerAuthority: 'account_automation' as const, callerInputAuthorization: authorization };
        return { state, fetch, post, authorize, request };
    }

    it.each(['closed', 'aborted', 'installation_missing', 'origin_unavailable', 'installation_mismatch',
        'machine_mismatch', 'home_mismatch', 'currentness_rejected'] as const)('names %s without disclosing root or identity', async reason => {
        const { state, fetch, post, authorize, request } = setup();
        const original = readFileSync(identityPath);
        const controller = new AbortController();
        if (reason === 'closed') state.closed = true;
        if (reason === 'aborted') controller.abort(new Error('never-log-cancellation'));
        if (reason === 'installation_missing') rmSync(identityPath);
        if (reason === 'origin_unavailable') fetch.mockResolvedValue(new Response('', { status: 404 }));
        if (reason === 'installation_mismatch') request.callerInputAuthorization.binding.installationId = 'never-log-other-installation';
        if (reason === 'machine_mismatch') state.machineId = 'never-log-other-machine';
        if (reason === 'home_mismatch') state.homeId = 'srv_other_home';
        if (reason === 'currentness_rejected') post.mockResolvedValue({ status: 403, data: { error: 'never-log-body' } });
        try {
            const result = await authorize({ ...request, signal: controller.signal });
            expect(result).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN', failureCause: {
                phase: `session.rpc.authorization.${reason}`, errorClass: 'Error', errorCode: 'RPC_FORBIDDEN', httpStatus: null,
            } });
            expect(JSON.stringify(result)).not.toMatch(/never-log|srv_other_home|srv_session_diagnostic/);
            if (!result.ok && 'failureCause' in result) expect(ActionFailureCauseV1Schema.safeParse(result.failureCause).success).toBe(true);
        } finally { writeFileSync(identityPath, original); }
    });

    it('projects a thrown identity read failure without including the identity path or parse input', async () => {
        const { authorize, request } = setup();
        const original = readFileSync(identityPath);
        writeFileSync(identityPath, 'never-log-corrupt-identity');
        try {
            const result = await authorize(request);
            expect(result).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN', failureCause: {
                phase: 'session.rpc.authorization.unavailable', errorClass: 'Error', errorCode: null, httpStatus: null,
            } });
            expect(JSON.stringify(result)).not.toContain('never-log');
            expect(JSON.stringify(result)).not.toContain(home);
        } finally { writeFileSync(identityPath, original); }
    });

    it('keeps a legitimate API root admitted and carries a later refusal through the real RPC manager', async () => {
        const { authorize, request, post } = setup();
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', scopeKind: 'session', localMachineId: 'never-log-machine',
            encryptionMode: 'plain', authorizeRequest: authorize, logger: () => {} });
        let effects = 0;
        rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, () => { effects += 1; return { ok: true }; });
        expect(await rpc.handleRequest(request)).toMatchObject({ ok: true });
        expect(effects).toBe(1);
        post.mockResolvedValue({ status: 403, data: { error: 'never-log-body' } });
        const refused = await rpc.handleRequest(request);
        expect(refused).toMatchObject({ errorCode: 'RPC_FORBIDDEN', effectAttempted: false,
            failureCause: { phase: 'session.rpc.authorization.currentness_rejected', errorCode: 'RPC_FORBIDDEN' } });
        expect(effects).toBe(1);
        expect(JSON.stringify(refused)).not.toContain('never-log');
    });

    it.each(['requester_authority_unavailable', 'unrestricted_owner_required', 'installation_missing',
        'owner_credentials_missing', 'currentness_rejected', 'requester_execution_unavailable'] as const)(
        'names raw requester execution refusal %s before its handler runs', async reason => {
            const { state, post } = setup();
            post.mockResolvedValue({ status: 200, data: { v: 1, ok: true } });
            const original = readFileSync(identityPath);
            const authorize = createSessionRpcAuthorization({ sessionId: 'session', localMachineId: state.machineId,
                serverUrl: 'https://session-diagnostic.test', isClosed: () => state.closed,
                readHomeServerIdentityId: () => state.homeId,
                readOwnerCredentials: async () => reason === 'owner_credentials_missing'
                    ? null : { token: 'never-log-owner-token', encryption: null } });
            const rpc = new RpcHandlerManager({ scopePrefix: 'session', scopeKind: 'session', localMachineId: state.machineId,
                encryptionMode: 'plain', authorizeRequest: authorize, logger: () => {} });
            let effects = 0;
            rpc.registerHandler(RPC_METHODS.WRITE_FILE, () => { effects += 1; return { ok: true }; });
            if (reason === 'installation_missing') rmSync(identityPath);
            if (reason === 'requester_execution_unavailable') writeFileSync(identityPath, 'never-log-corrupt-identity');
            if (reason === 'currentness_rejected') post.mockResolvedValue({ status: 403, data: { error: 'never-log-body' } });
            const request = { method: `session:${RPC_METHODS.WRITE_FILE}`, params: {}, callerAuthority: 'present_user' as const,
                ...(reason === 'requester_authority_unavailable' ? {} : { machineAdmission: {
                    actorAccountId: reason === 'unrestricted_owner_required' ? 'never-log-other' : 'never-log-owner',
                    custodianAccountId: 'never-log-owner', machineId: state.machineId,
                    installationId: installation.installationId, role: 'use' as const, encryptionMode: 'plain' as const,
                } }) };
            try {
                const ownerResult = await authorize(request);
                expect(ownerResult).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable', effectAttempted: false,
                    failureCause: { phase: `session.rpc.authorization.${reason}`, errorClass: 'Error', errorCode: null, httpStatus: null } });
                const result = await rpc.handleRequest(request);
                expect(result).toMatchObject({ errorCode: 'agent_isolation_unavailable', effectAttempted: false,
                    failureCause: { phase: `session.rpc.authorization.${reason}`, errorClass: 'Error', errorCode: null, httpStatus: null } });
                expect(effects).toBe(0);
                expect(post).toHaveBeenCalledTimes(reason === 'currentness_rejected' ? 2 : 0);
                expect(JSON.stringify([ownerResult, result])).not.toMatch(/never-log|srv_session_diagnostic/);
                expect(JSON.stringify([ownerResult, result])).not.toContain(home);
            } finally { writeFileSync(identityPath, original); }
        });

    it('admits a current raw owner through the real manager with one Home verification', async () => {
        const { state, post } = setup();
        post.mockResolvedValue({ status: 200, data: { v: 1, ok: true } });
        const authorize = createSessionRpcAuthorization({ sessionId: 'session', localMachineId: state.machineId,
            serverUrl: 'https://session-diagnostic.test', isClosed: () => false,
            readHomeServerIdentityId: () => state.homeId,
            readOwnerCredentials: async () => ({ token: 'never-log-owner-token', encryption: null }) });
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', scopeKind: 'session', localMachineId: state.machineId,
            encryptionMode: 'plain', authorizeRequest: authorize, logger: () => {} });
        let effects = 0;
        rpc.registerHandler(RPC_METHODS.WRITE_FILE, () => { effects += 1; return { ok: true }; });
        expect(await rpc.handleRequest({ method: `session:${RPC_METHODS.WRITE_FILE}`, params: {}, callerAuthority: 'present_user',
            machineAdmission: { actorAccountId: 'never-log-owner', custodianAccountId: 'never-log-owner', machineId: state.machineId,
                installationId: installation.installationId, role: 'use', encryptionMode: 'plain' } })).toMatchObject({ ok: true });
        expect(effects).toBe(1);
        expect(post).toHaveBeenCalledTimes(1);
    });

    function setupAttachmentRequester() {
        const { state, post, fetch } = setup();
        const requester = { sessionId: 'session', homeServerIdentityId: state.homeId,
            identity: { kind: 'isolated' as const, separationRequired: true,
                requester: { serverId: 'saved-home-profile', accountId: 'never-log-member',
                    machineId: state.machineId, installationId: installation.installationId } } };
        const authorize = createSessionRpcAuthorization({ sessionId: 'session', localMachineId: state.machineId,
            serverUrl: 'https://session-diagnostic.test', isClosed: () => state.closed,
            readHomeServerIdentityId: () => state.homeId, readOwnerCredentials: async () => null,
            readSessionAttachmentRequester: () => requester });
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', scopeKind: 'session', localMachineId: state.machineId,
            encryptionMode: 'plain', authorizeRequest: authorize, logger: () => {} });
        const admission = { actorAccountId: requester.identity.requester.accountId, custodianAccountId: 'never-log-owner',
            machineId: state.machineId, installationId: installation.installationId, role: 'use' as const,
            encryptionMode: 'plain' as const };
        return { state, requester, authorize, rpc, admission, post, fetch };
    }

    it('keeps ordinary owner uploads available when no native worker was bound', async () => {
        const { state, post } = setup();
        post.mockResolvedValue({ status: 200, data: { v: 1, ok: true } });
        await withTempDir('session-owner-upload-', async directory => {
            let registration: ReturnType<typeof registerSessionHandlers>;
            const authorize = createSessionRpcAuthorization({ sessionId: 'session', localMachineId: state.machineId,
                serverUrl: 'https://session-diagnostic.test', isClosed: () => false,
                readHomeServerIdentityId: () => state.homeId,
                readOwnerCredentials: async () => ({ token: 'never-log-owner-token', encryption: null }),
                readSessionAttachmentRequester: method => registration?.readSessionAttachmentRequester(method) });
            const rpc = new RpcHandlerManager({ scopePrefix: 'session', scopeKind: 'session', localMachineId: state.machineId,
                encryptionMode: 'plain', authorizeRequest: authorize, logger: () => {} });
            registration = registerSessionHandlers(rpc, directory, {
                sessionId: 'session', readSessionAttachmentNativeRuntime: () => null,
                // This fixture's Home is supplied directly rather than persisted as a saved server profile.
                filesystemEffectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => state.homeId }),
            });
            try {
                expect(await rpc.handleRequest({ method: `session:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`,
                    callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'never-log-owner', custodianAccountId: 'never-log-owner',
                        machineId: state.machineId, installationId: installation.installationId, role: 'use', encryptionMode: 'plain' },
                    params: { t: 'session_attachment_upload_v1', sessionId: 'session', messageLocalId: 'message',
                        fileName: 'notes.txt', sizeBytes: 1, uploadLocation: 'workspace', workspaceRelativeDir: '.happier/attachments',
                        vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false },
                }, undefined, 'authenticated_home_socket')).toMatchObject({ success: true });
                expect(post).toHaveBeenCalledTimes(1);
            } finally { await registration.dispose(); }
        });
    });

    it.each(['owner', 'grantee'] as const)('admits every exact %s Session attachment phase without repeating Home permission reads', async actor => {
        const { rpc, requester, admission, post, fetch } = setupAttachmentRequester();
        if (actor === 'owner') {
            admission.actorAccountId = admission.custodianAccountId;
            requester.identity.requester.accountId = admission.actorAccountId;
            requester.identity.separationRequired = false;
        }
        const completed: string[] = [];
        for (const method of SessionTransferRpcMethodV1Schema.options) {
            rpc.registerHandler(method, () => { completed.push(method); return { ok: true }; });
            expect(await rpc.handleRequest({ method: `session:${method}`, params: {}, callerAuthority: 'present_user',
                machineAdmission: admission }, undefined, 'authenticated_home_socket')).toMatchObject({ ok: true });
        }
        expect(completed).toEqual(SessionTransferRpcMethodV1Schema.options);
        expect(post).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([false, true])('refuses daemon-user attachment writes when the native binding is absent (cleared after authorization: %s)', async clearAfterAuthorization => {
        const { state, requester, admission, post } = setupAttachmentRequester();
        const authorize = createSessionRpcAuthorization({ sessionId: 'session', localMachineId: state.machineId,
            serverUrl: 'https://session-diagnostic.test', isClosed: () => false,
            readHomeServerIdentityId: () => state.homeId,
            readOwnerCredentials: async () => ({ token: 'never-log-owner-token', encryption: null }),
            // Model both an absent binding and the clear window between the
            // authorizer's read and the registrar's read of that same binding.
            readSessionAttachmentRequester: () => clearAfterAuthorization ? requester : null });
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', scopeKind: 'session', localMachineId: state.machineId,
            encryptionMode: 'plain', authorizeRequest: authorize, logger: () => {} });
        await withTempDir('session-attachment-no-native-', async directory => {
            const registration = registerSessionHandlers(rpc, directory, {
                sessionId: 'session', readSessionAttachmentNativeRuntime: () => null,
            });
            try {
                expect(await rpc.handleRequest({ method: `session:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`,
                    callerAuthority: 'present_user', machineAdmission: admission, params: {
                        t: 'session_attachment_upload_v1', sessionId: 'session', messageLocalId: 'message',
                        fileName: 'attachment.txt', sizeBytes: 4, uploadLocation: 'workspace',
                        workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
                    } }, undefined, 'authenticated_home_socket')).toMatchObject(clearAfterAuthorization ? {
                    success: false, errorCode: 'filesystem_identity_custody_unavailable',
                } : {
                    errorCode: 'agent_isolation_unavailable', effectAttempted: false,
                    failureCause: { phase: 'session.rpc.authorization.unrestricted_owner_required' },
                });
                expect(await readdir(directory)).toEqual([]);
                expect(post).not.toHaveBeenCalled();
            } finally { await registration.dispose(); }
        });
    });

    it.each(['actor', 'session', 'home', 'machine', 'installation', 'held_machine', 'held_installation',
        'receiver_installation', 'closed'] as const)(
        'refuses a mismatched or ended Session attachment binding: %s', async mismatch => {
            const { state, requester, rpc, admission, post } = setupAttachmentRequester();
            let effects = 0;
            rpc.registerHandler(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, () => { effects += 1; return { ok: true }; });
            if (mismatch === 'actor') admission.actorAccountId = 'never-log-other-member';
            if (mismatch === 'session') requester.sessionId = 'never-log-other-session';
            if (mismatch === 'home') requester.homeServerIdentityId = 'srv_other_home';
            if (mismatch === 'machine') admission.machineId = 'never-log-other-machine';
            if (mismatch === 'installation') admission.installationId = 'never-log-other-installation';
            if (mismatch === 'held_machine') requester.identity.requester.machineId = 'never-log-other-machine';
            if (mismatch === 'held_installation') requester.identity.requester.installationId = 'never-log-other-installation';
            if (mismatch === 'receiver_installation') {
                admission.installationId = 'never-log-other-installation';
                requester.identity.requester.installationId = admission.installationId;
            }
            if (mismatch === 'closed') state.closed = true;
            const result = await rpc.handleRequest({ method: `session:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK}`,
                params: {}, callerAuthority: 'present_user', machineAdmission: admission }, undefined, 'authenticated_home_socket');
            expect(result).toMatchObject({ errorCode: 'agent_isolation_unavailable', effectAttempted: false });
            expect(effects).toBe(0);
            expect(post).not.toHaveBeenCalled();
        });

    it('refuses an attachment phase cancelled before receiver admission', async () => {
        const { authorize, admission, post } = setupAttachmentRequester();
        const controller = new AbortController();
        controller.abort();
        expect(await authorize({ method: `session:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK}`, params: {},
            callerAuthority: 'present_user', machineAdmission: admission, signal: controller.signal }, 'authenticated_home_socket')).toMatchObject({
            ok: false, errorCode: 'agent_isolation_unavailable', effectAttempted: false,
        });
        expect(post).not.toHaveBeenCalled();
    });

    it('requires authenticated Home transport before trusting attachment Machine admission', async () => {
        const { rpc, admission, post } = setupAttachmentRequester();
        let effects = 0;
        rpc.registerHandler(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, () => { effects += 1; return { ok: true }; });
        expect(await rpc.handleRequest({ method: `session:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK}`, params: {},
            callerAuthority: 'present_user', machineAdmission: admission })).toMatchObject({
            errorCode: 'agent_isolation_unavailable', effectAttempted: false,
        });
        expect(effects).toBe(0);
        expect(post).not.toHaveBeenCalled();
    });

    it('does not spend attachment custody on an unscoped method or general filesystem write', async () => {
        const { authorize, rpc, admission, post } = setupAttachmentRequester();
        let effects = 0;
        rpc.registerHandler(RPC_METHODS.WRITE_FILE, () => { effects += 1; return { ok: true }; });
        expect(await rpc.handleRequest({ method: `session:${RPC_METHODS.WRITE_FILE}`, params: {},
            callerAuthority: 'present_user', machineAdmission: admission }, undefined, 'authenticated_home_socket')).toMatchObject({
            errorCode: 'agent_isolation_unavailable', effectAttempted: false,
            failureCause: { phase: 'session.rpc.authorization.unrestricted_owner_required' },
        });
        expect(await authorize({ method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, params: {},
            callerAuthority: 'present_user', machineAdmission: admission }, 'authenticated_home_socket')).toMatchObject({ ok: false,
            errorCode: 'agent_isolation_unavailable', effectAttempted: false });
        expect(effects).toBe(0);
        expect(post).not.toHaveBeenCalled();
    });
});
