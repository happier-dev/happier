import { bindManagedPresetAcquireOriginV1 } from '@happier-dev/cli-common/machines/managed';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createManagedMachinePresetAcquireOverrideV1,
    projectManagedMachinePresetForRecipientV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema,
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
