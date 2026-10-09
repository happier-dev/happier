import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { dispatchLocalManagedMachineEnvironment, dispatchManagedMachineEnvironment, dispatchManagedSessionStart } from './externalActionExecutionAuthorization';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { updateSettings } from '@/persistence';

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
            opened = openExternalActionRequestV2({ envelope: request.envelope, binding, material })?.input;
            return { status: 200, data: prepareExternalActionResponseV2({ binding, request: request.envelope, material,
                randomBytes: length => new Uint8Array(length).fill(4), executedMachineId: 'guest',
                execution: { ok: true, result: { operationId: 'setup-operation' } } }).response };
        });
        expect(await dispatchManagedMachineEnvironment({ input: setup, serverId: 'home-profile', continuation, authorization: root,
            serverHttpBaseUrl: 'https://home.example', installationId: 'installation', privateKey: keyPair.secretKey, material }))
            .toMatchObject({ ok: true, result: { operationId: 'setup-operation' } });
        expect(opened).toEqual(setup);
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
            openedInput = openExternalActionRequestV2({ envelope: request.envelope, binding, material })?.input;
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
