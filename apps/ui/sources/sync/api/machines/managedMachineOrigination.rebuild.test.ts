import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { describe, expect, it, onTestFinished } from 'vitest';
import tweetnacl from 'tweetnacl';

import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedRebuildInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

installApprovalCommonModuleMocks();
// Install the shared presentation boundaries before loading the real Account transport.
const { executeManagedMachineNativeAction, isManagedMachineRetainedControlAction } = await import('./managedMachineOrigination');

it.each([
    ['machines.managed.power.set', { when: 'now' }, true],
    ['machines.managed.power.set', { when: 'after-idle' }, false],
    ['machines.managed.delete', { when: 'now' }, true],
    ['machines.managed.delete', { when: 'after-idle' }, false],
    ['machines.managed.inspect', {}, true],
    ['machines.managed.bootstrap.retry', {}, true],
    ['machines.managed.controller.update', {}, false],
] as const)('classifies UI retained invocation %s %j before selecting a controller', (actionId, input, retained) => {
    expect(isManagedMachineRetainedControlAction(actionId, input)).toBe(retained);
});

describe('managed Machine rebuild origination', () => {
    it.each((['machines.managed.rebuild', 'machines.managed.controller.update'] as const).flatMap(actionId =>
        (['plain', 'e2ee'] as const).map(accountMode => ({ accountMode, actionId }))))(
        'keeps foreign native requester custody private through exact installation sealing ($actionId, $accountMode)', async ({ accountMode, actionId }) => {
        const moving = actionId === 'machines.managed.controller.update';
        const homeId = `srv_foreign_${moving ? 'move' : 'rebuild'}_${accountMode}`;
        const serverUrl = `https://foreign-${moving ? 'move' : 'rebuild'}-${accountMode}.example.test`;
        const accountId = 'bob';
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64')}.signature`;
        await upsertServerProfile({ serverUrl, name: 'Requester Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        const credentials = accountMode === 'e2ee' ? { token, secret: encodeBase64(new Uint8Array(32).fill(29), 'base64url') } : { token };
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, credentials)).toBe(true);
        const encryption = accountMode === 'e2ee' ? await createEncryptionFromAuthCredentials(credentials) : undefined;
        const material = encryption ? { type: 'dataKey' as const, machineKey: encryption.getContentPrivateKey() } : undefined;
        const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
        const selectedController = { machineId: moving ? 'alice-destination' : 'alice-controller',
            installationId: moving ? 'alice-destination-installation' : 'alice-installation' };
        const input = moving ? { homeId, managedId: 'alice-child', expectedIntentRevision: 4,
            controller: selectedController, reviewedPendingEffects: true as const }
            : ManagedRebuildInputV1Schema.parse({ homeId, managedMachineId: 'alice-child', kind: 'rebuild',
                expectedRevision: 4, reviewedEffectDigest: 'a'.repeat(64) });
        const machine = ManagedMachineV1Schema.parse({ id: 'alice-child', homeId, custodianAccountId: 'alice',
            controller: { machineId: 'alice-controller', installationId: 'alice-installation' },
            launch: { provider: { pluginId: 'acme.devcontainer', localId: 'child' }, schemaVersion: 1, name: 'Child', choices: {} },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 4,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'acme.devcontainer', localId: 'child' }, schemaVersion: 1, value: {} } });
        const approval = { kind: 'approval_request_created' as const, artifactId: 'bob-native-ask', actionId };
        const binding = { serverIdentityId: homeId, accountId, authentication: { kind: 'account' as const, tokenEpoch: 1 },
            actionId, requestId: 'bob-original-rebuild',
            target: { kind: 'machine' as const, machineId: selectedController.machineId } };
        const effects: unknown[] = [];
        let mintedEnvelope: unknown;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            expect(new URL(String(url)).origin).toBe(serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            if (path === '/v1/account/encryption') return Response.json({ mode: accountMode, updatedAt: 1 });
            if (path === '/v1/machines/managed/actions/get') return Response.json(machine);
            // The Action Machine is read by id through the Machine rows reader (a532f4a1e0).
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body, id => (
                id === selectedController.machineId ? { ...createPlainMachineRowFixture({ id, accountId: 'alice' }),
                installationId: selectedController.installationId, installationPublicKey: encodeBase64(installation.publicKey) } : null));
            if (path === `/v1/actions/${actionId}/execution-authorization`) {
                const request = body as Readonly<{ envelope: unknown; machineId: string }>;
                const envelope = ExternalActionRequestEnvelopeSchema.parse(request.envelope);
                if (envelope.v === 2 && material) expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material })).toEqual({ input });
                expect(request.machineId).toBe(selectedController.machineId);
                mintedEnvelope = envelope;
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-signed-root', binding: {
                    accountId, authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: homeId,
                    machineId: selectedController.machineId, installationId: selectedController.installationId,
                    custodianAccountId: 'alice', accountEncryptionMode: accountMode, actionId: approval.actionId,
                    requestId: envelope.requestId, target: envelope.target,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                } }));
            }
            expect(path).toBe(`/v1/actions/${actionId}`);
            expect(body).toMatchObject({ v: 1, machineId: selectedController.machineId, envelope: mintedEnvelope,
                executionAuthorization: { token: 'home-signed-root', requesterAccountContext: { kind: 'installation_sealed_v1', installationId: selectedController.installationId } } });
            expect(JSON.stringify(body)).not.toContain(token);
            expect(JSON.stringify(body)).not.toContain('sessionId');
            const carried = body as Readonly<{ executionAuthorization: unknown; envelope: unknown }>;
            expect(openExternalActionRequesterAccountContextV1({ authorization: carried.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId: selectedController.machineId,
                installationId: selectedController.installationId, serverIdentityId: homeId,
                installationPrivateKey: installation.secretKey })).toEqual(accountMode === 'e2ee'
                    ? { token, secret: encodeBase64(new Uint8Array(32).fill(29)) } : { token });
            effects.push(body);
            const envelope = ExternalActionRequestEnvelopeSchema.parse(carried.envelope);
            if (envelope.v === 2 && material) return Response.json(prepareExternalActionResponseV2({ binding, request: envelope,
                material, randomBytes: getRandomBytes, executedMachineId: selectedController.machineId,
                execution: { ok: true, result: approval } }).response);
            return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: approval.actionId,
                requestId: 'bob-original-rebuild', execution: { ok: true, result: approval } }));
        });
        onTestFinished(resetRuntimeFetch);
        const account = await captureLazyActionAccountContext(homeId);
        onTestFinished(() => account.dispose());
        const result = await executeManagedMachineNativeAction({ account, actionId, input,
            context: { surface: 'ui', authority: 'present_user', actionRequestId: 'bob-original-rebuild' } });
        expect(result).toEqual({ ok: true, result: approval });
        expect(effects).toHaveLength(1);
    });

    it.each([{ actionId: 'machines.managed.rebuild', revoked: false }, { actionId: 'machines.setup.apply', revoked: false },
        { actionId: 'machines.setup.apply', revoked: true }] as const)(
        'routes only the current reviewed exact machine ($actionId, revoked=$revoked)', async ({ actionId, revoked }) => {
        const applyingEnvironment = actionId === 'machines.setup.apply';
        const homeId = applyingEnvironment ? `srv_environment_origination_home_${revoked}` : 'srv_rebuild_origination_home';
        const serverUrl = applyingEnvironment ? `https://environment-origination-${revoked}.example.test` : 'https://rebuild-origination.example.test';
        const accountId = 'rebuild-owner';
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64')}.signature`;
        await upsertServerProfile({ serverUrl, name: 'Rebuild Home' });
        const profile = await setServerProfileIdentityForUrl(serverUrl, homeId);
        expect(profile).not.toBeNull();
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, { token })).toBe(true);
        const rebuildInput = ManagedRebuildInputV1Schema.parse({ homeId, managedMachineId: 'retained-child', kind: 'rebuild',
            expectedRevision: 4, reviewedEffectDigest: 'a'.repeat(64) });
        const input = applyingEnvironment ? { homeId, machineId: 'ordinary-child',
            targets: [{ homeId, machineId: 'ordinary-child', desiredRevision: 0,
                sources: [{ kind: 'direct', setup: {} }], recipePlans: [], exclusions: [] }] } : rebuildInput;
        const machine = ManagedMachineV1Schema.parse({ id: rebuildInput.managedMachineId, homeId, custodianAccountId: accountId,
            controller: { machineId: 'physical-controller', installationId: 'physical-installation' },
            launch: { provider: { pluginId: 'acme.devcontainer', localId: 'child' }, schemaVersion: 1,
                name: 'Child', choices: {} }, allocation: 'bound', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: rebuildInput.expectedRevision,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrolledMachineId: 'ordinary-child',
            resource: { contributionRef: { pluginId: 'acme.devcontainer', localId: 'child' }, schemaVersion: 1, value: {} },
        });
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const approval = { kind: 'approval_request_created' as const, artifactId: 'rebuild-approval', actionId };
        // Only Home HTTP is substituted. Scope, credential storage, token parsing,
        // row validation, target selection and public envelope owners remain real.
        setRuntimeFetch(async (url, init) => {
            const parsedUrl = new URL(String(url));
            expect(parsedUrl.origin).toBe(serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            if (parsedUrl.pathname === '/v1/account/encryption') {
                return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
            }
            if (parsedUrl.pathname === '/v1/machines/managed/actions/get') {
                expect(applyingEnvironment).toBe(false);
                expect(body).toEqual({ homeId, managedId: rebuildInput.managedMachineId });
                return new Response(JSON.stringify(machine), { status: 200 });
            }
            if (parsedUrl.pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body, id => (
                id === 'ordinary-child' ? { ...createPlainMachineRowFixture({ id, accountId }),
                installationId: 'joined-installation', revokedAt: revoked ? 5 : null } : null));
            if (parsedUrl.pathname === `/v1/actions/${actionId}`) {
                expect(revoked).toBe(false);
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
                expect(envelope.target).toEqual({ kind: 'machine', machineId: applyingEnvironment ? 'ordinary-child' : nativeController.machineId });
                expect(envelope.input).toEqual(input);
                return new Response(JSON.stringify(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1,
                    actionId: approval.actionId, requestId: envelope.requestId, execution: { ok: true, result: approval } })), { status: 200 });
            }
            throw new Error(`Unexpected rebuild Home request: ${parsedUrl.pathname}`);
        });
        onTestFinished(resetRuntimeFetch);
        const account = await captureLazyActionAccountContext(homeId);
        onTestFinished(() => account.dispose());
        const result = await executeManagedMachineNativeAction({ account, actionId, input,
            context: { surface: 'ui', authority: 'present_user', actionRequestId: 'reviewed-rebuild-invocation' } });
        expect(result).toEqual(revoked ? { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' }
            : { ok: true, result: approval });
    });
});
