import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema,
    projectExternalActionDeploymentNativeEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: false }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { createUiDeploymentActionDeps } = await import('@/sync/api/deployments/deploymentActions');
const actionId = 'deployments.backups.restore';
const serverIdentityId = 'srv_restore_ingress';
const detail = createDeploymentEnvironmentDetailV1();
const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
let serverId: string;
let effects: unknown[];
let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>>;

beforeEach(async () => {
    await homes.reset();
    effects = [];
    serverId = await homes.addHome({ name: 'Restore Home', serverUrl: 'https://restore-ingress.test',
        serverIdentityId, accountId: 'owner', currentAccount: true });
    account = await captureLazyActionAccountContext(serverId);
    const machine = { ...createPlainMachineRowFixture({ id: 'runtime', accountId: 'owner' }),
        installationId: 'installed', installationPublicKey: encodeBase64(installation.publicKey) };
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    homes.answer(serverId, 'GET /v1/machines/runtime', { body: { machine } });
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
        ok: true, environment: detail.environment, targetLinks: [],
    } });
    // The daemon's network/native-effect boundary is substituted. Its actual
    // Action policy, confirmation digest and Environment-scope resolver run.
    const daemon = createActionExecutor({ ...createUiDeploymentActionDeps(account),
        presentUserActionConfirmation: async () => false,
        deploymentRestore: async input => {
            effects.push(input);
            return DeploymentActionOutputSchemasV1[actionId].parse(input.mode === 'prepare'
                ? { kind: 'prepared', operationId: 'prepared-restore', evidence: { backup: input.source } }
                : { kind: 'restored', verified: true, nextAction: 'none', evidence: { backup: input.source } });
        },
    });
    homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'restore-root', binding: {
            accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId,
            machineId: machine.id, installationId: machine.installationId, custodianAccountId: 'owner',
            accountEncryptionMode: 'plain', actionId, requestId: request.envelope.requestId,
            target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            environmentId: detail.environment.id,
            deploymentNativeAdmission: projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope: request.envelope }),
        } }) };
    } });
    homes.answer(serverId, `/v1/actions/${actionId}`, { select: async body => {
        const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
        const invocation = authorized.success ? openExternalActionRequesterAccountContextV1({
            authorization: authorized.data.executionAuthorization, purpose: { kind: 'external_action' },
            machineId: machine.id, installationId: machine.installationId, serverIdentityId,
            installationPrivateKey: installation.secretKey, includeInvocation: true,
        })?.invocation : undefined;
        const execution = await daemon.execute(actionId, envelope.input, {
            ...invocation, surface: invocation?.surface ?? 'ui', authority: invocation?.authority ?? 'present_user',
            ...(invocation ? { actionCaller: invocation.caller } : {}),
            ...(envelope.target ? { externalActionTarget: envelope.target } : {}),
            serverId, serverIdentityId, runtimeAccountId: 'owner', actionRequestId: envelope.requestId,
        });
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId, execution }) };
    } });
});
afterEach(async () => { account?.dispose(); await homes.reset(); });

function prepareInput() {
    return DeploymentActionInputSchemasV1[actionId].parse({ mode: 'prepare', serverId,
        environmentId: detail.environment.id, machineId: 'runtime', installationId: 'installed',
        targetLinkId: 'target', deploymentId: 'capture-receipt', source: { kind: 'repository', snapshotId: 'backup' }, expectedRevision: 3 });
}

describe('restore press through the UI Action front door', () => {
    it('dispatches prepare then confirm with the returned prepareOperationId to the daemon', async () => {
        const execute = createFrontDoorActionExecute();
        const input = prepareInput();
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'owner' };
        const prepared = await execute.confirmed(actionId, input, context);
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, result: { kind: 'prepared', operationId: 'prepared-restore' } });
        if (!prepared.ok) throw new Error('Restore preparation did not reach the daemon');
        const preparation = DeploymentActionOutputSchemasV1[actionId].parse(prepared.result);
        if (preparation.kind !== 'prepared') throw new Error('Expected restore preparation');
        const confirmed = { ...input, mode: 'confirm' as const, prepareOperationId: preparation.operationId };
        expect(await execute.confirmed(actionId, confirmed, context)).toMatchObject({ ok: true, result: { kind: 'restored' } });
        const ingress = homes.requestsFor(`/v1/actions/${actionId}`).map(record =>
            ExternalActionRequestEnvelopeV1Schema.parse(ExternalActionExecutionAuthorizationRequestV1Schema.parse(record.input).envelope));
        expect(ingress.map(request => request.input)).toEqual([input, confirmed]);
        expect(ingress.map(request => request.target)).toEqual([{ kind: 'machine', machineId: 'runtime' }, { kind: 'machine', machineId: 'runtime' }]);
        expect(effects).toEqual([input, confirmed]);
        expect(homes.artifacts(serverId).list()).toEqual([]);
    });

    it('refuses an unconfirmed restore at daemon admission without native effects', async () => {
        const result = await createFrontDoorActionExecute()(actionId, prepareInput(), { surface: 'ui', serverId, expectedAccountId: 'owner' });
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
        expect(effects).toEqual([]);
    });

    it('refuses a foreign Account before dispatching to the daemon', async () => {
        const result = await createFrontDoorActionExecute().confirmed(actionId, prepareInput(), {
            surface: 'ui', serverId, expectedAccountId: 'foreign',
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(homes.requestsFor(`/v1/actions/${actionId}`)).toEqual([]);
        expect(effects).toEqual([]);
    });
});
