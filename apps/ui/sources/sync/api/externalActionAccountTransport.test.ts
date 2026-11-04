import nacl from 'tweetnacl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
const { machinePluginUiResourceRead } = await import('@/sync/ops/machineContributionRegistryProjection');
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '@/sync/domains/session/spawn/spawnSessionRpcTimeout';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

// Only authenticated HTTP and device credential IO leave this process.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { executeOriginalAccountActionTransport, executeOriginalAccountMachineAction, readOriginalAccountActionMachine } = await import('./externalActionAccountTransport');
let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
let serverId: string;
const path = '/v1/actions/plugins.uninstall';
const binding: ExternalActionEncryptionBindingV2 = {
    serverIdentityId: 'srv_plugin_transport', accountId: 'owner',
    authentication: { kind: 'account', tokenEpoch: 0 },
    actionId: 'plugins.uninstall', requestId: 'uninstall-1', target: { kind: 'machine', machineId: 'machine-1' },
};

beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Plugin transport', serverUrl: 'https://plugin-transport.test',
        serverIdentityId: binding.serverIdentityId, accountId: 'owner', currentAccount: true, active: false });
    account = await captureLazyActionAccountContext(serverId);
});
afterEach(async () => { account?.dispose(); account = null; vi.useRealTimers(); await homes.reset(); });

function answerOwnedMachine() {
    const machine = { ...createPlainMachineRowFixture({ id: 'machine-1', accountId: 'owner' }), installationId: 'installation-1' };
    homes.answer(serverId, '/v1/machines/machine-1', { body: { machine } });
}

async function execute() {
    if (!account) throw new Error('Expected captured Account');
    const result = await executeOriginalAccountActionTransport({ account, binding,
        input: { machineId: 'machine-1', pluginId: 'example.plugin' }, authority: 'present_user' });
    expect(homes.requestsFor(path)).toHaveLength(1);
    expect(ActionExecuteFailureSchema.safeParse(result).success).toBe(true);
    return result;
}

describe('captured Account Action response decoding', () => {
    it('routes a native host Resource read through its original Account logs Action', async () => {
        const actionId = 'machines.services.logs.read';
        const resource = { hostRead: 'machines.services.logs' as const,
            input: { serverId, machineId: 'machine-1', serviceId: 'worker' },
            expectedGeneration: 'generation', sourceRevision: 'source' };
        const row = { ...createPlainMachineRowFixture({ id: 'machine-1', accountId: 'owner' }),
            installationId: 'installation-1' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        const actionPath = `/v1/actions/${actionId}`;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-resource-proof', binding: {
                ...binding, actionId, requestId: envelope.requestId, machineId: 'machine-1', installationId: 'installation-1',
                custodianAccountId: 'owner', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        const result = { ok: true, resource, contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
            bytesBase64: 'e30=' };
        homes.answer(serverId, actionPath, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } };
        } });
        expect(await machinePluginUiResourceRead('machine-1', { serverId, accountId: 'owner', resource }))
            .toEqual({ supported: true, result });
        expect(homes.requestsFor(actionPath)).toHaveLength(1);
    });

    it('binds native logs continuation and generation into the exact Home-minted original invocation', async () => {
        if (!account) throw new Error('Expected captured Account');
        const logsBinding = { ...binding, actionId: 'machines.services.logs.read', requestId: 'logs-resource-read' };
        const input = { serverId, machineId: 'machine-1', serviceId: 'worker',
            cursor: { sourceRevision: 'native-source-1', token: 'selected-cursor' } };
        const resource = { hostRead: 'machines.services.logs' as const, input,
            expectedGeneration: 'generation-1', sourceRevision: 'native-source-1' };
        const resourceContinuation = { method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
            params: { machineId: input.machineId, resource } };
        const machineServiceLogsGeneration = { expectedGeneration: resource.expectedGeneration };
        const actionPath = `/v1/actions/${logsBinding.actionId}`;
        const installation = nacl.sign.keyPair();
        let mintedEnvelope: unknown;
        let receivedEnvelope: unknown;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            mintedEnvelope = envelope;
            return { body: { v: 1, token: 'home-native-logs-proof', binding: {
                ...logsBinding, machineId: 'machine-1', installationId: 'installation-1', custodianAccountId: 'owner',
                accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        homes.answer(serverId, actionPath, { select: body => {
            receivedEnvelope = typeof body === 'object' && body !== null && 'envelope' in body ? body.envelope : body;
            return { body: { v: 1, actionId: logsBinding.actionId, requestId: logsBinding.requestId,
                execution: { ok: true, result: { accepted: true } } } };
        } });
        const request = { account, binding: logsBinding, input, resourceContinuation, machineServiceLogsGeneration,
            machineCustody: { accountMode: 'plain' as const, installationId: 'installation-1',
                installationPublicKey: installation.publicKey, custodian: { accountId: 'owner' } } };
        expect(await executeOriginalAccountActionTransport(request)).toEqual({ ok: true, result: { accepted: true } });
        expect(mintedEnvelope).toMatchObject({ input, resourceContinuation, machineServiceLogsGeneration });
        expect(receivedEnvelope).toEqual(mintedEnvelope);
    });

    it('reads only the exact Action Machine rather than the Account Machine census', async () => {
        const machines = Array.from({ length: 100 }, (_, index) => createPlainMachineRowFixture({ id: `machine-${index}`, accountId: 'owner' }));
        homes.answer(serverId, '/v1/machines', { body: machines });
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, id => machines.find(machine => machine.id === id) ?? null).json(),
        }) });
        if (!account) throw new Error('Expected captured Account');
        expect(await readOriginalAccountActionMachine(account, 'machine-42')).toMatchObject({ id: 'machine-42' });
        expect(homes.requests.filter(request => new URL(request.path, 'https://plugin-transport.test').pathname === '/v1/machines')).toHaveLength(0);
        expect(homes.requestsFor('/v1/machines/read-batch').map(request => request.input)).toEqual([{ machineIds: ['machine-42'] }]);
    });

    it('refuses private Machine discovery without a captured Account read transport', async () => {
        if (!account) throw new Error('Expected captured Account');
        const before = homes.requests.length;
        expect(await readOriginalAccountActionMachine({ ...account, readTransport: undefined }, 'machine-1')).toBeNull();
        expect(homes.requests.slice(before)).toHaveLength(0);
    });

    it('preserves Account page source and version through the real Machine Action envelope', async () => {
        answerOwnedMachine();
        const mountedBinding = { pluginId: 'com.acme.portable', contributionLocalId: 'page', occurrenceId: 'account-custody',
            pluginVersion: '1.0.0', sourceCustody: { kind: 'bundled_first_party' as const,
                packagedRuntime: { kind: 'source_declaration' as const, packageName: '@acme/portable' } } };
        homes.answer(serverId, path, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.pluginInvocation).toEqual({ kind: 'mountedPluginSurface', mountedBinding });
            return { body: { v: 1, actionId: binding.actionId, requestId: envelope.requestId,
                execution: { ok: true, result: { completed: true } } } };
        } });
        if (!account) throw new Error('Expected captured Account');
        expect(await executeOriginalAccountMachineAction({ account, machineId: 'machine-1', actionId: binding.actionId,
            requestId: binding.requestId, input: {}, actionCaller: { kind: 'plugin', ...mountedBinding } })).toMatchObject({ ok: true, result: { completed: true } });
    });
    it('carries an Account surface declaration through Action dispatch and the canonical executor into the Machine envelope', async () => {
        const { createActionExecutor } = await import('@happier-dev/protocol/actions');
        const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
        const { dispatchPluginSurfaceAction } = await import('@/components/plugins/surfaces/pluginSurfaceActionDispatch');
        const capturedAccount = account;
        if (!capturedAccount) throw new Error('Expected captured Account');
        answerOwnedMachine();
        const mountedBinding = { pluginId: 'com.acme.portable', contributionLocalId: 'page', occurrenceId: 'account-custody',
            pluginVersion: '1.0.0', sourceCustody: { kind: 'bundled_first_party' as const,
                packagedRuntime: { kind: 'source_declaration' as const, packageName: '@acme/portable' } } };
        let receivedInvocation: unknown;
        homes.answer(serverId, '/v1/actions/plugins.list', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            receivedInvocation = envelope.pluginInvocation;
            return { body: { v: 1, actionId: 'plugins.list', requestId: envelope.requestId,
                execution: { ok: true, result: { ok: true, kind: 'plugins_list', plugins: [] } } } };
        } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            // The native plugin-management effect leaves through its real HTTP adapter.
            pluginsDevLoopAction: async ({ actionId, input, context }) => {
                const result = await executeOriginalAccountMachineAction({ account: capturedAccount, machineId: 'machine-1',
                    requestId: 'page-dispatch', actionId, input, actionCaller: context.actionCaller });
                return result.ok ? result.result : result;
            },
        }));
        expect(await dispatchPluginSurfaceAction({ callerPluginId: mountedBinding.pluginId, callerContributionLocalId: 'page',
            callerBinding: mountedBinding, action: 'plugins.list', input: {}, hostAction: { execute: executor.execute } }))
            .toEqual({ ok: true, result: { ok: true, kind: 'plugins_list', plugins: [] } });
        expect(receivedInvocation).toEqual({ kind: 'mountedPluginSurface', mountedBinding });
    });
    it.each(['action_not_admitted', 'action_outcome_unknown'] as const)('preserves request correlation for %s and refuses a mismatched reply', async code => {
        const refusal = projectExternalActionHttpError(code, binding.requestId);
        homes.answer(serverId, path, { status: refusal.statusCode, body: refusal.payload });
        expect(await execute()).toMatchObject({ ok: false, errorCode: code, details: { requestId: binding.requestId } });
        homes.answer(serverId, path, { status: refusal.statusCode,
            body: projectExternalActionHttpError(code, 'another-request').payload });
        if (!account) throw new Error('Expected captured Account');
        expect(await executeOriginalAccountActionTransport({ account, binding, input: {} }))
            .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });

    it('projects native optional members before the strict envelope for other app Action families', async () => {
        homes.answer(serverId, path, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.input).toEqual({ machineId: 'machine-1', pluginId: 'example.plugin',
                options: { enabled: false, selection: null } });
            return { body: { v: 1, actionId: binding.actionId, requestId: binding.requestId,
                execution: { ok: true, result: { completed: true } } } };
        } });
        if (!account) throw new Error('Expected captured Account');
        expect(await executeOriginalAccountActionTransport({ account, binding, input: {
            machineId: 'machine-1', pluginId: 'example.plugin', optional: undefined,
            options: { optional: undefined, enabled: false, selection: null },
        } })).toEqual({ ok: true, result: { completed: true } });
        expect(homes.requestsFor(path)).toHaveLength(1);
    });

    it.each([new Map(), [undefined], { callback: () => true }])('refuses genuinely non-JSON input before HTTP issuance (%j)', async invalid => {
        if (!account) throw new Error('Expected captured Account');
        const onTransportIssued = vi.fn();
        expect(await executeOriginalAccountActionTransport({ account, binding,
            input: { invalid }, onTransportIssued })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(homes.requestsFor(path)).toEqual([]);
        expect(onTransportIssued).not.toHaveBeenCalled();
    });

    it('keeps non-spawn Action lifetime independent from the Session startup budget', async () => {
        let release!: () => void;
        homes.answer(serverId, path, { respondAfter: new Promise<void>(resolve => { release = resolve; }),
            body: { v: 1, actionId: binding.actionId, requestId: binding.requestId,
                execution: { ok: true, result: { completed: true } } } });
        if (!account) throw new Error('Expected captured Account');
        vi.useFakeTimers();
        let settled = false;
        const pending = executeOriginalAccountActionTransport({ account, binding,
            input: { machineId: 'machine-1', pluginId: 'example.plugin' }, authority: 'present_user' })
            .finally(() => { settled = true; });
        await waitForHomeGovernance(() => expect(homes.requestsFor(path)).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(readSpawnSessionRpcTimeoutMsFromEnv() + 1);
        expect(settled).toBe(false);
        release();
        await expect(pending).resolves.toEqual({ ok: true, result: { completed: true } });
    });

    it('keeps the server’s empty post-dispatch 502 acknowledgement loss uncertain', async () => {
        // registerExternalActionRoutes sends exactly this empty response after
        // its daemon dispatcher reports submitted_unknown, without a retry.
        homes.answer(serverId, path, { status: 502 });
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'outcome_uncertain' });
    });

    it.each([
        { status: 200 },
        { status: 502, body: { notAnActionResponse: true } },
    ])('does not reinterpret another malformed response as known acknowledgement loss (%j)', async answer => {
        homes.answer(serverId, path, answer);
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });

    it('preserves a schema-valid pre-dispatch refusal instead of making it uncertain', async () => {
        const refusal = projectExternalActionHttpError('invalid_envelope', binding.requestId);
        homes.answer(serverId, path, { status: refusal.statusCode, body: refusal.payload });
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'invalid_envelope' });
    });
});
