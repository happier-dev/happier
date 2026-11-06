import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { prepareManagedRetentionPolicy } from './managedIntentReconciler';
import { Server } from 'socket.io';
import { createServer } from 'node:http';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedControllerIntentReportV1Schema, ManagedControllerReportV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { signMachineInstallationProof, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { ManagedActivityBridgeResultV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { MANAGED_POLICY_PROOF_HEADER, ManagedPolicyAdmissionInputV1Schema, decodeManagedPolicyProofV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { fixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createManagedMachineAcquisitionDriver, type ManagedMachineAcquisitionDriverInput } from './acquire';
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
import * as activitySocket from '@/api/session/sockets';
import { createLiveWorkProducerGroup, createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { registerManagedActivityRpcHandlers } from '@/api/machine/rpcHandlers.managedActivity';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    ManagedActivityBridgeResultV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationGetV1ResponseSchema as PredecessorOperationGetSchema } from '@/daemon/actionOperations/testFixtures/predecessorActionOperationV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { doesManagedNativeObservationSettleIntent } from '../../../../server/sources/app/machines/managed/managedNativeObservation';
import { createAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';

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
    nativeResult: { kind: 'confirmed' | 'unknown' } | { kind: 'refused'; code: string } = { kind: 'confirmed' }, intent: 'start' | 'stop' | 'suspend' | 'delete' | 'rebuild' = 'delete',
    inspectObservation?: ProviderObservationV1, onNativeEffect?: () => void,
    rebuildResult?: ReturnType<typeof MachineProvisionerRebuildResultV1Schema.parse>, recoverRebuild = false,
    cleanupObservation?: { kind: 'confirmed' | 'retryable' } | { kind: 'unknown'; code?: string },
    nativeFixtureOptions: Pick<NonNullable<Parameters<typeof fixture>[0]>, 'nativeRoleResults' | 'onInspect'> = {}) {
    const effects: string[] = [];
    const nativeInputs: unknown[] = [];
    const native = fixture({ privateNative: true, supportedIntents: [intent], ...(recoverRebuild ? { reconciliation: true, reconciliationResource: true } : {}),
        ...(cleanupObservation ? { cleanupObservation } : {}),
        nativeRoleResults: { destroy: nativeResult, power: nativeResult,
        ...(recoverRebuild && rebuildResult ? { reconcile: rebuildResult } : {}),
        ...(intent === 'rebuild' ? { rebuild: rebuildResult ?? { kind: 'unknown', recovery: { reference: 'old-native', reason: 'native_rebuild_unknown' } } } : {}),
        ...(inspectObservation ? { inspect: inspectObservation } : {}) }, onNativeRole: (role, input) => {
            onNativeEffect?.(); effects.push(role); nativeInputs.push(input);
        }, ...nativeFixtureOptions });
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
        if (path.endsWith('/activation-failed')) return { status: 200, data: { ok: true, didFail: true } };
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
        if (path.endsWith('/report')) {
            const report = ManagedControllerReportV1Schema.parse(body);
            if (report.result.kind === 'bound') machine = { ...machine, allocation: 'bound', resource: report.result.resource };
            if (report.result.kind === 'rejected') machine = { ...machine, allocation: 'confirmed-absent' };
            if (report.observation) machine = { ...machine, observation: report.observation };
        }
        if (path.endsWith('/submit-intent')) {
            const first = !machine.submittedNativeEffect; submitted = true;
            if (first) machine = { ...machine, submittedNativeEffect: { intentRevision: machine.intentRevision, requestId: 'control', intent: machine.desired, controller } };
            return { status: 200, data: { machine, submitted: first } };
        }
        if (path.endsWith('/report-intent')) {
            // Native producer output must satisfy the real Home report consumer.
            const report = ManagedControllerIntentReportV1Schema.parse(body);
            reports.push(report);
            if (report.result.kind === 'refused') {
                machine = { ...machine, submittedNativeEffect: undefined };
            }
            if (report.observation) {
                machine = { ...machine, observation: report.observation };
                if (machine.observation?.availability === 'absent') machine = { ...machine, allocation: 'confirmed-absent',
                    nativeOperationRef: undefined, submittedNativeEffect: undefined };
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
    const readActivity = vi.fn(async (): Promise<ManagedActivityBridgeResultV1> => decision.kind === 'idle'
        ? { ...decision, evidence: signedIdle(machine, decision.since, Date.now()) } : decision);
    const confirmIdle = vi.fn(async (): Promise<ManagedActivityBridgeResultV1> => decision.kind === 'idle'
        ? { ...decision, evidence: signedIdle(machine, decision.since, Date.now()) } : decision);
    const reopen = vi.fn(async () => undefined);
    const waitForChange = vi.fn(async (signal?: AbortSignal): Promise<'activity' | void> => await new Promise<void>((_resolve, reject) => {
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
    return { effects, nativeInputs, reports, post, readActivity, confirmIdle, reopen, waitForChange, run, driver, driverInput, options, installationKeys,
        retireNative: native.retire,
        readMachine: () => machine,
        setMachine: (update: Partial<typeof machine>) => { machine = { ...machine, ...update }; },
    };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('unused Stop through guest drain and controller operation custody', () => {
    it.each(['native-currentness', 'private-currentness', 'private-admission'] as const)(
        'settles a definite pre-handler refusal at %s without a phantom native effect', async boundary => {
        const test = setup(undefined, undefined, 'start');
        const machine = test.readMachine();
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const home = test.post.getMockImplementation()!;
        let submittedReads = 0;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/current') && test.readMachine().submittedNativeEffect) {
                submittedReads += 1;
                // The first read is the reconciler's post-submit check; the next
                // belongs to native.invoke, then to private Action custody.
                if (submittedReads === (boundary === 'private-currentness' ? 3 : 2)) {
                    if (boundary === 'private-admission') test.retireNative();
                    else return { status: 503, data: { error: 'database_connection_unavailable' } };
                }
            }
            return await home(url, body, config);
        });
        const input = { homeId: machine.homeId, managedId: machine.id, intent: 'start', when: 'now', expectedRevision: 1 };
        const operations = createHostActionOperationRuntime({ machineId: nativeController.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'not-run' });
        let work: ReturnType<typeof test.driver.execute> | undefined;
        await operations.observeExecution({ actionId: 'machines.managed.power.set', input, actionRequestId: 'control',
            execute: async context => {
                work = test.driver.execute('machines.managed.power.set', input, { requestId: 'control', context, signal: context.signal });
                const result = await work;
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : { ok: true, result };
            } });
        const code = boundary === 'private-admission' ? 'plugin_managed_provider_operation_custody_invalid' : 'database_connection_unavailable';
        await expect(work).rejects.toMatchObject({ code });
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'refused', code } })]);
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        expect(test.effects).toEqual([]);
        expect(ActionOperationGetV1ResponseSchema.parse(await operations.handlers.getV2({ operationId: 'not-run' })))
            .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: code }, settledAt: expect.any(Number) } });
    });
    it.each([
        { intent: 'start', role: 'power', action: 'machines.managed.power.set' },
        { intent: 'delete', role: 'destroy', action: 'machines.managed.delete' },
        { intent: 'rebuild', role: 'rebuild', action: 'machines.managed.rebuild' },
    ] as const)('retains native unknown $role receipts without replay and settles definite refusal', async ({ intent, role, action }) => {
        const test = setup(undefined, { kind: 'unknown' }, intent);
        const machine = test.readMachine();
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const input = intent === 'rebuild'
            ? { homeId: machine.homeId, managedMachineId: machine.id, kind: 'rebuild', expectedRevision: 1, reviewedEffectDigest: 'reviewed-effects' }
            : { homeId: machine.homeId, managedId: machine.id, intent, when: 'now', expectedRevision: 1,
                ...(intent === 'delete' ? { reviewedDependencies: true } : {}) };
        const operations = createHostActionOperationRuntime({ machineId: nativeController.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `native-${role}` });
        let work: ReturnType<typeof test.driver.execute> | undefined;
        const execute = () => operations.observeExecution({ actionId: action, input, actionRequestId: 'control',
            execute: async context => {
                work = test.driver.execute(action, input, { requestId: 'control', context, signal: context.signal });
                const result = await work;
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : { ok: true, result };
            } });
        await expect(execute()).resolves.toMatchObject({ ok: true, result: { kind: 'accepted', managedId: machine.id } });
        await expect(work).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        const readReceipt = async () => ActionOperationGetV1ResponseSchema.parse(
            await operations.handlers.getV2({ operationId: `native-${role}` }));
        const receipt = await readReceipt();
        expect(receipt).toMatchObject({ kind: 'found', operation: { state: 'running',
            observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' },
            domainRef: { kind: 'managedMachine', id: machine.id } } });
        if (receipt.kind !== 'found') throw new Error('Missing native operation receipt');
        expect(receipt.operation.settledAt).toBeUndefined();
        const submission = test.readMachine().submittedNativeEffect;
        expect(submission).toEqual({ intentRevision: 1, requestId: 'control', intent, controller: machine.controller });
        await test.driver.execute('machines.managed.inspect', { homeId: machine.homeId, managedId: machine.id }, test.options);
        await expect(execute()).resolves.toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
        expect(await readReceipt()).toEqual(receipt);
        // Direct driver re-entry also observes the same submission; neither path
        // may apply a second power, destroy or rebuild effect.
        await expect(test.driver.execute(action, input, test.options)).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        expect(test.readMachine().submittedNativeEffect).toEqual(submission);
        expect(test.effects).toEqual([role]);

        test.post.mockRestore();
        const nativeCause = { httpStatusClass: '4xx' as const, code: 'forbidden' as const };
        const refusedResult = { kind: 'refused' as const, code: 'native_denied', nativeCause };
        const refused = setup(undefined, refusedResult, intent, undefined, undefined,
            intent === 'rebuild' ? refusedResult : undefined);
        const refusalOperations = createHostActionOperationRuntime({ machineId: nativeController.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `refused-${role}` });
        let refusalWork: ReturnType<typeof refused.driver.execute> | undefined;
        await refusalOperations.observeExecution({ actionId: action, input, actionRequestId: 'control',
            execute: async context => {
                refusalWork = refused.driver.execute(action, input, { requestId: 'control', context, signal: context.signal });
                return { ok: true, result: await refusalWork };
            } });
        await expect(refusalWork).rejects.toMatchObject({ code: 'native_denied' });
        expect(ActionOperationGetV1ResponseSchema.parse(await refusalOperations.handlers.getV2({ operationId: `refused-${role}` })))
            .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'native_denied',
                details: { kind: 'managedNative', nativeCause } }, settledAt: expect.any(Number) } });
        expect(refused.readMachine().submittedNativeEffect).toBeUndefined();
        expect(refused.effects).toEqual([role]);
    });
    it.each([
        { boundary: 'admit-control', intent: 'start', action: 'machines.managed.power.set', code: 'database_connection_unavailable' },
        { boundary: 'admit-control', intent: 'start', action: 'machines.managed.power.set', code: 'database_transaction_conflict_exhausted' },
        { boundary: 'admit-control', intent: 'delete', action: 'machines.managed.delete', code: 'database_transaction_conflict_exhausted' },
        { boundary: 'admit-control', intent: 'rebuild', action: 'machines.managed.rebuild', code: 'database_transaction_conflict_exhausted' },
        { boundary: 'submit-intent', intent: 'start', action: 'machines.managed.power.set', code: 'database_connection_unavailable' },
    ] as const)('retains the managed target through $action $boundary $code', async ({ boundary, intent, action, code }) => {
        const test = setup(undefined, undefined, intent);
        const machine = test.readMachine();
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => String(url).endsWith(`/${boundary}`)
            ? { status: 503, data: { error: code } }
            : await home(url, body, config));
        const snapshots: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1[] = [];
        const operations = createHostActionOperationRuntime({ machineId: nativeController.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `unavailable-${boundary}`,
            publishSnapshot: snapshot => { snapshots.push(snapshot); } });
        const input = intent === 'rebuild'
            ? { homeId: machine.homeId, managedMachineId: machine.id, kind: 'rebuild', expectedRevision: machine.intentRevision,
                reviewedEffectDigest: 'reviewed-effects' }
            : { homeId: machine.homeId, managedId: machine.id, intent, when: 'now', expectedRevision: machine.intentRevision,
                ...(intent === 'delete' ? { reviewedDependencies: true } : {}) };
        let work: ReturnType<typeof test.driver.execute> | undefined;
        const observed = operations.observeExecution({ actionId: action, input,
            ...(intent === 'start' ? { actionRequestId: 'control' } : {}),
            execute: async context => {
                work = test.driver.execute(action, input, { requestId: context.actionRequestId!, context, signal: context.signal });
                const result = await work;
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : { ok: true, result };
            } });
        const uncertainAdmission = boundary === 'admit-control' && code === 'database_connection_unavailable';
        if (boundary === 'admit-control' && !uncertainAdmission) {
            await expect(observed).rejects.toMatchObject({ code });
        } else if (uncertainAdmission) {
            await expect(observed).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
            await expect(work).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown', details: {
                path: '/v1/machines/managed/controller/admit-control', status: 503, code,
            } });
        } else {
            await expect(observed).resolves.toMatchObject({ ok: true, result: { kind: 'accepted', managedId: machine.id } });
            await expect(work).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown', details: {
                path: '/v1/machines/managed/controller/submit-intent', status: 503, code: 'database_connection_unavailable',
            } });
        }
        expect(test.effects).toEqual([]);
        expect(ActionOperationGetV1ResponseSchema.parse(await operations.handlers.getV2({ operationId: `unavailable-${boundary}` })))
            .toMatchObject({ kind: 'found', operation: {
                domainRef: { kind: 'managedMachine', id: machine.id },
                ...(boundary === 'submit-intent' || uncertainAdmission
                    ? { state: 'running', observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' } }
                    : { state: 'failed', error: { errorCode: code } }),
            } });
        expect(snapshots[0]).toMatchObject({ state: 'accepted', domainRef: { kind: 'managedMachine', id: machine.id } });
        for (const snapshot of snapshots) {
            expect(snapshot.domainRef).toMatchObject({ kind: 'managedMachine', id: machine.id });
        }
    });
    it('does not recreate unused Stop operations after observed settlement and resumes the policy after observed Start', async () => {
        const test = setup(undefined, undefined, 'stop', {
            observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained',
        });
        test.setMachine({ retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' },
            observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained' } });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
            generateOperationId: () => 'policy-stop' });
        const failures: unknown[] = [];
        let reads = 0;
        const runtime = createDaemonManagedMachinePolicyRuntime({
            // Census and the fixture's guest/native transports are the only replaced boundaries.
            loadMachine: async id => ({ id, encryptionMode: 'plain', active: true, metadata: null, metadataVersion: 0,
                daemonState: { status: 'running' }, daemonStateVersion: 1 }),
            readCensus: async () => { reads++; return { machines: [test.readMachine()], targets: [] }; },
            executePolicy: async request => operations.observeExecution({ actionId: 'machines.managed.power.set', input: {},
                actionRequestId: 'policy-stop', execute: async operation => ({ ok: true,
                    result: await test.driver.executePolicy(request.machine, request.purpose, {
                        requestId: 'policy-stop', context: operation, signal: request.signal,
                    }) }) }),
            onUnavailable: error => { failures.push(error); },
        });
        try {
            for (let expected = 1; expected <= 3; expected++) {
                runtime.notifyChanged();
                await vi.waitFor(() => expect(reads).toBe(expected));
            }
            expect(await operations.handlers.getV2({ operationId: 'policy-stop' })).toMatchObject({ kind: 'not_found' });
            expect(test.effects).toEqual([]);
            expect(failures).toEqual([]);
            test.setMachine({ desired: 'start', observation: {
                observedAt: 20, availability: 'present', power: 'running', storage: 'retained',
            } });
            runtime.notifyChanged();
            await vi.waitFor(async () => expect(await operations.handlers.getV2({ operationId: 'policy-stop' }))
                .toMatchObject({ kind: 'found' }));
        } finally { await runtime.stop(); }
    });
    it('does not recreate unused Stop operations while a suspend-only provider is already parked', async () => {
        const test = setup(undefined, undefined, 'suspend', {
            observedAt: 10, availability: 'present', power: 'suspended', storage: 'retained',
        });
        test.setMachine({ retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' },
            observation: { observedAt: 10, availability: 'present', power: 'suspended', storage: 'retained' } });
        let reads = 0;
        const executed: unknown[] = [];
        const runtime = createDaemonManagedMachinePolicyRuntime({
            readCensus: async () => { reads++; return { machines: [test.readMachine()], targets: [] }; },
            executePolicy: async request => { executed.push(request.purpose); return { ok: true, result: {} } as never; },
        });
        try {
            for (let expected = 1; expected <= 3; expected++) {
                runtime.notifyChanged();
                await vi.waitFor(() => expect(reads).toBe(expected));
            }
            expect(executed).toEqual([]);
        } finally { await runtime.stop(); }
    });
    it('does not recreate accepted Start operations while compute runs and the exact Session input remains pending', async () => {
        const test = setup(undefined, undefined, 'start', {
            observedAt: 10, availability: 'present', power: 'running', storage: 'retained',
        });
        test.setMachine({ wakeOnAcceptedMessage: true,
            observation: { observedAt: 10, availability: 'present', power: 'running', storage: 'retained' } });
        const machine = test.readMachine();
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest',
            expectedIntentRevision: machine.intentRevision, controller: machine.controller,
            origin: { kind: 'session-input' as const, session: { homeId: machine.homeId, sessionId: 'session' },
                pendingRequestId: 'retained-pending', requestedAt: 1 }, reason: 'admitted-work' as const };
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
            generateOperationId: () => 'already-running-wake' });
        let reads = 0;
        const runtime = createDaemonManagedMachinePolicyRuntime({
            readCensus: async () => { reads++; return { machines: [test.readMachine()], targets: [target] }; },
            executePolicy: async request => operations.observeExecution({ actionId: 'machines.managed.power.set', input: {},
                actionRequestId: 'already-running-wake', execute: async operation => ({ ok: true,
                    result: await test.driver.executePolicy(request.machine, request.purpose, {
                        requestId: 'already-running-wake', context: operation, signal: request.signal,
                    }) }) }),
        });
        try {
            for (let expected = 1; expected <= 3; expected++) {
                runtime.notifyChanged();
                await vi.waitFor(() => expect(reads).toBe(expected));
            }
        } finally { await runtime.stop(); }
        expect(await operations.handlers.getV2({ operationId: 'already-running-wake' })).toMatchObject({ kind: 'not_found' });
        expect(test.effects).toEqual([]);
    });
    it.each(['idle', 'busy', 'unknown', 'missing-confirmation', 'approval-held', 'approval-approved', 'approval-rejected', 'approval-observation-failed',
        'within-window', 'refused-reopen', 'lost-probe-reply', 'aborted-probe'] as const)(
        'settles unused Stop only with confirmed idle (%s)', async disposition => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_790_000_000_000);
        const test = setup(undefined, undefined, 'stop');
        test.setMachine({ desired: 'start', retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' } });
        const machine = test.readMachine();
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/prepare-policy')) return { status: 200, data: {
                machine: { ...test.readMachine(), desired: 'stop', desiredWhen: 'now' },
            } };
            if (String(url).endsWith('/admit-policy')) test.setMachine({ desired: 'stop' });
            return await home(url, body, config);
        });
        const drain = createDaemonAdmissionDrain();
        const guestOperations = createActionOperationStore();
        let missingCoverage = false;
        const guestOperationProducer = { read: guestOperations.readLiveWork, subscribe: guestOperations.subscribe };
        const guestWork = createLiveWorkProducerGroup(() => missingCoverage ? null
            : [guestOperationProducer]);
        const sessions = createSessionLiveWorkProducer({ readSessions: () => [], readActivity: async () => {
            throw new Error('An inactive retained Session has no local runner to query');
        } });
        const inventory = createManagedActivityInventory({ producers: [sessions, guestWork] });
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        const context: RpcHandlerContext = { signal: new AbortController().signal,
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'guest',
                installationId: 'guest-installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true };
        registerManagedActivityRpcHandlers({ activity: inventory, admissionDrain: drain,
            rpcHandlerManager: { registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
                handlers.set(method, (raw, ingress) => handler(raw as TRequest, ingress));
            } }, validateCurrentTarget: async target => target.managedId === machine.id
                && target.expectedRevision === test.readMachine().intentRevision,
            commitIdleEvidence: (_target, idle) => signedIdle(test.readMachine(), idle.since, Date.now()) });
        const call = async (current: typeof machine, method: string, action?: 'begin' | 'resume') => {
            const handler = handlers.get(method);
            if (!handler) throw new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND);
            return ManagedActivityBridgeResultV1Schema.parse(await handler({ homeId: current.homeId,
                managedId: current.id, expectedRevision: current.intentRevision, controller: current.controller,
                ...(action ? { action } : {}) }, context));
        };
        const bridge = { read: async (current: typeof machine) => {
                const result = await call(current, MANAGED_ACTIVITY_READ_RPC_METHOD);
                if (disposition === 'lost-probe-reply') throw new Error('RPC response lost');
                if (disposition === 'aborted-probe') await controller.handlers.cancel({ operationId: 'unused-stop' });
                return result;
            },
            confirmIdle: (current: typeof machine) => call(current, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, 'begin'),
            reopen: (current: typeof machine) => disposition === 'refused-reopen'
                ? Promise.resolve({ kind: 'refused' as const, code: 'admission_unavailable' as const })
                : call(current, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, 'resume'),
            waitForChange: async (signal?: AbortSignal) => {
                signal?.throwIfAborted();
                await new Promise<void>((resolve, reject) => {
                    const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', abort); };
                    const abort = () => { cleanup(); reject(signal?.reason); };
                    const unsubscribe = inventory.subscribe(() => { cleanup(); resolve(); });
                    signal?.addEventListener('abort', abort, { once: true });
                    if (signal?.aborted) abort();
                });
            } };
        const driver = createManagedMachineAcquisitionDriver({ ...test.driverInput, managedGuestActivity: bridge });
        const controller = createHostActionOperationRuntime({ machineId: nativeController.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'unused-stop' });
        const approvals = createBlockingApprovalCoordinator();
        let storedApproval: ReturnType<typeof StoredApprovalRequestSchema.parse> | undefined;
        let failApprovalObservation: ((error: unknown) => void) | undefined;
        let work: ReturnType<typeof driver.executePolicy> | undefined;
        let settled = false;
        const insideWindow = ['within-window', 'refused-reopen', 'lost-probe-reply', 'aborted-probe'].includes(disposition);
        try {
            expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: Date.now() });
            vi.setSystemTime(Date.now() + (insideWindow ? 1_000 : 3_600_000));
            if (disposition === 'busy') {
                guestOperations.create({ operationId: 'accepted-work', actionId: 'projects.compute.exec', title: 'Accepted work',
                    scope: { accountId: 'owner', machineId: 'guest' }, cancellation: 'supported', inputIdentity: '{}' });
            } else if (disposition === 'unknown') {
                missingCoverage = true;
                guestWork.notifyChanged();
            }
            if (disposition === 'missing-confirmation') handlers.delete(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD);
            const observed = controller.observeExecution({ actionId: 'machines.managed.power.set', input: {}, actionRequestId: 'control',
                execute: async operation => {
                    work = driver.executePolicy(machine, { kind: 'retention' }, { requestId: 'control',
                        context: operation, signal: operation.signal,
                        ...(disposition.startsWith('approval-') ? {
                            runPolicyAction: (preview, runApproved) => executeManagedMachinePolicyAction({
                                machine: preview, runApproved, serverId: 'home',
                                context: { ...operation, actionRequestId: 'control', surface: 'cli', runtimeAccountId: 'owner',
                                    serverIdentityId: machine.homeId, defaultSessionMachineId: nativeController.machineId,
                                    actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
                                        'machines.managed.power.set': { approvalRequiredSurfaces: ['cli'] },
                                    } }) },
                                createExecutor: overrides => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...overrides,
                                    isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
                                        accountId: 'owner', machineId: nativeController.machineId, serverId: 'home',
                                        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: machine.homeId,
                                            machineId: nativeController.machineId }),
                                        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'token', encryption: null } }),
                                        isAccountCurrent: async () => true, listAccountApiTokens: async () => ({ tokens: [] }),
                                    }),
                                    // Artifact persistence is the system boundary; the real
                                    // guest bridge, Action policy and approval wait stay composed.
                                    approvalsCreate: async ({ request }) => {
                                        storedApproval = StoredApprovalRequestSchema.parse(request);
                                        return { artifactId: 'unused-stop-approval' };
                                    },
                                    approvalsGet: async () => storedApproval ?? null,
                                    approvalsUpdate: async ({ request }) => {
                                        storedApproval = StoredApprovalRequestSchema.parse(request);
                                        return { ok: true };
                                    },
                                    approvalsWaitForDecision: async args => {
                                        const decision = await approvals.waitForDecision({ ...args,
                                            readRequest: async () => storedApproval ?? null,
                                            subscribeChanges: (_onChange, onError) => {
                                                failApprovalObservation = onError;
                                                return { dispose() {} };
                                            } });
                                        return { ...decision, request: StoredApprovalRequestSchema.parse(decision.request) };
                                    },
                                }),
                            }),
                        } : {}) });
                    try { return { ok: true, result: await work }; }
                    catch (error) { return { ok: false, error: 'Drain unavailable', errorCode: operation.signal.aborted ? 'cancelled'
                        : error instanceof RpcError ? error.rpcErrorCode : 'drain_failed' }; }
                    finally { settled = true; }
                } });
            while (!settled) {
                if (disposition.startsWith('approval-') && storedApproval) break;
                const result = await controller.handlers.getV2({ operationId: 'unused-stop' });
                const expected = disposition === 'busy' ? 'managed.intent.busy' : 'managed.intent.activity-unknown';
                if (result.kind === 'found' && result.operation.progress?.kind === 'phase'
                    && (result.operation.progress.phase === expected || insideWindow
                        && result.operation.progress.phase === 'managed.intent.waiting-idle')) {
                    // Let the probe finish and reach its change wait, rather
                    // than asserting on the initial phase publication.
                    await new Promise<void>(resolve => setImmediate(resolve));
                    break;
                }
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            if (insideWindow) {
                expect(drain.isQuiescing()).toBe(false);
                expect(test.effects).toEqual([]);
                const installer = createAgentInstallJobOwner({ admissionDrain: drain, readTrackedSessions: () => [],
                    readRegistry: () => ({ agents: [{ id: 'fixture-manual', pluginId: 'fixture.plugin', runtimeSpec: {
                        id: 'fixture-manual', title: 'Fixture', binaryName: 'fixture-manual', sourcePreferenceDefault: 'system-first',
                        acceptsJavaScriptFileOverride: false, manualInstallKind: 'command', manualInstallRecipes: null,
                        managedInstall: null, installGuideUrl: 'https://example.com/guide',
                    } }], managedDependencies: [] }) });
                try {
                    expect(installer.start({ agentId: 'fixture-manual', intent: 'install', consent: { vendorRecipe: false } }).ok).toBe(true);
                } finally { await installer.shutdown(); }
                await controller.handlers.cancel({ operationId: 'unused-stop' });
                await observed;
                expect(drain.isQuiescing()).toBe(false);
            } else if (disposition.startsWith('approval-')) {
                expect(storedApproval).toMatchObject({ status: 'open', actionId: 'machines.managed.power.set',
                    approval: { flow: 'blocking', result: 'required' },
                    actionArgs: { managedId: machine.id, intent: 'stop', expectedRevision: machine.intentRevision },
                    executionOriginV1: { requestId: 'control', authority: 'account_automation' } });
                expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: Date.now() - 3_600_000 });
                await expect(controller.handlers.getV2({ operationId: 'unused-stop' })).resolves.toMatchObject({
                    kind: 'found', operation: { state: 'running', progress: { kind: 'phase', phase: 'waiting_for_approval',
                        approval: { kind: 'approval_request_created', artifactId: 'unused-stop-approval', actionId: 'machines.managed.power.set' } } },
                });
                const current = await controller.handlers.getV2({ operationId: 'unused-stop' });
                const reader = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                    actionOperationAction: args => executeActionOperationActionV1({ ...args, transport: async request => {
                        expect(request.method).toBe(ACTION_OPERATION_RPC_METHODS_V2.get);
                        return await controller.handlers.getV2(request.payload);
                    } }),
                });
                for (const surface of ['agent', 'mcp', 'cli'] as const) {
                    expect(await reader.execute('action.operations.get', { serverId: 'home',
                        machineId: nativeController.machineId, operationId: 'unused-stop' }, {
                        surface, authority: 'account_automation', actionCaller: { kind: 'host' },
                        serverId: 'home', actionRequestId: `read:${surface}`, defaultSessionMachineId: nativeController.machineId,
                    })).toEqual({ ok: true, result: current });
                }
                const predecessor = PredecessorOperationGetSchema.parse(await controller.handlers.get({ operationId: 'unused-stop' }));
                expect(predecessor).toMatchObject({ kind: 'found', operation: {
                    progress: { kind: 'phase', phase: 'waiting_for_approval' },
                } });
                if (predecessor.kind === 'found') expect(predecessor.operation.progress).not.toHaveProperty('approval');
                expect(test.effects).toEqual([]);
                expect(test.post.mock.calls.some(([url]) => String(url).endsWith('/admit-policy'))).toBe(false);
                expect(test.readMachine()).toMatchObject({ desired: 'start', intentRevision: machine.intentRevision });
                if (disposition === 'approval-held') await controller.handlers.cancel({ operationId: 'unused-stop' });
                else if (disposition === 'approval-observation-failed') {
                    if (!failApprovalObservation) throw new Error('Missing Artifact observation');
                    failApprovalObservation(new Error('approval_feed_failed'));
                }
                else {
                    if (!storedApproval) throw new Error('Missing Stop Ask');
                    await approvals.resolveBlockingDecision({ artifactId: 'unused-stop-approval', request: storedApproval,
                        decision: disposition === 'approval-approved' ? 'approve' : 'reject', decisionAuthority: 'present_user' });
                }
                await observed;
                const terminal = await controller.handlers.getV2({ operationId: 'unused-stop', waitForTerminal: true });
                expect(terminal).toMatchObject({ kind: 'found', operation: {
                    state: disposition === 'approval-approved' ? 'succeeded' : disposition === 'approval-held' ? 'cancelled' : 'failed',
                } });
                if (terminal.kind === 'found') {
                    expect(terminal.operation.progress).not.toHaveProperty('approval');
                    expect(terminal.operation.progress).not.toMatchObject({ phase: 'waiting_for_approval' });
                }
                expect(test.effects).toEqual(disposition === 'approval-approved' ? ['power'] : []);
                expect(drain.isQuiescing()).toBe(disposition === 'approval-approved');
            } else if (disposition === 'busy' || disposition === 'unknown') {
                await expect(controller.handlers.getV2({ operationId: 'unused-stop' })).resolves.toMatchObject({ kind: 'found', operation: {
                    state: 'running', progress: { phase: disposition === 'busy' ? 'managed.intent.busy' : 'managed.intent.activity-unknown' } } });
                expect(test.effects).toEqual([]);
                expect(test.post.mock.calls.some(([url]) => String(url).endsWith('/admit-policy'))).toBe(false);
                await controller.handlers.cancel({ operationId: 'unused-stop' });
                await observed;
            } else {
                await observed;
                await expect(controller.handlers.getV2({ operationId: 'unused-stop', waitForTerminal: true })).resolves.toMatchObject({ kind: 'found', operation: {
                    state: disposition === 'idle' ? 'succeeded' : 'failed' } });
                expect(test.effects).toEqual(disposition === 'idle' ? ['power'] : []);
                if (disposition === 'idle') expect(test.nativeInputs).toContainEqual({ resource: machine.resource!.value, intent: 'stop' });
            }
        } finally {
            await controller.handlers.cancel({ operationId: 'unused-stop' });
            approvals.dispose();
            await work?.catch(() => undefined);
            inventory.dispose();
            guestWork.dispose();
        }
    });
});

it('Remove recovers an identity-free submitted allocation through ordinary read-only reconciliation before destruction', async () => {
    const test = setup(undefined, undefined, 'delete', { observedAt: 1, availability: 'absent' }, undefined, undefined, true);
    test.setMachine({ allocation: 'may-exist', resource: undefined, nativeOperationRef: undefined, enrolledMachineId: undefined });
    expect(await test.run()).toMatchObject({ kind: 'accepted', managedId: 'managed' });
    expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
    expect(test.effects).toEqual(['reconcile', 'destroy']);
    expect(test.nativeInputs[0]).toMatchObject({ correlation: { managedId: 'managed', requestId: 'control', launch: {} } });
    expect(test.nativeInputs[1]).toEqual({ resource: {} });
});

async function finScopeAuthorization(test: ReturnType<typeof setup>, isSourceCurrent: () => boolean) {
    const machine = test.readMachine();
    if (!machine.controller) throw new Error('FIN scope fixture requires a controller');
    const controller = machine.controller;
    const transport = test.post.getMockImplementation()!;
    test.post.mockImplementation(async (url, body, config) => String(url).endsWith('/verify')
        ? { status: isSourceCurrent() ? 200 : 401, data: isSourceCurrent() ? { ok: true } : { error: 'invalid_token' } }
        : await transport(url, body, config));
    const target = { kind: 'machine' as const, machineId: controller.machineId };
    const authorization = await projectExternalActionRequesterHttpAuthorization({
        authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-fin-origin', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', serverIdentityId: machine.homeId, machineId: controller.machineId,
            installationId: controller.installationId, actionId: 'machines.managed.delete', requestId: 'control',
            requestEnvelopeDigest: 'a'.repeat(43), target, workflowActionOrigin: { runId: 'scope-run', requestId: 'control' },
        } }), serverId: 'home', serverIdentityId: machine.homeId, serverHttpBaseUrl: 'https://home.example',
        target, installationId: controller.installationId, privateKey: test.installationKeys.secretKey,
    });
    if (!authorization) throw new Error('FIN scope fixture did not admit');
    return { externalActionExecutionAuthorization: authorization, externalActionTarget: target };
}

describe('managed native intent through the accepted Action', () => {
    it('refuses unused retention for an unenrolled guest before opening its activity socket', async () => {
        const test = setup();
        test.setMachine({ enrolledMachineId: undefined, retention: { kind: 'unused', afterMs: 60_000, effect: 'delete' } });
        // Network allocation is forbidden for a refusal already established by the retained row.
        const socket = vi.spyOn(activitySocket, 'createUserScopedSocketConnection').mockImplementation(() => {
            throw new Error('Unexpected activity socket allocation');
        });
        const driver = createManagedMachineAcquisitionDriver({ ...test.driverInput, managedGuestActivity: undefined });
        await expect(driver.executePolicy(test.readMachine(), { kind: 'retention' }, test.options))
            .rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(socket).not.toHaveBeenCalled();
        expect(test.effects).toEqual([]);
    });
    it('re-supplies retained native destroy custody instead of replaying resource deletion', async () => {
        const test = setup(undefined, { kind: 'confirmed' }, 'delete', undefined, undefined, undefined, true);
        const machine = test.readMachine();
        test.setMachine({ nativeOperationRef: { contributionRef: machine.resource!.contributionRef,
            schemaVersion: machine.resource!.schemaVersion, value: {} },
            submittedNativeEffect: { intentRevision: machine.intentRevision, requestId: 'control', intent: 'delete',
                controller: machine.controller } });

        await expect(test.driver.execute('machines.managed.inspect', { homeId: machine.homeId, managedId: machine.id }, test.options))
            .resolves.toMatchObject({ machine: { allocation: 'confirmed-absent' } });
        expect(test.effects).toEqual(['destroy']);
        expect(test.nativeInputs).toEqual([{ nativeOperation: {} }]);
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'confirmed' },
            observation: expect.objectContaining({ availability: 'absent' }) })]);
    });
    it.each([{ label: 'Delete', action: 'delete' }, { label: 'Check now', action: 'inspect' }] as const)
    ('finishes canceled creation $label when its acquisition read proves no native resource exists', async ({ action }) => {
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, true, undefined,
            { nativeRoleResults: { reconcile: { kind: 'rejected', code: 'managed_not_found' } } });
        test.setMachine({ creationState: 'canceled', allocation: 'may-exist', resource: undefined, nativeOperationRef: undefined, enrolledMachineId: undefined,
            cleanup: { disposition: 'pending', reason: 'creation_canceled' } });
        if (action === 'delete') await expect(test.run()).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
        else await expect(test.driver.execute('machines.managed.inspect', {
            homeId: test.readMachine().homeId, managedId: test.readMachine().id,
        }, test.options)).resolves.toMatchObject({ machine: { allocation: 'confirmed-absent' } });
        expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
        expect(test.effects).toEqual(['reconcile']);
        expect(test.post.mock.calls.filter(([url]) => String(url).endsWith('/submit-intent'))).toHaveLength(0);
    });
    it('settles canceled submitted cleanup when Check now proves the retained acquisition is absent', async () => {
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, true, undefined,
            { nativeRoleResults: { reconcile: { kind: 'rejected', code: 'managed_not_found' } } });
        const machine = test.readMachine();
        test.setMachine({ creationState: 'canceled', allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: { contributionRef: machine.launch.provider, schemaVersion: 1, value: {} },
            submittedNativeEffect: { intentRevision: machine.intentRevision, requestId: 'control', intent: 'delete', controller: machine.controller },
            cleanup: { disposition: 'pending', reason: 'creation_canceled' } });
        await expect(test.driver.execute('machines.managed.inspect', { homeId: machine.homeId, managedId: machine.id }, test.options))
            .resolves.toMatchObject({ machine: { allocation: 'confirmed-absent', observation: { availability: 'absent' } } });
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        expect(test.effects).toEqual(['reconcile']);
    });
    it('uses the acquisition owner observation once when Check now recovers a submitted Delete resource', async () => {
        const onInspect = vi.fn();
        const test = setup(undefined, undefined, 'delete', { observedAt: 123, availability: 'present' }, undefined, undefined, true, undefined, { onInspect });
        const machine = test.readMachine();
        test.setMachine({ creationState: 'canceled', allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: { contributionRef: machine.launch.provider, schemaVersion: 1, value: {} },
            submittedNativeEffect: { intentRevision: machine.intentRevision, requestId: 'control', intent: 'delete', controller: machine.controller } });
        await expect(test.driver.execute('machines.managed.inspect', { homeId: machine.homeId, managedId: machine.id }, test.options))
            .resolves.toMatchObject({ machine: { allocation: 'bound', submittedNativeEffect: { intent: 'delete' },
                observation: { observedAt: 123, availability: 'present' } } });
        expect(onInspect).toHaveBeenCalledTimes(1);
        expect(test.effects).toEqual(['reconcile']);
    });
    it.each(['inspect', 'delete'] as const)('settles lost pending cleanup through %s without binding compute or replaying Delete', async action => {
        const test = setup(undefined, { kind: 'unknown' }, 'delete', { observedAt: 123, availability: 'absent' }, undefined,
            { kind: 'unknown', recovery: { reference: 'owned-volume', reason: 'native_cleanup_unknown' } }, true, { kind: 'confirmed' });
        test.setMachine({ allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} } });
        await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        if (action === 'inspect') await test.driver.execute('machines.managed.inspect', {
            homeId: test.readMachine().homeId, managedId: test.readMachine().id,
        }, test.options);
        else await test.run();
        expect(test.readMachine()).toMatchObject({ id: 'managed', allocation: 'confirmed-absent' });
        expect(test.readMachine().nativeOperationRef).toBeUndefined();
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
        await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
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
        await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
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
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
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
        const currentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'owner', machineId: nativeController.machineId,
            serverId: 'home', resolveCurrentMachineExecutionOriginContext: async () => originCurrent
                ? { serverIdentityId: machine.homeId, machineId: nativeController.machineId } : null,
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'token', encryption: null } }),
            isAccountCurrent: async () => true,
            listAccountApiTokens: async () => ({ tokens: [] }) });
        const work = test.driver.executePolicy(machine, { kind: 'accepted-input-start', target }, { ...test.options, signal: lifetime.signal, actionOrigin,
            runPolicyAction: (policyMachine, runApproved) => executeManagedMachinePolicyAction({ machine: policyMachine,
                context: { ...test.options.context, signal: lifetime.signal, actionRequestId: 'control', surface: 'cli', runtimeAccountId: 'owner',
                    serverIdentityId: machine.homeId, defaultSessionMachineId: nativeController.machineId,
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

    it.each(['project-machine', 'demanded-session'] as const)('retains the original finite wake authority in every signed native policy phase (%s)', async root => {
        const observation: ProviderObservationV1 = { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' };
        const test = setup(undefined, undefined, 'start', observation,
            () => Object.assign(observation, { observedAt: 2, power: 'running' }));
        test.setMachine({ wakeOnAcceptedMessage: true });
        const machine = test.readMachine();
        // Only Home/native network boundaries are substituted. This is the exact
        // guest-targeted issuer envelope, never controller credentials or command bytes.
        const actionOrigin = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-finite-authority', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', machineId: 'guest', installationId: 'guest-installation', serverIdentityId: machine.homeId,
            actionId: root === 'demanded-session' ? 'session.open' : 'projects.script.run',
            requestId: 'original-finite', requestEnvelopeDigest: 'a'.repeat(43),
            ...(root === 'demanded-session' ? { machineRuntimeDemand: 'required', target: { kind: 'session', sessionId: 'sleeping-session' } }
                : { target: { kind: 'machine', machineId: 'guest' } }),
        } });
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest',
            expectedIntentRevision: machine.intentRevision, controller: machine.controller,
            origin: { kind: 'finite-command' as const, actionRequestId: actionOrigin.binding.requestId }, reason: 'admitted-work' as const };
        if (root === 'demanded-session') {
            const passiveOrigin = ExternalActionExecutionAuthorizationV1Schema.parse({ ...actionOrigin,
                binding: { ...actionOrigin.binding, machineRuntimeDemand: undefined } });
            await expect(test.driver.executePolicy(machine, { kind: 'accepted-input-start', target },
                { ...test.options, actionOrigin: passiveOrigin })).rejects.toMatchObject({ code: 'admission_unavailable' });
            expect(test.effects).toEqual([]);
            expect(test.post).not.toHaveBeenCalled();
        }
        await expect(test.driver.executePolicy(machine, { kind: 'accepted-input-start', target }, { ...test.options, ...{ actionOrigin } }))
            .resolves.toMatchObject({ kind: 'accepted', managedId: machine.id });
        expect(test.effects).toEqual(['power', 'bootstrap']);
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
        await expect(test.driver.execute('machines.managed.rebuild', request, test.options)).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        expect(test.effects).toEqual(['rebuild']);
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'unknown', recovery: { reference: 'old-native', reason: 'native_rebuild_unknown' } } })]);
        await expect(test.driver.execute('machines.managed.rebuild', request, test.options)).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
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
        const transport = test.post.getMockImplementation()!;
        let admitted = false;
        test.post.mockImplementation(async (url, body, config) => {
            const path = String(url);
            // Home's /current endpoint authenticates an already admitted request.
            // Before admission this new policy request cannot replace Cancel's custody.
            if (path.endsWith('/current') && !admitted) return { status: 409, data: { code: 'request_conflict' } };
            const response = await transport(url, body, config);
            if (path.endsWith('/admit-policy')) admitted = true;
            return response;
        });
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
        test.setMachine({ desired: 'start', retention: kind === 'deadline'
            ? { kind: 'deadline', at: Date.now() + 3_600_000, effect: 'delete', interrupts: true }
            : { kind: 'unused', afterMs: 3_600_000, effect: 'delete' } });
        const machine = test.readMachine();
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const operationId = `waiting-${kind}`;
        const operations = createHostActionOperationRuntime({ machineId: nativeController.machineId,
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
    it.each(['busy', 'unknown'] as const)('publishes the actual %s guest decision and waits for confirmation before an after-idle native effect', async kind => {
        const test = setup({ kind, reasons: ['finite'] });
        test.setMachine({ desiredWhen: 'after-idle' });
        const machine = test.readMachine();
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const operations = createHostActionOperationRuntime({ machineId: nativeController.machineId,
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
                progress: { kind: 'phase', phase: 'managed.intent.waiting-idle' },
            } });
            expect(test.effects).toEqual([]);
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
    it('issues zero controller currentness reads for unrelated own-Machine, Team and Account reconnect changes while idle', async () => {
        const test = setup({ kind: 'busy', reasons: ['finite'] });
        test.setMachine({ desired: 'start', retention: { kind: 'unused', afterMs: 60_000, effect: 'delete' } });
        const machine = test.readMachine();
        const http = createServer();
        const server = new Server(http, { path: '/v1/updates/' });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Expected loopback socket');
        let activityReads = 0;
        server.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, (_request: unknown, reply: (result: unknown) => void) => {
            activityReads++;
            reply({ ok: true, result: { kind: 'busy', reasons: ['finite'] } });
        }));
        let publish: Parameters<NonNullable<ManagedMachineAcquisitionDriverInput['subscribeManagedMachineChanges']>>[0] | undefined;
        const lifetime = new AbortController();
        let waiting = false;
        const work = prepareManagedRetentionPolicy({ machine, purpose: { kind: 'retention' },
            input: { ...test.driverInput, serverUrl: `http://127.0.0.1:${address.port}`, managedGuestActivity: undefined,
                subscribeManagedMachineChanges: listener => { publish = listener; return () => { publish = undefined; }; } },
            options: { requestId: 'retention', signal: lifetime.signal,
                context: { operationOwnerUpdate: { update: () => { waiting = true; } } } },
        }).catch((error: unknown) => error);
        try {
            await vi.waitFor(() => { expect(waiting).toBe(true); expect(activityReads).toBe(1); });
            const currentReads = () => test.post.mock.calls.filter(([url]) => String(url).endsWith('/controller/current')).length;
            const before = currentReads();
            for (let index = 0; index < 60; index++) {
                publish?.({ kind: 'machines', machineIds: [machine.controller!.machineId] });
                publish?.({ kind: 'currentness' });
                publish?.(undefined);
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            expect(currentReads() - before).toBe(0);
            expect(activityReads).toBe(1);
            test.setMachine({ intentRevision: machine.intentRevision + 1 });
            publish?.({ kind: 'managed', managedIds: [machine.id] });
            expect(await work).toMatchObject({ code: 'intent_changed' });
            expect(currentReads() - before).toBe(1);
        } finally {
            lifetime.abort();
            await work;
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
    it.each(['control', 'policy'] as const)('associates the real %s operation with its admitted row before native effects', async (source) => {
        let domainRef: ActionOperationDomainRefV1 | undefined;
        const observed: Array<ActionOperationDomainRefV1 | undefined> = [];
        const test = setup(undefined, undefined, 'delete', undefined, () => { observed.push(domainRef); });
        const machine = test.readMachine();
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const operations = createHostActionOperationRuntime({ machineId: nativeController.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `managed-${source}`,
            publishSnapshot: snapshot => { domainRef = snapshot.domainRef; },
        });
        const request = { homeId: machine.homeId, managedId: machine.id, when: 'now' as const,
            intent: 'delete' as const, expectedRevision: machine.intentRevision, reviewedDependencies: true };
        if (source === 'policy') test.setMachine({ desired: 'start', retention: { kind: 'unused', afterMs: 1, effect: 'delete' } });
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
        }, test.options)).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        expect(test.effects).toEqual(['power']);
        expect(test.readMachine().submittedNativeEffect).toMatchObject({ intentRevision: 2, requestId: 'control', intent: 'start' });
    });
    it.each(['stopped', 'running', 'unknown', 'stale'] as const)(
        'settles retained Start from %s native observation before proceeding with the newer Stop', async power => {
        const test = setup(undefined, { kind: 'confirmed' }, 'stop', {
            observedAt: power === 'stale' ? 9 : 20, availability: 'present', power: power === 'stale' ? 'stopped' : power,
        });
        const original = test.readMachine();
        test.setMachine({ intentRevision: 2, observation: { observedAt: 10, availability: 'present', power: 'stopped' },
            submittedNativeEffect: { intentRevision: 1, requestId: 'old-start', intent: 'start', controller: original.controller } });
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/report-intent')) {
                const report = ManagedControllerIntentReportV1Schema.parse(body);
                const current = test.readMachine();
                // Home HTTP is the substituted system boundary. Its settlement
                // decision runs the same real owner consumed by reportManagedIntent.
                if (doesManagedNativeObservationSettleIntent(current.submittedNativeEffect!.intent,
                    report.observation, current.observation)) test.setMachine({ submittedNativeEffect: undefined });
            }
            return await home(url, body, config);
        });
        const work = test.driver.execute('machines.managed.power.set', { homeId: original.homeId, managedId: original.id,
            intent: 'stop', when: 'now', expectedRevision: 2 }, test.options);
        if (power === 'unknown' || power === 'stale') {
            await expect(work).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
            expect(test.readMachine().submittedNativeEffect).toMatchObject({ intent: 'start', intentRevision: 1, requestId: 'old-start' });
            expect(test.effects).toEqual([]);
        } else {
            await expect(work).resolves.toMatchObject({ kind: 'accepted', intentRevision: 2 });
            expect(test.effects).toEqual(['power']);
            expect(test.reports).toMatchObject([
                { expectedIntentRevision: 1, requestId: 'old-start', observation: { power } },
                { expectedIntentRevision: 2, requestId: 'control', result: { kind: 'confirmed' } },
            ]);
            expect(test.readMachine().submittedNativeEffect?.intent).not.toBe('start');
            expect(test.readMachine()).toMatchObject({ desired: 'stop', intentRevision: 2 });
        }
    });
    it('does not settle a new Start after only inspecting an older unknown Stop on the same resource', async () => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'confirmed' }, 'start');
        test.setMachine({ intentRevision: 2, desired: 'start', submittedNativeEffect: {
            intentRevision: 1, requestId: 'old-stop', intent: 'stop', controller: test.readMachine().controller,
        } });
        const machine = test.readMachine();
        await expect(test.driver.execute('machines.managed.power.set', { homeId: machine.homeId,
            managedId: machine.id, intent: 'start', when: 'now', expectedRevision: machine.intentRevision,
        }, test.options)).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        expect(test.effects).toEqual([]);
        expect(test.reports).toEqual([expect.objectContaining({ expectedIntentRevision: 1, requestId: 'old-stop',
            result: { kind: 'unknown' }, observation: { observedAt: 0, availability: 'present' } })]);
        expect(test.readMachine().submittedNativeEffect?.requestId).toBe('old-stop');
    });
    it.each(['unknown', 'thrown'] as const)('retains waiting input when native Start is %s', async outcome => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'unknown' }, 'start', undefined,
            outcome === 'thrown' ? () => { throw new Error('native_transport_lost'); } : undefined);
        const machine = test.readMachine();
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest',
            expectedIntentRevision: machine.intentRevision, controller: machine.controller,
            origin: { kind: 'session-input' as const, session: { homeId: machine.homeId, sessionId: 'session' },
                pendingRequestId: 'pending', requestedAt: 1 }, reason: 'admitted-work' as const };
        await expect(test.driver.executePolicy(machine, { kind: 'accepted-input-start', target }, test.options)).rejects.toThrow();
        expect(test.reports).toMatchObject([{ result: { kind: 'unknown' } }]);
        expect(test.post.mock.calls.filter(([url]) => String(url).endsWith('/activation-failed'))).toEqual([]);
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
            .toEqual({ target, failureCode: 'managed_start_refused' });
        const report = test.post.mock.calls.find(([url]) => String(url).endsWith('/activation-failed'));
        const headers = report?.[2]?.headers;
        const proof = decodeManagedPolicyProofV1(String(headers?.[MANAGED_POLICY_PROOF_HEADER]));
        expect(proof?.payload.managedPolicy?.expectedIntentRevision).toBe(target.expectedIntentRevision);
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
    });
    it('carries an after-idle retention Stop out as native Suspend for a provider that only suspends', async () => {
        vi.useFakeTimers({ now: 3_599_999 });
        const test = setup(undefined, undefined, 'suspend');
        test.setMachine({ desiredWhen: 'after-idle', desiredAfterMs: 3_600_000, retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' } });
        const work = test.run();
        await vi.advanceTimersByTimeAsync(0);
        expect(test.effects).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await work;
        expect(test.effects).toEqual(['power']);
        expect(test.nativeInputs).toMatchObject([{ intent: 'suspend' }]);
    });
    it('keeps the selected unused interval in waiting until native preparation is due', async () => {
        vi.useFakeTimers({ now: 60_000 });
        const test = setup();
        test.setMachine({ desiredWhen: 'after-idle', desiredAfterMs: 3_600_000 });
        const machine = test.readMachine();
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const phases: string[] = [];
        const operations = createHostActionOperationRuntime({ machineId: nativeController.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'unused-interval',
            publishSnapshot: snapshot => {
                if (snapshot.progress?.kind === 'phase') phases.push(snapshot.progress.phase);
            } });
        const observed = operations.observeExecution({ actionId: 'machines.managed.delete', input: {}, actionRequestId: 'control',
            execute: async context => ({ ok: true, result: await test.driver.execute('machines.managed.delete', {
                homeId: machine.homeId, managedId: machine.id, when: 'after-idle', intent: 'delete',
                afterMs: 3_600_000, reviewedDependencies: true,
            }, { requestId: 'control', context, signal: context.signal }) }) });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(test.effects).toEqual([]);
            expect(await operations.handlers.getV2({ operationId: 'unused-interval' })).toMatchObject({ kind: 'found', operation: {
                state: 'running', progress: { kind: 'phase', phase: 'managed.intent.waiting-idle' },
            } });
            // The guest's short probe is not a stopping state in the UI.
            expect(phases).not.toContain('managed.intent.draining');
            await vi.advanceTimersByTimeAsync(3_540_000);
            await observed;
            expect(test.effects).toEqual(['destroy']);
            expect(phases).toContain('managed.intent.draining');
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
        test.readActivity.mockResolvedValue(fresh);
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
        test.readActivity.mockResolvedValue(fresh);
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
        await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        expect(test.effects.filter(role => role === 'destroy')).toEqual(['destroy']);
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'confirmed' } }),
            expect.objectContaining({ result: { kind: 'unknown' }, observation: { observedAt: 0, availability: 'present' } })]);
    });
    it('retains an unknown native delivery and retries only inspection of the same resource', async () => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'unknown' });
        await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        expect(test.effects).toEqual(['destroy']);
        expect(test.reports).toHaveLength(2);
        expect(test.reports[1]).toMatchObject({ requestId: 'control', expectedIntentRevision: 1,
            result: { kind: 'unknown' }, observation: { observedAt: 0, availability: 'present' } });
    });
    it('settles native uncertainty through the actual Inspect front door without acquisition reporting or native replay', async () => {
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'unknown' });
        await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
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
        await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
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
        test.setMachine({ desired: 'start', retention: { kind: 'unused', afterMs: 1, effect: 'delete' } });
        const lifetime = new AbortController();
        let enabled = true;
        let interrupted = false;
        const coordinator = createBlockingApprovalCoordinator();
        let stored: ReturnType<typeof StoredApprovalRequestSchema.parse> | undefined;
        let waiting!: () => void;
        const held = new Promise<void>(resolve => { waiting = resolve; });
        const initialMachine = test.readMachine();
        const initialNativeController = initialMachine.controller;
        if (!initialNativeController) throw new Error('The native fixture requires its installed controller.');
        const currentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'owner', machineId: initialNativeController.machineId,
            serverId: 'home', resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: initialMachine.homeId,
                machineId: initialNativeController.machineId }),
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'token', encryption: null } }),
            isAccountCurrent: async () => true,
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
            const idle = async (): Promise<ManagedActivityBridgeResultV1> => ({ kind: 'idle', since: 0,
                evidence: signedIdle(test.readMachine(), 0, Date.now()) });
            test.readActivity.mockImplementation(idle);
            test.confirmIdle.mockImplementation(idle);
        });
        const work = test.driver.executePolicy(test.readMachine(), { kind: 'retention' }, { ...test.options, signal: lifetime.signal,
            runPolicyAction: (machine, runApproved) => {
                const nativeController = machine.controller;
                if (!nativeController) throw new Error('The native fixture requires its installed controller.');
                return executeManagedMachinePolicyAction({ machine, runApproved, serverId: 'home',
                context: { ...test.options.context, signal: lifetime.signal, actionRequestId: 'control', surface: 'cli',
                    runtimeAccountId: 'owner', serverIdentityId: machine.homeId, defaultSessionMachineId: nativeController.machineId,
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
            });
            } });
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
            while (test.waitForChange.mock.calls.length === 0 && test.effects.length === 0) {
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
        const nativeController = test.readMachine().controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const operations = createHostActionOperationRuntime({ machineId: nativeController.machineId,
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
    });
});
