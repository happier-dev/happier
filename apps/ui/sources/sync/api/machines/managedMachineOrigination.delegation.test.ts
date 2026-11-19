import { bindManagedPresetAcquireOriginV1 } from '@happier-dev/cli-common/machines/managed';
import nacl from 'tweetnacl';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1, ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createManagedMachinePresetAcquireOverrideV1,
    projectManagedMachinePresetForRecipientV1, sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema,
    ExternalActionResponseEnvelopeV1Schema, projectExternalActionManagedAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { describe, expect, it, onTestFinished } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDelegatedManagedPresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { createMachineFixture, createMachineReadBatchResponseFixture,
    createPlainSharedMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

installApprovalCommonModuleMocks();
const { executeManagedMachineNativeAction } = await import('./managedMachineOrigination');

describe('delegated managed preset origination', () => {
    it.each(['current', 'pool', 'pool-unavailable', 'pool-malformed', 'stale'] as const)(
        'binds opaque preset origins through the canonical public Pool projection ($mode)',
        async mode => {
            const homeId = 'srv_delegated';
            const poolId = '4d783830-8626-4da8-8fde-a6da516025e1';
            const controller = { machineId: 'company-controller', installationId: 'company-installation' };
            const descriptor = MachineProvisionerContributionV1Schema.parse({ id: 'vm', title: 'VM', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
                enrollmentRole: 'sandbox', launchSchema: { type: 'object', properties: {}, additionalProperties: false },
                resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
                billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['delete'] },
                actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } });
            const usesPool = mode === 'pool' || mode === 'pool-unavailable' || mode === 'pool-malformed';
            const preset = createDelegatedManagedPresetFixture({
                preset: { id: 'team-preset', homeId, revision: 4, name: 'Team VM private snapshot',
                    owner: { kind: 'team', teamId: 'company-team' },
                    ...(usesPool ? { controllerPoolId: poolId } : { controller }),
                    launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1,
                        name: 'Team VM private launch', choices: {} } },
                descriptor, custodianAccountId: 'company',
                installationPublicKey: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
            });
            const publicCarrier = JSON.parse(JSON.stringify(preset)) as Record<string, unknown>;
            expect(publicCarrier).not.toHaveProperty('name');
            expect(publicCarrier).not.toHaveProperty('launch');
            expect(publicCarrier).not.toHaveProperty('delegatedAcquire');
            expect(publicCarrier).not.toHaveProperty('opened');
            expect(preset.opened.launch.name).toBe('Team VM private launch');

            const projection = projectManagedMachinePresetForRecipientV1({ content: preset.content,
                recipients: preset.recipients, recipientAccountId: 'requester' });
            const override = createManagedMachinePresetAcquireOverrideV1({ presetId: preset.id, mode: 'plain', projection,
                enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });
            expect(override).not.toBeNull();
            if (!override) throw new Error('Expected an opaque preset acquire override');
            const input = ManagedAcquireInputV1Schema.parse({
                selection: { kind: 'preset', homeId, id: preset.id, revision: mode === 'stale' ? 3 : preset.revision },
                ...(usesPool ? {} : { controller }),
                retention: preset.retention,
                wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage,
                presetContentOverride: override,
            });
            const poolRequests: unknown[] = [];
            const result = await bindManagedPresetAcquireOriginV1({ input, preset, requestKey: 'delegated-create',
                resolveExact: async () => ({ kind: 'resolved', controller, controllerAccess: preset.opened.controllerAccess }),
                resolvePool: async request => {
                    poolRequests.push(request);
                    if (mode === 'pool-unavailable') return { kind: 'unavailable', poolId,
                        reason: 'managed_preset_unavailable', code: 'controller_unavailable' };
                    const managedPreset = {
                        preset: { id: preset.id, revision: preset.revision, contentEncryptionMode: preset.contentEncryptionMode },
                        controller, controllerAccess: preset.opened.controllerAccess,
                        retention: preset.retention, wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage,
                    };
                    return { kind: 'resolved', poolId, machineId: controller.machineId, priorityTier: 0,
                        managedPreset: mode === 'pool-malformed'
                            ? { preset: managedPreset.preset, controllerAccess: managedPreset.controllerAccess,
                                retention: managedPreset.retention, wakeOnAcceptedMessage: managedPreset.wakeOnAcceptedMessage }
                            : managedPreset };
                },
            });

            if (mode === 'stale') {
                expect(result).toEqual({ kind: 'refused', code: 'request_conflict' });
                expect(poolRequests).toEqual([]);
                return;
            }
            if (mode === 'pool-unavailable') {
                expect(result).toEqual({ kind: 'refused', code: 'controller_unavailable' });
            } else if (mode === 'pool-malformed') {
                expect(result).toEqual({ kind: 'refused', code: 'managed_response_invalid' });
            } else {
                expect(result).toEqual({ kind: 'bound',
                    controllerAccess: preset.opened.controllerAccess,
                    input: usesPool ? { ...input, controller } : input });
            }
            expect(poolRequests).toEqual(usesPool ? [{ poolId, requestKey: 'delegated-create', purpose: 'managed-preset',
                preset: { homeId, id: preset.id, revision: preset.revision } }] : []);
        },
    );

    it.each(['team-controller', 'local-refusal'] as const)(
        'routes exact E2EE preset acquisition from the public Action (%s)', async placement => {
            const homeId = 'srv_e2ee_preset';
            const serverUrl = 'https://e2ee-preset-acquire.example.test';
            const accountId = 'team-member';
            const custodianAccountId = 'team-owner';
            const requestId = 'team-preset-acquire';
            const actionId = 'machines.managed.acquire';
            const route = '/v1/actions/machines.managed.acquire';
            const controller = { machineId: 'team-controller', installationId: 'team-controller-installation' };
            const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(37));
            const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }),
                secret: encodeBase64(new Uint8Array(32).fill(41), 'base64url') };
            const encryption = await createEncryptionFromAuthCredentials(credentials);
            const recipient = { account: { kind: 'account' as const, accountId, name: null, firstName: null,
                lastName: null, username: null, avatarUrl: null },
                readiness: { status: 'available' as const, contentPublicKey: encodeBase64(encryption.contentDataKey),
                    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey) },
                envelopeStatus: 'missing' as const };
            const presetId = 'team-private-preset';
            const launchName = 'Team private installation-only launch';
            const sealed = sealManagedMachinePresetContentV1({ presetId, mode: 'e2ee',
                content: { v: 1, name: 'Team delegated preset', launch: { provider: { pluginId: 'custom.compute', localId: 'vm' },
                    schemaVersion: 1, name: launchName, choices: {} } },
                recipientCensus: [recipient], randomBytes: getRandomBytes });
            const preset = ManagedMachinePresetV1Schema.parse({ id: presetId, homeId, revision: 4,
                owner: { kind: 'team', teamId: 'team' }, contentEncryptionMode: 'e2ee', ...sealed,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                ...(placement === 'team-controller' ? { controller, teamAcquireDelegated: true } : {}) });
            const override = createManagedMachinePresetAcquireOverrideV1({ presetId, mode: 'e2ee', accountId,
                accountKey: encryption.getContentPrivateKey(), randomBytes: getRandomBytes,
                projection: projectManagedMachinePresetForRecipientV1({ ...sealed, recipientAccountId: accountId }),
                enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });
            if (!override) throw new Error('Expected a sealed acquisition override');
            const input = ManagedAcquireInputV1Schema.parse({
                selection: { kind: 'preset', homeId, id: presetId, revision: preset.revision }, presetContentOverride: override });
            const boundInput = ManagedAcquireInputV1Schema.parse({ ...input, controller });
            const binding = { serverIdentityId: homeId, accountId, actionId, requestId,
                target: { kind: 'machine' as const, machineId: controller.machineId },
                authentication: { kind: 'account' as const, tokenEpoch: 0 } };
            const approval = { kind: 'approval_request_created', artifactId: 'create-approval', actionId };
            await upsertServerProfile({ serverUrl, name: 'Team Home' });
            await setServerProfileIdentityForUrl(serverUrl, homeId);
            expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, credentials)).toBe(true);

            let deliveredInput: unknown;
            let deliveryError: unknown;
            const routingReads: unknown[] = [];
            setRuntimeFetch(async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (isServerFetchConnectivityProbeRequest(url)) return Response.json({});
                const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createAccountEncryptionCurrentnessFixtureForCredentials(credentials));
                if (path === '/v1/machines/presets/get') return Response.json({ kind: 'found', preset });
                if (path === MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1) {
                    routingReads.push(body);
                    return Response.json({ kind: 'resolved', controller, controllerAccess: {
                        custodian: { accountId: custodianAccountId }, installationPublicKey: encodeBase64(keys.publicKey, 'base64url'),
                    } });
                }
                if (path === `${route}/execution-authorization`) {
                    const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                    return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-team-preset-authorization',
                        binding: { ...binding, ...controller, custodianAccountId, accountEncryptionMode: 'e2ee',
                            managedAcquireDelegation: true, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } }));
                }
                if (path === route) {
                    try {
                        expect(JSON.stringify(body)).not.toContain(launchName);
                        expect(JSON.stringify(body)).not.toContain(credentials.token);
                        const { envelope, executionAuthorization } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                        if (envelope.v !== 2 || !executionAuthorization) throw new Error('Expected a signed encrypted controller request');
                        const material = openManagedControllerActionCodecV1({ authorization: executionAuthorization, serverIdentityId: homeId,
                            ...controller, installationPrivateKey: keys.secretKey });
                        if (!material) throw new Error('Expected the exact installation to open the invocation codec');
                        expect(material.machineKey).not.toEqual(encryption.getContentPrivateKey());
                        deliveredInput = openExternalActionRequestV2({ envelope, binding, material,
                            projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
                        return Response.json(prepareExternalActionResponseV2({ request: envelope, binding, material, randomBytes: getRandomBytes,
                            executedMachineId: controller.machineId, execution: { ok: true, result: approval } }).response);
                    } catch (error) {
                        deliveryError = error;
                        throw error;
                    }
                }
                return Response.json({}, { status: 404 });
            });
            onTestFinished(resetRuntimeFetch);
            const account = await captureLazyActionAccountContext(homeId);
            onTestFinished(() => account.dispose());

            const result = await executeManagedMachineNativeAction({ account, actionId, input,
                context: { surface: 'ui', authority: 'present_user', actionRequestId: requestId } });
            if (placement === 'local-refusal') {
                expect(result).toMatchObject({ ok: false, errorCode: 'guest_cli_identity_unavailable',
                    failureCause: { errorCode: 'guest_cli_identity_unavailable' } });
                expect(routingReads).toEqual([]);
                expect(deliveredInput).toBeUndefined();
                return;
            }
            expect(deliveryError).toBeUndefined();
            expect(result).toEqual({ ok: true, result: approval });
            expect(routingReads).toEqual([{ homeId, id: presetId, revision: preset.revision, controller }]);
            expect(deliveredInput).toEqual({ input: boundInput });
        },
    );

    it('routes deletion from an opaque captured preset row without reopening its private preset', async () => {
        const homeId = 'srv_delegated_delete';
        const serverUrl = 'https://delegated-delete.example.test';
        const accountId = 'requester';
        const controller = { machineId: 'company-controller', installationId: 'company-installation' };
        const requestId = 'delegated-delete';
        const token = createAccountTokenForTests(accountId, { currentAccount: true });
        const credentials = { token };
        await upsertServerProfile({ serverUrl, name: 'Team Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, credentials)).toBe(true);
        const descriptor = MachineProvisionerContributionV1Schema.parse({ id: 'vm', title: 'VM', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            enrollmentRole: 'sandbox', launchSchema: { type: 'object', properties: {}, additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['delete'] },
            actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } });
        const preset = createDelegatedManagedPresetFixture({
            preset: { id: 'team-preset', homeId, revision: 4, name: 'Team VM private snapshot',
                owner: { kind: 'team', teamId: 'company-team' }, controller,
                launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1,
                    name: 'Team VM private launch', choices: {} } },
            descriptor, custodianAccountId: 'company',
            installationPublicKey: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
        });
        const read = {
            machine: { id: 'created-resource', homeId, custodianAccountId: 'company', enrollmentAccountId: accountId,
                preset: { id: preset.id, revision: preset.revision, contentEncryptionMode: preset.contentEncryptionMode },
                controller, controllerAccess: preset.opened.controllerAccess,
                allocation: 'bound' as const, creationState: 'active' as const, desired: 'stop' as const,
                desiredWhen: 'now' as const, intentRevision: 4, retention: preset.retention,
                wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage },
            presetContent: projectManagedMachinePresetForRecipientV1({ content: preset.content,
                recipients: preset.recipients, recipientAccountId: accountId }),
        };
        const input = { homeId, managedId: read.machine.id, when: 'now' as const, expectedRevision: 4,
            intent: 'delete' as const, reviewedDependencies: true as const };
        const approval = { kind: 'approval_request_created' as const, artifactId: 'requester-approval', actionId: 'machines.managed.delete' as const };
        let presetReads = 0;
        let authorizations = 0;
        let executions = 0;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (isServerFetchConnectivityProbeRequest(url)) return Response.json({});
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createAccountEncryptionCurrentnessFixtureForCredentials(credentials));
            if (path === '/v1/machines/managed/actions/get') return Response.json(read);
            if (path === '/v1/machines/presets/get') { presetReads += 1; return Response.json({ code: 'not_found' }, { status: 404 }); }
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, machineId => machineId === controller.machineId
                ? { ...createPlainSharedMachineRowFixture({ id: machineId, custodianAccountId: 'company',
                    machine: createMachineFixture({ id: machineId, activeAt: Date.now() }) }),
                installationId: controller.installationId, installationPublicKey: encodeBase64(new Uint8Array(32).fill(3), 'base64') }
                : null);
            if (path.endsWith('/execution-authorization')) {
                authorizations += 1;
                const request = body as Readonly<{ envelope: unknown }>;
                const envelope = ExternalActionRequestEnvelopeSchema.parse(request.envelope);
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-signed-root', binding: {
                    serverIdentityId: homeId, accountId, authentication: { kind: 'account', tokenEpoch: 0 },
                    actionId: 'machines.managed.delete', requestId, target: { kind: 'machine', machineId: controller.machineId },
                    machineId: controller.machineId, installationId: controller.installationId, custodianAccountId: 'company',
                    accountEncryptionMode: 'plain',
                    managedAdmission: { ...projectExternalActionManagedAdmissionV1('machines.managed.delete', input), authority: 'creator_recovery' },
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                } }));
            }
            expect(path).toBe('/v1/actions/machines.managed.delete');
            executions += 1;
            const request = body as Readonly<{ envelope: unknown }>;
            const envelope = ExternalActionRequestEnvelopeSchema.parse(request.envelope);
            expect(envelope.v).toBe(1);
            if (envelope.v !== 1) throw new Error('Expected the Plain Account Action envelope');
            expect(envelope.target).toEqual({ kind: 'machine', machineId: controller.machineId });
            expect(envelope.input).toEqual(input);
            expect(JSON.stringify(envelope)).not.toContain('Team VM private launch');
            return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.managed.delete', requestId,
                execution: { ok: true, result: approval } }));
        });
        onTestFinished(resetRuntimeFetch);
        const account = await captureLazyActionAccountContext(homeId);
        onTestFinished(() => account.dispose());

        const result = await executeManagedMachineNativeAction({ account, actionId: 'machines.managed.delete', input, confirmInFlow: true,
            context: { surface: 'ui', authority: 'present_user', actionRequestId: requestId } });

        expect(result).toEqual({ ok: true, result: approval });
        expect(authorizations).toBe(1);
        expect(executions).toBe(1);
        expect(presetReads).toBe(0);
    });
});
