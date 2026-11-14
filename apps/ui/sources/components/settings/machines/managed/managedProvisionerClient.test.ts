import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionRequestEnvelopeV2Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createMachineProvisionerOptionsFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

const harness = createHomeGovernanceHarness();
const reviewedEnrollmentIdentity = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
    role: 'server', adminAccessAtCreation: 'preauthorized' } satisfies ManagedMachineEnrollmentIdentityV1;
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
await import('@/sync/ops/actions/defaultActionExecutor');
beforeEach(async () => { await harness.reset(); resetScopedHomeActionExecutorsForTests(); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await harness.reset(); await standardCleanup(); });
describe('managed configurator uses the exact Home Action front door', () => {
    it('shares the selected availability answer across concurrent readers and launch-option edits', async () => {
        const homeId = 'srv_shared_availability';
        const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://shared-availability.example',
            serverIdentityId: homeId, accountId: 'shared-availability-owner', currentAccount: true });
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const bindingHook = await renderHook(() => ({ picker: useServerCredentialAccountScopeBinding(serverId),
            form: useServerCredentialAccountScopeBinding(serverId) }));
        await waitForHomeGovernance(() => expect(bindingHook.getCurrent().form.binding).not.toBeNull());
        const binding = bindingHook.getCurrent().form.binding!;
        const pickerBinding = bindingHook.getCurrent().picker.binding!;
        const held = createDeferred<void>();
        let available = true;
        harness.answer(serverId, '/v1/actions/machines.provisioners.check', { async select(value) {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            await held.promise;
            return { body: { v: 1, actionId: 'machines.provisioners.check', requestId: request.requestId,
                execution: { ok: true, result: available ? { available: true } : { available: false, code: 'lima_2_required' } } } };
        } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select(value) {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId,
                execution: { ok: true, result: createMachineProvisionerOptionsFixture() } } };
        } });
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const { readManagedConfiguration } = await import('./readManagedConfiguration');
        const { refreshManagedProvisionerAvailability } = await import('./managedProvisionerAvailability');
        const nativeInput = { homeId, controller: { machineId: 'controller', installationId: 'installation' },
            contribution: { pluginId: 'happier.machine.lima', localId: 'lima' } };
        const read = (cpus: number, capturedBinding = binding, signal = new AbortController().signal,
            occurrenceId = 'lima-installed') => readManagedConfiguration({ binding: capturedBinding,
            client: createManagedProvisionerClient(capturedBinding.scope, homeId), nativeInput, selectors: { cpus },
            occurrenceId, signal, onApprovalPending() {} });
        const departed = new AbortController();
        const first = read(2, pickerBinding, departed.signal);
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.check').length).toBeGreaterThan(0));
        departed.abort();
        const concurrent = read(4);
        held.resolve();
        expect(await first).toEqual({ kind: 'retired' });
        expect(await concurrent).toMatchObject({ kind: 'settled', check: { available: true } });
        available = false;
        expect(await read(8)).toMatchObject({ kind: 'settled', check: { available: true } });
        expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(1);
        expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(3);
        refreshManagedProvisionerAvailability(binding, nativeInput);
        expect(await read(8)).toMatchObject({ kind: 'settled', check: { available: false, code: 'lima_2_required' } });
        expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(2);
        available = true;
        expect(await read(8, binding, new AbortController().signal, 'lima-reinstalled'))
            .toMatchObject({ kind: 'settled', check: { available: true } });
        expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(3);
        await bindingHook.unmount();
    });
    it('qualifies availability by credential selectors while sharing unrelated launch-option edits', async () => {
        const homeId = 'srv_credential_selectors';
        const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://credential-selectors.example',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const bindingHook = await renderHook(() => useServerCredentialAccountScopeBinding(serverId));
        await waitForHomeGovernance(() => expect(bindingHook.getCurrent().binding).not.toBeNull());
        const binding = bindingHook.getCurrent().binding!;
        const qualifiers: unknown[] = [];
        harness.answer(serverId, '/v1/actions/machines.provisioners.check', { select(value) {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            qualifiers.push(request.input);
            return { body: { v: 1, actionId: 'machines.provisioners.check', requestId: request.requestId,
                execution: { ok: true, result: { available: true } } } };
        } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select(value) {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId,
                execution: { ok: true, result: createMachineProvisionerOptionsFixture() } } };
        } });
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const { readManagedConfiguration } = await import('./readManagedConfiguration');
        const nativeInput = { homeId, controller: { machineId: 'host', installationId: 'installation' },
            contribution: { pluginId: 'custom.compute', localId: 'container' } };
        const provisioner = { credentialPurposeRequirements: [{ purpose: 'coordinator',
            optionalWhen: { op: 'eq' as const, path: 'route.transport', value: 'direct' } }] };
        const read = async (cpus: number, transport: string, retained = false) => {
            const selectors = { route: { transport }, cpus };
            return readManagedConfiguration({ binding, client: createManagedProvisionerClient(binding.scope, homeId),
                nativeInput, provisioner, occurrenceId: 'container-installed', signal: new AbortController().signal,
                selectors: retained ? async () => ({ kind: 'succeeded' as const, value: selectors }) : selectors,
                optionsAfterAvailableCheck: true, onApprovalPending() {} });
        };
        expect(await read(2, 'direct', true)).toMatchObject({ kind: 'settled', check: { available: true } });
        expect(await read(4, 'direct')).toMatchObject({ kind: 'settled', check: { available: true } });
        expect(await read(4, 'coordinator')).toMatchObject({ kind: 'settled', check: { available: true } });
        expect(qualifiers).toEqual([
            { ...nativeInput, selectors: { route: { transport: 'direct' } } },
            { ...nativeInput, selectors: { route: { transport: 'coordinator' } } },
        ]);
        expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(3);
        await bindingHook.unmount();
    });
    it('preserves an unsuccessful options Action’s typed native failure', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://failed-options.example',
            serverIdentityId: 'srv_failed_options', accountId: 'owner', currentAccount: true });
        const nativeCause = { httpStatusClass: '4xx', code: 'forbidden' } as const;
        const details = { kind: 'managedNative', nativeCause } as const;
        const failureCause = { phase: 'machines.provisioners.options', errorClass: 'ManagedMachineControllerError',
            errorCode: 'credential_scope_denied', httpStatus: null } as const;
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: envelope.requestId,
                execution: { ok: false, errorCode: 'action_failed', error: 'action_failed', details, failureCause } } };
        } });
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const client = createManagedProvisionerClient({ serverId, accountId: 'owner' }, 'srv_failed_options');
        const input = { homeId: 'srv_failed_options', controller: { machineId: 'host', installationId: 'installation' },
            contribution: { pluginId: 'custom.compute', localId: 'vm' }, selectors: {} };
        expect(await client.execute('machines.provisioners.options', input))
            .toEqual({ kind: 'failed', code: 'action_failed', nativeCause, details, failureCause });
        expect(await client.read('machines.provisioners.options', input))
            .toEqual({ kind: 'failed', code: 'action_failed', nativeCause, details, failureCause });
    });

    it.each(['native', 'authored'] as const)('preserves the %s failure when options settle after approval', async (shape) => {
        const homeId = 'srv_failed_approval';
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://failed-approval.example',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const actionId = 'machines.provisioners.options';
        const input = { homeId, controller: { machineId: 'host', installationId: 'installation' },
            contribution: { pluginId: 'custom.compute', localId: 'vm' }, selectors: {} };
        harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId, requestId: envelope.requestId,
                execution: { ok: true, result: { kind: 'approval_request_created', artifactId: 'native-approval', actionId } } } };
        } });
        const nativeCause = { httpStatusClass: '4xx', code: 'forbidden' } as const;
        const nativeDetails = { kind: 'managedNative', nativeCause } as const;
        const { PluginError } = await import('@happier-dev/plugin-sdk/errors');
        const { readPluginActionError } = await import('@happier-dev/protocol/plugins/actions/invocation');
        const authored = readPluginActionError(new PluginError({ code: 'action_failed',
            message: '  Sign in to Docker: run sbx login  ', remediation: { kind: 'retry' }, details: nativeDetails }));
        const details = shape === 'authored' ? authored?.data : nativeDetails;
        const failureCause = { phase: actionId, errorClass: 'ManagedMachineControllerError' as const,
            errorCode: 'credential_scope_denied', httpStatus: null };
        const request: ApprovalRequestV2 = { v: 2, status: 'failed', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs: input, summary: 'Read native options',
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                serverId: homeId, accountId: 'owner', actionId, requestId: 'options-request' },
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: { executedAtMs: 2, ok: false, errorCode: 'action_failed', error: 'action_failed', details, failureCause } };
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        let approval: ActionApprovalRegistration | undefined;
        const pending = createManagedProvisionerClient({ serverId, accountId: 'owner' }, homeId).read(actionId, input,
            { onApprovalPending: value => { approval = value; } });
        await waitForHomeGovernance(() => expect(approval).toBeDefined());
        if (!approval || typeof approval === 'string') throw new Error('Expected the options approval continuation');
        approval.onTerminal?.('failed', { id: 'native-approval', title: null,
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true });
        expect(await pending).toEqual({ kind: 'failed', code: 'action_failed', nativeCause, details: nativeDetails, failureCause,
            ...(shape === 'authored' ? { message: 'Sign in to Docker: run sbx login', remediation: { kind: 'retry' } } : {}) });
    });

    it('reads a legacy controller catalog through strict native Action admission without inventing combinations', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://legacy-options.example', serverIdentityId: 'srv_legacy_options', accountId: 'owner', currentAccount: true });
        const price = { amount: '0.005', currency: 'EUR', unit: 'hour', source: 'native', observedAt: 10 };
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: envelope.requestId, execution: { ok: true, result: {
                choices: [{ id: 'first', title: 'First complete launch', launch: { cpu: 2, image: 'linux' }, prices: [price] },
                    { id: 'second', title: 'Second complete launch', launch: { cpu: 4, image: 'windows' }, available: false }],
            } } } };
        } });
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const client = createManagedProvisionerClient({ serverId, accountId: 'owner' }, 'srv_legacy_options');
        const result = await client.read('machines.provisioners.options', { homeId: 'srv_legacy_options', controller: { machineId: 'host', installationId: 'installation' },
            contribution: { pluginId: 'custom.compute', localId: 'vm' }, selectors: {} });
        expect(result).toMatchObject({ kind: 'succeeded', value: { base: { launch: {} }, dimensions: { size: [
            { id: 'first', title: 'First complete launch', assignments: [{ path: 'cpu', value: 2 }, { path: 'image', value: 'linux' }], prices: [price] },
            { id: 'second', title: 'Second complete launch', available: false },
        ], image: [], location: [], network: [], duration: [] } } });
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
    });
    it('keeps a slow native options refusal and its safe cause without retrying', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://native-options.example',
            serverIdentityId: 'srv_native_options', accountId: 'owner', currentAccount: true });
        const nativeCause = { httpStatusClass: '4xx', code: 'forbidden' } as const;
        let release!: () => void;
        const respondAfter = new Promise<void>(resolve => { release = resolve; });
        let issue!: () => void;
        const issued = new Promise<void>(resolve => { issue = resolve; });
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(value);
            issue();
            return { respondAfter, body: { v: 1, actionId: 'machines.provisioners.options', requestId: envelope.requestId,
                execution: { ok: true, result: createMachineProvisionerOptionsFixture({ code: 'provider_unavailable', nativeCause }) } } };
        } });
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const client = createManagedProvisionerClient({ serverId, accountId: 'owner' }, 'srv_native_options');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = client.read('machines.provisioners.options', { homeId: 'srv_native_options',
            controller: { machineId: 'host', installationId: 'installation' },
            contribution: { pluginId: 'custom.compute', localId: 'vm' }, selectors: {} });
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(1));
        await issued;
        await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1);
        release();
        expect(await pending).toEqual({ kind: 'failed', code: 'provider_unavailable', nativeCause });
        await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1);
        expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(1);
    });
    it('refuses a catalog qualified for a different controller installation than the requested one', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://qualified-catalog.example', serverIdentityId: 'srv_qualified_catalog', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: envelope.requestId, execution: { ok: true,
                result: { controller: { machineId: 'host', installationId: 'replacement' }, provisioners: [] } } } };
        } });
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const client = createManagedProvisionerClient({ serverId, accountId: 'owner' }, 'srv_qualified_catalog');
        expect(await client.read('machines.provisioners.list', { homeId: 'srv_qualified_catalog',
            controller: { machineId: 'host', installationId: 'installation' } })).toEqual({ kind: 'failed', code: 'invalid_action_output' });
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list')).toHaveLength(1);
    });
    it('keeps an encrypted offline admission receipt distinct from a completed Action and exposes its waiting row', async () => {
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://receipt.compute.test', serverIdentityId: 'srv_compute',
            accountId: 'owner', accountEncryptionMode: 'e2ee', credentials: { token, secret: encodeBase64(new Uint8Array(32).fill(29), 'base64url') } });
        await harness.addHome({ name: 'Other', serverUrl: 'https://receipt.other.test', serverIdentityId: 'srv_other', accountId: 'other' });
        let receipts = 0;
        const controller = await answerExternalActionAccountForHome(harness, serverId, { machineId: 'host', installationId: 'installation',
            actionId: 'machines.managed.acquire', tokenEpoch: 3, execute: () => { throw new Error('Expected the offline admission receipt'); } });
        controller.machine.active = false;
        harness.answer(serverId, '/v1/machines', { body: [controller.machine] });
        harness.answer(serverId, 'POST /v1/actions/machines.managed.acquire', { select: value => {
            const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(value);
            const envelope = ExternalActionRequestEnvelopeV2Schema.parse(authorized.success ? authorized.data.envelope : value);
            receipts++;
            return { status: 409, body: { error: 'invalid_request', code: 'target_unavailable', requestId: envelope.requestId,
                managedAdmission: { managedId: 'waiting-managed' } } };
        } });
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const client = createManagedProvisionerClient({ serverId, accountId: 'owner' }, 'srv_compute');
        expect(await client.execute('machines.managed.acquire', { selection: { kind: 'one-off', homeId: 'srv_compute',
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'host', installationId: 'installation' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            enrollmentIdentity: reviewedEnrollmentIdentity }))
            .toEqual({ kind: 'admitted', receipt: { managedId: 'waiting-managed' } });
        expect(receipts).toBe(1);
    });
    it('lists without acquiring and preserves normal Ask-first custody for Create', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner', currentAccount: true });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: envelope.requestId, execution: { ok: true, result: { provisioners: [] } } } };
        } });
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const client = createManagedProvisionerClient({ serverId, accountId: 'owner' }, 'srv_compute');
        expect(await client.execute('machines.provisioners.list', { homeId: 'srv_compute', controller: { machineId: 'host', installationId: 'installation' } })).toEqual({ kind: 'succeeded', value: { provisioners: [] } });
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list')[0]?.serverId).toBe(serverId);
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        // Native Action admission owns its ordinary Artifact; the UI does not create an outer Ask.
        const controller = await answerExternalActionAccountForHome(harness, serverId, { machineId: 'host', installationId: 'installation',
            actionId: 'machines.managed.acquire', tokenEpoch: 0,
            execute: () => ({ kind: 'approval_request_created', artifactId: 'native-approval', actionId: 'machines.managed.acquire' }) });
        harness.answer(serverId, '/v1/machines', { body: [controller.machine] });
        const result = await client.execute('machines.managed.acquire', { selection: { kind: 'one-off', homeId: 'srv_compute',
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'host', installationId: 'installation' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            enrollmentIdentity: reviewedEnrollmentIdentity });
        expect(result).toMatchObject({ kind: 'approval_pending', approval: { artifactId: expect.any(String) } });
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(1);
        expect(await client.execute('machines.provisioners.list', { homeId: 'srv_other' })).toEqual({ kind: 'failed', code: 'server_target_mismatch' });
    });
});
