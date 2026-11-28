import { randomUUID } from 'node:crypto';
import axios from 'axios';
import nacl from 'tweetnacl';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { SocketRpcMachineAdmissionContextV1Schema, WorkspaceSyncSourceExecutionV1Schema } from '@happier-dev/protocol/socketRpc';
import { expect, onTestFinished, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema, ExternalActionServerPrincipalV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext, createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import * as installationStore from '@/daemon/identity/store';
import { createExternalActionMachineRpcExecution, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, readMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import type { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '@/daemon/externalActions/approvalExecutionAuthorization';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createLightSqliteHarness, createAccountTokenForTests } from '../../../../../../../apps/server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../../../../apps/server/sources/storage/db';
import { createAuthenticatedTestApp } from '../../../../../../../apps/server/sources/app/api/testkit/sqliteFastify';
import { registerExternalActionRoutes } from '../../../../../../../apps/server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { registerMachineAdmissionRoutes } from '../../../../../../../apps/server/sources/app/api/routes/machines/registerMachineAdmissionRoutes';
import { resolveMachineAdmission } from '../../../../../../../apps/server/sources/app/machines/machineAccess';

/** The same real Home issuer and installed requester ingress used by the composed approval fixture. */
export async function createProjectServiceMoveHome(input: Readonly<{
    serverIdentityId: string;
    credentials: StoredCredentials;
    machineInstallationKeys: ReadonlyMap<string, Uint8Array>;
}>) {
    const home = await createLightSqliteHarness({ tempDirPrefix: 'service-move-home-', initAuth: true, initEncrypt: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: input.serverIdentityId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
            AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    onTestFinished(() => home.close());
    await db.account.create({ data: { id: 'owner', publicKey: null, encryptionMode: 'plain' } });
    const terminalToken = await createAccountTokenForTests('owner', { kind: 'terminal', authority: 'account_automation' });
    const uiToken = await createAccountTokenForTests('owner', { kind: 'account', authority: 'present_user' });
    input.credentials.token = terminalToken;
    for (const [machineId, privateKey] of input.machineInstallationKeys) {
        await db.machine.create({ data: { id: machineId, accountId: 'owner',
            metadata: encodePlainMachineStoredContent({ host: machineId, platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), metadataVersion: 1,
            installationId: machineId === 'machine' ? 'source-installation' : 'installation',
            installationPublicKey: new Uint8Array(nacl.sign.keyPair.fromSecretKey(privateKey).publicKey) } });
    }
    const privateKey = input.machineInstallationKeys.get('machine');
    if (!privateKey) throw new Error('Move SOURCE installation key missing');
    const publicKey = nacl.sign.keyPair.fromSecretKey(privateKey).publicKey;
    // Installation persistence is the OS boundary, as in the canonical installed fixture.
    const sourceInstallation = { version: 1 as const,
        installationId: 'source-installation', createdAt: 1, publicKey: Buffer.from(publicKey).toString('base64url'),
        privateKey: Buffer.from(privateKey).toString('base64url') };
    const installation = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(sourceInstallation);
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    registerExternalActionRoutes(app);
    registerMachineAdmissionRoutes(app);
    onTestFinished(() => app.close());
    const priorPost = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
        const path = new URL(String(url)).pathname;
        if (!path.startsWith('/v1/actions/') && !path.endsWith('/admission/verify')) return priorPost(url, body, options);
        const response = await app.inject({ method: 'POST', url: path,
            headers: Object.fromEntries(Object.entries(options?.headers ?? {}).map(([key, value]) => [key, String(value)])),
            payload: body });
        return { status: response.statusCode, data: response.json() };
    });
    const signedInputs: Parameters<NonNullable<ActionExecutorContext['signExternalActionApprovalInput']>>[0][] = [];
    let prepareReplay: ReturnType<typeof createDaemonApprovalExecutionAuthorizationPreparer> | undefined;
    return {
        signedInputs,
        createReceivingRpc(machineId: string, executor: ReturnType<typeof createActionExecutor>) {
            const receiverKey = input.machineInstallationKeys.get(machineId);
            if (!receiverKey) throw new Error('Move receiver installation key missing');
            const receiverPublicKey = nacl.sign.keyPair.fromSecretKey(receiverKey).publicKey;
            const receiverInstallation = { version: 1 as const,
                installationId: machineId === 'machine' ? 'source-installation' : 'installation', createdAt: 1,
                publicKey: Buffer.from(receiverPublicKey).toString('base64url'), privateKey: Buffer.from(receiverKey).toString('base64url') };
            const rpc = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain',
                authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, { machineId,
                    resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => receiverInstallation.installationId,
                    verifyMachineAdmission: received => readMachineRpcAdmissionCurrent({ ...received, privateKey: receiverKey,
                        daemonToken: input.credentials.token, serverHttpBaseUrl: 'https://home.example' }) }, source),
                prepareRequesterAccountContext: request => prepareInstalledRequesterAccountActionContext({ ...request,
                    purpose: request.purpose ?? { kind: 'external_action' },
                    ownCredentials: input.credentials, machineId, serverId: 'home', serverHttpBaseUrl: 'https://home.example',
                    resolveCurrentMachineExecutionOriginContext: async () => ({ machineId, serverIdentityId: input.serverIdentityId }),
                    createExecutor: () => executor }) });
            return { rpc, async invoke(call: Parameters<typeof callExactMachineRpc>[0]) {
                const external = call.externalAction;
                const root = external?.context.externalActionExecutionAuthorization;
                const seal = root?.requesterAccountProjection?.sealRequesterAccountContext;
                if (external && (!root || !seal)) throw new Error('Move child requires installed requester custody');
                const authorization = root && seal ? await seal({ authorization: root, purpose: { kind: 'machine_rpc', method: call.method,
                    params: call.request, recipient: { machineId, installationId: receiverInstallation.installationId } },
                    installationPublicKey: receiverPublicKey }) : undefined;
                if (external && !authorization) throw new Error('Move child requester sealing failed');
                expect(call.credentials.token).toBe(input.credentials.token);
                const admission = await resolveMachineAdmission({ actorAccountId: root?.binding.accountId ?? 'owner', machineId, requiredRole: 'manage' });
                if (admission.kind !== 'admitted') throw new Error(`Move receiver unavailable: ${JSON.stringify(admission)}`);
                const machineAdmission = SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: admission.actorAccountId,
                    custodianAccountId: admission.custodianAccountId, machineId: admission.machineId,
                    installationId: admission.installationId, role: admission.role, encryptionMode: admission.encryptionMode });
                const method = `${machineId}:${call.method}`;
                const requestId = randomUUID();
                const callId = randomUUID().replaceAll('-', '');
                const content = { mode: 'plain' as const };
                const params = await socketRpcCodec.encodeParams(content, call.request, { method, callId });
                const packet = external && authorization ? WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId, params,
                    originalActionEnvelope: external.context.originalActionEnvelope,
                    externalActionExecution: createExternalActionMachineRpcExecution({ context: { ...external.context,
                        externalActionExecutionAuthorization: authorization }, effectActionId: external.effectActionId,
                        installationId: external.installationId, privateKey: external.privateKey, method, requestId, params }) }) : undefined;
                // Two installed processes share this test's OS persistence boundary.
                // Nested calls return to the calling installation's OS identity.
                const previousInstallation = installationStore.readInstallationIdentityIfExistsSync();
                installation.mockReturnValue(receiverInstallation);
                try {
                    const result = await rpc.handleRequest({ method, requestId, params, machineAdmission,
                        callerAuthority: external?.context.authority ?? call.authorityCeiling ?? 'account_automation',
                        ...(external ? { ...(authorization ? { callerInputAuthorization: authorization } : {}),
                            originalActionEnvelope: external.context.originalActionEnvelope, workspaceSyncSourceExecution: packet } : {}) });
                    return await socketRpcCodec.decodeResult(content, { ok: true, result }, callId);
                } finally { installation.mockReturnValue(previousInstallation); }
            } };
        },
        prepareApprovalExecutionAuthorization: async (request: Parameters<NonNullable<typeof prepareReplay>>[0]) => {
            if (!prepareReplay) throw new Error('Move replay requires installed requester ingress');
            return prepareReplay(request);
        },
        async run(executor: ReturnType<typeof createActionExecutor>, actionId: ActionId, actionInput: unknown,
            context: ActionExecutorContext) {
            const surface = context.surface === 'ui' ? 'ui' : 'cli';
            const authority = surface === 'ui' ? 'present_user' : 'account_automation';
            const token = surface === 'ui' ? uiToken : terminalToken;
            // Each ingress is a fresh invocation. The Move operation's domain
            // requestId may exceed the public envelope's independent ID format.
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1,
                requestId: randomUUID(), target: { kind: 'machine', machineId: 'machine' }, input: actionInput });
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: 'machine', envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = sealExternalActionRequesterAccountContextV1({
                authorization: ExternalActionExecutionAuthorizationV1Schema.parse(issued.json()),
                credentials: { ...encodeStoredCredentials(input.credentials), token },
                invocation: { caller: { kind: 'host' }, surface, authority }, purpose: { kind: 'external_action' },
                installationPublicKey: publicKey, randomBytes: nacl.randomBytes });
            const resolveOrigin = async () => ({ serverIdentityId: input.serverIdentityId, machineId: 'machine' });
            const prepareRequesterAccountContext: NonNullable<Parameters<typeof executeExternalAction>[0]['prepareRequesterAccountContext']> = request =>
                prepareInstalledRequesterAccountActionContext({ ...request,
                    ownCredentials: input.credentials, purpose: request.purpose ?? { kind: 'external_action' },
                    machineId: 'machine', serverId: 'home', serverHttpBaseUrl: 'https://home.example',
                    resolveCurrentMachineExecutionOriginContext: resolveOrigin,
                    createExecutor: () => admittedExecutor });
            // Root ingress and requester custody share this one executor, so it admits every Action id.
            const admittedExecutor: Pick<ReturnType<typeof createActionExecutor>, 'execute'> = { execute: (id, value, admitted) => {
                prepareReplay = createDaemonApprovalExecutionAuthorizationPreparer({
                    machineId: 'machine', serverId: 'home', serverBaseUrl: 'https://home.example',
                    resolveCurrentMachineExecutionOriginContext: resolveOrigin,
                    requesterAccountContext: readRequesterAccountActionContext(admitted?.externalActionExecutionAuthorization) ?? undefined,
                    prepareRequesterAccountContext,
                    daemonWorkSignal: context.signal ?? new AbortController().signal,
                });
                const signApprovalInput = admitted?.signExternalActionApprovalInput;
                return executor.execute(id, value, { ...context, ...admitted,
                    ...(signApprovalInput ? { signExternalActionApprovalInput: signing => {
                        signedInputs.push(signing);
                        return signApprovalInput(signing);
                    } } : {}),
                    ...(context.actionsSettings ? { actionsSettings: context.actionsSettings } : {}) });
            } };
            const binding = authorization.binding;
            if (!('authentication' in binding)) throw new Error('Move Home root must retain Account authentication');
            const principal = ExternalActionServerPrincipalV1Schema.parse({ accountId: binding.accountId, authority, authentication: binding.authentication });
            const result = await executeExternalAction({ actionId, envelope, principal, surface,
                executionAuthorization: authorization, currentMachineId: 'machine', currentServerId: 'home',
                currentServerHttpBaseUrl: 'https://home.example', currentInstallationId: 'source-installation',
                externalActionMachineRequestPrivateKey: privateKey, signal: context.signal,
                verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                    privateKey, installationId: 'source-installation', serverHttpBaseUrl: 'https://home.example' }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials: input.credentials }),
                executor: admittedExecutor,
                prepareRequesterAccountContext });
            expect(result.kind, JSON.stringify(result)).toBe('response');
            if (result.kind !== 'response' || result.response.v !== 1) throw new Error('Move installed ingress refused');
            return result.response.execution;
        },
    };
}
