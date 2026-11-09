import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';

afterEach(() => vi.restoreAllMocks());

it.each(['deployments.environments.update', 'deployments.bindings.set'] as const)(
    'prepares %s scope under its original signed root without claiming mutation custody', async actionId => {
        const { environment, targetLinks } = createDeploymentEnvironmentDetailV1();
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
        const target = { kind: 'machine' as const, machineId: 'controller' };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-home-root', binding: {
            accountId: 'owner', custodianAccountId: 'owner', serverIdentityId: environment.serverId,
            machineId: target.machineId, installationId: 'installed-controller', actionId,
            authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
            requestId: 'scope-request', requestEnvelopeDigest: 'a'.repeat(43), target,
        } });
        let metadataReads = 0;
        let issuedMutations = 0;
        let current = true;
        // Home HTTP is the boundary. Real executor, scope resolver, binding and
        // installation signer run beneath it; no scope or policy is mocked.
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(request.method).toBe('GET');
            const path = new URL(request.url!).pathname + new URL(request.url!).search;
            expect(path).toBe(`/v1/deployments/environments/${environment.id}?serverId=${environment.serverId}`);
            const effectActionId = request.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
            const signed = effectActionId === actionId && verifyExternalActionMachineRequestV1({
                authorizationToken: authorization.token, effectActionId, target,
                installationId: authorization.binding.installationId, requestId: authorization.binding.requestId,
                method: 'GET', path, signature: String(request.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
                publicKey: keys.publicKey,
            });
            metadataReads++;
            return signed ? { status: 200, data: { ok: true, environment,
                targetLinks: targetLinks.map(item => item.targetLink) } }
                : { status: 403, data: { ok: false, error: 'deployment_access_denied' } };
        });
        const storage = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
            admitAccount: async () => current ? null : { ok: false, errorCode: 'action_forbidden', error: 'action_forbidden' },
            resolveRequestHeaders: async (_context, effectActionId, wire) => createExternalActionAuthorizedRequestHeaders({
                authorization, effectActionId, target, installationId: authorization.binding.installationId,
                privateKey: keys.secretKey, ...wire,
            }),
            async dispatchReceipt() { throw new Error('Scope preparation cannot dispatch a receipt'); },
        });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...storage });
        const input = { serverId: environment.serverId, environmentId: environment.id, expectedRevision: environment.revision,
            contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
            contentBodyVersion: environment.contentBodyVersion,
            ...(actionId === 'deployments.bindings.set' ? { referencedSavedSecretRevisions: [] } : {}) };
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            actionCaller: { kind: 'host' as const }, serverId: environment.serverId, runtimeAccountId: 'owner',
            actionsSettings: setScopedActionApprovalPreference({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
                actionId, scope: { kind: 'environment', environmentId: environment.id }, surface: 'ui', mode: 'waived' }),
            externalActionExecutionAuthorization: authorization, onTransportIssued() { issuedMutations++; } };
        const prepared = await executor.prepare(actionId, input, context);
        expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
        expect(metadataReads).toBeGreaterThan(0);
        expect(issuedMutations).toBe(0);
        current = false;
        const readsBeforeRevocation = metadataReads;
        expect(await executor.prepare(actionId, input, context)).toMatchObject({ kind: 'settled', result: { ok: false } });
        expect(metadataReads).toBe(readsBeforeRevocation);
        expect(issuedMutations).toBe(0);
    });
