import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { describe, expect, it, onTestFinished } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { hasManagedMachinePresetCreationV1, ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionResponseEnvelopeV1Schema,
    projectExternalActionManagedAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { openExternalActionRequesterAccountContextV1, openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createDelegatedManagedPresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
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
    it.each([
        { mode: 'current', accountMode: 'plain' }, { mode: 'current', accountMode: 'e2ee' },
        { mode: 'pool', accountMode: 'plain' }, { mode: 'pool', accountMode: 'e2ee' },
        { mode: 'pool-unavailable', accountMode: 'plain' },
        { mode: 'stale', accountMode: 'plain' }, { mode: 'substituted', accountMode: 'plain' },
        { mode: 'withdrawn', accountMode: 'plain' },
        { mode: 'delete', accountMode: 'plain' }, { mode: 'delete', accountMode: 'e2ee' },
        { mode: 'recovery', accountMode: 'plain' }, { mode: 'inspect', accountMode: 'plain' },
        { mode: 'recovery', accountMode: 'e2ee' }, { mode: 'inspect', accountMode: 'e2ee' },
        { mode: 'operations-list', accountMode: 'plain' }, { mode: 'operations-list', accountMode: 'e2ee' },
        { mode: 'operations-get', accountMode: 'plain' }, { mode: 'operations-get', accountMode: 'e2ee' },
        { mode: 'missing-carrier', accountMode: 'plain' },
        { mode: 'session-caller', accountMode: 'e2ee' },
    ] as const)('uses only the exact public preset carrier ($mode, $accountMode)', async ({ mode, accountMode }) => {
        const actionId = mode === 'operations-list' ? 'action.operations.list' : mode === 'operations-get' ? 'action.operations.get'
            : mode === 'delete' ? 'machines.managed.delete' : mode === 'recovery' ? 'machines.managed.bootstrap.retry'
            : mode === 'inspect' || mode === 'missing-carrier' ? 'machines.managed.inspect' : 'machines.managed.acquire';
        const homeId = `srv_delegated_${mode}_${accountMode}`;
        const serverUrl = `https://delegated-${mode}-${accountMode}.example.test`;
        const accountId = 'requester';
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64')}.signature`;
        await upsertServerProfile({ serverUrl, name: 'Team Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        const credentials = accountMode === 'e2ee' ? { token, secret: encodeBase64(new Uint8Array(32).fill(29), 'base64url') } : { token };
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, credentials)).toBe(true);
        const encryption = accountMode === 'e2ee' ? await createEncryptionFromAuthCredentials(credentials) : undefined;
        const material = encryption ? { type: 'dataKey' as const, machineKey: encryption.getContentPrivateKey() } : undefined;
        const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
        const descriptor = MachineProvisionerContributionV1Schema.parse({ id: 'vm', title: 'VM', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            enrollmentRole: 'sandbox', launchSchema: { type: 'object', properties: {}, additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['delete'] },
            actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } });
        const exactPreset = createDelegatedManagedPresetFixture({ preset: { id: 'team-preset', homeId, revision: 4, name: 'Team VM',
            owner: { kind: 'team', teamId: 'company-team' }, controller: { machineId: 'company-controller', installationId: 'company-installation' },
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Team VM', choices: {} } },
            descriptor, custodianAccountId: 'company', installationPublicKey: encodeBase64(installation.publicKey, 'base64url') });
        const selectedController = { machineId: 'company-controller', installationId: 'company-installation' };
        const pool = mode === 'pool' || mode === 'pool-unavailable';
        const poolId = '4d783830-8626-4da8-8fde-a6da516025e1';
        const preset = pool && exactPreset.delegatedAcquire?.kind === 'ready'
            ? ManagedMachinePresetV1Schema.parse({ ...exactPreset, controller: undefined, controllerPoolId: poolId,
                delegatedAcquire: { ...exactPreset.delegatedAcquire, controller: undefined,
                    reviewedFacts: { ...exactPreset.delegatedAcquire.reviewedFacts, controller: undefined } } }) : exactPreset;
        if (!hasManagedMachinePresetCreationV1(preset)) throw new Error('Expected a creation-bearing delegated preset fixture');
        if (preset.delegatedAcquire?.kind !== 'ready') throw new Error('Expected the public delegated preset fixture');
        const facts = preset.delegatedAcquire.reviewedFacts;
        const input = mode === 'operations-list' || mode === 'operations-get' ? { serverId: homeId,
            machineId: selectedController.machineId, managed: { homeId, managedId: 'created-resource' },
            ...(mode === 'operations-get' ? { operationId: 'installation-operation', waitForTerminal: true, includeManagedPrompt: true } : {}) }
            : mode === 'delete' ? { homeId, managedId: 'created-resource', when: 'now', expectedRevision: 4, intent: 'delete', reviewedDependencies: true }
            : mode === 'recovery' ? { homeId, managedId: 'created-resource', expectedIntentRevision: 4 }
            : mode === 'inspect' || mode === 'missing-carrier' ? { homeId, managedId: 'created-resource' }
            : ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId, id: preset.id,
            revision: mode === 'stale' ? 3 : preset.revision }, controller: mode === 'substituted'
                ? { ...selectedController, installationId: 'substituted-installation' } : preset.controller,
            retention: facts.retention, wakeOnAcceptedMessage: facts.wakeOnAcceptedMessage,
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, reviewedFacts: facts });
        const requestId = 'delegated-create';
        const binding = { serverIdentityId: homeId, accountId, authentication: { kind: 'account' as const, tokenEpoch: 1 },
            actionId, requestId, target: { kind: 'machine' as const, machineId: selectedController.machineId } };
        const approval = { kind: 'approval_request_created' as const, artifactId: 'requester-approval', actionId };
        const output = mode === 'operations-list' ? { items: [], nextCursor: null }
            : mode === 'operations-get' ? { kind: 'not_found' } : approval;
        let privateMachineReads = 0;
        let authorizations = 0;
        let executions = 0;
        let poolResolves = 0;
        const boundInput = pool ? { ...input, controller: selectedController,
            reviewedFacts: exactPreset.delegatedAcquire?.kind === 'ready' ? exactPreset.delegatedAcquire.reviewedFacts : undefined } : input;
        const codecKeys: string[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (isServerFetchConnectivityProbeRequest(url)) return Response.json({});
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            if (path === '/v1/account/encryption') return Response.json({ mode: accountMode, updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createAccountEncryptionCurrentnessFixtureForCredentials(credentials));
            if (path === '/v1/machines/pools/resolve') {
                poolResolves++;
                expect(body).toEqual({ poolId, requestKey: requestId, purpose: 'managed-preset',
                    preset: { homeId, id: preset.id, revision: preset.revision } });
                return Response.json(mode === 'pool-unavailable' ? { kind: 'unavailable', poolId,
                    reason: 'managed_preset_unavailable', code: 'controller_unavailable' } : {
                    kind: 'resolved', poolId, machineId: selectedController.machineId, priorityTier: 0,
                    managedPreset: { controller: selectedController, controllerAccess: exactPreset.delegatedAcquire?.kind === 'ready'
                        ? exactPreset.delegatedAcquire.controller : undefined, provisioner: descriptor,
                        reviewedFacts: exactPreset.delegatedAcquire?.kind === 'ready' ? exactPreset.delegatedAcquire.reviewedFacts : undefined } });
            }
            if (path === '/v1/machines/managed/actions/get') return Response.json(ManagedMachineV1Schema.parse({
                id: 'created-resource', homeId, custodianAccountId: 'company', enrollmentAccountId: accountId,
                launch: preset.launch, controller: preset.controller, controllerAccess: mode !== 'missing-carrier' && preset.delegatedAcquire?.kind === 'ready'
                    ? preset.delegatedAcquire.controller : undefined,
                allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 4,
                retention: facts.retention, wakeOnAcceptedMessage: facts.wakeOnAcceptedMessage,
                resource: { contributionRef: preset.launch.provider, schemaVersion: 1, value: {} },
            }));
            if (path === '/v1/machines/presets/get') {
                expect(mode === 'recovery' || mode === 'inspect').toBe(false);
                return Response.json({ kind: 'found', preset: mode === 'withdrawn'
                ? { ...preset, delegatedAcquire: { kind: 'unavailable', code: 'permission_denied' } } : preset });
            }
            if (path === '/v1/machines/read-batch') { privateMachineReads += 1; return createMachineReadBatchResponseFixture(init?.body, () => null); }
            if (path.endsWith('/execution-authorization')) {
                authorizations += 1;
                const request = body as Readonly<{ envelope: unknown }>;
                const envelope = ExternalActionRequestEnvelopeSchema.parse(request.envelope);
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-signed-root', binding: {
                    ...binding, machineId: selectedController.machineId, installationId: selectedController.installationId,
                    custodianAccountId: 'company', accountEncryptionMode: accountMode,
                    ...(mode === 'delete' || mode === 'operations-list' || mode === 'operations-get'
                        ? { managedAdmission: { ...projectExternalActionManagedAdmissionV1(actionId, input),
                            ...(mode === 'delete' ? { authority: 'creator_recovery' } : {}) } } : {}),
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                } }));
            }
            expect(path).toBe(`/v1/actions/${actionId}`);
            executions += 1;
            const request = body as Readonly<{ envelope: unknown; executionAuthorization: unknown }>;
            const envelope = ExternalActionRequestEnvelopeSchema.parse(request.envelope);
            expect(openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId: selectedController.machineId,
                installationId: selectedController.installationId, serverIdentityId: homeId,
                installationPrivateKey: installation.secretKey })).toBeNull();
            const codec = openManagedControllerActionCodecV1({ authorization: request.executionAuthorization,
                machineId: selectedController.machineId, installationId: selectedController.installationId,
                serverIdentityId: homeId, installationPrivateKey: installation.secretKey });
            expect(codec).not.toBeNull();
            if (!codec) throw new Error('Expected invocation codec');
            codecKeys.push(encodeBase64(codec.machineKey));
            expect(codec).not.toHaveProperty('credentials');
            if (material) expect(codec.machineKey).not.toEqual(material.machineKey);
            if (envelope.v === 2) expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material: codec })).toEqual({ input: boundInput });
            else expect(envelope.input).toEqual(boundInput);
            return Response.json(envelope.v === 2 ? prepareExternalActionResponseV2({ binding, request: envelope,
                material: codec, randomBytes: getRandomBytes, executedMachineId: selectedController.machineId,
                execution: { ok: true, result: output } }).response : ExternalActionResponseEnvelopeV1Schema.parse({ v: 1,
                actionId, requestId, execution: { ok: true, result: output } }));
        });
        onTestFinished(resetRuntimeFetch);
        const account = await captureLazyActionAccountContext(homeId);
        onTestFinished(() => account.dispose());
        const result = await executeManagedMachineNativeAction({ account, actionId, input,
            context: { surface: 'ui', authority: 'present_user', actionRequestId: requestId,
                ...(mode === 'session-caller' ? { actionCaller: { kind: 'session' as const, sessionId: 'actual-session', starterDepth: 1, turnDepth: 2 } } : {}) } });
        expect(privateMachineReads).toBe(0);
        expect(poolResolves).toBe(pool ? 1 : 0);
        if (mode === 'delete' || mode === 'pool' || mode === 'current' || mode === 'recovery' || mode === 'inspect' || mode === 'operations-list' || mode === 'operations-get') {
            expect(result).toEqual({ ok: true, result: output });
            expect(authorizations).toBe(1); expect(executions).toBe(1);
            if (mode === 'current') {
                expect(await executeManagedMachineNativeAction({ account, actionId, input,
                    context: { surface: 'ui', authority: 'present_user', actionRequestId: requestId } })).toEqual(result);
                expect(codecKeys[0]).not.toBe(codecKeys[1]);
            }
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: mode === 'pool-unavailable' ? 'controller_unavailable' : mode === 'session-caller' ? 'admission_unavailable' : mode === 'missing-carrier' ? 'controller_unavailable' : mode === 'stale' ? 'request_conflict'
                : mode === 'substituted' ? 'controller_retired' : 'permission_denied' });
            expect(authorizations).toBe(0); expect(executions).toBe(0);
        }
    });
});
