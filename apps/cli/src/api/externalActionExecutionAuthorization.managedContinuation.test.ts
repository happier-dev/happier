import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { dispatchManagedMachineAdminAccess, verifyManagedCreationAdminAccessInput, verifyManagedCreationAgentIsolationInput,
    projectExternalActionRequesterHttpAuthorization } from './externalActionExecutionAuthorization';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { dispatchLocalManagedMachineEnvironment, dispatchManagedMachineEnvironment, dispatchManagedSessionStart } from './externalActionExecutionAuthorization';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { updateSettings } from '@/persistence';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';

const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
    serverIdentityId: 'srv_home', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 2 },
    actionId: 'machines.managed.acquire', requestId: 'creation', requestEnvelopeDigest: 'a'.repeat(43),
    machineId: 'controller', custodianAccountId: 'account', installationId: 'installation', target: { kind: 'machine', machineId: 'controller' },
    accountEncryptionMode: 'e2ee',
} });
const input = { executionTarget: { serverId: 'home-profile', machineId: 'guest' }, directory: { kind: 'managed' as const },
    agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } },
    initialInput: { text: 'private instructions' } };
const continuation = { managedId: 'managed', creationRequestId: 'creation', expectedIntentRevision: 3 };

describe('managed continuation through the ordinary public Action transport', () => {
    beforeEach(async () => {
        await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
            'home-profile': { id: 'home-profile', name: 'Home', serverUrl: 'https://home.example', webappUrl: 'https://home.example',
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
                homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'https://home.example',
                    revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] } },
        } }));
    });
    afterEach(() => vi.restoreAllMocks());

    it.each([true, false])('seals the administrator child with the existing creation correlation and verifies its retained policy before target execution (controller=%s)', async controllerPresent => {
        const policy = { version: 1 as const, mode: 'ask' as const, administratorUsername: 'operator' };
        const request = { serverId: 'srv_home', machineId: 'guest', expectedMetadataVersion: 0,
            expectedAdminAccess: { version: 1 as const, mode: 'none' as const }, adminAccess: policy, comparison: 'field' as const };
        const row = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account',
            controller: controllerPresent ? { machineId: 'controller', installationId: 'installation' } : undefined,
            launch: { provider: { pluginId: 'native.provisioner', localId: 'guest' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'native.provisioner', localId: 'guest' }, schemaVersion: 1, value: { id: 'paid-guest' } },
            allocation: 'bound', creationState: 'active', enrolledMachineId: 'guest', desired: 'start', desiredWhen: 'now', intentRevision: 3,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'deployTarget',
                adminAccessAtCreation: 'ask', administrator: { username: 'operator' } } };
        const child = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root, binding: { ...root.binding,
            actionId: 'machines.setup.adminAccess.set', machineId: 'guest', installationId: 'guest-installation',
            target: { kind: 'machine', machineId: 'guest' }, managedContinuation: { ...continuation,
                controller: row.controller, acquireRequestEnvelopeDigest: root.binding.requestEnvelopeDigest } } });
        const context = { surface: 'cli' as const, actionRequestId: 'creation', externalActionExecutionAuthorization: child,
            externalActionTarget: child.binding.target, signal: new AbortController().signal };
        let bootstrapRetry = false;
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (url.endsWith('/v1/actions/machines.setup.adminAccess.set')) {
                const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                expect(carrier.managedContinuation).toEqual(continuation);
                expect(carrier.envelope.requestId).toBe(bootstrapRetry ? 'retry' : 'creation');
                expect(carrier.envelope).not.toHaveProperty('sessionSpawnAdmission');
                if (carrier.envelope.v !== 2) throw new Error('Expected sealed administrator policy');
                const binding = { serverIdentityId: 'srv_home', accountId: 'account',
                    actionId: 'machines.setup.adminAccess.set', requestId: bootstrapRetry ? 'retry' : 'creation', target: { kind: 'machine' as const, machineId: 'guest' },
                    authentication: { kind: 'account' as const, tokenEpoch: 2 } };
                expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: carrier.envelope, material, binding })?.input).toEqual(request);
                expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
                return { status: 200, data: prepareExternalActionResponseV2({ binding, request: carrier.envelope, material,
                    randomBytes: length => new Uint8Array(length).fill(4), executedMachineId: 'guest',
                    execution: { ok: true, result: { status: 'applied', policy, metadataVersion: 1 } } }).response };
            }
            expect(url).toBe('https://home.example/v1/machines/managed/actions/get');
            expect(body).toEqual({ homeId: 'srv_home', managedId: 'managed' });
            expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: child.token });
            return { status: 200, data: row };
        });
        expect(await dispatchManagedMachineAdminAccess({ input: request, serverId: 'home-profile', continuation, authorization: root,
            material, installationId: 'installation', privateKey: keyPair.secretKey, serverHttpBaseUrl: 'https://home.example' }))
            .toMatchObject({ ok: true, result: { status: 'applied' } });
        const args = { request, context, serverIdentityId: 'srv_home', daemonToken: 'unused-host-credential',
            privateKey: keyPair.secretKey, installationId: 'guest-installation', serverHttpBaseUrl: 'https://home.example' };
        expect(await verifyManagedCreationAdminAccessInput(args)).toBe(true);
        post.mockResolvedValueOnce({ status: 200, data: { ...row, controller: controllerPresent ? undefined
            : { machineId: 'controller', installationId: 'installation' } } });
        expect(await verifyManagedCreationAdminAccessInput(args)).toBe(false);
        bootstrapRetry = true;
        const retryRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root,
            binding: { ...root.binding, actionId: 'machines.managed.bootstrap.retry', requestId: 'retry' } });
        expect(await dispatchManagedMachineAdminAccess({ input: request, serverId: 'home-profile', continuation, authorization: retryRoot,
            material, installationId: 'installation', privateKey: keyPair.secretKey, serverHttpBaseUrl: 'https://home.example' }))
            .toMatchObject({ ok: true, result: { status: 'applied' } });
        const retryChild = ExternalActionExecutionAuthorizationV1Schema.parse({ ...child,
            binding: { ...child.binding, requestId: 'retry' } });
        expect(await verifyManagedCreationAdminAccessInput({ ...args,
            context: { ...context, actionRequestId: 'retry', externalActionExecutionAuthorization: retryChild } })).toBe(true);
        bootstrapRetry = false;
        expect(await verifyManagedCreationAdminAccessInput({ ...args, request: { ...request,
            adminAccess: { ...policy, administratorUsername: 'different' } } })).toBe(false);
        expect(await verifyManagedCreationAdminAccessInput({ ...args, request: { ...request, machineId: 'other-guest' } })).toBe(false);
        expect(await verifyManagedCreationAdminAccessInput({ ...args, request: { ...request, serverId: 'srv_other' } })).toBe(false);
        post.mockResolvedValueOnce({ status: 200, data: { ...row, intentRevision: 4 } });
        expect(await verifyManagedCreationAdminAccessInput(args)).toBe(false);
        const isolationRequest = { serverId: 'srv_home', machineId: 'guest', enabled: true,
            expectedMetadataVersion: 2, expectedPolicy: { enabled: true }, expectedPlanDigest: 'reviewed-effects' };
        const isolationChild = ExternalActionExecutionAuthorizationV1Schema.parse({ ...child,
            binding: { ...child.binding, actionId: 'machines.agentIsolation.set', requestId: 'retry' } });
        const isolationContext = { ...context, actionRequestId: 'retry', externalActionExecutionAuthorization: isolationChild };
        const isolationArgs = { ...args, actionId: 'machines.agentIsolation.set' as const, request: isolationRequest, context: isolationContext };
        expect(await verifyManagedCreationAgentIsolationInput(isolationArgs)).toBe(true);
        expect(await verifyManagedCreationAgentIsolationInput({ ...isolationArgs, request: { ...isolationRequest, enabled: false } })).toBe(false);
        post.mockResolvedValueOnce({ status: 200, data: { ...row, enrollmentIdentity: { kind: 'existingUser', role: 'adopted' } } });
        expect(await verifyManagedCreationAgentIsolationInput(isolationArgs)).toBe(false);
        const currentness = await createRequesterCurrentnessSocketHarness();
        try {
            let mutations = 0;
            let rpcResult: unknown = { status: 'applied', policy, metadataVersion: 2 };
            currentness.server.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, (_packet, acknowledge) => {
                mutations++;
                acknowledge({ ok: true, result: rpcResult });
            }));
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url === 'https://home.example/v1/machines/guest') return { status: 200, data: { machine: {
                    id: 'guest', kind: 'persistent', storageMode: 'plain', installationId: 'guest-installation',
                    installationPublicKey: Buffer.from(keyPair.publicKey).toString('base64'),
                    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                } } };
                expect(url).toBe('https://home.example/v1/account/encryption/currentness');
                return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null,
                    contentKeyFingerprint: null, updatedAt: 1 } };
            });
            const http = await projectExternalActionRequesterHttpAuthorization({ authorization: { ...child,
                binding: { ...child.binding, accountEncryptionMode: 'plain' } }, serverId: 'home-profile', serverIdentityId: 'srv_home',
                serverHttpBaseUrl: 'https://home.example', target: child.binding.target, installationId: 'guest-installation',
                privateKey: keyPair.secretKey, isCurrent: async () => true });
            if (!http) throw new Error('Exact Home projection was not established');
            const credentials = { token: 'requester-token', encryption: null };
            const admitted = await projectRequesterAccountActionAuthorization({ authorization: http, serverIdentityId: 'srv_home',
                bootstrap: { credentials, serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true,
                    attribution: { serverId: 'home-profile', accountId: 'account', machineId: 'guest', installationId: 'guest-installation' } } });
            if (!admitted) throw new Error('Requester custody was not established');
            const deps = createCliActionDeps({ token: credentials.token, credentials, mode: 'plain', ctx: null, sessionId: '', serverId: 'home-profile',
                serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example',
                externalActionMachineInstallationId: 'guest-installation', externalActionMachineRequestPrivateKey: keyPair.secretKey });
            const invoke = (value: typeof request) => deps.machineAdminAccessAction!({ actionId: 'machines.setup.adminAccess.set',
                input: value, context: { ...context, serverId: 'home-profile', externalActionExecutionAuthorization: admitted }, signal: context.signal });
            expect(await invoke({ ...request, adminAccess: { ...policy, administratorUsername: 'different' } }))
                .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
            expect(mutations).toBe(0);
            expect(await invoke(request)).toMatchObject({ status: 'applied' });
            expect(mutations).toBe(1);
            const isolationHttp = await projectExternalActionRequesterHttpAuthorization({ authorization: { ...isolationChild,
                binding: { ...isolationChild.binding, accountEncryptionMode: 'plain' } }, serverId: 'home-profile', serverIdentityId: 'srv_home',
                serverHttpBaseUrl: 'https://home.example', target: isolationChild.binding.target, installationId: 'guest-installation',
                privateKey: keyPair.secretKey, isCurrent: async () => true });
            if (!isolationHttp) throw new Error('Isolation Home projection was not established');
            const isolationAdmitted = await projectRequesterAccountActionAuthorization({ authorization: isolationHttp, serverIdentityId: 'srv_home',
                bootstrap: { credentials, serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true,
                    attribution: { serverId: 'home-profile', accountId: 'account', machineId: 'guest', installationId: 'guest-installation' } } });
            if (!isolationAdmitted) throw new Error('Isolation requester custody was not established');
            rpcResult = { kind: 'accepted', operationId: 'isolation-operation', metadataVersion: 3,
                status: { kind: 'applying', phase: 'runtime_replacement' } };
            const invokeIsolation = (value: typeof isolationRequest) => deps.machineAgentIsolationAction!({ actionId: 'machines.agentIsolation.set',
                input: value, context: { ...isolationContext, serverId: 'home-profile', externalActionExecutionAuthorization: isolationAdmitted }, signal: context.signal });
            expect(await invokeIsolation({ ...isolationRequest, enabled: false })).toMatchObject({ ok: false, errorCode: 'managed_enrollment_policy_unverified' });
            expect(mutations).toBe(1);
            expect(await invokeIsolation(isolationRequest)).toMatchObject({ kind: 'accepted', status: { kind: 'applying' } });
            expect(mutations).toBe(2);
            post.mockClear();
            expect(await verifyManagedCreationAdminAccessInput({ ...args, context: { surface: 'cli' } })).toBe(true);
            expect(post).not.toHaveBeenCalled(); // Ordinary policy Actions do no creation-row read.
        } finally { await currentness.close(); }
    });

    it.each(['action_not_admitted', 'action_outcome_unknown'] as const)('preserves managed child correlation for %s and refuses a mismatched reply', async code => {
        const response = (id: string) => {
            const refusal = projectExternalActionHttpError(code, id);
            return { status: refusal.statusCode, data: refusal.payload };
        };
        vi.spyOn(axios, 'post').mockResolvedValueOnce(response(root.binding.requestId)).mockResolvedValueOnce(response('other-request'));
        const request = { input, continuation, authorization: root, material, installationId: 'installation',
            privateKey: keyPair.secretKey, serverHttpBaseUrl: 'https://home.example', targetMachineId: 'guest' };
        expect(await dispatchManagedSessionStart(request))
            .toMatchObject({ ok: false, errorCode: code, details: { requestId: root.binding.requestId } });
        expect(await dispatchManagedSessionStart(request)).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });

    it('originates setup for a genuine local host creation through the existing exact Account signer and refuses borrowed origins', async () => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 2,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const setup = { homeId: 'srv_home', machineId: 'guest', presetId: 'preset', presetRevision: 4 };
        const machine = { id: 'guest', kind: 'persistent', active: true, installationId: 'guest-installation', revokedAt: null,
            replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
            access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
        vi.spyOn(axios, 'get').mockImplementation(async url => url.endsWith('/v1/account/encryption')
            ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
            : url.endsWith('/v1/machines/guest') ? { status: 200, data: { machine } } : { status: 200, data: [machine] });
        let delivered = 0;
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(carrier).not.toHaveProperty('managedContinuation');
            expect(carrier.envelope).toMatchObject({ v: 1, requestId: 'creation', target: { kind: 'machine', machineId: 'guest' }, input: setup });
            if (url.endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'exact-local-setup-root', binding: {
                accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 2 }, accountEncryptionMode: 'plain',
                serverIdentityId: 'srv_home', machineId: 'guest', installationId: 'guest-installation', actionId: 'machines.environment.apply',
                requestId: 'creation', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(carrier.envelope), target: carrier.envelope.target,
            } } };
            expect(url).toBe('https://home.example/v1/actions/machines.environment.apply');
            if (!carrier.executionAuthorization) throw new Error('Missing exact local setup authorization');
            expect(carrier.executionAuthorization.token).toBe('exact-local-setup-root');
            delivered++;
            return { status: 200, data: { v: 1, actionId: 'machines.environment.apply', requestId: 'creation', execution: { ok: true, result: { operationId: 'actual-setup' } } } };
        });
        const args = { input: setup, credentials: { token, encryption: null, credentialProvenance: 'stored_session' as const },
            custodianAccountId: 'account', serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true,
            context: { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
                actionRequestId: 'creation', serverIdentityId: 'srv_home', signal: new AbortController().signal } };
        expect(await dispatchLocalManagedMachineEnvironment(args)).toEqual({ ok: true, result: { operationId: 'actual-setup' } });
        expect(delivered).toBe(1);
        post.mockClear();
        expect(await dispatchLocalManagedMachineEnvironment({ ...args, custodianAccountId: 'other-account' })).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(await dispatchLocalManagedMachineEnvironment({ ...args, context: { ...args.context, surface: 'agent',
            actionCaller: { kind: 'session', sessionId: 'source', starterDepth: 0, turnDepth: 0 } } })).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });

    it('seals setup for the exact joined guest using the existing creation proof without Session admission', async () => {
        const setup = { homeId: 'srv_home', machineId: 'guest', presetId: 'preset', presetRevision: 4 };
        let opened: unknown;
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            expect(url).toBe('https://home.example/v1/actions/machines.environment.apply');
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(request.managedContinuation).toEqual(continuation);
            expect(request.envelope.requestId).toBe('creation');
            expect(request.envelope).not.toHaveProperty('sessionSpawnAdmission');
            expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
            const binding = { serverIdentityId: 'srv_home', accountId: 'account', authentication: { kind: 'account' as const, tokenEpoch: 2 },
                actionId: 'machines.environment.apply', requestId: 'creation', target: { kind: 'machine' as const, machineId: 'guest' } };
            if (request.envelope.v !== 2) throw new Error('Expected sealed setup');
            opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope, binding, material })?.input;
            return { status: 200, data: prepareExternalActionResponseV2({ binding, request: request.envelope, material,
                randomBytes: length => new Uint8Array(length).fill(4), executedMachineId: 'guest',
                execution: { ok: true, result: { operationId: 'setup-operation' } } }).response };
        });
        expect(await dispatchManagedMachineEnvironment({ input: setup, serverId: 'home-profile', continuation, authorization: root,
            serverHttpBaseUrl: 'https://home.example', installationId: 'installation', privateKey: keyPair.secretKey, material }))
            .toMatchObject({ ok: true, result: { operationId: 'setup-operation' } });
        expect(opened).toEqual(setup);
    });

    it('carries the captured Voice automation ceiling through signed managed setup', async () => {
        const setup = { homeId: 'srv_home', machineId: 'guest', presetId: 'preset', presetRevision: 4 };
        let capturedHeaders: unknown;
        vi.spyOn(axios, 'post').mockImplementation(async (_url, body, config) => {
            capturedHeaders = config?.headers;
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { status: 200, data: { v: 1, actionId: 'machines.environment.apply', requestId: request.envelope.requestId,
                execution: { ok: true, result: { operationId: 'setup-operation' } } } };
        });
        await expect(dispatchManagedMachineEnvironment({ input: setup, serverId: 'home-profile', continuation,
            authorization: { ...root, binding: { ...root.binding, accountEncryptionMode: 'plain' } },
            authority: 'account_automation', serverHttpBaseUrl: 'https://home.example',
            installationId: 'installation', privateKey: keyPair.secretKey })).resolves.toMatchObject({ ok: true });
        expect(capturedHeaders).toMatchObject({ [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' });
    });

    it('qualifies a real local profile to its exact Home before sealing guest input and admission facts', async () => {
        let emittedRequestId: string | undefined;
        let openedInput: unknown;
        let admissionFacts: unknown;
        const canonicalInput = { ...input, executionTarget: { ...input.executionTarget, serverId: root.binding.serverIdentityId } };
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            expect(url).toBe('https://home.example/v1/actions/session.spawn_new');
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(request.managedContinuation).toEqual(continuation);
            emittedRequestId = request.envelope.requestId;
            expect(request.envelope.v).toBe(2);
            if (request.envelope.v !== 2) throw new Error('Expected sealed request');
            expect(JSON.stringify(request)).not.toContain('private instructions');
            expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
            const binding = { serverIdentityId: root.binding.serverIdentityId, accountId: root.binding.accountId,
                authentication: { kind: 'account' as const, tokenEpoch: 2 }, actionId: 'session.spawn_new',
                requestId: request.envelope.requestId, target: { kind: 'machine' as const, machineId: 'guest' } };
            openedInput = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope, binding, material })?.input;
            admissionFacts = request.envelope.sessionSpawnAdmission;
            return { status: 200, data: prepareExternalActionResponseV2({ binding, request: request.envelope,
                material, randomBytes: length => new Uint8Array(length).fill(4), executedMachineId: 'guest',
                execution: { ok: true, result: { type: 'success', disposition: 'created', sessionId: 'real-session',
                    executionTarget: canonicalInput.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
                    initialInput: { status: 'accepted', localId: 'first-message' } } } }).response };
        });
        await expect(dispatchManagedSessionStart({ input, continuation, authorization: root,
            serverHttpBaseUrl: 'https://home.example', installationId: 'installation', privateKey: keyPair.secretKey,
            material })).resolves.toMatchObject({ ok: true, result: { sessionId: 'real-session' } });
        // Keep this outside the HTTP boundary: an assertion thrown inside an
        // HTTP adapter is correctly treated as a transport failure by callers.
        expect(emittedRequestId).toBe(root.binding.requestId);
        expect(openedInput).toEqual(canonicalInput);
        expect(admissionFacts).toEqual(projectApiTokenSessionSpawnAdmissionV1(canonicalInput));
    });

    it('refuses encrypted continuation without real material before transmitting, while keyless Plain uses V1', async () => {
        const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(request.envelope.v).toBe(1);
            return { status: 200, data: { v: 1, actionId: 'session.spawn_new', requestId: request.envelope.requestId,
                execution: { ok: true, result: { type: 'success', disposition: 'created', sessionId: 'plain-session',
                    executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
                    initialInput: { status: 'accepted', localId: 'first-message' } } } } };
        });
        const args = { input, continuation, authorization: root, serverHttpBaseUrl: 'https://home.example',
            installationId: 'installation', privateKey: keyPair.secretKey };
        await expect(dispatchManagedSessionStart(args)).resolves.toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
        await expect(dispatchManagedSessionStart({ ...args, authorization: { ...root,
            binding: { ...root.binding, accountEncryptionMode: 'plain' } } })).resolves.toMatchObject({ ok: true, result: { sessionId: 'plain-session' } });
    });

    it('preserves a genuine child grant refusal instead of reporting it as unavailable transport', async () => {
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 403, data: { error: 'credential_scope_denied' } });
        await expect(dispatchManagedSessionStart({ input, continuation, authorization: root,
            serverHttpBaseUrl: 'https://home.example', installationId: 'installation', privateKey: keyPair.secretKey,
            material })).resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    });

    it('refuses a saved target from another Home before transmitting or rewriting it to the root Home', async () => {
        await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
            'other-profile': { id: 'other-profile', name: 'Other', serverUrl: 'https://other.example', webappUrl: 'https://other.example',
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
                homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_other', canonicalServerUrl: 'https://other.example',
                    revision: 1, endpoints: [{ kind: 'https', url: 'https://other.example' }] } },
        } }));
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 409, data: { error: 'target_unavailable' } });
        await expect(dispatchManagedSessionStart({ input: { ...input,
            executionTarget: { ...input.executionTarget, serverId: 'other-profile' } }, continuation, authorization: root,
            serverHttpBaseUrl: 'https://home.example', installationId: 'installation', privateKey: keyPair.secretKey,
            material })).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });
});
