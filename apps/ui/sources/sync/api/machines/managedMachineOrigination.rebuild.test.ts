import { describe, expect, it, onTestFinished, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedRebuildInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { Modal } from '@/modal';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const disclosure = vi.hoisted(() => vi.fn(async () => true));
installApprovalCommonModuleMocks();
// Install the presentation boundary before loading the real transport that imports it.
const { executeManagedMachineNativeAction } = await import('./managedMachineOrigination');

describe('managed Machine rebuild origination', () => {
    it.each((['machines.managed.rebuild', 'machines.managed.controller.update'] as const).flatMap(actionId =>
        ([{ accountMode: 'plain', accepted: true }, { accountMode: 'plain', accepted: false }, { accountMode: 'e2ee', accepted: true }] as const)
            .map(value => ({ ...value, actionId }))))(
        'keeps foreign native requester custody private and requires confidentiality consent ($actionId, $accountMode, $accepted)', async ({ accountMode, accepted, actionId }) => {
        disclosure.mockReset().mockResolvedValue(accepted);
        const confirm = vi.spyOn(Modal, 'confirm').mockImplementation(disclosure);
        onTestFinished(() => confirm.mockRestore());
        const moving = actionId === 'machines.managed.controller.update';
        const homeId = `srv_foreign_${moving ? 'move' : 'rebuild'}_${accountMode}_${accepted}`;
        const serverUrl = `https://foreign-${moving ? 'move' : 'rebuild'}-${accountMode}-${accepted}.example.test`;
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
            if (path === '/v1/machines') return Response.json([{ id: selectedController.machineId, kind: 'persistent', active: true,
                installationId: selectedController.installationId, installationPublicKey: encodeBase64(installation.publicKey),
                revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
                access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }]);
            expect(disclosure).toHaveBeenCalledOnce();
            expect(accepted).toBe(true);
            if (path === `/v1/actions/${actionId}/execution-authorization`) {
                const request = body as Readonly<{ envelope: unknown; machineId: string }>;
                const envelope = ExternalActionRequestEnvelopeSchema.parse(request.envelope);
                if (envelope.v === 2 && material) expect(openExternalActionRequestV2({ envelope, binding, material })).toEqual({ input });
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
        expect(disclosure, JSON.stringify(result)).toHaveBeenCalledOnce();
        const disclosed = JSON.stringify(disclosure.mock.calls);
        expect(disclosed).toContain('machineRequester.fullSignIn');
        expect(disclosed).toContain('machineRequester.osVisibility');
        expect(disclosed).not.toContain(token);
        expect(result).toMatchObject(accepted ? { ok: true, result: approval } : { ok: false });
        expect(effects).toHaveLength(accepted ? 1 : 0);
    });

    it('resolves the specialized retained row id to its controller without changing the reviewed rebuild input', async ({ onTestFinished }) => {
        const homeId = 'srv_rebuild_origination_home';
        const serverUrl = 'https://rebuild-origination.example.test';
        const accountId = 'rebuild-owner';
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64')}.signature`;
        await upsertServerProfile({ serverUrl, name: 'Rebuild Home' });
        const profile = await setServerProfileIdentityForUrl(serverUrl, homeId);
        expect(profile).not.toBeNull();
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, { token })).toBe(true);
        const input = ManagedRebuildInputV1Schema.parse({ homeId, managedMachineId: 'retained-child', kind: 'rebuild',
            expectedRevision: 4, reviewedEffectDigest: 'a'.repeat(64) });
        const machine = ManagedMachineV1Schema.parse({ id: input.managedMachineId, homeId, custodianAccountId: accountId,
            controller: { machineId: 'physical-controller', installationId: 'physical-installation' },
            launch: { provider: { pluginId: 'acme.devcontainer', localId: 'child' }, schemaVersion: 1,
                name: 'Child', choices: {} }, allocation: 'bound', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: input.expectedRevision,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrolledMachineId: 'ordinary-child',
            resource: { contributionRef: { pluginId: 'acme.devcontainer', localId: 'child' }, schemaVersion: 1, value: {} },
        });
        const approval = { kind: 'approval_request_created' as const, artifactId: 'rebuild-approval', actionId: 'machines.managed.rebuild' };
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
                expect(body).toEqual({ homeId, managedId: input.managedMachineId });
                return new Response(JSON.stringify(machine), { status: 200 });
            }
            if (parsedUrl.pathname === '/v1/actions/machines.managed.rebuild') {
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
                expect(envelope.target).toEqual({ kind: 'machine', machineId: machine.controller.machineId });
                expect(envelope.input).toEqual(input);
                return new Response(JSON.stringify(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1,
                    actionId: approval.actionId, requestId: envelope.requestId, execution: { ok: true, result: approval } })), { status: 200 });
            }
            throw new Error(`Unexpected rebuild Home request: ${parsedUrl.pathname}`);
        });
        onTestFinished(resetRuntimeFetch);
        const account = await captureLazyActionAccountContext(homeId);
        onTestFinished(() => account.dispose());
        const result = await executeManagedMachineNativeAction({ account, actionId: 'machines.managed.rebuild', input,
            context: { surface: 'ui', authority: 'present_user', actionRequestId: 'reviewed-rebuild-invocation' } });
        expect(result).toEqual({ ok: true, result: approval });
    });
});
