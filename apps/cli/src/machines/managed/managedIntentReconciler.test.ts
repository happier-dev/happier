import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ProviderObservationV1Schema, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { signMachineInstallationProof, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { ManagedActivityBridgeResultV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { MANAGED_POLICY_PROOF_HEADER, ManagedPolicyAdmissionInputV1Schema, decodeManagedPolicyProofV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { fixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createManagedMachineAcquisitionDriver } from './acquire';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { ActionOperationDomainRefV1 } from '@happier-dev/protocol/actions';
import { MachineProvisionerRebuildResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerManagedFiniteWake } from '@/rpc/handlers/managedFiniteWake';
import { MANAGED_FINITE_WAKE_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { ACTION_API_SERVER_ORIGIN, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { executeManagedMachinePolicyAction } from '@/daemon/startup/managedMachinePolicyAction';
import { createDaemonManagedMachinePolicyRuntime } from '@/daemon/startup/managedMachinePolicyRuntime';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential transport'); };
function signedIdle(machine: ReturnType<typeof ManagedMachineV1Schema.parse>, since: number, confirmedAt: number) {
    const context = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'guest',
        installationId: 'guest-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const managedTarget = { homeId: machine.homeId, managedId: machine.id, expectedRevision: machine.intentRevision, controller: machine.controller };
    const decision = { kind: 'idle' as const, since, confirmedAt };
    const method = 'guest:managed.admission.drain.confirm';
    return { context, method, managedTarget, decision, proof: signMachineInstallationProof({
        payload: { version: 1, accountId: 'owner', machineId: 'guest', installationId: 'guest-installation',
            rpcAdmission: { context, method, managedTarget, managedIdleDecision: decision } },
        privateKey: tweetnacl.sign.keyPair().secretKey,
    }) };
}
function setup(decision: { kind: 'idle'; since: number } | { kind: 'busy' | 'unknown'; reasons: ['finite'] } = { kind: 'idle', since: 0 },
    nativeResult: { kind: 'confirmed' | 'unknown' } | { kind: 'refused'; code: string } = { kind: 'confirmed' }, intent: 'start' | 'delete' | 'rebuild' = 'delete',
    inspectObservation?: ProviderObservationV1, onNativeEffect?: () => void,
    rebuildResult?: ReturnType<typeof MachineProvisionerRebuildResultV1Schema.parse>, recoverRebuild = false,
    cleanupObservation?: { kind: 'confirmed' | 'retryable' } | { kind: 'unknown'; code?: string }) {
    const effects: string[] = [];
    const native = fixture({ privateNative: true, supportedIntents: [intent], ...(recoverRebuild ? { reconciliation: true, reconciliationResource: true } : {}),
        ...(cleanupObservation ? { cleanupObservation } : {}),
        nativeRoleResults: { destroy: nativeResult, power: nativeResult,
        ...(recoverRebuild && rebuildResult ? { reconcile: rebuildResult } : {}),
        ...(intent === 'rebuild' ? { rebuild: rebuildResult ?? { kind: 'unknown', recovery: { reference: 'old-native', reason: 'native_rebuild_unknown' } } } : {}),
        ...(inspectObservation ? { inspect: inspectObservation } : {}) }, onNativeRole: role => {
            onNativeEffect?.(); effects.push(role);
        } });
    const homeId = 'srv_managed_intent';
    const controller = { machineId: 'controller', installationId: 'installation' };
    const installationKeys = tweetnacl.sign.keyPair();
    let machine = ManagedMachineV1Schema.parse({
        id: 'managed', homeId, custodianAccountId: 'owner', controller,
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
        allocation: 'bound', creationState: 'active', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        enrolledMachineId: 'guest', desired: intent, desiredWhen: 'now', intentRevision: 1,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    });
    let submitted = false;
    const reports: unknown[] = [];
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const path = String(url);
        if (path.endsWith('/admit-control')) return { status: 200, data: { machine, replayed: submitted } };
        if (path.endsWith('/prepare-policy')) {
            const preparation = ManagedPolicyAdmissionInputV1Schema.parse(body);
            return { status: 200, data: { machine: { ...machine,
                ...(preparation.purpose.kind === 'accepted-input-start' ? { desired: 'start' as const } : {}),
                desiredWhen: 'now', desiredAfterMs: undefined } } };
        }
        if (path.endsWith('/admit-policy')) {
            const admission = ManagedPolicyAdmissionInputV1Schema.parse(body);
            // Home owns the committed intent; accepted work wakes the retained
            // stopped resource rather than preserving its pre-admission Stop.
            machine = { ...machine, intentRevision: 2,
                ...(admission.purpose.kind === 'accepted-input-start' ? { desired: 'start' as const } : {}) };
            return { status: 200, data: { machine, requestId: 'control', replayed: submitted } };
        }
        if (path.endsWith('/actions/get')) return { status: 200, data: machine };
        if (path.endsWith('/context')) return { status: 200, data: { machine, requestId: 'control' } };
        if (path.endsWith('/submit-intent')) {
            const first = !machine.submittedNativeEffect; submitted = true;
            if (first) machine = { ...machine, submittedNativeEffect: { intentRevision: machine.intentRevision, requestId: 'control', intent: machine.desired, controller } };
            return { status: 200, data: { machine, submitted: first } };
        }
        if (path.endsWith('/report-intent')) {
            reports.push(body);
            if (body && typeof body === 'object' && 'result' in body && body.result && typeof body.result === 'object'
                && 'kind' in body.result && body.result.kind === 'refused') {
                machine = { ...machine, submittedNativeEffect: undefined };
            }
            if (body && typeof body === 'object' && 'observation' in body) {
                machine = { ...machine, observation: ProviderObservationV1Schema.parse(body.observation) };
                if (machine.observation?.availability === 'absent') machine = { ...machine, allocation: 'confirmed-absent', submittedNativeEffect: undefined };
            }
        }
        return { status: 200, data: { machine } };
    });
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
        }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const readActivity = vi.fn(async () => decision);
    const confirmIdle = vi.fn(async (): Promise<ManagedActivityBridgeResultV1> => decision.kind === 'idle'
        ? { ...decision, evidence: signedIdle(machine, decision.since, Date.now()) } : decision);
    const reopen = vi.fn(async () => undefined);
    const waitForChange = vi.fn(async (signal?: AbortSignal) => await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const driverInput = { token: 'token', serverUrl: 'https://home.example', homeId, controller,
        externalActionMachineRequestPrivateKey: installationKeys.secretKey,
        credentials: { token: 'token', encryption: null }, runtimeRegistry: native.runtimeRegistry,
        managedProviderOperationAuthority: authority,
        homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' }),
        managedGuestActivity: { read: readActivity, confirmIdle, reopen, waitForChange },
        readPolicyCurrent: async (managedId, signal) => ManagedMachineV1Schema.parse((await axios.post(
            'https://home.example/v1/machines/managed/controller/current', { managedId }, { signal },
        )).data.machine),
    } satisfies Parameters<typeof createManagedMachineAcquisitionDriver>[0];
    const driver = createManagedMachineAcquisitionDriver(driverInput);
    const options = { requestId: 'control', context: {
        operationAcceptance: { operationId: 'operation', accept(_result: unknown) {} },
        operationOwnerUpdate: { update() {} },
    } };
    const run = (signal?: AbortSignal) => driver.execute('machines.managed.delete', { homeId, managedId: machine.id,
        ...machine.desiredWhen === 'after-idle' ? { when: 'after-idle', intent: 'delete', afterMs: machine.desiredAfterMs } : { when: 'now', intent: 'delete', expectedRevision: machine.intentRevision },
        reviewedDependencies: true }, { ...options, ...(signal ? { signal } : {}) });
    return { effects, reports, post, readActivity, confirmIdle, reopen, waitForChange, run, driver, options, installationKeys,
        readMachine: () => machine,
        setMachine: (update: Partial<typeof machine>) => { machine = { ...machine, ...update }; },
    };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function finScopeAuthorization(test: ReturnType<typeof setup>, isSourceCurrent: () => boolean) {
    const machine = test.readMachine();
    const transport = test.post.getMockImplementation()!;
    test.post.mockImplementation(async (url, body, config) => String(url).endsWith('/verify')
        ? { status: isSourceCurrent() ? 200 : 401, data: isSourceCurrent() ? { ok: true } : { error: 'invalid_token' } }
        : await transport(url, body, config));
    const target = { kind: 'machine' as const, machineId: machine.controller.machineId };
    const authorization = await projectExternalActionRequesterHttpAuthorization({
        authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-fin-origin', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', serverIdentityId: machine.homeId, machineId: machine.controller.machineId,
            installationId: machine.controller.installationId, actionId: 'machines.managed.delete', requestId: 'control',
            requestEnvelopeDigest: 'a'.repeat(43), target, workflowActionOrigin: { runId: 'scope-run', requestId: 'control' },
        } }), serverId: 'home', serverIdentityId: machine.homeId, serverHttpBaseUrl: 'https://home.example',
        target, installationId: machine.controller.installationId, privateKey: test.installationKeys.secretKey,
    });
    if (!authorization) throw new Error('FIN scope fixture did not admit');
    return { externalActionExecutionAuthorization: authorization, externalActionTarget: target };
}

describe('managed native intent through the accepted Action', () => {
    it.each(['inspect', 'delete'] as const)('settles lost pending cleanup through %s without binding compute or replaying Delete', async action => {
        const test = setup(undefined, { kind: 'unknown' }, 'delete', { observedAt: 123, availability: 'absent' }, undefined,
            { kind: 'unknown', recovery: { reference: 'owned-volume', reason: 'native_cleanup_unknown' } }, true, { kind: 'confirmed' });
        test.setMachine({ allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} } });
        await expect(test.run()).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        const retained = test.readMachine().nativeOperationRef;
        if (action === 'inspect') await test.driver.execute('machines.managed.inspect', {
            homeId: test.readMachine().homeId, managedId: test.readMachine().id,
        }, test.options);
        else await test.run();
        expect(test.readMachine()).toMatchObject({ id: 'managed', allocation: 'confirmed-absent', nativeOperationRef: retained });
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        expect(test.readMachine().resource).toBeUndefined();
        expect(test.effects.filter(role => role === 'destroy')).toEqual(['destroy']);
        expect(test.reports.at(-1)).toMatchObject({ result: { kind: 'confirmed' }, observation: { availability: 'absent' } });
    });
    it('only resumes pending Delete after fresh exact native retry qualification, while inspect remains observational', async () => {
        const nativeResult: { kind: 'confirmed' | 'unknown' } = { kind: 'unknown' };
        const test = setup(undefined, nativeResult, 'delete', undefined, undefined,
            { kind: 'unknown', recovery: { reference: 'owned-volume', reason: 'native_cleanup_unknown' } }, true, { kind: 'retryable' });
        test.setMachine({ allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} } });
        await expect(test.run()).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        await test.driver.execute('machines.managed.inspect', { homeId: test.readMachine().homeId, managedId: 'managed' }, test.options);
        expect(test.effects.filter(role => role === 'destroy')).toEqual(['destroy']);
        expect(test.readMachine().submittedNativeEffect).toMatchObject({ requestId: 'control', intentRevision: 1 });
        nativeResult.kind = 'confirmed';
        await expect(test.run()).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
        expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent' });
        expect(test.effects.filter(role => role === 'destroy')).toEqual(['destroy', 'destroy']);
        expect(test.reports.at(-1)).toMatchObject({ requestId: 'control', expectedIntentRevision: 1,
            result: { kind: 'confirmed' }, observation: { availability: 'absent' } });
    });
    it.each(['active', 'canceled'] as const)('deletes proven-owned pending native attachments from an %s row without a Machine id', async creationState => {
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, true);
        test.setMachine({ creationState, allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} } });
        const machine = test.readMachine();
        const work = creationState === 'canceled'
            ? test.driver.executePolicy(machine, { kind: 'creation-cleanup' }, test.options)
            : test.run();
        await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: machine.id });
        expect(test.effects).toEqual(['destroy']);
        expect(test.reports).toContainEqual(expect.objectContaining({ result: { kind: 'confirmed' },
            observation: expect.objectContaining({ availability: 'absent' }) }));
    });
    it('retains incomplete pending cleanup for read-only recovery without purchasing or reissuing Delete', async () => {
        const test = setup(undefined, { kind: 'unknown' }, 'delete', undefined, undefined,
            { kind: 'unknown', recovery: { reference: 'owned-partial-allocation', reason: 'native_cleanup_unknown' } }, true);
        test.setMachine({ allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} } });
        await expect(test.run()).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        expect(test.effects).toEqual(['destroy']);
        expect(test.reports).toContainEqual(expect.objectContaining({ result: { kind: 'unknown' } }));
        expect(test.reports.some(report => report && typeof report === 'object' && 'observation' in report)).toBe(false);
        expect(test.readMachine()).toMatchObject({ allocation: 'may-exist', nativeOperationRef: { value: {} }, submittedNativeEffect: { intent: 'delete' } });
        await expect(test.driver.execute('machines.managed.inspect', { homeId: test.readMachine().homeId,
            managedId: test.readMachine().id }, test.options)).resolves.toMatchObject({ machine: {
                allocation: 'may-exist', submittedNativeEffect: { intent: 'delete' },
            } });
        expect(test.effects).toEqual(['destroy', 'reconcile']);
        expect(test.reports.at(-1)).toMatchObject({ result: { kind: 'unknown', code: 'native_cleanup_unconfirmed' } });
        expect(test.reports.some(report => report && typeof report === 'object' && 'observation' in report)).toBe(false);
    });
    it('resumes canceled owned pending cleanup from the controller census without scheduling unknown or active pending purchases', async () => {
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, true);
        test.setMachine({ creationState: 'canceled', allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} } });
        const owned = test.readMachine();
        const failures: unknown[] = [];
        let settled = false;
        const runtime = createDaemonManagedMachinePolicyRuntime({
            // The controller census is a network boundary; the actual driver,
            // policy proof and private native Action path remain real.
            readCensus: async () => ({ machines: [owned,
                { ...owned, id: 'unknown-pending', nativeOperationRef: undefined },
                { ...owned, id: 'active-pending', creationState: 'active' },
                { ...owned, id: 'retired-pending', archivedAt: 1 }], targets: [] }),
            executePolicy: async request => ({ ok: true, result: await test.driver.executePolicy(request.machine, request.purpose,
                { ...test.options, signal: request.signal }) }),
            onSettled: () => { settled = true; }, onUnavailable: error => { failures.push(error); },
        });
        try {
            runtime.notifyChanged();
            await vi.waitFor(() => expect(settled).toBe(true));
            expect(failures).toEqual([]);
            expect(test.effects).toEqual(['destroy']);
            expect(test.reports).toContainEqual(expect.objectContaining({ result: { kind: 'confirmed' },
                observation: expect.objectContaining({ availability: 'absent' }) }));
        } finally { await runtime.stop(); }
    });
    it.each(['approve', 'retire', 'cancel'] as const)('holds the installed native finite wake under shared Ask before %s, retaining the same operation', async disposition => {
        const test = setup(undefined, undefined, 'start', { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' });
        test.setMachine({ wakeOnAcceptedMessage: true, desired: 'stop' });
        const machine = test.readMachine();
        const actionOrigin = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-finite-authority', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
            machineId: 'guest', installationId: 'guest-installation', serverIdentityId: machine.homeId, actionId: 'projects.script.run',
            requestId: 'original-finite', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'guest' },
        } });
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest', expectedIntentRevision: machine.intentRevision,
            controller: machine.controller, origin: { kind: 'finite-command' as const, actionRequestId: 'original-finite' }, reason: 'admitted-work' as const };
        const lifetime = new AbortController();
        const coordinator = createBlockingApprovalCoordinator();
        let originCurrent = true;
        let stored: ReturnType<typeof StoredApprovalRequestSchema.parse> | undefined;
        let waiting!: () => void;
        const held = new Promise<void>(resolve => { waiting = resolve; });
        const currentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'owner', machineId: machine.controller.machineId,
            serverId: 'home', resolveCurrentMachineExecutionOriginContext: async () => originCurrent
                ? { serverIdentityId: machine.homeId, machineId: machine.controller.machineId } : null,
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'token', encryption: null } }),
            listAccountApiTokens: async () => ({ tokens: [] }) });
        const work = test.driver.executePolicy(machine, { kind: 'accepted-input-start', target }, { ...test.options, signal: lifetime.signal, actionOrigin,
            runPolicyAction: (policyMachine, runApproved) => executeManagedMachinePolicyAction({ machine: policyMachine,
                context: { ...test.options.context, signal: lifetime.signal, actionRequestId: 'control', surface: 'cli', runtimeAccountId: 'owner',
                    serverIdentityId: machine.homeId, defaultSessionMachineId: machine.controller.machineId,
                    actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { 'machines.managed.power.set': { approvalRequiredSurfaces: ['cli'] } } }) },
                serverId: 'home', runApproved,
                createExecutor: overrides => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...overrides,
                    isApprovalExecutionOriginCurrent: currentness,
                    // Artifact persistence is the only substituted boundary. The
                    // shared Action admission/replay and blocking coordinator stay real.
                    approvalsCreate: async ({ request }) => { stored = StoredApprovalRequestSchema.parse(request); return { artifactId: 'native-wake-approval' }; },
                    approvalsGet: async () => stored ?? null,
                    approvalsUpdate: async ({ request }) => { stored = StoredApprovalRequestSchema.parse(request); return { ok: true }; },
                    approvalsWaitForDecision: async args => {
                        const pending = coordinator.waitForDecision({ ...args, readRequest: async () => stored ?? null });
                        waiting();
                        const decision = await pending;
                        return { ...decision, request: StoredApprovalRequestSchema.parse(decision.request) };
                    },
                    approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
                }),
            }) });
        const settled = work.then(value => ({ value }), error => ({ error }));
        try {
            await held;
            expect(test.effects).toEqual([]);
            expect(test.post.mock.calls.some(([url]) => String(url).endsWith('/admit-policy'))).toBe(false);
            expect(test.readMachine()).toMatchObject({ desired: 'stop', intentRevision: machine.intentRevision });
            expect(stored).toMatchObject({ status: 'open', actionId: 'machines.managed.power.set', approval: { flow: 'blocking' },
                actionArgs: { intent: 'start', expectedRevision: machine.intentRevision },
                executionOriginV1: { authority: 'account_automation', requestId: 'control', caller: { kind: 'host' } } });
            if (!stored) throw new Error('Missing canonical native Ask request');
            if (disposition === 'cancel') lifetime.abort(new Error('original finite caller ended'));
            else {
                if (disposition === 'retire') originCurrent = false;
                await coordinator.resolveBlockingDecision({ artifactId: 'native-wake-approval', request: stored,
                    decision: 'approve', decisionAuthority: 'present_user' });
            }
            const result = await settled;
            if (disposition === 'approve') {
                expect(result).toMatchObject({ value: { kind: 'accepted', intentRevision: 2 } });
                expect(stored).toMatchObject({ execution: { ok: true, result: { kind: 'accepted', intentRevision: 2 } } });
                expect(test.effects).toEqual(['power']);
            }
            else { expect(result).toHaveProperty('error'); expect(test.effects).toEqual([]); }
        } finally {
            lifetime.abort();
            coordinator.dispose();
            await settled;
        }
    });
    it('requires the private Home transport before a finite causal proof can reach the installed native driver', async () => {
        const test = setup(undefined, undefined, 'start', { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' });
        test.setMachine({ wakeOnAcceptedMessage: true });
        const machine = test.readMachine();
        const actionOrigin = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-finite-authority', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', machineId: 'guest', installationId: 'guest-installation', serverIdentityId: machine.homeId,
            actionId: 'projects.script.run', requestId: 'original-finite', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'guest' },
        } });
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest',
            expectedIntentRevision: machine.intentRevision, controller: machine.controller,
            origin: { kind: 'finite-command' as const, actionRequestId: 'original-finite' }, reason: 'admitted-work' as const };
        const rpc = new RpcHandlerManager({ scopePrefix: 'controller', encryptionMode: 'plain', logger: () => {} });
        registerManagedFiniteWake(rpc, { readCurrent: async () => test.readMachine(), executePolicy: async request => ({ ok: true,
            result: await test.driver.executePolicy(request.machine, request.purpose,
                { ...test.options, signal: request.signal, actionOrigin: request.actionOrigin }),
        }) });
        const request = { method: `controller:${MANAGED_FINITE_WAKE_RPC_METHOD}`, params: { target, actionOrigin } };
        expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(test.effects).toEqual([]);
        expect(test.post).not.toHaveBeenCalled();
        expect(await rpc.handleRequest({ ...request, authorization: ACTION_API_SERVER_ORIGIN })).toMatchObject({ ok: true });
        expect(test.effects).toEqual(['power']);
    });
    it('refuses a finite wake without the original admitted Action authority before native IO', async () => {
        const test = setup(undefined, undefined, 'start', { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' });
        test.setMachine({ wakeOnAcceptedMessage: true });
        const machine = test.readMachine();
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest',
            expectedIntentRevision: machine.intentRevision, controller: machine.controller,
            origin: { kind: 'finite-command' as const, actionRequestId: 'original-finite' }, reason: 'admitted-work' as const };
        await expect(test.driver.executePolicy(machine, { kind: 'accepted-input-start', target }, test.options))
            .rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(test.effects).toEqual([]);
        expect(test.post.mock.calls).toEqual([]);
    });

    it('retains the original finite wake authority in every signed native policy phase', async () => {
        const test = setup(undefined, undefined, 'start', { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' });
        test.setMachine({ wakeOnAcceptedMessage: true });
        const machine = test.readMachine();
        // Only Home/native network boundaries are substituted. This is the exact
        // guest-targeted issuer envelope, never controller credentials or command bytes.
        const actionOrigin = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-finite-authority', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', machineId: 'guest', installationId: 'guest-installation', serverIdentityId: machine.homeId,
            actionId: 'projects.script.run', requestId: 'original-finite', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'guest' },
        } });
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest',
            expectedIntentRevision: machine.intentRevision, controller: machine.controller,
            origin: { kind: 'finite-command' as const, actionRequestId: actionOrigin.binding.requestId }, reason: 'admitted-work' as const };
        await expect(test.driver.executePolicy(machine, { kind: 'accepted-input-start', target }, { ...test.options, ...{ actionOrigin } }))
            .resolves.toMatchObject({ kind: 'accepted', managedId: machine.id });
        expect(test.effects).toEqual(['power']);
        const phases = test.post.mock.calls.filter(([url]) => ['/admit-policy', '/current', '/submit-intent', '/report-intent']
            .some(phase => String(url).endsWith(phase)));
        expect(phases.length).toBeGreaterThan(2);
        for (const [_url, _body, config] of phases) {
            const proof = decodeManagedPolicyProofV1(String(config?.headers?.[MANAGED_POLICY_PROOF_HEADER]));
            expect(proof && Reflect.get(proof, 'actionOrigin')).toEqual(actionOrigin);
            expect(proof && verifyMachineInstallationProof({ payload: proof.payload, proof: proof.proof,
                publicKey: test.installationKeys.publicKey })).toBe(true);
        }
    });

    it('recovers an uncertain rebuild through the existing read-only native reconciliation role without replay or enrollment', async () => {
        const replacement = { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {},
            devcontainerObservation: { nativeResourceId: 'replacement', user: 'coder', workspaceFolder: '/work', storage: { kind: 'child' as const, childPath: '/work' } } };
        const test = setup(undefined, undefined, 'rebuild', undefined, undefined, { kind: 'bound', resource: replacement }, true);
        const machine = test.readMachine();
        test.setMachine({ submittedNativeEffect: { intentRevision: machine.intentRevision, requestId: 'control', intent: 'rebuild', controller: machine.controller },
            recovery: { reference: 'old-native', reason: 'native_rebuild_unknown' } });
        const transport = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/report-intent') && body && typeof body === 'object' && 'result' in body
                && body.result && typeof body.result === 'object' && 'kind' in body.result && body.result.kind === 'bound') {
                test.setMachine({ resource: replacement, enrolledMachineId: undefined, submittedNativeEffect: undefined });
                test.reports.push(body);
                return { status: 200, data: { machine: test.readMachine() } };
            }
            return await transport(url, body, config);
        });
        await expect(test.driver.execute('machines.managed.inspect', { homeId: machine.homeId, managedId: machine.id }, test.options))
            .resolves.toMatchObject({ machine: { resource: replacement } });
        expect(test.readMachine().enrolledMachineId).toBeUndefined();
        expect(test.effects).toEqual(['reconcile']);
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'bound', resource: replacement } })]);
    });

    it('persists an issued rebuild replacement before cancellation prevents fresh enrollment', async () => {
        const cancellation = new AbortController();
        const replacement = { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} };
        const test = setup(undefined, undefined, 'rebuild', undefined, () => cancellation.abort(), { kind: 'bound', resource: replacement });
        await expect(test.driver.execute('machines.managed.rebuild', { homeId: test.readMachine().homeId, managedMachineId: 'managed',
            kind: 'rebuild', expectedRevision: 1, reviewedEffectDigest: 'reviewed-effects' }, { ...test.options, signal: cancellation.signal }))
            .rejects.toMatchObject({ code: 'cancelled' });
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'bound', resource: replacement } })]);
        expect(test.effects).toEqual(['rebuild']);
    });

    it('routes reviewed rebuild through the same private intent custody and retains uncertain replacement without replay', async () => {
        const test = setup(undefined, undefined, 'rebuild');
        const request = { homeId: test.readMachine().homeId, managedMachineId: 'managed', kind: 'rebuild', expectedRevision: 1, reviewedEffectDigest: 'reviewed-effects' };
        await expect(test.driver.execute('machines.managed.rebuild', request, test.options)).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        expect(test.effects).toEqual(['rebuild']);
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'unknown', recovery: { reference: 'old-native', reason: 'native_rebuild_unknown' } } })]);
        await expect(test.driver.execute('machines.managed.rebuild', request, test.options)).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        expect(test.effects).toEqual(['rebuild']);
    });

    it('returns the settled rebuild on identical public retry without native effects or fresh enrollment', async () => {
        const test = setup(undefined, undefined, 'rebuild');
        const replacement = { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {},
            devcontainerObservation: { nativeResourceId: 'replacement', user: 'coder', workspaceFolder: '/work', storage: { kind: 'child' as const, childPath: '/work' } } };
        test.setMachine({ resource: replacement, enrolledMachineId: 'replacement-guest' });
        const settled = test.readMachine();
        const transport = test.post.getMockImplementation()!;
        // Home is the network boundary and owns whether this exact admitted
        // rebuild has settled; the actual driver and private custody stay real.
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/admit-control')) return { status: 200, data: { machine: settled, replayed: true } };
            if (String(url).endsWith('/submit-intent')) return { status: 200, data: { machine: settled, submitted: false } };
            return await transport(url, body, config);
        });
        await expect(test.driver.execute('machines.managed.rebuild', { homeId: settled.homeId, managedMachineId: settled.id,
            kind: 'rebuild', expectedRevision: settled.intentRevision, reviewedEffectDigest: 'reviewed-effects' }, test.options))
            .resolves.toMatchObject({ kind: 'accepted', managedId: settled.id, intentRevision: settled.intentRevision });
        expect(test.effects).toEqual([]);
        expect(test.reports).toEqual([]);
        expect(test.readMachine()).toEqual(settled);
    });

    it('refuses rebuild effects when the exact physical controller is unavailable without changing the ordinary child binding', async () => {
        const test = setup(undefined, undefined, 'rebuild');
        test.setMachine({ controller: { machineId: 'offline-controller', installationId: 'other-installation' } });
        await expect(test.driver.execute('machines.managed.rebuild', { homeId: test.readMachine().homeId, managedMachineId: 'managed',
            kind: 'rebuild', expectedRevision: 1, reviewedEffectDigest: 'reviewed-effects' }, test.options)).rejects.toMatchObject({ code: 'controller_unavailable' });
        expect(test.effects).toEqual([]);
        expect(test.readMachine().enrolledMachineId).toBe('guest');
    });
    it.each([false, true])('permits canceled creation Delete cleanup without granting effects after manual retirement (archived=%s)', async archived => {
        const test = setup();
        test.setMachine({ creationState: 'canceled', enrolledMachineId: undefined,
            ...(archived ? { archivedAt: 1, cleanup: { disposition: 'unavailable', reason: 'manual_responsibility' } } : {}) });
        const work = test.driver.executePolicy(test.readMachine(), { kind: 'creation-cleanup' }, test.options);
        if (archived) {
            await expect(work).rejects.toMatchObject({ code: 'native_resource_unavailable' });
            expect(test.effects).toEqual([]);
        } else {
            await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: test.readMachine().id });
            expect(test.effects).toEqual(['destroy']);
            expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'confirmed' } })]);
        }
    });
    it.each(['deadline', 'unused'] as const)('associates the verified policy row while waiting for %s, before native admission', async kind => {
        const test = setup({ kind: 'busy', reasons: ['finite'] });
        test.setMachine({ retention: kind === 'deadline'
            ? { kind: 'deadline', at: Date.now() + 3_600_000, effect: 'delete', interrupts: true }
            : { kind: 'unused', afterMs: 3_600_000, effect: 'delete' } });
        const machine = test.readMachine();
        const operationId = `waiting-${kind}`;
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => operationId });
        let work: ReturnType<typeof test.driver.executePolicy> | undefined;
        let settled = false;
        const observed = operations.observeExecution({ actionId: 'machines.managed.delete', input: {}, actionRequestId: 'control',
            execute: async context => {
                work = test.driver.executePolicy(machine, { kind: 'retention' }, { requestId: 'control', context, signal: context.signal });
                return { ok: true, result: await work };
            },
        }).catch(error => error).finally(() => { settled = true; });
        try {
            while (test.waitForChange.mock.calls.length === 0 && !settled) await new Promise<void>(resolve => setImmediate(resolve));
            expect(test.waitForChange.mock.calls.length).toBeGreaterThan(0);
            expect(await operations.handlers.getV2({ operationId })).toMatchObject({ kind: 'found', operation: {
                state: 'running', domainRef: { kind: 'managedMachine', id: machine.id },
                progress: { kind: 'phase', phase: kind === 'deadline' ? 'managed.intent.waiting-deadline' : 'managed.intent.busy' },
            } });
            expect(test.post.mock.calls.some(([url]) => String(url).endsWith('/admit-policy'))).toBe(false);
            expect(test.effects).toEqual([]);
        } finally {
            await operations.handlers.cancel({ operationId });
            await observed;
            await work?.catch(() => undefined);
        }
        expect(await operations.handlers.getV2({ operationId, waitForTerminal: true })).toMatchObject({ kind: 'found', operation: {
            state: 'cancelled', domainRef: { kind: 'managedMachine', id: machine.id }, cancellation: 'supported',
        } });
        expect(test.effects).toEqual([]);
    });
    it.each(['busy', 'unknown'] as const)('publishes the actual %s guest decision and drain before an after-idle native effect', async kind => {
        const test = setup({ kind, reasons: ['finite'] });
        test.setMachine({ desiredWhen: 'after-idle' });
        const machine = test.readMachine();
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `activity-${kind}` });
        let work: ReturnType<typeof test.driver.execute> | undefined;
        let release!: () => void;
        const changed = new Promise<void>(resolve => { release = resolve; });
        let releaseDrain!: () => void;
        const confirming = new Promise<void>(resolve => { releaseDrain = resolve; });
        test.waitForChange.mockImplementation(async () => await changed);
        const observed = operations.observeExecution({ actionId: 'machines.managed.delete', input: {}, actionRequestId: 'control',
            execute: async context => {
                work = test.driver.execute('machines.managed.delete', { homeId: machine.homeId, managedId: machine.id,
                    when: 'after-idle', intent: 'delete', reviewedDependencies: true },
                    { requestId: 'control', context, signal: context.signal });
                return { ok: true, result: await work };
            } });
        try {
            while (test.waitForChange.mock.calls.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
            expect(await operations.handlers.getV2({ operationId: `activity-${kind}` })).toMatchObject({ kind: 'found', operation: {
                state: 'running', domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller: machine.controller },
                progress: { kind: 'phase', phase: kind === 'busy' ? 'managed.intent.busy' : 'managed.intent.activity-unknown' },
            } });
            expect(test.effects).toEqual([]);
            test.readActivity.mockResolvedValue({ kind: 'idle', since: 0 });
            test.confirmIdle.mockImplementation(async () => {
                await confirming;
                return { kind: 'idle', since: 0, evidence: signedIdle(machine, 0, Date.now()) };
            });
            release();
            while (test.confirmIdle.mock.calls.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
            expect(await operations.handlers.getV2({ operationId: `activity-${kind}` })).toMatchObject({ kind: 'found', operation: {
                domainRef: { resource: machine.resource, controller: machine.controller },
                progress: { kind: 'phase', phase: 'managed.intent.draining' },
            } });
            releaseDrain();
            await observed;
            await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: machine.id });
            expect(await operations.handlers.getV2({ operationId: `activity-${kind}`, waitForTerminal: true }))
                .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
            expect(test.effects).toEqual(['destroy']);
        } finally {
            release();
            releaseDrain();
            await operations.handlers.cancel({ operationId: `activity-${kind}` });
            await observed.catch(() => undefined);
            await work?.catch(() => undefined);
        }
    });
    it.each(['control', 'policy'] as const)('associates the real %s operation with its admitted row before native effects', async (source) => {
        let domainRef: ActionOperationDomainRefV1 | undefined;
        const observed: Array<ActionOperationDomainRefV1 | undefined> = [];
        const test = setup(undefined, undefined, 'delete', undefined, () => { observed.push(domainRef); });
        const machine = test.readMachine();
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `managed-${source}`,
            publishSnapshot: snapshot => { domainRef = snapshot.domainRef; },
        });
        const request = { homeId: machine.homeId, managedId: machine.id, when: 'now' as const,
            intent: 'delete' as const, expectedRevision: machine.intentRevision, reviewedDependencies: true };
        if (source === 'policy') test.setMachine({ retention: { kind: 'unused', afterMs: 1, effect: 'delete' } });
        let work: ReturnType<typeof test.driver.execute> | undefined;
        await expect(operations.observeExecution({ actionId: 'machines.managed.delete', input: request, actionRequestId: 'control',
            execute: async context => {
                work = source === 'control'
                    ? test.driver.execute('machines.managed.delete', request, { requestId: 'control', context, signal: context.signal })
                    : test.driver.executePolicy(test.readMachine(), { kind: 'retention', evidence: signedIdle(test.readMachine(), 0, 200) },
                        { requestId: 'control', context, signal: context.signal });
                return { ok: true, result: await work };
            },
        })).resolves.toMatchObject({ ok: true, result: { managedId: machine.id } });
        await work;
        expect(test.effects).toEqual(['destroy']);
        expect(observed).toEqual([expect.objectContaining({ kind: 'managedMachine', id: machine.id,
            ...(source === 'policy' ? { resource: machine.resource, controller: machine.controller } : {}) })]);
        expect(await operations.handlers.getV2({ operationId: `managed-${source}`, waitForTerminal: true })).toMatchObject({ kind: 'found',
            operation: { state: 'succeeded', domainRef: { kind: 'managedMachine', id: machine.id } },
        });
    });
    it.each(['running', 'stopped'] as const)('releases accepted input only for an actual running native observation, not %s command acceptance', async power => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'confirmed' }, 'start', { observedAt: 1, availability: 'present', power });
        const machine = test.readMachine();
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest',
            expectedIntentRevision: machine.intentRevision, controller: machine.controller,
            origin: { kind: 'session-input' as const, session: { homeId: machine.homeId, sessionId: 'session' },
                pendingRequestId: 'pending', requestedAt: 1 }, reason: 'admitted-work' as const };
        const work = test.driver.executePolicy(machine, { kind: 'accepted-input-start', target }, test.options);
        if (power === 'running') await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: machine.id });
        else await expect(work).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        expect(test.effects).toEqual(['power']);
        const header = test.post.mock.calls.find(([url]) => String(url).endsWith('/admit-policy'))?.[2]?.headers?.[MANAGED_POLICY_PROOF_HEADER];
        const proof = decodeManagedPolicyProofV1(String(header));
        expect(proof?.purpose).toEqual({ kind: 'accepted-input-start', target });
        expect(proof && verifyMachineInstallationProof({ payload: proof.payload, proof: proof.proof, publicKey: test.installationKeys.publicKey })).toBe(true);
    });
    it('dispatches the still-current new Start once after fresh native observation settles the old Stop', async () => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'unknown' }, 'start', { observedAt: 1, availability: 'present', power: 'stopped' });
        test.setMachine({ intentRevision: 2, desired: 'start', submittedNativeEffect: {
            intentRevision: 1, requestId: 'old-stop', intent: 'stop', controller: test.readMachine().controller,
        } });
        const transport = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            // The server boundary confirms settlement of the retained Stop
            // from actual native observation; it does not admit the new Start.
            if (String(url).endsWith('/report-intent') && body && typeof body === 'object'
                && 'requestId' in body && body.requestId === 'old-stop') {
                test.setMachine({ submittedNativeEffect: undefined });
                return { status: 200, data: { machine: test.readMachine() } };
            }
            return await transport(url, body, config);
        });
        const machine = test.readMachine();
        await expect(test.driver.execute('machines.managed.power.set', { homeId: machine.homeId,
            managedId: machine.id, intent: 'start', when: 'now', expectedRevision: machine.intentRevision,
        }, test.options)).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        expect(test.effects).toEqual(['power']);
        expect(test.readMachine().submittedNativeEffect).toMatchObject({ intentRevision: 2, requestId: 'control', intent: 'start' });
    });
    it('does not settle a new Start after only inspecting an older unknown Stop on the same resource', async () => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'confirmed' }, 'start');
        test.setMachine({ intentRevision: 2, desired: 'start', submittedNativeEffect: {
            intentRevision: 1, requestId: 'old-stop', intent: 'stop', controller: test.readMachine().controller,
        } });
        const machine = test.readMachine();
        await expect(test.driver.execute('machines.managed.power.set', { homeId: machine.homeId,
            managedId: machine.id, intent: 'start', when: 'now', expectedRevision: machine.intentRevision,
        }, test.options)).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        expect(test.effects).toEqual([]);
        expect(test.reports).toEqual([expect.objectContaining({ expectedIntentRevision: 1, requestId: 'old-stop',
            result: { kind: 'unknown' }, observation: { observedAt: 0, availability: 'present' } })]);
        expect(test.readMachine().submittedNativeEffect?.requestId).toBe('old-stop');
    });
    it('reports a definite native wake refusal through the existing pending failure owner without passing requester content', async () => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'refused', code: 'native_denied' }, 'start');
        const machine = test.readMachine();
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest',
            expectedIntentRevision: machine.intentRevision, controller: machine.controller,
            origin: { kind: 'session-input' as const, session: { homeId: machine.homeId, sessionId: 'session' },
                pendingRequestId: 'pending', requestedAt: 1 }, reason: 'admitted-work' as const };
        await expect(test.driver.executePolicy(machine, { kind: 'accepted-input-start', target }, test.options))
            .rejects.toMatchObject({ code: 'native_denied' });
        expect(test.effects).toEqual(['power']);
        expect(test.post.mock.calls.find(([url]) => String(url).endsWith('/activation-failed'))?.[1])
            .toEqual({ target, failureCode: 'runtime_start_failed' });
    });
    it('uses the real managed policy purpose in the same native owner without an external Action envelope', async () => {
        const test = setup();
        test.setMachine({ retention: { kind: 'unused', afterMs: 1, effect: 'delete' } });
        const machine = test.readMachine();
        const evidence = signedIdle(machine, 0, 200);
        await test.driver.executePolicy(machine, { kind: 'retention', evidence }, test.options);
        expect(test.effects).toEqual(['destroy']);
        expect(test.post.mock.calls.some(([url, _body, config]) => String(url).endsWith('/admit-policy')
            && decodeManagedPolicyProofV1(String(config?.headers?.[MANAGED_POLICY_PROOF_HEADER]))?.purpose.kind === 'retention')).toBe(true);
        const currentProof = test.post.mock.calls.filter(([url]) => String(url).endsWith('/current')).at(-1)?.[2]?.headers?.[MANAGED_POLICY_PROOF_HEADER];
        const proof = decodeManagedPolicyProofV1(String(currentProof));
        expect(proof?.payload.managedPolicy?.expectedIntentRevision).toBe(2);
        expect(proof && verifyMachineInstallationProof({ payload: proof.payload, proof: proof.proof, publicKey: test.installationKeys.publicKey })).toBe(true);
    });
    it('dispatches reviewed immediate Delete while guest work is busy and reports native inspection rather than command-derived absence', async () => {
        const test = setup({ kind: 'busy', reasons: ['finite'] });
        await test.run();
        expect(test.effects).toEqual(['destroy']);
        expect(test.readActivity).not.toHaveBeenCalled();
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'confirmed' },
            observation: { observedAt: 0, availability: 'present' } })]);
    });
    it.each(['busy', 'unknown'] as const)('keeps %s work pending and dispatches nothing when canceled before unused-stop', async kind => {
        const test = setup({ kind, reasons: ['finite'] });
        test.setMachine({ desiredWhen: 'after-idle', desiredAfterMs: 3_600_000 });
        const controller = new AbortController();
        const work = test.run(controller.signal);
        while (test.waitForChange.mock.calls.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
        expect(test.effects).toEqual([]);
        controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
        await expect(work).rejects.toMatchObject({ code: 'cancelled' });
        expect(test.effects).toEqual([]);
    });
    it('uses the selected idle duration, then confirms drain and rechecks exact target before native Delete', async () => {
        vi.useFakeTimers({ now: 3_599_999 });
        const test = setup();
        test.setMachine({ desiredWhen: 'after-idle', desiredAfterMs: 3_600_000 });
        const work = test.run();
        await vi.advanceTimersByTimeAsync(0);
        expect(test.effects).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await work;
        expect(test.effects).toEqual(['destroy']);
        expect(test.reopen).toHaveBeenCalledOnce();
    });
    it('returns to waiting while the guest drain is reopened for the selected unused interval', async () => {
        vi.useFakeTimers({ now: 3_599_999 });
        const test = setup();
        test.setMachine({ desiredWhen: 'after-idle', desiredAfterMs: 3_600_000 });
        const machine = test.readMachine();
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'unused-interval' });
        const observed = operations.observeExecution({ actionId: 'machines.managed.delete', input: {}, actionRequestId: 'control',
            execute: async context => ({ ok: true, result: await test.driver.execute('machines.managed.delete', {
                homeId: machine.homeId, managedId: machine.id, when: 'after-idle', intent: 'delete',
                afterMs: 3_600_000, reviewedDependencies: true,
            }, { requestId: 'control', context, signal: context.signal }) }) });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(test.effects).toEqual([]);
            expect(test.reopen).toHaveBeenCalledOnce();
            expect(await operations.handlers.getV2({ operationId: 'unused-interval' })).toMatchObject({ kind: 'found', operation: {
                state: 'running', progress: { kind: 'phase', phase: 'managed.intent.waiting-idle' },
            } });
            await vi.advanceTimersByTimeAsync(1);
            await observed;
            expect(test.effects).toEqual(['destroy']);
        } finally {
            await operations.handlers.cancel({ operationId: 'unused-interval' });
            await observed.catch(() => undefined);
        }
    });
    it('does not shorten the selected guest idle interval when the controller clock is ahead', async () => {
        vi.useFakeTimers({ now: 3_600_000 });
        const test = setup();
        test.setMachine({ desiredWhen: 'after-idle', desiredAfterMs: 2 });
        const fresh = { kind: 'idle' as const, since: 0, evidence: signedIdle(test.readMachine(), 0, 1) };
        test.confirmIdle.mockResolvedValue(fresh);
        const cancellation = new AbortController();
        const work = test.run(cancellation.signal);
        // Let real internal native admission settle without advancing the
        // guest-selected timer or inventing a native observation.
        await vi.advanceTimersByTimeAsync(0);
        expect(test.effects).toEqual([]);
        cancellation.abort();
        await expect(work).rejects.toMatchObject({ code: 'cancelled' });
    });
    it('does not postpone already confirmed guest idle when the controller clock is behind', async () => {
        vi.useFakeTimers({ now: 0 });
        const test = setup({ kind: 'idle', since: 100_000 });
        test.setMachine({ desiredWhen: 'after-idle', desiredAfterMs: 2 });
        const fresh = { kind: 'idle' as const, since: 100_000, evidence: signedIdle(test.readMachine(), 100_000, 200_000) };
        test.confirmIdle.mockResolvedValue(fresh);
        const cancellation = new AbortController();
        const work = test.run(cancellation.signal);
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(test.effects).toEqual(['destroy']);
            await work;
        } finally {
            cancellation.abort();
            await work.catch(() => undefined);
        }
    });
    it('does not replay a submitted effect when the same admitted request is inspected again', async () => {
        const test = setup();
        await test.run();
        await expect(test.run()).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        expect(test.effects.filter(role => role === 'destroy')).toEqual(['destroy']);
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'confirmed' } }),
            expect.objectContaining({ result: { kind: 'unknown' }, observation: { observedAt: 0, availability: 'present' } })]);
    });
    it('retains an unknown native delivery and retries only inspection of the same resource', async () => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'unknown' });
        await expect(test.run()).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        await expect(test.run()).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        expect(test.effects).toEqual(['destroy']);
        expect(test.reports).toHaveLength(2);
        expect(test.reports[1]).toMatchObject({ requestId: 'control', expectedIntentRevision: 1,
            result: { kind: 'unknown' }, observation: { observedAt: 0, availability: 'present' } });
    });
    it('settles native uncertainty through the actual Inspect front door without acquisition reporting or native replay', async () => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'unknown' });
        await expect(test.run()).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        await test.driver.execute('machines.managed.inspect', { homeId: 'srv_managed_intent', managedId: 'managed' }, test.options);
        expect(test.effects).toEqual(['destroy']);
        expect(test.reports).toHaveLength(2);
        expect(test.reports[1]).toMatchObject({ result: { kind: 'unknown' }, requestId: 'control',
            observation: { observedAt: 0, availability: 'present' } });
        expect(test.post.mock.calls.some(([url]) => String(url).endsWith('/controller/report'))).toBe(false);
    });
    it('keeps guest admission drained after an unknown native effect may still stop the same resource', async () => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'unknown' });
        test.setMachine({ desiredWhen: 'after-idle' });
        await expect(test.run()).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
        expect(test.effects).toEqual(['destroy']);
        expect(test.reopen).not.toHaveBeenCalled();
    });
    it('releases only the unused-stop drain after a definite native refusal', async () => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'refused', code: 'native_denied' });
        test.setMachine({ desiredWhen: 'after-idle' });
        await expect(test.run()).rejects.toMatchObject({ code: 'native_denied' });
        expect(test.effects).toEqual(['destroy']);
        expect(test.reopen).toHaveBeenCalledOnce();
    });
    it('reopens the matching drain if the controller changes after fresh idle confirmation', async () => {
        const test = setup();
        test.setMachine({ desiredWhen: 'after-idle' });
        test.confirmIdle.mockImplementationOnce(async () => {
            test.setMachine({ controller: { machineId: 'moved', installationId: 'other' } });
            return { kind: 'idle', since: 0 };
        });
        await expect(test.run()).rejects.toMatchObject({ code: 'intent_changed' });
        expect(test.effects).toEqual([]);
        expect(test.reopen).toHaveBeenCalledOnce();
    });
    it('rechecks installed Account policy after guest work interrupts an approved unused Delete', async () => {
        const test = setup();
        test.setMachine({ retention: { kind: 'unused', afterMs: 1, effect: 'delete' } });
        const lifetime = new AbortController();
        let enabled = true;
        let interrupted = false;
        const coordinator = createBlockingApprovalCoordinator();
        let stored: ReturnType<typeof StoredApprovalRequestSchema.parse> | undefined;
        let waiting!: () => void;
        const held = new Promise<void>(resolve => { waiting = resolve; });
        const initialMachine = test.readMachine();
        const currentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'owner', machineId: initialMachine.controller.machineId,
            serverId: 'home', resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: initialMachine.homeId,
                machineId: initialMachine.controller.machineId }),
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'token', encryption: null } }),
            listAccountApiTokens: async () => ({ tokens: [] }) });
        const transport = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/submit-intent') && !interrupted) {
                // Accepted guest work arrives at the network preparation
                // boundary, before the real private native pre-handler check.
                interrupted = true;
                test.readActivity.mockResolvedValue({ kind: 'busy', reasons: ['finite'] });
                test.confirmIdle.mockResolvedValue({ kind: 'busy', reasons: ['finite'] });
            }
            return await transport(url, body, config);
        });
        test.waitForChange.mockImplementation(async () => {
            // The guest becomes idle after the Account has disabled Delete.
            // A fresh installed policy invocation must consume that projection.
            enabled = false;
            test.readActivity.mockResolvedValue({ kind: 'idle', since: 0 });
            test.confirmIdle.mockImplementation(async () => ({ kind: 'idle', since: 0,
                evidence: signedIdle(test.readMachine(), 0, Date.now()) }));
        });
        const work = test.driver.executePolicy(test.readMachine(), { kind: 'retention' }, { ...test.options, signal: lifetime.signal,
            runPolicyAction: (machine, runApproved) => executeManagedMachinePolicyAction({ machine, runApproved, serverId: 'home',
                context: { ...test.options.context, signal: lifetime.signal, actionRequestId: 'control', surface: 'cli',
                    runtimeAccountId: 'owner', serverIdentityId: machine.homeId, defaultSessionMachineId: machine.controller.machineId,
                    actionsSettings: normalizeActionsSettingsV1({ v: 1,
                        actions: { 'machines.managed.delete': { enabled } },
                    }) },
                createExecutor: overrides => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...overrides,
                    isApprovalExecutionOriginCurrent: currentness,
                    // Approval persistence is a boundary; Ask admission and
                    // its present-user decision continuation remain real.
                    approvalsCreate: async ({ request }) => { stored = StoredApprovalRequestSchema.parse(request); return { artifactId: 'unused-delete-approval' }; },
                    approvalsGet: async () => stored ?? null,
                    approvalsUpdate: async ({ request }) => { stored = StoredApprovalRequestSchema.parse(request); return { ok: true }; },
                    approvalsWaitForDecision: async args => {
                        const pending = coordinator.waitForDecision({ ...args, readRequest: async () => stored ?? null });
                        waiting();
                        const decision = await pending;
                        return { ...decision, request: StoredApprovalRequestSchema.parse(decision.request) };
                    },
                    approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
                }),
            }) });
        const settled = work.then(value => ({ value }), error => ({ error }));
        try {
            const initial = await Promise.race([held.then(() => 'held' as const), settled]);
            expect(initial).toBe('held');
            expect(test.effects).toEqual([]);
            expect(test.post.mock.calls.some(([url]) => String(url).endsWith('/admit-policy'))).toBe(false);
            if (!stored) throw new Error('Missing canonical unused Delete Ask');
            await coordinator.resolveBlockingDecision({ artifactId: 'unused-delete-approval', request: stored,
                decision: 'approve', decisionAuthority: 'present_user' });
            expect(await settled).toMatchObject({ error: { code: 'action_disabled' } });
            expect(interrupted).toBe(true);
            expect(enabled).toBe(false);
            expect(test.effects).toEqual([]);
            expect(test.reports).toContainEqual(expect.objectContaining({ result: { kind: 'refused', code: 'activity_changed' } }));
            expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        } finally {
            lifetime.abort();
            coordinator.dispose();
            await settled;
        }
    });
    it('keeps accepted work ahead of unused Delete when the guest becomes busy during native submission preparation', async () => {
        const test = setup();
        test.setMachine({ desiredWhen: 'after-idle' });
        const transport = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/submit-intent')) {
                // Accepted queued work is real guest material, without a
                // fabricated controller intent revision or native result.
                test.readActivity.mockResolvedValue({ kind: 'busy', reasons: ['finite'] });
                test.confirmIdle.mockResolvedValue({ kind: 'busy', reasons: ['finite'] });
            }
            return await transport(url, body, config);
        });
        const cancellation = new AbortController();
        const work = test.run(cancellation.signal);
        try {
            while (test.confirmIdle.mock.calls.length < 2 && test.effects.length === 0) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            expect(test.effects).toEqual([]);
            cancellation.abort();
            await expect(work).rejects.toMatchObject({ code: 'cancelled' });
        } finally {
            cancellation.abort();
            await work.catch(() => undefined);
        }
    });
    it('rechecks accepted guest work at private native custody after asynchronous controller currentness preparation', async () => {
        const test = setup();
        test.setMachine({ desiredWhen: 'after-idle' });
        let nativePreparation = false;
        let acceptedWork = false;
        const operations = createHostActionOperationRuntime({ machineId: test.readMachine().controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'late-accepted-work',
            publishSnapshot: snapshot => {
                nativePreparation = snapshot.progress?.kind === 'phase' && snapshot.progress.phase === 'managed.intent.native-effect';
            },
        });
        const transport = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/current') && nativePreparation && !acceptedWork) {
                // The canonical native owner has entered its asynchronous
                // installation/currentness network preparation. Accepted guest
                // work need not change the retained controller row revision.
                acceptedWork = true;
                test.readActivity.mockResolvedValue({ kind: 'busy', reasons: ['finite'] });
                test.confirmIdle.mockResolvedValue({ kind: 'busy', reasons: ['finite'] });
            }
            return await transport(url, body, config);
        });
        let work: ReturnType<typeof test.run> | undefined;
        let settled = false;
        const observed = operations.observeExecution({ actionId: 'machines.managed.delete', input: {}, actionRequestId: 'control',
            execute: async context => {
                work = test.driver.execute('machines.managed.delete', { homeId: test.readMachine().homeId,
                    managedId: test.readMachine().id, intent: 'delete', when: 'after-idle', reviewedDependencies: true,
                }, { requestId: 'control', context, signal: context.signal });
                try { return { ok: true, result: await work }; }
                finally { settled = true; }
            },
        }).catch(error => error);
        try {
            while ((!acceptedWork || (test.waitForChange.mock.calls.length === 0 && test.effects.length === 0)) && !settled) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            expect(acceptedWork).toBe(true);
            expect(test.effects).toEqual([]);
            expect(await operations.handlers.getV2({ operationId: 'late-accepted-work' })).toMatchObject({ kind: 'found', operation: {
                state: 'running', progress: { kind: 'phase', phase: 'managed.intent.busy' },
            } });
        } finally {
            await operations.handlers.cancel({ operationId: 'late-accepted-work' });
            await observed;
            await work?.catch(() => undefined);
        }
        expect(test.effects).toEqual([]);
    });
    it('refuses a retired FIN scope after asynchronous final idle confirmation without issuing Delete', async () => {
        const test = setup();
        test.setMachine({ desiredWhen: 'after-idle' });
        const machine = test.readMachine();
        let sourceCurrent = true;
        const origin = await finScopeAuthorization(test, () => sourceCurrent);
        let confirmations = 0;
        test.confirmIdle.mockImplementation(async () => {
            confirmations += 1;
            // Home/source changes while the final guest transport awaits. The
            // native row/credential checks already completed before this RPC.
            if (confirmations === 2) sourceCurrent = false;
            return { kind: 'idle', since: 0, evidence: signedIdle(machine, 0, Date.now()) };
        });
        const work = test.driver.execute('machines.managed.delete', { homeId: machine.homeId, managedId: machine.id,
            intent: 'delete', when: 'after-idle', reviewedDependencies: true }, { ...test.options,
            context: { ...test.options.context, ...origin },
        });
        await expect(work).rejects.toBeInstanceOf(Error);
        expect(test.effects).toEqual([]);
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        expect(test.reopen).toHaveBeenCalled();
    });
    it.each(['busy', 'unknown', 'interval'] as const)('retires the same accepted FIN scope during %s waiting without native IO', async phase => {
        if (phase === 'interval') { vi.useFakeTimers(); vi.setSystemTime(0); }
        const test = setup(phase === 'interval' ? { kind: 'idle', since: 0 } : { kind: phase, reasons: ['finite'] });
        test.setMachine({ desiredWhen: 'after-idle', ...(phase === 'interval' ? { desiredAfterMs: 100 } : {}) });
        let sourceCurrent = true;
        const origin = await finScopeAuthorization(test, () => sourceCurrent);
        test.waitForChange.mockImplementation(async () => { sourceCurrent = false; });
        const machine = test.readMachine();
        const work = test.driver.execute('machines.managed.delete', { homeId: machine.homeId, managedId: machine.id,
            intent: 'delete', when: 'after-idle', ...(phase === 'interval' ? { afterMs: 100 } : {}), reviewedDependencies: true },
            { ...test.options, context: { ...test.options.context, ...origin } });
        await expect(work).rejects.toMatchObject({ code: 'intent_changed' });
        expect(test.effects).toEqual([]);
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        if (phase === 'interval') expect(test.reopen).toHaveBeenCalled();
    });
});
