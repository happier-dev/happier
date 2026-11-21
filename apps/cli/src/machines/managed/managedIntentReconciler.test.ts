import axios from 'axios';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema, ManagedOpaquePresetMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachinePresetContentV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ManagedControlAdmissionInputV1Schema, ManagedControllerIntentReportV1Schema, ManagedControllerReportV1Schema, ManagedControllerCurrentnessV1Schema, ManagedControllerCurrentInputV1Schema, ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolveMachineRetentionNativeIntentV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import type { ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { signMachineInstallationProof, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { ManagedActivityBridgeResultV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { MANAGED_POLICY_PROOF_HEADER, ManagedPolicyAdmissionInputV1Schema, ManagedPolicyAdmissionOutputV1Schema, decodeManagedPolicyProofV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { fixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createManagedMachineAcquisitionDriver, createManagedMachineControllerClient, type ManagedMachineAcquisitionDriverInput } from './acquire';
import { createManagedNativeInvocation } from './reconcile';
import { prepareManagedRetentionPolicy } from './managedIntentReconciler';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { ActionOperationDomainRefV1 } from '@happier-dev/protocol/actions';
import { MachineProvisionerPowerResultV1Schema, MachineProvisionerDestroyResultV1Schema, MachineProvisionerRebuildResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerManagedFiniteWake } from '@/rpc/handlers/managedFiniteWake';
import { MANAGED_FINITE_WAKE_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { ACTION_API_SERVER_ORIGIN, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { executeManagedMachinePolicyAction } from '@/daemon/startup/managedMachinePolicyAction';
import { createDaemonManagedMachinePolicyRuntime, readManagedMachinePolicyCensus } from '@/daemon/startup/managedMachinePolicyRuntime';
import { createManagedGuestLocalStop } from '@/daemon/startup/createManagedGuestLocalStop';
import { createActionExecutor, createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { MANAGED_EXEC_ACTION_ID_V1, MANAGED_POWER_SET_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ArtifactJsonUpdateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { observeManagedChildApprovalExecution } from '@/api/managedChildApproval';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import * as activitySocket from '@/api/session/sockets';
import { createLiveWorkProducerGroup, createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { registerManagedActivityRpcHandlers } from '@/api/machine/rpcHandlers.managedActivity';
import { RpcError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    ManagedActivityBridgeResultV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationGetV1ResponseSchema as PredecessorOperationGetSchema } from '@/daemon/actionOperations/testFixtures/predecessorActionOperationV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { doesManagedNativeObservationSettleIntent } from '../../../../server/sources/app/machines/managed/managedNativeObservation';
import { createAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN as HETZNER_PLUGIN } from '../../../../../packages/plugins/machine-hetzner/src/manifest';
import { MODAL_PLUGIN } from '../../../../../packages/plugins/machine-modal/src/manifest';
import { PLUGIN as BOAT_PLUGIN } from '../../../../../packages/plugins/machine-boat/src/manifest';
import { createBoatNativeClient } from '../../../../../packages/plugins/machine-boat/src/machine/nativeClient';
import { createModalProvisionerRoles, MODAL_CONTRIBUTION_REF } from '../../../../../packages/plugins/machine-modal/src/machine/roles';
import type { ModalNativeClient, ModalSandboxHandle } from '../../../../../packages/plugins/machine-modal/src/machine/nativeClient';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createPluginInvocationServiceBinding, createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { LIMA_PLUGIN } from '../../../../../packages/plugins/machine-lima/src/manifest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
import { createConnectedAccountPluginHttpPurposeHost } from '@/plugins/runtime/fetch/connectedAccountPurpose';
import { createDeferred } from '@/testkit/async/deferred';
import { PluginError } from '@happier-dev/plugin-sdk';
import { logger } from '@/ui/logger';
import { ManagedMachineControllerError, ManagedMachineNativeEffectGuardRefusal } from './controllerErrors';
import { projectActionOperationFailure } from '@/daemon/actionOperations/actionOperationFailure';
import { withManagedOpaquePresetReview } from './presetHydration';

const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential transport'); };
function signedIdle(machine: ReturnType<typeof ManagedMachineV1Schema.parse>, since: number, confirmedAt: number) {
    const context = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'guest',
        installationId: 'guest-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const managedTarget = { homeId: machine.homeId, managedId: machine.id, expectedRevision: machine.intentRevision,
        ...(machine.controller ? { controller: machine.controller } : {}) };
    const decision = { kind: 'idle' as const, since, confirmedAt };
    const method = 'guest:managed.admission.drain.confirm';
    return { context, method, managedTarget, decision, proof: signMachineInstallationProof({
        payload: { version: 1, accountId: 'owner', machineId: 'guest', installationId: 'guest-installation',
            rpcAdmission: { context, method, managedTarget, managedIdleDecision: decision } },
        privateKey: tweetnacl.sign.keyPair().secretKey,
    }) };
}
function setup(decision: { kind: 'idle'; since: number } | { kind: 'busy' | 'unknown'; reasons: ['finite'] } = { kind: 'idle', since: 0 },
    nativeResult: ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse> = { kind: 'confirmed' }, intent: 'start' | 'resume' | 'stop' | 'suspend' | 'delete' | 'rebuild' = 'delete',
    inspectObservation?: ProviderObservationV1, onNativeEffect?: () => void,
    rebuildResult?: ReturnType<typeof MachineProvisionerRebuildResultV1Schema.parse>, recoverRebuild = false,
    cleanupObservation?: { kind: 'confirmed' | 'retryable' } | { kind: 'unknown'; code?: string },
    nativeFixtureOptions: Omit<NonNullable<Parameters<typeof fixture>[0]>, 'credentialOwner'> & {
        credentialOwner?: ReturnType<typeof createConnectedAccountPurposeBindingOwner>;
    } = {}) {
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
    const changeListeners = new Set<Parameters<NonNullable<Parameters<typeof createManagedMachineAcquisitionDriver>[0]['subscribeManagedMachineChanges']>>[0]>();
    const reports: unknown[] = [];
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const path = String(url);
        if (path.endsWith('/activation-failed')) return { status: 200, data: { ok: true, didFail: true } };
        if (path.endsWith('/admit-control')) {
            const admission = ManagedControlAdmissionInputV1Schema.parse(body);
            expect(admission.input.homeId).toBe(homeId);
            if (admission.action === 'machines.managed.power.set' || admission.action === 'machines.managed.delete') {
                expect(admission.input.managedId).toBe(machine.id);
                machine = { ...machine, desired: admission.input.intent, desiredWhen: admission.input.when,
                    desiredAfterMs: admission.input.when === 'after-idle' ? admission.input.afterMs : undefined };
            }
            return { status: 200, data: { machine, replayed: submitted } };
        }
        if (path.endsWith('/prepare-policy')) {
            const preparation = ManagedPolicyAdmissionInputV1Schema.parse(body);
            return { status: 200, data: ManagedPolicyAdmissionOutputV1Schema.parse({ requestId: preparation.requestId, replayed: false, machine: { ...machine,
                ...(preparation.purpose.kind === 'accepted-input-start' ? { desired: 'start' as const }
                    : preparation.purpose.kind === 'retention' && machine.retention.kind !== 'until-delete' && !machine.submittedNativeEffect
                        ? { desired: resolveMachineRetentionNativeIntentV1(machine.retention.effect, [intent])! } : {}),
                desiredWhen: 'now', desiredAfterMs: undefined } }) };
        }
        if (path.endsWith('/admit-policy')) {
            const admission = ManagedPolicyAdmissionInputV1Schema.parse(body);
            // Home owns the committed intent; accepted work wakes the retained
            // stopped resource rather than preserving its pre-admission Stop.
            machine = { ...machine, intentRevision: 2,
                ...(admission.purpose.kind === 'accepted-input-start' ? { desired: 'start' as const }
                    : admission.purpose.kind === 'retention' && machine.retention.kind !== 'until-delete' && !machine.submittedNativeEffect
                        ? { desired: resolveMachineRetentionNativeIntentV1(machine.retention.effect, [intent])! } : {}) };
            return { status: 200, data: { machine, requestId: 'control', replayed: submitted } };
        }
        if (path.endsWith('/actions/get')) return { status: 200, data: machine };
        if (path.endsWith('/context')) return { status: 200, data: { machine, requestId: 'control' } };
        if (path.endsWith('/report')) {
            const report = ManagedControllerReportV1Schema.parse(body);
            if (report.result.kind === 'bound') machine = { ...machine, allocation: 'bound', resource: report.result.resource,
                ...(machine.allocation === 'may-exist' && machine.submittedNativeEffect?.intent !== 'delete' ? { nativeOperationRef: undefined } : {}) };
            if (report.result.kind === 'rejected') machine = { ...machine, allocation: 'confirmed-absent' };
            if (report.result.kind === 'unknown') machine = { ...machine, recovery: report.result.recovery };
            if (report.observation) machine = { ...machine, observation: report.observation };
        }
        if (path.endsWith('/submit-intent')) {
            const first = !machine.submittedNativeEffect; submitted = true;
            const submission = ManagedControllerCurrentnessV1Schema.parse(body);
            if (first) machine = { ...machine, submittedNativeEffect: { intentRevision: machine.intentRevision, requestId: submission.requestId, intent: machine.desired, controller } };
            return { status: 200, data: { machine, submitted: first } };
        }
        if (path.endsWith('/report-intent')) {
            // Native producer output must satisfy the real Home report consumer.
            const report = ManagedControllerIntentReportV1Schema.parse(body);
            reports.push(report);
            if (report.result.kind === 'refused') {
                machine = { ...machine, submittedNativeEffect: undefined };
            }
            if (report.result.kind === 'accepted') machine = { ...machine, nativeOperationRef: report.result.nativeOperationRef };
            if (report.observation) {
                machine = { ...machine, observation: report.observation };
                if (machine.observation?.availability === 'absent') machine = { ...machine, allocation: 'confirmed-absent',
                    nativeOperationRef: undefined, submittedNativeEffect: undefined };
            }
            for (const listener of changeListeners) await listener({ kind: 'managed', managedIds: [machine.id] });
        }
        return { status: 200, data: { machine } };
    });
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
        purposeBindingOwner: nativeFixtureOptions.credentialOwner ?? createConnectedAccountPurposeBindingOwner({
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
        subscribeManagedMachineChanges: listener => {
            changeListeners.add(listener);
            return () => { changeListeners.delete(listener); };
        },
        readPolicyCurrent: async (managedId, signal) => ManagedMachineV1Schema.parse((await axios.post(
            'https://home.example/v1/machines/managed/controller/current', { managedId }, { signal },
        )).data.machine),
    } satisfies Parameters<typeof createManagedMachineAcquisitionDriver>[0];
    const driver = createManagedMachineAcquisitionDriver(driverInput);
    const options = { requestId: 'control', context: {
        operationAcceptance: { operationId: 'operation', accept(_result: unknown) {} },
        operationOwnerUpdate: { update() {} },
    } };
    const run = (signal?: AbortSignal) => driver.execute(intent === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set', { homeId, managedId: machine.id,
        ...machine.desiredWhen === 'after-idle' ? { when: 'after-idle', intent, afterMs: machine.desiredAfterMs } : { when: 'now', intent, expectedRevision: machine.intentRevision },
        ...(intent === 'delete' ? { reviewedDependencies: true } : {}) }, { ...options, ...(signal ? { signal } : {}) });
    return { effects, nativeInputs, reports, post, readActivity, confirmIdle, reopen, waitForChange, run, driver, driverInput, options, installationKeys,
        retireNative: native.retire,
        readMachine: () => machine,
        setMachine: (update: Partial<typeof machine>) => { machine = { ...machine, ...update }; },
    };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('settles a reviewed native command wake with an enrolled guest daemon unavailable', async () => {
    let inspections = 0;
    const test = setup(undefined, undefined, 'start', undefined, undefined, undefined, false, undefined, {
        nativeRoleResults: {
            inspect: () => ({ availability: 'present', storage: 'retained', observedAt: ++inspections,
                power: inspections === 1 ? 'stopped' : 'running' }),
            power: { kind: 'confirmed' },
            bootstrap: () => { throw new Error('Guest daemon is unavailable'); },
        },
    });
    const { homeId, id: managedId, intentRevision: expectedRevision } = test.readMachine();
    const child = { action: MANAGED_POWER_SET_ACTION_ID_V1, role: 'managed-wake',
        input: { homeId, managedId, expectedRevision, when: 'now', intent: 'start' } } as const;
    const port = createHostReviewedChildPortV1({ actionId: MANAGED_EXEC_ACTION_ID_V1,
        input: { homeId, managedId, argv: ['true'] }, context: { surface: 'cli' },
        plan: { children: [child] }, reviewAdmitted: true,
        policies: [{ action: child.action, role: child.role, surface: 'cli' }],
        execute: async (input, context) => ({ ok: true, result: await test.driver.execute(child.action, input,
            { ...test.options, context: { ...context, ...test.options.context } }) }),
    });
    await expect(port.invoke(child)).resolves.toMatchObject({ ok: true, result: { kind: 'accepted', managedId } });
    expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'confirmed' },
        observation: { availability: 'present', storage: 'retained', power: 'running', observedAt: 2 } })]);
    expect(test.effects).toEqual(['power']);
});

it.each(['start', 'resume', 'stop', 'suspend'] as const)(
    'settles %s after another observer clears native custody and the report reply is lost', async intent => {
    const power = intent === 'start' || intent === 'resume' ? 'running' : intent === 'stop' ? 'stopped' : 'suspended';
    const observation: ProviderObservationV1 = { observedAt: 1, availability: 'present', power: 'stopped' };
    const test = setup(undefined, { kind: 'confirmed' }, intent, observation, () => {
        observation.observedAt = 2;
        observation.power = power;
    });
    // Retained pre-restart power is a fact, never native-operation custody.
    test.setMachine({ observation: { observedAt: 1, availability: 'present', power: 'running' } });
    const transport = test.post.getMockImplementation()!;
    test.post.mockImplementation(async (url, body, config) => {
        if (String(url).endsWith('/report-intent')) {
            // Another Inspect has already published this native fact and settled
            // the same submitted tuple before this controller's report arrives.
            const report = ManagedControllerIntentReportV1Schema.parse(body);
            test.setMachine({ submittedNativeEffect: undefined, observation: report.observation });
            throw new axios.AxiosError('Settlement reply lost', 'EPIPE');
        }
        return await transport(url, body, config);
    });
    const machine = test.readMachine();
    const input = { homeId: machine.homeId, managedId: machine.id, intent, when: 'now', expectedRevision: machine.intentRevision };
    const operations = createHostActionOperationRuntime({ machineId: machine.controller!.machineId,
        resolveAccountId: async () => 'owner', generateOperationId: () => 'power-report-conflict' });
    let work: ReturnType<typeof test.driver.execute> | undefined;
    await operations.observeExecution({ actionId: 'machines.managed.power.set', input, actionRequestId: 'control',
        execute: async context => {
            work = test.driver.execute('machines.managed.power.set', input, { requestId: 'control', context, signal: context.signal });
            const result = await work;
            const failure = ActionExecuteFailureSchema.safeParse(result);
            return failure.success ? failure.data : { ok: true, result };
        } });
    await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: machine.id });
    expect(await operations.handlers.getV2({ operationId: 'power-report-conflict' })).toMatchObject({ kind: 'found',
        operation: { state: 'succeeded' } });
    expect(test.effects.filter(role => role === 'power')).toEqual(['power']);
    expect(test.post.mock.calls.filter(([url]) => String(url).endsWith('/report-intent'))).toHaveLength(1);
});

it.each(['pending', 'changed-resource', 'current-refused'] as const)('preserves a lost Start report cause when exact settlement is unavailable (%s)', async state => {
    const observation: ProviderObservationV1 = { observedAt: 1, availability: 'present', power: 'stopped' };
    const test = setup(undefined, { kind: 'confirmed' }, 'start', observation, () => {
        observation.observedAt = 2;
        observation.power = 'running';
    });
    const transport = test.post.getMockImplementation()!;
    let conflicted = false;
    test.post.mockImplementation(async (url, body, config) => {
        if (String(url).endsWith('/report-intent')) {
            conflicted = true;
            if (state === 'changed-resource') test.setMachine({ submittedNativeEffect: undefined, observation,
                resource: { ...test.readMachine().resource!, value: { replacement: true } } });
            throw new axios.AxiosError('Settlement reply lost', 'EPIPE');
        }
        if (conflicted && state === 'current-refused' && String(url).endsWith('/current')) {
            return { status: 409, data: { code: 'intent_changed' } };
        }
        return await transport(url, body, config);
    });
    await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown',
        failureCause: { phase: 'managed.controller.report_intent', errorCode: 'EPIPE' } });
    expect(test.effects.filter(role => role === 'power')).toEqual(['power']);
    expect(test.post.mock.calls.filter(([url]) => String(url).endsWith('/report-intent'))).toHaveLength(1);
});

it('does not turn a native Start refusal into success through stale running power after a report conflict', async () => {
    const test = setup(undefined, { kind: 'refused', code: 'native_permission_denied' }, 'start',
        { observedAt: 2, availability: 'present', power: 'stopped' });
    test.setMachine({ observation: { observedAt: 1, availability: 'present', power: 'running' } });
    const transport = test.post.getMockImplementation()!;
    test.post.mockImplementation(async (url, body, config) => {
        if (String(url).endsWith('/report-intent')) {
            test.setMachine({ submittedNativeEffect: undefined });
            return { status: 409, data: { code: 'request_conflict' } };
        }
        return await transport(url, body, config);
    });
    const machine = test.readMachine();
    const input = { homeId: machine.homeId, managedId: machine.id, intent: 'start', when: 'now', expectedRevision: machine.intentRevision };
    const operations = createHostActionOperationRuntime({ machineId: machine.controller!.machineId,
        resolveAccountId: async () => 'owner', generateOperationId: () => 'refused-start-report' });
    let work: ReturnType<typeof test.driver.execute> | undefined;
    await operations.observeExecution({ actionId: 'machines.managed.power.set', input, actionRequestId: 'control',
        execute: async context => {
            work = test.driver.execute('machines.managed.power.set', input, { requestId: 'control', context, signal: context.signal });
            const result = await work;
            const failure = ActionExecuteFailureSchema.safeParse(result);
            return failure.success ? failure.data : { ok: true, result };
        } });
    await expect(work).rejects.toMatchObject({ code: 'native_permission_denied' });
    expect(await operations.handlers.getV2({ operationId: 'refused-start-report' })).toMatchObject({ kind: 'found',
        operation: { state: 'failed', error: { errorCode: 'native_permission_denied' } } });
    expect(test.effects).toEqual(['power']);
});

it('preserves the authored native failure when controller outcome reporting fails and records its closed report warning', async () => {
    const failureCause = { phase: 'action.invoke', errorClass: 'Error', errorCode: 'EPIPE', httpStatus: null } as const;
    const test = setup(undefined, undefined, 'stop', undefined, () => {
        throw new PluginError({ code: 'native_transport_unavailable', message: 'Reconnect the native provider', failureCause });
    });
    const transport = test.post.getMockImplementation()!;
    test.post.mockImplementation(async (url, body, config) => String(url).endsWith('/report-intent')
        ? { status: 403, data: { code: 'forbidden' } } : await transport(url, body, config));
    // Console/file output is the external logging boundary, not domain logic.
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const machine = test.readMachine();
    await expect(test.driver.execute('machines.managed.power.set', { homeId: machine.homeId, managedId: machine.id,
        intent: 'stop', when: 'now', expectedRevision: machine.intentRevision }, test.options))
        .rejects.toMatchObject({ code: 'native_transport_unavailable', failureCause,
            cause: { ok: false, errorCode: 'native_transport_unavailable', error: 'Reconnect the native provider', failureCause } });
    expect(warnings).toHaveBeenCalledWith(expect.any(String), {
        phase: 'managed.controller.report_intent', errorClass: 'ManagedMachineControllerError', errorCode: 'forbidden', httpStatus: 403,
    });
});

it.each(['power-refused', 'delete-refused', 'rebuild-refused', 'guest-startup-failed', 'confirmed'] as const)(
    'preserves a returned native outcome when Home reporting fails (%s)', async outcome => {
    const startup = outcome === 'guest-startup-failed';
    const refused = outcome.endsWith('-refused');
    const intent = outcome === 'delete-refused' ? 'delete' : outcome === 'rebuild-refused' ? 'rebuild' : startup ? 'start' : 'stop';
    const nativeCause = { httpStatusClass: '4xx' } as const;
    const refusal = { kind: 'refused', code: 'native_permission_denied', nativeCause } as const;
    const failureCause = { phase: 'action.invoke', errorClass: 'Error', errorCode: 'EPIPE', httpStatus: null } as const;
    const test = setup(undefined, refused ? refusal : { kind: 'confirmed' }, intent,
        startup ? { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' } : undefined,
        startup ? () => { throw new PluginError({ code: 'native_transport_unavailable',
            message: 'Reconnect the native provider', failureCause }); } : undefined,
        outcome === 'rebuild-refused' ? refusal : undefined);
    if (startup) test.setMachine({ enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });
    const transport = test.post.getMockImplementation()!;
    test.post.mockImplementation(async (url, body, config) => String(url).endsWith('/report-intent')
        ? { status: 403, data: { code: 'forbidden', message: 'private-home-report-body' } }
        : await transport(url, body, config));
    // Console/file output is the external logging boundary.
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const machine = test.readMachine();
    const work = intent === 'rebuild'
        ? test.driver.execute('machines.managed.rebuild', { homeId: machine.homeId, managedMachineId: machine.id,
            kind: 'rebuild', expectedRevision: machine.intentRevision, reviewedEffectDigest: 'reviewed-effects' }, test.options)
        : test.run();
    if (refused || startup) {
        await expect(work).rejects.toMatchObject(startup
            ? { code: 'native_transport_unavailable', failureCause }
            : { code: refusal.code, details: { kind: 'managedNative', nativeCause } });
        expect(warnings).toHaveBeenCalledWith(expect.any(String), {
            phase: 'managed.controller.report_intent',
            errorClass: 'ManagedMachineControllerError', errorCode: 'forbidden', httpStatus: 403,
        });
    } else {
        // A confirmed native result does not hide failure to report it to Home.
        await expect(work).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown',
            failureCause: { phase: 'managed.controller.report_intent', errorCode: 'forbidden', httpStatus: 403 } });
    }
    const report = test.post.mock.calls.find(([url]) => String(url).endsWith('/report-intent'));
    expect(report?.[1]).toMatchObject({ result: refused ? refusal : { kind: 'confirmed' } });
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-home-report-body');
});

it.each(['delete', 'stop'] as const)('preserves an unknown native %s cause when Home rejects its outcome report', async intent => {
    const nativeCause = { localCause: 'native_command_failed', command: intent, exitCode: 1,
        stderr: 'Native command failed for [redacted]' } as const;
    const result = { kind: 'unknown', code: 'native_command_failed', nativeCause } as const;
    const test = setup(undefined, result, intent);
    const transport = test.post.getMockImplementation()!;
    test.post.mockImplementation(async (url, body, config) => String(url).endsWith('/report-intent')
        ? { status: 400, data: { code: 'invalid-params', message: 'private-home-report-body' } }
        : await transport(url, body, config));
    // Console/file output is the external logging boundary.
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const failure = await test.run();
    expect(failure).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown',
        details: { kind: 'managedNative', nativeCause },
        failureCause: { errorCode: 'native_command_failed' } });
    expect(test.post.mock.calls.find(([url]) => String(url).endsWith('/report-intent'))?.[1])
        .toMatchObject({ result });
    expect(test.readMachine().submittedNativeEffect).toMatchObject({ intent });
    expect(test.effects).toEqual([intent === 'delete' ? 'destroy' : 'power']);
    expect(warnings).toHaveBeenCalledWith(expect.any(String), {
        phase: 'managed.controller.report_intent', errorClass: 'ManagedMachineControllerError', errorCode: 'invalid-params', httpStatus: 400,
    });
    expect(JSON.stringify({ failure, warnings: warnings.mock.calls })).not.toContain('private-home-report-body');
});

it('preserves the native pre-handler refusal and submitted custody when refusal reporting fails', async () => {
    const test = setup();
    test.setMachine({ desiredWhen: 'after-idle' });
    const transport = test.post.getMockImplementation()!;
    test.post.mockImplementation(async (url, body, config) => {
        if (String(url).endsWith('/submit-intent')) {
            // Guest network facts change before the real private pre-handler.
            test.confirmIdle.mockResolvedValue({ kind: 'busy', reasons: ['finite'] });
        }
        if (String(url).endsWith('/report-intent')) return { status: 403, data: { code: 'forbidden' } };
        return await transport(url, body, config);
    });
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const error = await test.run().then(() => undefined, (failure: unknown) => failure);
    const report = test.post.mock.calls.find(([url]) => String(url).endsWith('/report-intent'));
    expect(report?.[1]).toMatchObject({ result: { kind: 'refused', code: 'activity_changed' } });
    expect(error).toBeInstanceOf(ManagedMachineNativeEffectGuardRefusal);
    expect(error).toMatchObject({ code: 'activity_changed' });
    expect(test.readMachine().submittedNativeEffect).toMatchObject({ requestId: 'control', intent: 'delete' });
    expect(test.effects).toEqual([]);
    expect(test.reopen).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledWith(expect.any(String), {
        phase: 'managed.controller.report_intent', errorClass: 'ManagedMachineControllerError', errorCode: 'forbidden', httpStatus: 403,
    });
});

describe('opaque preset Delete on the controller', () => {
    it('keeps the opened native resource after Home claims the effect and destroys it', async () => {
        // #155 G1 (op 43cd90df): a delegated Team preset row is structural at Home; the controller
        // opens its sealed native identity. Home's submit-intent reply is structural too.
        const test = setup();
        const { launch, resource, ...plainFields } = test.readMachine();
        const preset = { id: 'opaque-preset', revision: 1, contentEncryptionMode: 'plain' as const };
        const content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'opaque-preset', launch,
            nativeResult: { kind: 'bound', resource } }) };
        const toStructural = (row: Record<string, unknown>) => {
            const { launch: _launch, resource: _resource, ...rest } = row;
            return ManagedOpaquePresetMachineV1Schema.parse({ ...rest, preset });
        };
        toStructural(plainFields);
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            const response = await home(url, body, config) as { status: number; data: unknown };
            const data = response.data;
            if (String(url).endsWith('/actions/get')) return { ...response, data: toStructural(data as Record<string, unknown>) };
            if (!data || typeof data !== 'object' || !('machine' in data) || !data.machine || typeof data.machine !== 'object') return response;
            const machine = toStructural(data.machine as Record<string, unknown>);
            const carrier = /\/(admit-control|context)$/.test(String(url)) ? { presetContent: { content, recipients: [] } } : {};
            return { ...response, data: { ...data, machine, ...carrier } };
        });
        // Plain preset custody opens under the custodian Account named by the controller's token.
        const ownerToken = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const driver = createManagedMachineAcquisitionDriver({ ...test.driverInput, token: ownerToken,
            credentials: { token: ownerToken, encryption: null } });
        await expect(driver.execute('machines.managed.delete', { homeId: plainFields.homeId, managedId: 'managed', when: 'now',
            intent: 'delete', expectedRevision: plainFields.intentRevision, reviewedDependencies: true }, test.options))
            .resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
        expect(test.effects).toEqual(['destroy']);
    });
});
it('retains the opaque Update acquire policy refusal through reconcile and operation projection', async () => {
    const test = setup();
    const machine = { ...test.readMachine(), preset: { id: 'opaque-preset', revision: 1, contentEncryptionMode: 'plain' as const } };
    const { launch: _launch, resource: _resource, ...structural } = machine;
    const opaqueMachine = ManagedOpaquePresetMachineV1Schema.parse(structural);
    const action = 'machines.managed.bootstrap.retry' as const;
    const target = { kind: 'machine' as const, machineId: machine.controller!.machineId };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-root', binding: {
        serverIdentityId: machine.homeId, accountId: 'owner', custodianAccountId: 'owner',
        authentication: { kind: 'account', tokenEpoch: 1 }, ...machine.controller,
        actionId: action, requestId: 'control', requestEnvelopeDigest: 'A'.repeat(43), target,
    } });
    const options = withManagedOpaquePresetReview({ ...test.options, context: { ...test.options.context,
        surface: 'ui' as const, runtimeAccountId: 'owner', actionRequestId: 'control',
        externalActionExecutionAuthorization: authorization, externalActionTarget: target,
        actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
            'acme.compute/actions/acquire': { approvalRequiredSurfaces: ['ui'] },
        } }),
    } }, { machine, opaqueMachine, parent: { actionId: action,
        input: { homeId: machine.homeId, managedId: machine.id } }, requestId: 'control' });
    const client = createManagedMachineControllerClient(test.driverInput, options, action);
    const native = createManagedNativeInvocation({ input: test.driverInput, options, client, machine, action }, () => machine);
    const error = await native.invoke('acquire', {}).then(() => { throw new Error('Expected policy refusal'); }, error => error);
    expect(error).toBeInstanceOf(ManagedMachineNativeEffectGuardRefusal);
    const failure = projectActionOperationFailure(error, 'action_operation_failed', 'root');
    expect(failure).toMatchObject({ errorCode: 'credential_scope_denied',
        failureCause: { phase: 'deployment.reviewed_child', errorCode: 'approval_required', httpStatus: null } });
    expect(failure.error).toContain('acme.compute/actions/acquire');
    expect(failure.error).toContain('required surface: ui');
    expect(failure.error).toContain('requested surface: ui');
    expect(test.effects).toEqual([]);
});
describe('Delete with no native resource', () => {
    it('settles the Home-confirmed absence without native effects or guest activity', async () => {
        const test = setup();
        test.setMachine({ allocation: 'confirmed-absent', creationState: 'canceled',
            resource: undefined, enrolledMachineId: undefined });
        await expect(test.run()).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
        expect(test.effects).toEqual([]);
        expect(test.readActivity).not.toHaveBeenCalled();
        expect(test.confirmIdle).not.toHaveBeenCalled();
        expect(test.post.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
            '/v1/machines/managed/controller/admit-control',
        ]);
    });
});

describe('Delete with a retained native resource after canceled bootstrap', () => {
    it.skipIf(process.platform === 'win32').each([
        { incident: 'ADMIN bootstrap failure', bootstrapInstalled: true,
            observation: { observedAt: 1, availability: 'unavailable', reason: 'bootstrap.remote_command_failed' } satisfies ProviderObservationV1 },
        { incident: 'F acquisition recovery', bootstrapInstalled: undefined,
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } satisfies ProviderObservationV1 },
        { incident: 'lost native Delete reply', bootstrapInstalled: true,
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } satisfies ProviderObservationV1 },
        { incident: 'lost controller Delete reply', bootstrapInstalled: true,
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } satisfies ProviderObservationV1 },
        { incident: 'lost controller Delete report before commit', bootstrapInstalled: true,
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } satisfies ProviderObservationV1 },
    ])('deletes the retained stopped Lima disk when Home admission changes the cleanup reason ($incident)', async ({ incident, bootstrapInstalled, observation }) => {
        const directory = mkdtempSync(join(tmpdir(), 'managed-lima-delete-'));
        const resource = { instance: 'happier-retained-stopped', store: join(directory, 'store'), arch: 'x86_64', vmType: 'qemu',
            cpus: 1, memoryBytes: 2 * 1024 ** 3, diskBytes: 15 * 1024 ** 3, image: 'https://example.test/ubuntu.img', mounts: [] };
        let retained = true;
        const nativeDeletes: string[][] = [];
        const exec: Pick<ExecService, 'run'> = { run: async request => {
            expect(request.cwd).toBe(resource.store);
            expect(request.env).toEqual({ LIMA_HOME: resource.store });
            const args = [...(request.args ?? [])];
            expect(['list', 'delete']).toContain(args[0]);
            if (args[0] === 'delete') {
                expect(args).toEqual(['delete', '--force', resource.instance]);
                nativeDeletes.push(args);
                retained = false;
                if (incident === 'lost native Delete reply') throw new PluginError({ code: 'native_transport_unavailable',
                    message: 'Native reply lost', failureCause: { phase: 'native.destroy.reply', errorClass: 'Error', errorCode: 'EPIPE', httpStatus: null } });
            }
            return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                stdout: new TextEncoder().encode(args[0] === 'list' && retained
                    ? JSON.stringify({ name: resource.instance, dir: resource.instance, status: 'Stopped' }) : ''),
                stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false } satisfies PluginProcessResult;
        } };
        const plugin = await createPluginTestkit({ manifest: LIMA_PLUGIN.manifest, module: LIMA_PLUGIN });
        try {
            const actionHandlers = new Map(LIMA_PLUGIN.manifest.contributes.actions!.map(action => {
                const handler = plugin.registration('actions', action.id);
                if (!handler) throw new Error(`Missing Lima Action ${action.id}`);
                return [action.id, handler] as const;
            }));
            const unavailableServices = createUnavailablePluginServicesFactory();
            const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, false, undefined, {
                fixtureManifest: normalizePluginManifestV2(LIMA_PLUGIN.manifest), actionHandlers,
                resolveHostBinding: createTargetActionHostBindingResolver({
                    createServiceBinding: (occurrence, id) => createPluginInvocationServiceBinding(occurrence, id),
                }),
                createServices(seed, binding) {
                    const services = unavailableServices(seed, binding);
                    return { ...services, exec: { ...services.exec, ...exec }, managedServices: { ...services.managedServices,
                        dependencies: { ...services.managedServices.dependencies, status: async id => ({ state: 'ready', id,
                            supported: true, version: '2.2.1', sourceId: 'system', executable: { kind: 'managedDependency',
                                id: { pluginId: LIMA_PLUGIN.manifest.id, localId: id } } }) } } };
                },
            });
            const provider = { pluginId: LIMA_PLUGIN.manifest.id, localId: 'lima' };
            const { instance: _instance, memoryBytes, diskBytes, ...launch } = resource;
            test.setMachine({ creationState: 'canceled', enrolledMachineId: undefined, bootstrapInstalled,
                launch: { ...test.readMachine().launch, provider, choices: { ...launch,
                    memoryGiB: memoryBytes / 1024 ** 3, diskGiB: diskBytes / 1024 ** 3 } },
                resource: { contributionRef: provider, schemaVersion: 1, value: resource },
                observation, ...(incident === 'F acquisition recovery' ? { recovery: {
                    reference: `${resource.store}/${resource.instance}`, reason: 'lima_start_failed' } } : {}),
                cleanup: { disposition: 'pending', reason: 'creation_canceled' } });
            const transport = test.post.getMockImplementation()!;
            let reportReplyLost = false;
            test.post.mockImplementation(async (url, body, config) => {
                // Home admission changes diagnostics while retaining native ownership.
                if (String(url).endsWith('/admit-control')) {
                    test.setMachine({ cleanup: { disposition: 'pending', reason: 'delete_requested' } });
                }
                if (incident === 'lost controller Delete report before commit' && !reportReplyLost && String(url).endsWith('/report-intent')) {
                    reportReplyLost = true;
                    throw new axios.AxiosError('Report lost before Home committed', 'EPIPE');
                }
                const response = await transport(url, body, config);
                if (incident === 'lost controller Delete reply' && !reportReplyLost && String(url).endsWith('/report-intent')) {
                    reportReplyLost = true;
                    throw new axios.AxiosError('Reply lost after Home committed', 'EPIPE');
                }
                return response;
            });
            const machine = test.readMachine();
            let operationSequence = 0;
            const operations = createHostActionOperationRuntime({ machineId: machine.controller!.machineId,
                resolveAccountId: async () => 'owner', generateOperationId: () => `retained-${operationSequence++ === 0 ? 'delete' : 'inspect'}` });
            const input = { homeId: machine.homeId, managedId: machine.id, intent: 'delete', when: 'now',
                expectedRevision: machine.intentRevision, reviewedDependencies: true };
            let work: ReturnType<typeof test.driver.execute> | undefined;
            await operations.observeExecution({ actionId: 'machines.managed.delete', input, actionRequestId: 'control',
                execute: async context => {
                    work = test.driver.execute('machines.managed.delete', input, { requestId: 'control', context, signal: context.signal });
                    const result = await work;
                    const failure = ActionExecuteFailureSchema.safeParse(result);
                    return failure.success ? failure.data : { ok: true, result };
                } });
            if (incident === 'lost controller Delete report before commit') {
                await expect(work).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown',
                    failureCause: { phase: 'managed.controller.report_intent', errorCode: 'EPIPE' }, details: { requestId: 'control' } });
                expect(test.readMachine().submittedNativeEffect?.intent).toBe('delete');
                expect(await operations.handlers.getV2({ operationId: 'retained-delete' })).toMatchObject({ kind: 'found',
                    operation: { state: 'running', observation: { kind: 'outcome_uncertain' } } });
                await operations.observeExecution({ actionId: 'machines.managed.inspect', input: {}, actionRequestId: 'inspect',
                    execute: async context => ({ ok: true, result: await test.driver.execute('machines.managed.inspect', {
                        homeId: machine.homeId, managedId: machine.id,
                    }, { requestId: 'inspect', context, signal: context.signal }) }) });
            } else {
                await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
            }
            expect(nativeDeletes).toEqual([['delete', '--force', resource.instance]]);
            expect(retained).toBe(false);
            expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
            expect(test.readMachine().submittedNativeEffect).toBeUndefined();
            expect(await operations.handlers.getV2({ operationId: 'retained-delete' })).toMatchObject({ kind: 'found',
                operation: { state: 'succeeded', requestId: 'control' } });
        } finally {
            await plugin.dispose();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe('unused Stop through guest drain and controller operation custody', () => {
    it.each(['idle-lapse', 'delayed-native-lapse', 'work-during-native-lapse', 'work-resumes', 'activity-unavailable', 'activity-unknown', 'until-delete', 'cancel', 'renewal-failure'] as const)(
        'owns Boat mandatory TTL through the real policy lifecycle (%s)', async ending => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        vi.setSystemTime(1_790_000_000_000);
        const sandboxId = 'bx_23456789';
        let ttlSeconds = 7200;
        let expiry = Date.now() + 7200_000;
        let failRenewal = false;
        let activityUnavailable = false;
        const requests: Array<{ method: string; path: string; body?: unknown }> = [];
        const http = createPluginHttpFixture({ request: request => {
            const path = new URL(request.url).pathname;
            const method = request.method ?? 'GET';
            if (ending === 'activity-unavailable' && method === 'GET' && Date.now() >= expiry) activityUnavailable = true;
            const body = request.body ? JSON.parse(new TextDecoder().decode(request.body)) : undefined;
            requests.push({ path, method, body });
            if (method === 'PATCH') {
                if (failRenewal) return { status: 503, headers: {}, body: new TextEncoder().encode(JSON.stringify({ ok: false, code: 'unavailable' })) };
                ttlSeconds = body.ttlSeconds;
                expiry = Date.now() + ttlSeconds * 1000;
            }
            return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ ok: true, type: 'sandbox.info',
                sandbox: { id: sandboxId, state: Date.now() >= expiry + (ending === 'delayed-native-lapse' || ending === 'work-during-native-lapse' || ending === 'activity-unavailable' ? 5_000 : 0) ? 'archived' : 'ready',
                    ttlSeconds, archiveAfter: new Date(expiry).toISOString(), dataExpiredAt: null } })) };
        } });
        const plugin = await createPluginTestkit({ manifest: BOAT_PLUGIN.manifest, module: BOAT_PLUGIN });
        const actionHandlers = new Map(BOAT_PLUGIN.manifest.contributes.actions!.map(action => {
            const handler = plugin.registration('actions', action.id);
            if (!handler) throw new Error(`Missing Boat Action ${action.id}`);
            return [action.id, handler] as const;
        }));
        const credentialOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'owner',
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Captured' } : null,
            materializeAccount: async () => ({ kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture' } }),
            resolveCredentialConfigurationRevision: async () => 'fixture-configuration',
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable });
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, connectedAccounts: credentialOwner,
            http: createStablePluginHttpHost({ adapter: { openWebSocket: unavailable, request: http.request },
                purposeHost: createConnectedAccountPluginHttpPurposeHost(credentialOwner, { registerRawForRedaction() {} }) }) });
        const test = setup(undefined, undefined, 'stop', undefined, undefined, undefined, false, undefined, {
            fixtureManifest: normalizePluginManifestV2(BOAT_PLUGIN.manifest), actionHandlers, credentialOwner,
            executionRealm: 'account', credentialPurposes: [{ purpose: 'cloud-api', service: { pluginId: BOAT_PLUGIN.manifest.id, localId: 'boat-account' } }],
            createServices: owners.createServices, resolveHostBinding: owners.resolveHostBinding,
        });
        const provider = { pluginId: BOAT_PLUGIN.manifest.id, localId: 'boat' };
        test.setMachine({ desired: 'start', retention: ending === 'until-delete' ? { kind: 'until-delete' }
            : { kind: 'unused', afterMs: 60_000, effect: 'stop' },
            observation: { observedAt: Date.now(), availability: 'present', power: 'running', storage: 'retained', nativeExpiry: expiry },
            launch: { ...test.readMachine().launch, provider, choices: { size: 'small', source: { kind: 'blank' } }, credentials: [{
                purpose: { consumer: provider, purpose: 'cloud-api' }, configurationRevision: 'fixture-configuration',
                account: { service: { pluginId: provider.pluginId, localId: 'boat-account' }, accountId: 'captured-account' },
            }] }, resource: { contributionRef: provider, schemaVersion: 1, value: { sandboxId } } });
        test.setMachine(ManagedMachineV1Schema.parse(test.readMachine()));
        let activityUnknown = ending === 'activity-unknown';
        let busy = !activityUnknown;
        const producer = createLiveWorkProducerGroup(() => [{ read: () => ({ coverage: activityUnknown ? 'unknown' : 'complete',
            items: busy ? [{ category: 'finite', state: 'active', ownerRef: 'work', attribution: { kind: 'unknown' } }] : [] }),
            subscribe: () => () => {} }]);
        const inventory = createManagedActivityInventory({ producers: [producer] });
        const read = vi.fn(async () => {
            if (activityUnavailable) throw new RpcError('Guest activity transport is offline', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE);
            const decision = await inventory.readDecision();
            return decision.kind === 'idle' ? { ...decision, evidence: signedIdle(test.readMachine(), decision.since, Date.now()) } : decision;
        });
        let waitingForActivity = false;
        let enteredFirstWait: () => void = () => {};
        const firstWait = new Promise<void>(resolve => { enteredFirstWait = resolve; });
        const bridge = { read, confirmIdle: read, reopen: async () => undefined,
            waitForChange: (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
                if (ending === 'until-delete') throw new Error('Guest activity transport is offline');
                if (activityUnavailable) throw new RpcError('Guest activity transport is offline', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE);
                waitingForActivity = true; enteredFirstWait();
                const cleanup = () => { waitingForActivity = false; off(); signal?.removeEventListener('abort', abort); };
                const abort = () => { cleanup(); reject(signal?.reason); };
                const off = inventory.subscribe(() => { cleanup(); resolve(); });
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
            }) };
        const driver = createManagedMachineAcquisitionDriver({ ...test.driverInput, managedGuestActivity: bridge });
        const lifetime = new AbortController();
        let finished = false;
        const run = (signal?: AbortSignal) => driver.executePolicy(test.readMachine(), { kind: 'retention' }, { ...test.options, signal })
            .then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
        let execution: ReturnType<typeof run> | undefined;
        const runtime = ending === 'until-delete' ? createDaemonManagedMachinePolicyRuntime({
            readCensus: async () => ({ machines: [test.readMachine()], targets: [] }),
            supportsNativeLifetimeRenewal: async machine => driver.supportsNativeLifetimeRenewal(machine),
            executePolicy: async request => {
                execution = run(request.signal);
                const result = await execution;
                return 'value' in result ? { ok: true, result: result.value }
                    : { ok: false, errorCode: 'fixture_policy_failed', error: 'fixture_policy_failed' };
            },
        }) : undefined;
        const flush = async () => {
            do { await new Promise<void>(resolve => setImmediate(resolve)); }
            while (!finished && !waitingForActivity && vi.getTimerCount() === 0);
        };
        try {
            if (runtime) await runtime.notifyChanged();
            else execution = run(lifetime.signal);
            if (ending !== 'until-delete') await Promise.race([firstWait, execution]);
            await flush();
            if (finished) {
                const result = await execution;
                if (result && 'error' in result) throw result.error;
            }
            expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(1);
            for (let hour = 0; hour < 3; hour++) {
                await vi.advanceTimersByTimeAsync(3600_000);
                await flush();
            }
            expect(expiry).toBeGreaterThan(Date.now());
            expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(4);
            expect(finished).toBe(false);
            if (ending === 'activity-unknown') {
                expect(read).toHaveBeenCalledTimes(1);
                expect(requests.some(request => request.method === 'POST')).toBe(false);
                activityUnknown = false; producer.notifyChanged();
                await flush();
                expect(read).toHaveBeenCalledTimes(2);
                expect(expiry).toBe(Date.now() + 60_000);
            } else if (ending === 'activity-unavailable') {
                busy = false; producer.notifyChanged();
                await flush();
                expect(expiry).toBe(Date.now() + 60_000);
                await vi.advanceTimersByTimeAsync(60_000);
                await flush();
                expect(finished).toBe(true);
                expect(await execution).toMatchObject({ error: { rpcErrorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE } });
                // Coverage loss restores the normal vendor lifetime once before
                // this operation fails; it cannot leave an idle-shortened TTL.
                expect(expiry).toBe(Date.now() + 7200_000);
            } else if (ending === 'renewal-failure') {
                failRenewal = true;
                await vi.advanceTimersByTimeAsync(3600_000);
                await flush();
                expect(await execution).toMatchObject({ error: { code: 'native_service_unavailable' } });
            } else if (ending === 'idle-lapse' || ending === 'delayed-native-lapse' || ending === 'work-during-native-lapse' || ending === 'work-resumes') {
                busy = false; producer.notifyChanged();
                await flush();
                expect(expiry).toBe(Date.now() + 60_000);
                if (ending === 'work-resumes') {
                    await vi.advanceTimersByTimeAsync(30_000);
                    busy = true; producer.notifyChanged();
                    await flush();
                    expect(expiry).toBe(Date.now() + 7200_000);
                    await vi.advanceTimersByTimeAsync(60_000);
                    expect(finished).toBe(false);
                } else {
                    await vi.advanceTimersByTimeAsync(60_000);
                    await flush();
                    if (ending === 'work-during-native-lapse') {
                        expect(finished).toBe(false);
                        busy = true; producer.notifyChanged();
                        await flush();
                        expect(expiry).toBe(Date.now() + 7200_000);
                        await vi.advanceTimersByTimeAsync(5_000);
                        await flush();
                        expect(finished).toBe(false);
                        expect(requests.some(request => request.method === 'POST')).toBe(false);
                        return;
                    }
                    if (ending === 'delayed-native-lapse') {
                        expect(finished).toBe(false);
                        await vi.advanceTimersByTimeAsync(5_000);
                        await flush();
                    }
                    expect(await execution).toHaveProperty('value');
                    expect(test.readMachine().observation).toMatchObject({ availability: 'present', power: 'stopped', storage: 'retained' });
                }
            } else if (ending === 'until-delete') {
                busy = false; producer.notifyChanged();
                for (let hour = 0; hour < 3; hour++) {
                    await vi.advanceTimersByTimeAsync(3600_000);
                    await flush();
                }
                expect(expiry).toBeGreaterThan(Date.now());
                expect(finished).toBe(false);
            }
            expect(requests.some(request => request.method === 'POST')).toBe(false);
        } finally {
            lifetime.abort(); await runtime?.stop(); await execution;
            const count = requests.length;
            await vi.advanceTimersByTimeAsync(7200_000);
            expect(requests).toHaveLength(count);
            inventory.dispose(); producer.dispose(); await plugin.dispose(); test.retireNative();
        }
    });
    it('uses the existing daemon shutdown for a leaf-qualified process exit without reading elevation', async () => {
        const exit = vi.fn();
        const stop = createManagedGuestLocalStop({ requestProcessExit: exit,
            captureElevation: () => { throw new Error('Process exit has no elevated OS effect'); } });
        const prepared = await stop.prepare('process-exit');
        expect(exit).not.toHaveBeenCalled();
        await prepared!();
        expect(exit).toHaveBeenCalledOnce();
    });
    it.each(['none', 'ask'] as const)('uses the same provider Stop when current daemon elevation is %s', async mode => {
        const inspect = vi.fn();
        const test = setup(undefined, undefined, 'stop', undefined, undefined, undefined, false, undefined, { onInspect: inspect });
        const machine = test.readMachine();
        test.setMachine({ controller: undefined, desired: 'start', retention: { kind: 'deadline', at: 0, effect: 'stop' },
            reviewedFacts: { launch: machine.launch, optionStatus: 'current', prerequisites: [],
                billing: { location: 'cloud', stoppedBilling: 'billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop'], guestLocalStop: 'poweroff' },
                retention: { kind: 'deadline', at: 0, effect: 'stop' }, wakeOnAcceptedMessage: true } });
        const stop = createManagedGuestLocalStop({ requestProcessExit: () => { throw new Error('Poweroff is not daemon exit'); },
            captureElevation: () => ({ readPolicy: async () => mode === 'ask'
                ? { version: 1, mode, administratorUsername: 'operator' } : { version: 1, mode },
                observe: async () => { throw new Error('None/Ask does not probe sudo or prompt'); } }) });
        const driver = createManagedMachineAcquisitionDriver({ ...test.driverInput,
            controller: { machineId: 'guest', installationId: 'guest-installation' }, managedGuestLocalStop: stop });
        await driver.executePolicy(test.readMachine(), { kind: 'retention' }, test.options);
        expect(test.effects).toEqual(['power']);
        expect(inspect).toHaveBeenCalledOnce();
        expect(test.reports).toHaveLength(1);
    });
    it.each(['deadline', 'unused'] as const)('stops the enrolled guest locally without provider activation or a synthetic power report (%s)', async kind => {
        const inspect = vi.fn();
        const test = setup(undefined, undefined, 'stop', { observedAt: 2, availability: 'present', power: 'stopped', storage: 'retained' },
            undefined, undefined, false, undefined, { onInspect: inspect });
        test.setMachine({ controller: undefined, desired: 'start', retention: kind === 'unused'
            ? { kind: 'unused', afterMs: 1, effect: 'stop' } : { kind: 'deadline', at: 0, effect: 'stop' },
            observation: { observedAt: 1, availability: 'present', power: 'running' } });
        const machine = test.readMachine();
        test.setMachine({ reviewedFacts: {
            launch: machine.launch, optionStatus: 'current', prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'not-billed' },
            retentionCapabilities: { supportedIntents: ['start', 'stop'], guestLocalStop: 'poweroff' },
            retention: machine.retention, wakeOnAcceptedMessage: true,
        } });
        const stop = vi.fn(async () => {});
        const material = createActionOperationStore();
        material.create({ operationId: 'active-work', actionId: 'projects.compute.exec', title: 'Work',
            scope: { accountId: 'owner', machineId: 'guest' }, cancellation: 'supported', inputIdentity: '{}' });
        const inventory = createManagedActivityInventory({ producers: [{ read: material.readLiveWork, subscribe: material.subscribe }] });
        const drain = createDaemonAdmissionDrain();
        let observedBusy!: () => void;
        const busy = new Promise<void>(resolve => { observedBusy = resolve; });
        let changed = false;
        let wake: (() => void) | undefined;
        const detach = inventory.subscribe(() => { changed = true; wake?.(); });
        const readGuest = async (): Promise<ManagedActivityBridgeResultV1> => {
            const decision = await inventory.readDecision();
            if (decision.kind === 'busy') observedBusy();
            return decision.kind === 'idle' ? { ...decision, evidence: signedIdle(test.readMachine(), decision.since, Date.now()) } : decision;
        };
        // These replace the guest network boundary, retaining the real inventory and drain beneath it.
        test.readActivity.mockImplementation(readGuest);
        test.confirmIdle.mockImplementation(async () => { drain.beginUnusedStopDrain(); return readGuest(); });
        test.waitForChange.mockImplementation(async signal => {
            if (changed) { changed = false; return 'activity'; }
            return new Promise<'activity'>((resolve, reject) => {
                const clear = () => { wake = undefined; signal?.removeEventListener('abort', abort); };
                const abort = () => { clear(); reject(signal?.reason); };
                wake = () => { changed = false; clear(); resolve('activity'); };
                signal?.addEventListener('abort', abort, { once: true });
            });
        });
        const driver = createManagedMachineAcquisitionDriver({ ...test.driverInput,
            controller: { machineId: 'guest', installationId: 'guest-installation' },
            runtimeRegistry: { ...test.driverInput.runtimeRegistry,
                contributes: { ...test.driverInput.runtimeRegistry.contributes, machineProvisioners: [] } },
            managedGuestLocalStop: { prepare: async () => stop } });
        try {
            const pending = driver.executePolicy(test.readMachine(), { kind: 'retention' }, test.options);
            if (kind === 'unused') {
                await busy;
                expect(stop).not.toHaveBeenCalled();
                material.succeed('active-work', {});
            }
            await pending;
            expect(stop).toHaveBeenCalledOnce();
            expect(drain.isQuiescing()).toBe(kind === 'unused');
            expect(test.effects).toEqual([]);
            expect(inspect).not.toHaveBeenCalled();
            expect(test.reports).toEqual([]);
            expect(test.readMachine().observation).toEqual({ observedAt: 1, availability: 'present', power: 'running' });
            const inspected = await test.driver.execute('machines.managed.inspect', {
                homeId: machine.homeId, managedId: machine.id,
            }, test.options);
            expect(ManagedMachineActionOutputSchemasV1['machines.managed.inspect'].parse(inspected).machine.observation).toEqual({
                observedAt: 2, availability: 'present', power: 'stopped', storage: 'retained',
            });
            expect(test.effects).toEqual([]);
            expect(inspect).toHaveBeenCalledOnce();
            expect(stop).toHaveBeenCalledOnce();
        } finally { detach(); inventory.dispose(); }
    });
    it.each([
        { intent: 'stop', refuseResume: false }, { intent: 'delete', refuseResume: false },
        { intent: 'delete', refuseResume: true },
    ] as const)('settles cancellation before native $intent IO over Socket.IO (resume refused=$refuseResume)', async ({ intent, refuseResume }) => {
        const test = setup(undefined, undefined, intent);
        test.setMachine({ desiredWhen: 'after-idle' });
        const cancellation = new AbortController();
        const drain = createDaemonAdmissionDrain();
        const inventory = createManagedActivityInventory({ producers: [{
            read: () => ({ coverage: 'complete', items: [] }), subscribe: () => () => {},
        }] });
        const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'guest',
            installationId: 'guest-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
        const rpc = new RpcHandlerManager({ scopePrefix: 'guest', encryptionMode: 'plain', logger: () => {},
            authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, {
                machineId: 'guest', resolveCustodianAccountId: async () => 'owner',
                resolveInstallationId: () => 'guest-installation',
                // The Home is the network boundary; transport, admission, guest
                // inventory, drain, reconciler and native dispatch remain real.
                verifyMachineAdmission: async () => true,
            }, source) });
        registerManagedActivityRpcHandlers({ rpcHandlerManager: rpc, activity: inventory, admissionDrain: drain });
        const http = createServer();
        const server = new Server(http, { path: '/v1/updates/' });
        const drainActions: unknown[] = [];
        let connections = 0;
        const disconnected = new Promise<void>(resolve => server.once('connection', socket => socket.once('disconnect', () => resolve())));
        server.on('connection', socket => {
            connections++;
            socket.on(SOCKET_RPC_EVENTS.CALL, async (request: { method: string; params: unknown }, reply: (result: unknown) => void) => {
                if (request.method.endsWith(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD)
                    && request.params && typeof request.params === 'object' && 'action' in request.params) {
                    drainActions.push(request.params.action);
                    if (request.params.action === 'resume' && refuseResume) {
                        reply({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, error: 'Cleanup refused by Home' });
                        return;
                    }
                }
                reply({ ok: true, result: await rpc.handleRequest({ method: request.method,
                    params: request.params, machineAdmission }, undefined, 'authenticated_home_socket') });
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        try {
            const address = http.address();
            if (!address || typeof address === 'string') throw new Error('Missing guest activity endpoint');
            const driver = createManagedMachineAcquisitionDriver({ ...test.driverInput,
                managedGuestActivity: undefined, serverUrl: `http://127.0.0.1:${address.port}` });
            let cancelledUnderDrain = false;
            const failure = await driver.execute(intent === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set', {
                homeId: test.readMachine().homeId, managedId: 'managed', when: 'after-idle', intent,
                ...(intent === 'delete' ? { reviewedDependencies: true } : {}),
            }, { ...test.options, signal: cancellation.signal, context: { ...test.options.context,
                operationOwnerUpdate: { update(update) {
                    if (update.progress?.phase === 'managed.intent.draining' && drain.isQuiescing()) {
                        cancelledUnderDrain = true;
                        cancellation.abort();
                    }
                } },
            } }).then(() => null, (error: unknown) => error);
            expect(cancelledUnderDrain).toBe(true);
            expect(test.effects).toEqual([]);
            expect(drain.isQuiescing()).toBe(refuseResume);
            expect(drainActions).toEqual(['begin', 'resume']);
            if (refuseResume) expect(readRpcErrorCode(failure)).toBe(RPC_ERROR_CODES.FORBIDDEN);
            else expect(failure).toMatchObject({ code: 'cancelled' });
            await disconnected;
            expect(connections).toBe(1);
        } finally {
            inventory.dispose();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
    it('refuses an effectful role under Inspect at the native invocation boundary', async () => {
        const test = setup();
        const client = createManagedMachineControllerClient(test.driverInput, test.options, 'machines.managed.inspect');
        const native = createManagedNativeInvocation({ input: test.driverInput, options: test.options, client,
            machine: test.readMachine(), action: 'machines.managed.inspect' }, test.readMachine);
        await expect(native.invoke('destroy', { resource: test.readMachine().resource!.value }))
            .rejects.toMatchObject({ code: 'native_intent_unsupported' });
        expect(test.effects).toEqual([]);
        expect(test.post).not.toHaveBeenCalled();
    });
    it('runs admitted native roles without per-role Home authority reads', async () => {
        const test = setup();
        const client = createManagedMachineControllerClient(test.driverInput, test.options, 'machines.managed.delete');
        const native = createManagedNativeInvocation({ input: test.driverInput, options: test.options, client,
            machine: test.readMachine(), action: 'machines.managed.delete' }, test.readMachine);
        await native.invoke('inspect', { resource: test.readMachine().resource!.value });
        await expect(native.invoke('destroy', { resource: test.readMachine().resource!.value })).resolves.toMatchObject({ kind: 'confirmed' });
        const reads = test.post.mock.calls.filter(([url]) => String(url).endsWith('/current'));
        console.log('CF_LIFE_NATIVE_CURRENT_READS', reads.length);
        expect(reads).toHaveLength(0);
        expect(test.effects).toEqual(['destroy']);
    });
    it('submits a Delete with only admission, effect claim and settlement POSTs', async () => {
        const test = setup();
        await expect(test.run()).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
        const paths = test.post.mock.calls.map(([url]) => new URL(String(url)).pathname.split('/').at(-1));
        console.log('CF_LIFE_DELETE_POSTS', paths);
        expect(paths).toEqual(['admit-control', 'submit-intent', 'report-intent']);
        expect(test.effects).toEqual(['destroy']);
        expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
    });
    it('reads one authoritative row per Delete deadline wake and settles a pushed absence without native IO', async () => {
        vi.useFakeTimers();
        const observation: ProviderObservationV1 = { observedAt: 123, availability: 'present' };
        const test = setup(undefined, { kind: 'accepted', nativeOperationRef: {
            contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {},
        } }, 'delete', observation, undefined, undefined, true);
        const lifetime = new AbortController();
        const work = test.run(lifetime.signal);
        // Inspection-qualified Home reads distinguish the observer from the
        // destroy role's own required pre-handler admission.
        const reads = () => test.post.mock.calls.filter(([url, body]) => String(url).endsWith('/current')
            && ManagedControllerCurrentInputV1Schema.parse(body).nativeRole === 'inspect').length;
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(test.effects).toEqual(['destroy']);
            const initialReads = reads();
            await vi.advanceTimersByTimeAsync(5_000);
            console.log('CF_LIFE_DELETE_WAKE_READS', reads() - initialReads);
            expect(test.effects).toEqual(['destroy', 'destroy']);
            expect(reads() - initialReads).toBe(1);
            observation.availability = 'absent';
            await test.driver.execute('machines.managed.inspect', { homeId: test.readMachine().homeId,
                managedId: test.readMachine().id }, test.options);
            await vi.advanceTimersByTimeAsync(0);
            await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
            expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent' });
            expect(test.effects).toEqual(['destroy', 'destroy']);
            const settledReads = reads();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(settledReads);
        } finally {
            lifetime.abort();
            await work.catch(() => undefined);
        }
    });
    it('retains a pushed Delete settlement while the initial observer row read completes', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const observation: ProviderObservationV1 = { observedAt: 123, availability: 'present' };
        const test = setup(undefined, { kind: 'accepted', nativeOperationRef: {
            contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {},
        } }, 'delete', observation, undefined, undefined, true);
        const transport = test.post.getMockImplementation()!;
        let pushed = false;
        let publishSettlement!: () => void;
        const settlementPublished = new Promise<void>(resolve => { publishSettlement = resolve; });
        test.post.mockImplementation(async (url, body, config) => {
            const response = await transport(url, body, config);
            if (!pushed && String(url).endsWith('/current')
                && ManagedControllerCurrentInputV1Schema.parse(body).nativeRole === 'inspect'
                // Native Inspect's pre-handler read has the same role marker.
                // The Delete observer exists only after its accepted report.
                && test.reports.some(report => ManagedControllerIntentReportV1Schema.parse(report).result.kind === 'accepted')) {
                // A real Check now settles Home after this response was read,
                // but before the original observer receives that stale response.
                pushed = true;
                observation.availability = 'absent';
                await test.driver.execute('machines.managed.inspect', { homeId: test.readMachine().homeId,
                    managedId: test.readMachine().id }, test.options);
                publishSettlement();
            }
            return response;
        });
        const lifetime = new AbortController();
        let settled = false;
        const work = test.run(lifetime.signal).then(value => { settled = true; return value; });
        try {
            await vi.advanceTimersByTimeAsync(0);
            // Complete the real nested dispatch at the HTTP boundary before
            // asserting how the observer consumes that in-flight push.
            await Promise.race([settlementPublished, work]);
            await vi.advanceTimersByTimeAsync(0);
            expect(pushed).toBe(true);
            // Dispatch can still be completing real module/service preparation.
            // Wait for settlement while remaining below the first native wake.
            await vi.waitFor(() => expect(settled).toBe(true));
            await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
            expect(test.effects).toEqual(['destroy']);
        } finally {
            lifetime.abort();
            await work.catch(() => undefined);
        }
    });
    it.each(['delayed-completion', 'cancel-retry', 'native-failure'] as const)(
        'observes a recovered accepted Boat Delete through settlement (%s)', async sequence => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const sandboxId = 'bx_23456789';
        const operationId = `bdop_${'a'.repeat(32)}`;
        let status: 'pending' | 'processing' | 'completed' | 'blocked' = 'pending';
        const requests: Array<{ path: string; method: string }> = [];
        const http = createPluginHttpFixture({ async request(input) {
            const path = new URL(input.url).pathname;
            const method = input.method ?? 'GET';
            requests.push({ path, method });
            expect(path).toBe(method === 'DELETE' ? `/api/v1/sandboxes/${sandboxId}` : `/api/v1/deletion-operations/${operationId}`);
            return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ ok: true, type: 'sandbox',
                operation: { id: operationId, kind: 'sandbox', targetId: sandboxId, status } })) };
        } });
        // Produce the pre-retained handle at the real native HTTP boundary,
        // representing the accepted Delete whose original daemon was lost.
        const prior = await createBoatNativeClient({ fetch: async (url, init) => {
            const reply = await http.request({ url: String(url), method: 'DELETE', headers: {}, redirect: 'error' });
            expect(init?.method).toBe('DELETE');
            return new Response(new Uint8Array(reply.body), { status: reply.status });
        } }).destroy({ resource: { sandboxId } });
        const plugin = await createPluginTestkit({ manifest: BOAT_PLUGIN.manifest, module: BOAT_PLUGIN });
        const actions = BOAT_PLUGIN.manifest.contributes.actions;
        if (!actions) throw new Error('Missing authored Boat Actions');
        const actionHandlers = new Map(actions.map(action => {
            const handler = plugin.registration('actions', action.id);
            if (!handler) throw new Error(`Missing authored Boat Action ${action.id}`);
            return [action.id, handler] as const;
        }));
        const credentialOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'owner',
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Captured' } : null,
            materializeAccount: async () => ({ kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture' } }),
            resolveCredentialConfigurationRevision: async () => 'fixture-configuration',
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable });
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, connectedAccounts: credentialOwner,
            http: createStablePluginHttpHost({ adapter: { openWebSocket: unavailable, request: http.request },
                purposeHost: createConnectedAccountPluginHttpPurposeHost(credentialOwner, { registerRawForRedaction() {} }) }) });
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, false, undefined, {
            fixtureManifest: normalizePluginManifestV2(BOAT_PLUGIN.manifest), actionHandlers, credentialOwner,
            executionRealm: 'account',
            credentialPurposes: [{ purpose: 'cloud-api', service: { pluginId: BOAT_PLUGIN.manifest.id, localId: 'boat-account' } }],
            createServices: owners.createServices, resolveHostBinding: owners.resolveHostBinding,
        });
        const provider = { pluginId: BOAT_PLUGIN.manifest.id, localId: 'boat' };
        const accepted = MachineProvisionerDestroyResultV1Schema.parse({ kind: 'accepted',
            nativeOperationRef: { contributionRef: provider, schemaVersion: 1, value: prior.operation } });
        if (accepted.kind !== 'accepted') throw new Error('Expected accepted native Delete');
        test.setMachine({ intentRevision: 2,
            launch: { ...test.readMachine().launch, provider, choices: { size: 'small', source: { kind: 'blank' } }, credentials: [{
                purpose: { consumer: provider, purpose: 'cloud-api' },
                account: { service: { pluginId: provider.pluginId, localId: 'boat-account' }, accountId: 'captured-account' },
                configurationRevision: 'fixture-configuration',
            }] }, resource: { contributionRef: provider, schemaVersion: 1, value: { sandboxId } },
            nativeOperationRef: accepted.nativeOperationRef,
            submittedNativeEffect: { intentRevision: 1, requestId: 'earlier-delete', intent: 'delete', controller: test.readMachine().controller },
        });
        const machine = test.readMachine();
        let nextOperation = 0;
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `recovered-boat-${++nextOperation}` });
        const input = { homeId: machine.homeId, managedId: machine.id, intent: 'delete', when: 'now',
            expectedRevision: machine.intentRevision, reviewedDependencies: true };
        let work: Promise<unknown> | undefined;
        let finished = false;
        let nextRequest = 0;
        const start = async () => {
            finished = false;
            const reported = test.reports.length;
            const requestId = `approved-delete-${++nextRequest}`;
            await operations.observeExecution({ actionId: 'machines.managed.delete', input, actionRequestId: requestId,
                execute: async context => {
                    const execution = test.driver.execute('machines.managed.delete', input, { requestId, context, signal: context.signal });
                    work = execution.then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
                    return { ok: true, result: await execution };
                } });
            while (!finished && (test.reports.length === reported || !vi.getTimerCount())) await new Promise<void>(resolve => setImmediate(resolve));
            if (finished) expect(await work).toMatchObject({ value: { kind: 'accepted' } });
        };
        try {
            await start();
            expect(finished).toBe(false);
            expect(test.reports).toHaveLength(1);
            expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
            status = 'processing';
            await vi.advanceTimersByTimeAsync(5_000);
            expect(test.reports).toHaveLength(2);
            expect(finished).toBe(false);
            if (sequence === 'cancel-retry') {
                await operations.handlers.cancel({ operationId: 'recovered-boat-1' });
                expect(await work).toMatchObject({ error: { code: 'cancelled' } });
                expect(vi.getTimerCount()).toBe(0);
                const reads = requests.length;
                await vi.advanceTimersByTimeAsync(180_000);
                expect(requests).toHaveLength(reads);
                expect(test.readMachine().submittedNativeEffect).toMatchObject({ requestId: 'earlier-delete', intentRevision: 1 });
                await start();
                expect(finished).toBe(false);
            }
            status = sequence === 'native-failure' ? 'blocked' : 'completed';
            const reads = requests.length;
            await vi.advanceTimersByTimeAsync(sequence === 'cancel-retry' ? 5_000 : 10_000);
            expect(requests).toHaveLength(reads + 1);
            if (sequence === 'native-failure') {
                expect(await work).toMatchObject({ error: { code: 'native_delete_blocked' } });
                expect(await operations.handlers.getV2({ operationId: 'recovered-boat-1', waitForTerminal: true }))
                    .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'native_delete_blocked' } } });
            } else {
                expect(await work).toMatchObject({ value: { kind: 'accepted', managedId: machine.id } });
                expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
                expect(test.readMachine().submittedNativeEffect).toBeUndefined();
                expect(test.readMachine().nativeOperationRef).toBeUndefined();
                expect(await operations.handlers.getV2({ operationId: `recovered-boat-${nextOperation}`, waitForTerminal: true }))
                    .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
            }
            const settledReads = requests.length;
            await vi.advanceTimersByTimeAsync(180_000);
            expect(requests).toHaveLength(settledReads);
            expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await operations.handlers.cancel({ operationId: `recovered-boat-${nextOperation}` });
            await work;
            await plugin.dispose();
        }
    });

    it.each(['delayed-completion', 'observation-failure', 'terminate-refusal', 'terminate-unclassified-refusal'] as const)(
        'settles real Modal asynchronous Delete through the shared observer (%s)', async sequence => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        let nativeState: 'running' | 'ended' | 'failed' = 'running';
        const nativeFailure = () => Object.assign(new Error('private native failure'), { '@@nice-grpc:ClientError': true, code: 7 });
        // Only the Modal SDK/network boundary is substituted. Roles, native
        // identity qualification, strict results and managed host stay real.
        const sandbox: ModalSandboxHandle = {
            sandboxId: 'sb-retained',
            poll: vi.fn(async () => { if (nativeState === 'failed') throw nativeFailure(); return nativeState === 'ended' ? 137 : null; }),
            terminate: vi.fn(async () => {
                if (sequence === 'terminate-refusal') throw nativeFailure();
                if (sequence === 'terminate-unclassified-refusal') throw 'private unclassified native failure';
            }),
            exec: unavailable, filesystem: { writeBytes: unavailable },
        };
        const client: ModalNativeClient = {
            version: () => '0.11.0', apps: { fromName: async () => ({ appId: 'ap-selected' }) },
            images: { fromRegistry() { throw new Error('Unexpected native image lookup'); } },
            sandboxes: { fromId: async () => sandbox, create: unavailable, list: async function* () { yield sandbox; } },
        };
        const actionHandlers = new Map(MODAL_PLUGIN.manifest.contributes.actions.map(action => [action.id,
            async (input: unknown, context: { invokedAtMs: number; signal: AbortSignal }) => {
                const roles = createModalProvisionerRoles(client, context.invokedAtMs, context.signal);
                if (action.id === 'destroy') return await roles.destroy(input);
                if (action.id === 'inspect') return await roles.inspect(input);
                throw new Error(`Unexpected Modal role ${action.id}`);
            }] as const));
        const credentialOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'owner',
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Captured' } : null,
            materializeAccount: unavailable, resolveCredentialConfigurationRevision: async () => 'fixture-configuration',
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable });
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, connectedAccounts: credentialOwner,
            http: createStablePluginHttpHost({ adapter: { openWebSocket: unavailable, request: unavailable } }) });
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, false, undefined, {
            fixtureManifest: normalizePluginManifestV2(MODAL_PLUGIN.manifest), actionHandlers, credentialOwner,
            credentialPurposes: [{ purpose: 'modal-credential', service: { pluginId: MODAL_CONTRIBUTION_REF.pluginId, localId: 'modal-account' } }],
            createServices: owners.createServices, resolveHostBinding: owners.resolveHostBinding,
        });
        test.setMachine({ launch: { ...test.readMachine().launch, provider: MODAL_CONTRIBUTION_REF, credentials: [{
            purpose: { consumer: MODAL_CONTRIBUTION_REF, purpose: 'modal-credential' },
            account: { service: { pluginId: MODAL_CONTRIBUTION_REF.pluginId, localId: 'modal-account' }, accountId: 'captured-account' },
            configurationRevision: 'fixture-configuration',
        }], choices: { appReference: 'selected', imageReference: 'ubuntu:24.04', resources: { cpu: 0.125, memoryMb: 512 }, timeoutMs: 86_400_000 } },
            resource: { contributionRef: MODAL_CONTRIBUTION_REF, schemaVersion: 1, value: { appId: 'ap-selected', sandboxId: sandbox.sandboxId } } });
        const machine = test.readMachine();
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'modal-delete' });
        const input = { homeId: machine.homeId, managedId: machine.id, intent: 'delete', when: 'now',
            expectedRevision: machine.intentRevision, reviewedDependencies: true };
        let finished = false;
        let work: Promise<unknown> | undefined;
        try {
            await operations.observeExecution({ actionId: 'machines.managed.delete', input, actionRequestId: 'control',
                execute: async context => {
                    const execution = test.driver.execute('machines.managed.delete', input, { requestId: 'control', context, signal: context.signal });
                    work = execution.then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
                    const result = await execution;
                    const failure = ActionExecuteFailureSchema.safeParse(result);
                    return failure.success ? failure.data : { ok: true, result };
                } });
            while (test.reports.length < 1 && !finished) await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>(resolve => setImmediate(resolve));
            if (sequence !== 'terminate-refusal' && sequence !== 'terminate-unclassified-refusal') {
                if (finished) expect(await work).toHaveProperty('value');
                expect(finished).toBe(false);
                expect(await operations.handlers.getV2({ operationId: 'modal-delete' })).toMatchObject({ kind: 'found', operation: {
                    progress: { phase: 'managed.intent.waiting-delete' },
                } });
                const initialPolls = vi.mocked(sandbox.poll).mock.calls.length;
                await vi.advanceTimersByTimeAsync(4_999);
                expect(sandbox.poll).toHaveBeenCalledTimes(initialPolls);
                if (sequence === 'observation-failure') nativeState = 'failed';
                await vi.advanceTimersByTimeAsync(1);
                expect(sandbox.poll).toHaveBeenCalledTimes(initialPolls + 1);
                expect(sandbox.terminate).toHaveBeenCalledOnce();
                if (sequence === 'delayed-completion') {
                    expect(finished).toBe(false);
                    nativeState = 'ended';
                    await vi.advanceTimersByTimeAsync(10_000);
                }
            }
            expect(finished).toBe(true);
            if (sequence === 'delayed-completion') {
                expect(await work).toHaveProperty('value');
                expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
                expect(test.readMachine().submittedNativeEffect).toBeUndefined();
                expect(await operations.handlers.getV2({ operationId: 'modal-delete' })).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
            } else {
                const errorCode = sequence === 'observation-failure' ? 'modal_lookup_unavailable' : 'native_intent_unconfirmed';
                const details = sequence === 'terminate-unclassified-refusal' ? undefined : { kind: 'managedNative', nativeCause: { grpcStatusCode: 7 } };
                expect(await work).toMatchObject({ error: { code: errorCode, details } });
                expect(await operations.handlers.getV2({ operationId: 'modal-delete' })).toMatchObject({ kind: 'found', operation: {
                    state: 'failed', error: { errorCode, ...(details ? { details } : {}) },
                } });
            }
            expect(sandbox.terminate).toHaveBeenCalledOnce();
            const settledPolls = vi.mocked(sandbox.poll).mock.calls.length;
            await vi.advanceTimersByTimeAsync(180_000);
            expect(sandbox.poll).toHaveBeenCalledTimes(settledPolls);
            expect(sandbox.terminate).toHaveBeenCalledOnce();
        } finally {
            await operations.handlers.cancel({ operationId: 'modal-delete' });
            await work;
            test.retireNative();
        }
    });
    it.each(['automatic-server-first', 'manual-server-first', 'automatic-attachment-first', 'automatic-explicit-attachments', 'initial-native-failure', 'inspect-only'] as const)(
        'settles real Hetzner owned Primary IP cleanup through the shared Delete observer (%s)', async sequence => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        let serverPresent = true;
        let serverReads = 0;
        let ipPresent = sequence !== 'automatic-attachment-first';
        let volumePresent = sequence === 'automatic-explicit-attachments';
        let deleteActionComplete = sequence !== 'automatic-server-first';
        const requests: Array<{ path: string; method: string }> = [];
        const http = createPluginHttpFixture({ async request(input) {
            // The real purpose host injects the captured bearer before the HTTP boundary.
            expect(new Headers(input.headers).get('authorization') === 'Bearer fixture').toBe(true);
            const path = new URL(input.url).pathname;
            const method = input.method ?? 'GET';
            requests.push({ path, method });
            if (method === 'DELETE' && path === '/v1/servers/41') {
                // REST v1 removes account visibility before detachment finishes.
                if (!deleteActionComplete) serverPresent = false;
                return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
                    action: { id: 10, status: deleteActionComplete ? 'success' : 'running' },
                })) };
            }
            if (path === '/v1/servers/actions/10') return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
                action: { id: 10, status: deleteActionComplete ? 'success' : 'running' },
            })) };
            if (sequence === 'initial-native-failure' && method === 'DELETE' && path === '/v1/primary_ips/9') {
                return { status: 409, headers: {}, body: new TextEncoder().encode(JSON.stringify({ error: { code: 'conflict' } })) };
            }
            if (sequence === 'automatic-explicit-attachments' && method === 'DELETE' && path !== '/v1/servers/41') {
                expect(serverPresent).toBe(false);
                if (path === '/v1/primary_ips/9') ipPresent = false;
                else if (path === '/v1/volumes/7') volumePresent = false;
                else throw new Error(`Unexpected native attachment ${path}`);
                return { status: 204, headers: {}, body: new Uint8Array() };
            }
            // The server disappears after destroy's immediate readback.
            // Attachments stay observable until their distinct cleanup event.
            if (method === 'GET' && path === '/v1/servers/41'
                && ++serverReads > (sequence === 'initial-native-failure' ? 0 : 1)
                && sequence !== 'automatic-attachment-first') serverPresent = false;
            const present = path === '/v1/servers/41' ? serverPresent : path === '/v1/volumes/7' ? volumePresent : ipPresent;
            const status = method === 'DELETE' || present ? 200 : 404;
            const value = status === 404 ? { error: { code: 'not_found' } }
                : path === '/v1/servers/41' ? { server: { id: 41, status: 'deleting', labels: {}, volumes: [],
                    public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null } } }
                    : path === '/v1/volumes/7' ? { volume: { id: 7 } } : { primary_ip: { id: 9 } };
            return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
        } });
        const plugin = await createPluginTestkit({ manifest: HETZNER_PLUGIN.manifest, module: HETZNER_PLUGIN });
        const actionHandlers = new Map(HETZNER_PLUGIN.manifest.contributes.actions.map(action => {
            const handler = plugin.registration('actions', action.id);
            if (!handler) throw new Error(`Missing authored Hetzner Action ${action.id}`);
            return [action.id, handler] as const;
        }));
        const credentialOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'owner',
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Captured' } : null,
            materializeAccount: async () => ({ kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture' } }),
            resolveCredentialConfigurationRevision: async () => 'fixture-configuration',
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable });
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, connectedAccounts: credentialOwner,
            http: createStablePluginHttpHost({ adapter: { openWebSocket: unavailable, request: http.request },
                purposeHost: createConnectedAccountPluginHttpPurposeHost(credentialOwner, { registerRawForRedaction() {} }) }) });
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, false, undefined, {
            fixtureManifest: normalizePluginManifestV2(HETZNER_PLUGIN.manifest), actionHandlers, credentialOwner, executionRealm: 'account',
            credentialPurposes: [{ purpose: 'cloud-api', service: { pluginId: HETZNER_PLUGIN.manifest.id, localId: 'hetzner-account' } }],
            createServices: owners.createServices, resolveHostBinding: owners.resolveHostBinding,
        });
        const provider = { pluginId: HETZNER_PLUGIN.manifest.id, localId: 'hetzner' };
        test.setMachine({ launch: { ...test.readMachine().launch, provider, credentials: [{
            purpose: { consumer: provider, purpose: 'cloud-api' },
            account: { service: { pluginId: provider.pluginId, localId: 'hetzner-account' }, accountId: 'captured-account' },
            configurationRevision: 'fixture-configuration',
        }], choices: {
            serverTypeId: '114', imageId: '67794396', locationId: 'nbg1', publicNetworking: { ipv4: true, ipv6: false },
        } }, resource: { contributionRef: provider,
            schemaVersion: 1, value: { serverId: 41, owned: {
                volumeIds: sequence === 'automatic-explicit-attachments' ? [7] : [], primaryIpIds: [9],
            } } } });
        if (sequence === 'inspect-only') {
            serverPresent = false;
            const retained = test.readMachine();
            test.setMachine({ nativeOperationRef: retained.resource,
                submittedNativeEffect: { intentRevision: retained.intentRevision, requestId: 'original-delete', intent: 'delete', controller: retained.controller } });
            const checkNow = () => test.driver.execute('machines.managed.inspect',
                { homeId: retained.homeId, managedId: retained.id }, { ...test.options, requestId: 'check-now' });
            try {
                await expect(checkNow()).resolves.toMatchObject({ machine: { allocation: 'bound',
                    observation: { availability: 'unavailable', reason: 'native_cleanup_incomplete' } } });
                expect(ipPresent).toBe(true);
                expect(test.readMachine().submittedNativeEffect).toMatchObject({ requestId: 'original-delete' });
                expect(requests.every(request => request.method === 'GET')).toBe(true);
                ipPresent = false;
                await expect(checkNow()).resolves.toMatchObject({ machine: { allocation: 'confirmed-absent', observation: { availability: 'absent' } } });
                expect(test.readMachine().submittedNativeEffect).toBeUndefined();
                expect(test.readMachine().nativeOperationRef).toBeUndefined();
                expect(requests.map(request => request.method)).toEqual(['GET', 'GET', 'GET', 'GET']);
                expect(vi.getTimerCount()).toBe(0);
            } finally { await plugin.dispose(); }
            return;
        }
        const machine = test.readMachine();
        let operationNumber = 0;
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => ++operationNumber === 1 ? 'hetzner-delete' : 'hetzner-inspect' });
        const input = { homeId: machine.homeId, managedId: machine.id, intent: 'delete', when: 'now',
            expectedRevision: machine.intentRevision, reviewedDependencies: true };
        let finished = false;
        let work: Promise<unknown> | undefined;
        try {
            await operations.observeExecution({ actionId: 'machines.managed.delete', input, actionRequestId: 'control',
                execute: async context => {
                    const execution = test.driver.execute('machines.managed.delete', input, { requestId: 'control', context, signal: context.signal });
                    work = execution.then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
                    return { ok: true, result: await execution };
                } });
            while (test.reports.length < 1 && !finished) await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>(resolve => setImmediate(resolve));
            if (sequence === 'initial-native-failure') {
                // CLOUD15's observed initial native_request_failed never entered
                // waiting-delete. Construct a closed 4xx cause without assuming
                // the unavailable historical vendor code or retryability.
                expect(await work).toMatchObject({ error: { code: 'native_request_failed', details: {
                    kind: 'managedNative', nativeCause: { httpStatusClass: '4xx', code: 'conflict' },
                } } });
                const failed = { kind: 'found', operation: { state: 'failed', error: {
                    errorCode: 'native_request_failed', details: { kind: 'managedNative',
                        nativeCause: { httpStatusClass: '4xx', code: 'conflict' } },
                } } };
                expect(await operations.handlers.getV2({ operationId: 'hetzner-delete' })).toMatchObject(failed);
                expect(test.readMachine()).toMatchObject({ allocation: 'bound',
                    observation: { availability: 'unavailable', reason: 'native_cleanup_incomplete' },
                    submittedNativeEffect: { intent: 'delete' } });
                const failedRequests = requests.length;
                await vi.advanceTimersByTimeAsync(180_000);
                expect(requests).toHaveLength(failedRequests);
                ipPresent = false;
                await operations.observeExecution({ actionId: 'machines.managed.inspect',
                    input: { homeId: machine.homeId, managedId: machine.id }, actionRequestId: 'check-now',
                    execute: async context => ({ ok: true, result: await test.driver.execute('machines.managed.inspect',
                        { homeId: machine.homeId, managedId: machine.id }, { requestId: 'check-now', context, signal: context.signal }) }) });
                expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
                expect(await operations.handlers.getV2({ operationId: 'hetzner-delete' })).toMatchObject(failed);
                expect(requests.filter(request => request.method === 'DELETE').map(request => request.path))
                    .toEqual(['/v1/servers/41', '/v1/primary_ips/9']);
                return;
            }
            if (finished) {
                const outcome = await work;
                if (outcome && typeof outcome === 'object' && 'error' in outcome) throw outcome.error;
            }
            expect(finished).toBe(false);
            expect(test.readMachine().allocation).toBe('bound');
            if (sequence === 'automatic-attachment-first') {
                serverPresent = false;
            } else if (sequence === 'automatic-explicit-attachments') {
                const beforeContinuation = requests.length;
                await vi.advanceTimersByTimeAsync(4_999);
                expect(requests).toHaveLength(beforeContinuation);
                // The next native observation must advance admitted attachment
                // cleanup once the exact primary is absent, without replaying its DELETE.
                await vi.advanceTimersByTimeAsync(1);
                expect(requests).toHaveLength(beforeContinuation + 5); // Exact server/attachment reads and two owned DELETEs.
            } else {
                expect(test.readMachine().observation).toMatchObject({ availability: 'unavailable', reason: 'native_cleanup_incomplete' });
                if (sequence === 'automatic-server-first') {
                    expect(test.readMachine().nativeOperationRef?.value).toMatchObject({ deleteActionId: 10 });
                    expect(requests.some(request => request.method === 'DELETE' && request.path === '/v1/primary_ips/9')).toBe(false);
                    deleteActionComplete = true;
                }
                // One scheduled continuation advances the admitted owned-IP cleanup.
                const beforeObservation = requests.length;
                await vi.advanceTimersByTimeAsync(4_999);
                expect(requests).toHaveLength(beforeObservation);
                await vi.advanceTimersByTimeAsync(1);
                // Retained action completion (when present), server/IP read,
                // one DELETE, then its exact pending readback.
                expect(requests).toHaveLength(beforeObservation + (sequence === 'automatic-server-first' ? 5 : 4));
                expect(finished).toBe(false);
                ipPresent = false;
            }
            if (sequence === 'manual-server-first') {
                await test.driver.execute('machines.managed.inspect', { homeId: machine.homeId, managedId: machine.id },
                    { requestId: 'check-now', context: test.options.context });
                expect(test.readMachine().allocation).toBe('confirmed-absent');
                // Check now publishes Home's completion; the original operation
                // consumes that notification asynchronously on its own waiter.
                await new Promise<void>(resolve => setImmediate(resolve));
            } else if (sequence !== 'automatic-explicit-attachments') {
                await vi.advanceTimersByTimeAsync(sequence === 'automatic-attachment-first' ? 5_000 : 10_000);
            }
            expect(finished).toBe(true);
            expect(await work).toHaveProperty('value');
            expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
            expect(await operations.handlers.getV2({ operationId: 'hetzner-delete', waitForTerminal: true }))
                .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
            expect(requests.filter(request => request.method === 'DELETE' && request.path === '/v1/servers/41')).toHaveLength(1);
            expect(requests.filter(request => request.method === 'DELETE' && request.path === '/v1/primary_ips/9'))
                .toHaveLength(sequence === 'automatic-attachment-first' ? 0 : 1);
            expect(requests.filter(request => request.method === 'DELETE' && request.path === '/v1/volumes/7'))
                .toHaveLength(sequence === 'automatic-explicit-attachments' ? 1 : 0);
            expect(requests.every(request => ['/v1/servers/41', '/v1/servers/actions/10', '/v1/primary_ips/9', '/v1/volumes/7'].includes(request.path))).toBe(true);
            const settledReads = requests.length;
            await vi.advanceTimersByTimeAsync(180_000);
            expect(requests).toHaveLength(settledReads);
        } finally {
            await operations.handlers.cancel({ operationId: 'hetzner-delete' });
            await work;
            await plugin.dispose();
            test.retireNative();
        }
    });
    it('keeps policy Delete observing when its own accepted native handle is published', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const nativeResult: ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse> = { kind: 'accepted',
            nativeOperationRef: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} } };
        const test = setup(undefined, nativeResult, 'delete', { observedAt: Date.now(), availability: 'present' }, undefined, undefined, true);
        test.setMachine({ desired: 'start', retention: { kind: 'deadline', at: Date.now(), effect: 'delete' } });
        const original = test.readMachine();
        let censuses = 0;
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/policies')) {
                censuses += 1;
                return { status: 200, data: { machines: [test.readMachine()], targets: [] } };
            }
            return await home(url, body, config);
        });
        let held: AbortSignal | undefined;
        let work: Promise<unknown> | undefined;
        let finished = false;
        const failures: unknown[] = [];
        const runtime = createDaemonManagedMachinePolicyRuntime({
            readCensus: signal => readManagedMachinePolicyCensus({ homeId: original.homeId, controller: original.controller,
                custodianAccountId: original.custodianAccountId, privateKey: test.installationKeys.secretKey,
                token: 'token', serverUrl: 'https://home.example', signal }),
            executePolicy: async ({ machine, purpose, signal }) => {
                held = signal;
                const execution = test.driver.executePolicy(machine, purpose, { ...test.options, signal });
                work = execution.then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
                return await execution;
            },
            onUnavailable: error => { failures.push(error); finished = true; },
        });
        try {
            runtime.notifyChanged();
            while (!test.readMachine().nativeOperationRef && !finished) await new Promise<void>(resolve => setImmediate(resolve));
            expect(failures).toEqual([]);
            expect(test.readMachine().nativeOperationRef).toBeDefined();
            await new Promise<void>(resolve => setImmediate(resolve));
            runtime.notifyChanged(true);
            while (censuses < 2) await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(held?.aborted).toBe(false);
            Reflect.deleteProperty(nativeResult, 'nativeOperationRef');
            Object.assign(nativeResult, { kind: 'confirmed' });
            await vi.advanceTimersByTimeAsync(5_000);
            expect(await work).toHaveProperty('value');
            expect(test.readMachine().allocation).toBe('confirmed-absent');
        } finally {
            await runtime.stop();
            await work;
        }
    });
    it.each(['manual-check', 'cancel', 'typed-failure', 'operation-failure'] as const)('stops accepted Delete observation on %s without native replay', async ending => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const observation: ProviderObservationV1 = { observedAt: Date.now(), availability: 'present', power: 'running' };
        const nativeResult: ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse> = ending === 'operation-failure'
            ? { kind: 'accepted', nativeOperationRef: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} } }
            : { kind: 'pending' };
        const test = setup(undefined, nativeResult, 'delete', observation, undefined, undefined, true);
        const machine = test.readMachine();
        let sequence = 0;
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `observed-delete-${++sequence}` });
        const input = { homeId: machine.homeId, managedId: machine.id, intent: 'delete', when: 'now',
            expectedRevision: machine.intentRevision, reviewedDependencies: true };
        let work: Promise<unknown> | undefined;
        let finished = false;
        const accepted = operations.observeExecution({ actionId: 'machines.managed.delete', input, actionRequestId: 'control',
            execute: async context => {
                const execution = test.driver.execute('machines.managed.delete', input, { requestId: 'control', context, signal: context.signal });
                work = execution.then(value => ({ value }), error => ({ error }));
                try { return { ok: true, result: await execution }; } finally { finished = true; }
            } });
        try {
            await accepted;
            while (test.reports.length < 1 && !finished) await new Promise<void>(resolve => setImmediate(resolve));
            expect(finished).toBe(false);
            // Let the real private/native custody return and install its wait subscription.
            await new Promise<void>(resolve => setImmediate(resolve));
            if (ending === 'cancel') {
                expect(await operations.handlers.cancel({ operationId: 'observed-delete-1' })).toMatchObject({ kind: 'requested' });
                expect(await work).toMatchObject({ error: { code: 'cancelled' } });
            } else if (ending === 'manual-check') {
                Object.assign(observation, { observedAt: Date.now() + 1, availability: 'absent', power: 'unknown' });
                await operations.observeExecution({ actionId: 'machines.managed.inspect', input: { homeId: machine.homeId, managedId: machine.id },
                    actionRequestId: 'check-now', execute: async context => ({ ok: true,
                        result: await test.driver.execute('machines.managed.inspect', { homeId: machine.homeId, managedId: machine.id },
                            { requestId: 'check-now', context, signal: context.signal }) }) });
                expect(await work).toMatchObject({ value: { kind: 'accepted' } });
                expect(await operations.handlers.getV2({ operationId: 'observed-delete-1', waitForTerminal: true }))
                    .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
            } else if (ending === 'operation-failure') {
                Reflect.deleteProperty(nativeResult, 'nativeOperationRef');
                Object.assign(nativeResult, { kind: 'refused', code: 'native_delete_blocked' });
                await vi.advanceTimersByTimeAsync(5_000);
                expect(await work).toMatchObject({ error: { code: 'native_delete_blocked' } });
                expect(await operations.handlers.getV2({ operationId: 'observed-delete-1', waitForTerminal: true }))
                    .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'native_delete_blocked' } } });
            } else {
                Object.assign(observation, { observedAt: Date.now() + 5_000, availability: 'unavailable', power: 'unknown', reason: 'credential_unavailable',
                    nativeCause: { httpStatusClass: '4xx' } });
                await vi.advanceTimersByTimeAsync(5_000);
                expect(await work).toMatchObject({ error: { code: 'credential_unavailable',
                    details: { kind: 'managedNative', nativeCause: { httpStatusClass: '4xx' } } } });
                expect(await operations.handlers.getV2({ operationId: 'observed-delete-1', waitForTerminal: true }))
                    .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'credential_unavailable' } } });
            }
            const reads = test.reports.length;
            expect(test.nativeInputs.filter(input => input && typeof input === 'object' && 'resource' in input)).toEqual([{ resource: {} }]);
            await vi.advanceTimersByTimeAsync(180_000);
            expect(test.reports).toHaveLength(reads);
            if (ending === 'cancel' || ending === 'typed-failure') expect(test.readMachine().submittedNativeEffect).toMatchObject({ intent: 'delete' });
        } finally {
            await operations.handlers.cancel({ operationId: 'observed-delete-1' });
            await work;
        }
    });
    it.each(['resource', 'native-operation', 'pending-cleanup'] as const)('automatically settles accepted asynchronous Delete with bounded exact reads and no fires after settlement (%s)', async path => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const observation: ProviderObservationV1 = { observedAt: Date.now(), availability: 'present', power: 'running' };
        const nativeResult: ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse> = path === 'native-operation'
            ? { kind: 'accepted', nativeOperationRef: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} } }
            : { kind: 'pending' };
        if (path === 'pending-cleanup') Object.assign(observation, { availability: 'unavailable', power: 'unknown', reason: 'native_cleanup_incomplete' });
        if (path === 'native-operation') Object.assign(observation, { availability: 'unavailable', power: 'unknown', reason: 'native_cleanup_unconfirmed' });
        const test = setup(undefined, nativeResult, 'delete', observation, undefined, undefined, true);
        const machine = test.readMachine();
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'async-delete' });
        const input = { homeId: machine.homeId, managedId: machine.id, intent: 'delete', when: 'now',
            expectedRevision: machine.intentRevision, reviewedDependencies: true };
        let finished = false;
        let work: ReturnType<typeof test.driver.execute> | undefined;
        const accepted = operations.observeExecution({ actionId: 'machines.managed.delete', input, actionRequestId: 'control',
            execute: async context => {
                work = test.driver.execute('machines.managed.delete', input, { requestId: 'control', context, signal: context.signal });
                try { return { ok: true, result: await work }; } finally { finished = true; }
            } });
        try {
            await accepted;
            while (test.reports.length < 1 && !finished) await new Promise<void>(resolve => setImmediate(resolve));
            expect(finished).toBe(false);
            expect(test.readMachine().allocation).toBe('bound');
            expect(test.effects).toEqual(['destroy']);
            await expect(operations.observeExecution({ actionId: 'machines.managed.delete', input, actionRequestId: 'control',
                execute: async () => { throw new Error('Duplicate Delete owner'); } })).resolves.toMatchObject({ ok: true });
            await vi.advanceTimersByTimeAsync(4_999);
            expect(test.reports).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(1);
            while (test.reports.length < 2 && !finished) await new Promise<void>(resolve => setImmediate(resolve));
            expect(test.reports).toHaveLength(2);
            let reads = 2;
            let nextInterval = 10_000;
            if (path === 'resource') {
                // CD33 reuses the entire CD32 cadence and has no 180-second boot/cleanup deadline.
                for (const interval of [10_000, 20_000, 40_000, 60_000, 60_000]) {
                    await vi.advanceTimersByTimeAsync(interval - 1);
                    expect(test.reports).toHaveLength(reads);
                    await vi.advanceTimersByTimeAsync(1);
                    reads += 1;
                    while (test.reports.length < reads && !finished) await new Promise<void>(resolve => setImmediate(resolve));
                    expect(test.reports).toHaveLength(reads);
                    expect(finished).toBe(false);
                }
                nextInterval = 60_000;
            }
            Object.assign(observation, { observedAt: Date.now() + nextInterval, availability: 'absent', power: 'unknown' });
            if (path === 'native-operation') {
                Reflect.deleteProperty(nativeResult, 'nativeOperationRef');
                Object.assign(nativeResult, { kind: 'confirmed' });
            }
            await vi.advanceTimersByTimeAsync(nextInterval - 1);
            expect(test.reports).toHaveLength(reads);
            await vi.advanceTimersByTimeAsync(1);
            await work;
            expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
            expect(await operations.handlers.getV2({ operationId: 'async-delete', waitForTerminal: true }))
                .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
            expect(test.nativeInputs.filter(input => input && typeof input === 'object' && 'resource' in input)).toEqual([{ resource: {} }]);
            expect(test.reports).toHaveLength(reads + 1);
            await vi.advanceTimersByTimeAsync(180_000);
            expect(test.reports).toHaveLength(reads + 1);
        } finally {
            await operations.handlers.cancel({ operationId: 'async-delete' });
            await work?.catch(() => undefined);
        }
    });
    it.each(['unknown', 'refused'] as const)('retries %s native Delete once under a fresh admission and settles receipts honestly', async first => {
        const nativeResult: ReturnType<typeof MachineProvisionerPowerResultV1Schema.parse> = first === 'refused'
            ? { kind: 'refused', code: 'native_delete_refused' } : { kind: 'unknown' };
        const observation: ProviderObservationV1 = { observedAt: 10, availability: 'present', power: 'stopped' };
        const test = setup(undefined, nativeResult, 'delete', observation);
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/report-intent')) {
                const report = ManagedControllerIntentReportV1Schema.parse(body);
                const current = test.readMachine();
                const pending = current.submittedNativeEffect!;
                if (doesManagedNativeObservationSettleIntent(pending.intent, report.observation, current.observation,
                    current.intentRevision > pending.intentRevision && current.desired === 'delete'
                        && current.allocation === 'bound' && !current.nativeOperationRef)) {
                    test.setMachine({ submittedNativeEffect: undefined });
                }
            }
            return await home(url, body, config);
        });
        let nextOperation = 0;
        const operations = createHostActionOperationRuntime({ machineId: test.readMachine().controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `delete-${++nextOperation}` });
        const execute = async (requestId: string) => {
            const machine = test.readMachine();
            const input = { homeId: machine.homeId, managedId: machine.id, expectedRevision: machine.intentRevision,
                intent: 'delete' as const, when: 'now' as const, reviewedDependencies: true };
            let work: ReturnType<typeof test.driver.execute> | undefined;
            await operations.observeExecution({ actionId: 'machines.managed.delete', input, actionRequestId: requestId,
                execute: async context => {
                    work = test.driver.execute('machines.managed.delete', input, { requestId, context, signal: context.signal });
                    const result = await work;
                    const failure = ActionExecuteFailureSchema.safeParse(result);
                    return failure.success ? failure.data : { ok: true, result };
                } });
            await work;
        };
        if (first === 'refused') await expect(execute('control')).rejects.toMatchObject({ code: 'native_delete_refused' });
        else await execute('control');
        expect(test.effects).toEqual(['destroy']);
        expect(await operations.handlers.getV2({ operationId: 'delete-1' }))
            .toMatchObject({ kind: 'found', operation: first === 'refused'
                ? { state: 'failed', error: { errorCode: 'native_delete_refused' } }
                : { state: 'running', observation: { kind: 'outcome_uncertain' } } });
        test.setMachine({ intentRevision: 2 });
        Reflect.deleteProperty(nativeResult, 'code');
        Object.assign(nativeResult, { kind: 'confirmed' });
        observation.observedAt = 20;
        await execute('fresh-delete');
        expect(test.effects).toEqual(['destroy', 'destroy']);
        expect(test.nativeInputs).toEqual([{ resource: {} }, { resource: {} }]);
        expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
        for (const operationId of ['delete-1', 'delete-2']) {
            expect(await operations.handlers.getV2({ operationId, waitForTerminal: true }))
                .toMatchObject({ kind: 'found', operation: { state: first === 'refused' && operationId === 'delete-1' ? 'failed' : 'succeeded' } });
        }
    });
    it.each(['present', 'canceled', 'absent', 'canceled-absent', 'unavailable', 'same-admission'] as const)(
        'retries a fresh Delete after uncertain delivery with %s native state', async state => {
        const canceled = state === 'canceled' || state === 'canceled-absent';
        const absent = state === 'absent' || state === 'canceled-absent';
        const observation = { observedAt: 20, availability: absent ? 'absent' as const
            : state === 'unavailable' ? 'unavailable' as const : 'present' as const };
        const test = setup(undefined, { kind: 'confirmed' }, 'delete', observation);
        const original = test.readMachine();
        test.setMachine({ intentRevision: state === 'same-admission' ? 1 : 2,
            ...(canceled ? { creationState: 'canceled' as const, enrolledMachineId: undefined } : {}),
            observation: { observedAt: 10, availability: 'present' },
            submittedNativeEffect: { intentRevision: 1, requestId: 'old-delete', intent: 'delete', controller: original.controller } });
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/report-intent')) {
                const report = ManagedControllerIntentReportV1Schema.parse(body);
                const current = test.readMachine();
                const pending = current.submittedNativeEffect!;
                if (doesManagedNativeObservationSettleIntent(pending.intent, report.observation, current.observation,
                    current.intentRevision > pending.intentRevision && current.desired === 'delete'
                        && current.allocation === 'bound' && !current.nativeOperationRef)) {
                    test.setMachine({ submittedNativeEffect: undefined });
                }
            }
            return await home(url, body, config);
        });
        const operations = createHostActionOperationRuntime({ machineId: original.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'retry-delete' });
        const input = { homeId: original.homeId, managedId: original.id, expectedRevision: test.readMachine().intentRevision,
            intent: 'delete' as const, when: 'now' as const, reviewedDependencies: true };
        let work: ReturnType<typeof test.driver.execute> | undefined;
        await operations.observeExecution({ actionId: 'machines.managed.delete', input, actionRequestId: 'control',
            execute: async context => {
                work = test.driver.execute('machines.managed.delete', input, { requestId: 'control', context, signal: context.signal });
                const result = await work;
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : { ok: true, result };
            } });
        await work;
        if (state === 'unavailable' || state === 'same-admission') {
            expect(test.effects).toEqual([]);
            expect(test.readMachine().submittedNativeEffect).toMatchObject({ requestId: 'old-delete' });
            expect(await operations.handlers.getV2({ operationId: 'retry-delete' }))
                .toMatchObject({ kind: 'found', operation: { state: 'running', observation: { kind: 'outcome_uncertain' } } });
        } else {
            expect(test.reports).toMatchObject(absent
                ? [{ expectedIntentRevision: 1, observation: { availability: 'absent' } }]
                : [{ expectedIntentRevision: 1, observation: { availability: 'present' } },
                    { expectedIntentRevision: 2, result: { kind: 'confirmed' } }]);
            expect(test.effects).toEqual(absent ? [] : ['destroy']);
            expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
            expect(test.readMachine().submittedNativeEffect).toBeUndefined();
            expect(await operations.handlers.getV2({ operationId: 'retry-delete', waitForTerminal: true }))
                .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        }
    });
    it.each([
        { phase: 'same-invocation', pending: false },
        { phase: 'later-inspection', pending: false },
        { phase: 'later-inspection', pending: true },
    ] as const)('settles the original Delete operation after exact absence through $phase (pending=$pending)', async ({ phase, pending }) => {
        const observation = { observedAt: 123, availability: phase === 'same-invocation' ? 'absent' as const : 'unavailable' as const,
            ...(phase === 'later-inspection' ? { reason: 'transport' } : {}) };
        const cleanup: { kind: 'unknown' | 'confirmed' } = { kind: 'unknown' };
        const test = setup(undefined, phase === 'same-invocation'
            ? { kind: 'unknown', code: 'native_request_failed', nativeCause: { httpStatusClass: '4xx', code: 'conflict' } }
            : { kind: 'unknown' }, 'delete', observation, undefined, undefined, pending,
            pending ? cleanup : undefined);
        if (pending) test.setMachine({ allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} } });
        const machine = test.readMachine();
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'confirmed-delete' });
        const input = { homeId: machine.homeId, managedId: machine.id, intent: 'delete', when: 'now',
            expectedRevision: machine.intentRevision, reviewedDependencies: true };
        let work: ReturnType<typeof test.driver.execute> | undefined;
        await operations.observeExecution({ actionId: 'machines.managed.delete', input, actionRequestId: 'control',
            execute: async context => {
                work = test.driver.execute('machines.managed.delete', input, { requestId: 'control', context, signal: context.signal });
                const result = await work;
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : { ok: true, result };
            } });
        await work;
        if (phase === 'later-inspection') {
            expect(await operations.handlers.getV2({ operationId: 'confirmed-delete' })).toMatchObject({ kind: 'found',
                operation: { state: 'running', observation: { kind: 'outcome_uncertain' } } });
            Object.assign(observation, { observedAt: 124, availability: 'absent' });
            cleanup.kind = 'confirmed';
            await operations.observeExecution({ actionId: 'machines.managed.inspect', input: {
                homeId: machine.homeId, managedId: machine.id,
            }, actionRequestId: 'check-now', execute: async context => ({ ok: true,
                result: await test.driver.execute('machines.managed.inspect', { homeId: machine.homeId, managedId: machine.id },
                    { requestId: 'check-now', context, signal: context.signal }) }) });
        }
        expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        expect(await operations.handlers.getV2({ operationId: 'confirmed-delete' })).toMatchObject({ kind: 'found',
            operation: { state: 'succeeded', settledAt: expect.any(Number),
                result: { kind: 'accepted', managedId: machine.id, operation: { operationId: 'confirmed-delete' } } } });
        expect(test.effects.filter(role => role === 'destroy')).toEqual(['destroy']);
    });

    it.each(['running', 'stopped'] as const)('settles the original uncertain Start operation on later %s observation without replay', async power => {
        const observation: ProviderObservationV1 = { observedAt: 123, availability: 'unavailable', reason: 'transport' };
        const test = setup(undefined, { kind: 'unknown', code: 'transport' }, 'start', observation);
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/report-intent')) {
                const report = ManagedControllerIntentReportV1Schema.parse(body);
                const current = test.readMachine();
                if (current.submittedNativeEffect && doesManagedNativeObservationSettleIntent(current.submittedNativeEffect.intent,
                    report.observation, current.observation)) test.setMachine({ submittedNativeEffect: undefined });
            }
            return await home(url, body, config);
        });
        const machine = test.readMachine();
        const operations = createHostActionOperationRuntime({ machineId: machine.controller!.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'uncertain-start' });
        const input = { homeId: machine.homeId, managedId: machine.id, intent: 'start', when: 'now', expectedRevision: 1 };
        test.setMachine({ submittedNativeEffect: { intentRevision: 1, requestId: 'control', intent: 'start', controller: machine.controller } });
        await operations.observeExecution({ actionId: 'machines.managed.power.set', input, actionRequestId: 'control',
            execute: async context => {
                context.operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: machine.id,
                    controller: machine.controller, resource: machine.resource } });
                return { ok: false, errorCode: 'action_outcome_unknown', error: 'action_outcome_unknown' };
            } });
        expect(await operations.handlers.getV2({ operationId: 'uncertain-start' })).toMatchObject({ kind: 'found',
            operation: { state: 'running', observation: { kind: 'outcome_uncertain' } } });
        Object.assign(observation, { observedAt: 124, availability: 'present', power });
        await operations.observeExecution({ actionId: 'machines.managed.inspect', input: {}, actionRequestId: 'inspect',
            execute: async context => ({ ok: true, result: await test.driver.execute('machines.managed.inspect',
                { homeId: machine.homeId, managedId: machine.id }, { requestId: 'inspect', context, signal: context.signal }) }) });
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        expect(await operations.handlers.getV2({ operationId: 'uncertain-start' })).toMatchObject({ kind: 'found',
            operation: { state: power === 'running' ? 'succeeded' : 'failed', settledAt: expect.any(Number),
                ...(power === 'stopped' ? { error: { errorCode: 'native_intent_unconfirmed' } } : {}) } });
        expect(test.effects.filter(role => role === 'power')).toEqual([]);
    });

    it.each([
        { actionId: 'machines.managed.acquire', confirmed: true },
        { actionId: 'machines.managed.bootstrap.retry', confirmed: true },
        { actionId: 'machines.managed.acquire', confirmed: false },
    ] as const)('native Delete (confirmed=$confirmed) ends only confirmed $actionId isolation approval waits', async ({ actionId, confirmed }) => {
        const test = setup(undefined, confirmed ? { kind: 'confirmed' } : { kind: 'unknown' }, 'delete',
            confirmed ? undefined : { observedAt: 123, availability: 'unavailable', reason: 'transport' });
        const machine = test.readMachine();
        const http = createServer((_request, response) => {
            // This Home does not advertise optional Artifact query hints.
            response.writeHead(404);
            response.end();
        });
        const server = new Server(http, { path: '/v1/updates/' });
        const connected = new Promise<void>(resolve => server.once('connection', () => resolve()));
        const disconnected = new Promise<void>(resolve => server.once('connection', socket => socket.once('disconnect', () => resolve())));
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing approval observation endpoint');
        const serverUrl = `http://127.0.0.1:${address.port}`;
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const expectedOrigin = { actionId: 'machines.agentIsolation.set', requestId: 'isolation', accountId: 'owner',
            serverIdentityId: machine.homeId, machineId: 'guest' };
        const approval = StoredApprovalRequestSchema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: expectedOrigin.actionId, actionArgs: {},
            summary: 'Configure isolation', approval: { flow: 'deferred', result: 'none' },
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                serverId: 'home', ...expectedOrigin } });
        let artifact = { id: 'isolation-approval', ownerAccountId: 'owner', access: 'owner',
            encryptionMode: 'plain', publicAudience: 'none',
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1,
            createdAt: 1, updatedAt: 1 };
        // Only Home's durable Artifact HTTP boundary is substituted. The real
        // Account socket, coordinator, recorded execution and child observer run.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            expect(String(url)).toBe(`${serverUrl}/v1/artifacts/isolation-approval`);
            return { status: 200, data: artifact };
        });
        const postManaged = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, raw, config) => {
            if (String(url) !== `${serverUrl}/v1/artifacts/isolation-approval`) return postManaged(url, raw, config);
            const mutation = ArtifactJsonUpdateHttpInputV1Schema.parse(raw);
            expect(mutation.expectedHeaderVersion).toBe(artifact.headerVersion);
            expect(mutation.expectedBodyVersion).toBe(artifact.bodyVersion);
            artifact = { ...artifact, header: mutation.header ?? artifact.header, body: mutation.body ?? artifact.body,
                headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1 };
            return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
        });
        const harness = createCliActionExecutorHarness({ token, credentials: { token, encryption: null },
            sessionId: 'acquire', serverId: 'home', serverHttpBaseUrl: serverUrl, mode: 'plain', ctx: null });
        let nextId = 0;
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `delete-cancels-acquire-${++nextId}` });
        let acquireSignal: AbortSignal | undefined;
        let waiting: ReturnType<typeof observeManagedChildApprovalExecution> | undefined;
        await operations.observeExecution({ actionId, input: { managedId: machine.id }, actionRequestId: 'acquire', sessionId: 'acquiring-session',
            execute: async context => {
                acquireSignal = context.signal;
                context.operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: machine.id,
                    controller: machine.controller, resource: machine.resource } });
                context.operationAcceptance?.accept({ managedId: machine.id });
                waiting = observeManagedChildApprovalExecution({ context, expectedOrigin, isCurrent: async () => true,
                    execution: { ok: true, result: { kind: 'approval_request_created', artifactId: 'isolation-approval',
                        actionId: expectedOrigin.actionId } }, observeRecordedApprovalExecution: harness.observeRecordedApprovalExecution });
                return await waiting;
            } });
        try {
            await Promise.race([connected, waiting!.then(result => {
                throw new Error(`Child approval settled before observation connected: ${JSON.stringify(result)}`);
            })]);
            expect(await operations.handlers.getV2({ operationId: 'delete-cancels-acquire-1' })).toMatchObject({ kind: 'found',
                operation: { state: 'running', progress: { phase: 'waiting_for_approval', approval: { artifactId: 'isolation-approval' } } } });
            const input = { homeId: machine.homeId, managedId: machine.id, intent: 'delete', when: 'now',
                expectedRevision: machine.intentRevision, reviewedDependencies: true };
            let deleting: ReturnType<typeof test.driver.execute> | undefined;
            await operations.observeExecution({ actionId: 'machines.managed.delete', input, actionRequestId: 'control', sessionId: 'deleting-session',
                execute: async context => {
                    deleting = test.driver.execute('machines.managed.delete', input,
                        { requestId: 'control', context, signal: context.signal });
                    return { ok: true, result: await deleting };
                } });
            await deleting;
            expect(test.effects.filter(role => role === 'destroy')).toEqual(['destroy']);
            if (!confirmed) {
                expect(test.readMachine().allocation).toBe('bound');
                expect(acquireSignal?.aborted).toBe(false);
                expect(await operations.handlers.getV2({ operationId: 'delete-cancels-acquire-1' })).toMatchObject({ kind: 'found',
                    operation: { state: 'running', progress: { phase: 'waiting_for_approval', approval: { artifactId: 'isolation-approval' } } } });
                return;
            }
            expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
            expect(acquireSignal?.aborted).toBe(true);
            await expect(waiting).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
            const settled = await operations.handlers.getV2({ operationId: 'delete-cancels-acquire-1', waitForTerminal: true });
            expect(settled).toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
            if (settled.kind === 'found') {
                expect(settled.operation.progress).not.toHaveProperty('approval');
                expect(settled.operation.progress).not.toMatchObject({ phase: 'waiting_for_approval' });
            }
            await disconnected;
        } finally {
            await operations.handlers.cancel({ operationId: 'delete-cancels-acquire-1' });
            await waiting;
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('settles confirmed complete Delete without requiring another native read', async () => {
        // Confirmed destroy is complete owned-resource cleanup, unlike an
        // accepted command. A later failed read cannot undo that native proof.
        const test = setup(undefined, { kind: 'confirmed' }, 'delete',
            { observedAt: 123, availability: 'unavailable', reason: 'transport' });
        await test.run();
        expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        expect(test.reports).toContainEqual(expect.objectContaining({ result: { kind: 'confirmed' },
            observation: expect.objectContaining({ availability: 'absent' }) }));
    });

    it('settles retired native occurrence custody without a phantom native effect', async () => {
        const test = setup(undefined, undefined, 'start');
        const machine = test.readMachine();
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            const response = await home(url, body, config);
            if (String(url).endsWith('/submit-intent')) test.retireNative();
            return response;
        });
        const input = { homeId: machine.homeId, managedId: machine.id, intent: 'start', when: 'now', expectedRevision: 1 };
        const operations = createHostActionOperationRuntime({ machineId: machine.controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'not-run' });
        let work: ReturnType<typeof test.driver.execute> | undefined;
        await operations.observeExecution({ actionId: 'machines.managed.power.set', input, actionRequestId: 'control',
            execute: async context => {
                work = test.driver.execute('machines.managed.power.set', input, { requestId: 'control', context, signal: context.signal });
                const result = await work;
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : { ok: true, result };
            } });
        const code = 'plugin_action_generation_retired';
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
        const stopped: ProviderObservationV1 = { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' };
        const test = setup(undefined, { kind: 'unknown' }, intent, stopped);
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
        const refused = setup(undefined, refusedResult, intent, stopped, undefined,
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
        { observedAt: 5, availability: 'absent' as const },
        { observedAt: 5, availability: 'present' as const, power: 'stopped' as const, storage: 'lost' as const },
        { observedAt: 5, availability: 'unavailable' as const, reason: 'transport' },
    ])('settles a refused wake with its native observation ($availability)', async observation => {
        const test = setup(undefined, undefined, 'start', observation);
        const machine = test.readMachine();
        await expect(test.driver.execute('machines.managed.power.set', {
            homeId: machine.homeId, managedId: machine.id, intent: 'start', when: 'now', expectedRevision: machine.intentRevision,
        }, test.options)).rejects.toMatchObject({ code: 'provider_unavailable' });
        expect(test.reports).toEqual([expect.objectContaining({
            result: { kind: 'refused', code: 'provider_unavailable' }, observation,
        })]);
        expect(test.readMachine()).toMatchObject({ observation,
            allocation: observation.availability === 'absent' ? 'confirmed-absent' : 'bound' });
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        expect(test.effects).not.toContain('power');
    });
    it.each([
        { boundary: 'admit-control', intent: 'start', action: 'machines.managed.power.set', code: 'database_connection_unavailable' },
        { boundary: 'admit-control', intent: 'start', action: 'machines.managed.power.set', code: 'database_transaction_conflict_exhausted' },
        { boundary: 'admit-control', intent: 'delete', action: 'machines.managed.delete', code: 'database_transaction_conflict_exhausted' },
        { boundary: 'admit-control', intent: 'rebuild', action: 'machines.managed.rebuild', code: 'database_transaction_conflict_exhausted' },
        { boundary: 'submit-intent', intent: 'start', action: 'machines.managed.power.set', code: 'database_connection_unavailable' },
        { boundary: 'submit-intent', intent: 'delete', action: 'machines.managed.delete', code: 'request_conflict' },
    ] as const)('retains the managed target through $action $boundary $code', async ({ boundary, intent, action, code }) => {
        const test = setup(undefined, undefined, intent);
        const machine = test.readMachine();
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => String(url).endsWith(`/${boundary}`)
            ? { status: code === 'request_conflict' ? 409 : 503, data: { error: code } }
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
        if (code === 'request_conflict') {
            await expect(observed).resolves.toMatchObject({ ok: true, result: { kind: 'accepted', managedId: machine.id } });
            await expect(work).rejects.toMatchObject({ code, status: 409 });
        } else if (boundary === 'admit-control' && !uncertainAdmission) {
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
        if (uncertainAdmission || boundary === 'submit-intent' && code !== 'request_conflict') {
            await expect(work).resolves.toMatchObject({ failureCause: { phase: `managed.controller.${boundary.replaceAll('-', '_')}`, errorCode: code },
                details: { requestId: expect.any(String) } });
        }
        expect(test.effects).toEqual([]);
        expect(ActionOperationGetV1ResponseSchema.parse(await operations.handlers.getV2({ operationId: `unavailable-${boundary}` })))
            .toMatchObject({ kind: 'found', operation: {
                domainRef: { kind: 'managedMachine', id: machine.id },
                ...(boundary === 'submit-intent' && code !== 'request_conflict' || uncertainAdmission
                    ? { state: 'running', observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' } }
                    : { state: 'failed', error: { errorCode: code } }),
            } });
        expect(snapshots[0]).toMatchObject({ state: 'accepted', domainRef: { kind: 'managedMachine', id: machine.id } });
        for (const snapshot of snapshots) {
            expect(snapshot.domainRef).toMatchObject({ kind: 'managedMachine', id: machine.id });
        }
    });
    it('finishes its admitted unused Stop when Home publishes the policy intent before native submission', async () => {
        const test = setup({ kind: 'idle', since: Date.now() - 60_000 }, undefined, 'stop');
        test.setMachine({ desired: 'start', retention: { kind: 'unused', afterMs: 60_000, effect: 'stop' },
            observation: { observedAt: Date.now(), availability: 'present', power: 'running', storage: 'retained' } });
        const machine = test.readMachine();
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
            generateOperationId: () => 'policy-stop' });
        let finished = false;
        let admitted = false;
        const failures: unknown[] = [];
        const home = test.post.getMockImplementation()!;
        // Home's row push is delivered after admission persists Stop, before the
        // same response resumes native submission. The driver and scheduler stay real.
        test.post.mockImplementation(async (url, body, config) => {
            const response = await home(url, body, config);
            if (String(url).endsWith('/admit-policy')) {
                admitted = true;
                await runtime.notifyChanged();
            }
            return response;
        });
        const runtime = createDaemonManagedMachinePolicyRuntime({
            // Census, guest registration and native provider IO are system boundaries.
            loadMachine: async id => ({ id, encryptionMode: 'plain', active: true, metadata: null, metadataVersion: 0,
                daemonState: { status: 'running' }, daemonStateVersion: 1 }),
            readCensus: async () => ({ machines: [test.readMachine()], targets: [],
                ...(admitted ? { retentionContinuations: [{ managedId: machine.id, requestId: 'control' }] } : {}) }),
            executePolicy: async request => operations.observeExecution({ actionId: 'machines.managed.power.set', input: {},
                actionRequestId: 'control', execute: async operation => {
                    const context = { ...operation, signal: request.signal };
                    try {
                        return { ok: true, result: await test.driver.executePolicy(request.machine, request.purpose, {
                            requestId: 'control', context, signal: request.signal,
                            runPolicyAction: (preview, runApproved) => executeManagedMachinePolicyAction({
                                machine: preview, purpose: request.purpose, context, runApproved, serverId: machine.homeId,
                                createExecutor: overrides => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...overrides }),
                            }),
                        }) };
                    } catch (error) {
                        failures.push(error);
                        return { ok: false, errorCode: request.signal?.aborted ? 'cancelled' : 'policy_failed', error: 'Policy failed' };
                    } finally { finished = true; }
                } }),
        });
        try {
            await runtime.notifyChanged();
            await vi.waitFor(() => expect(finished).toBe(true));
            expect(failures).toEqual([]);
            expect(await operations.handlers.getV2({ operationId: 'policy-stop' })).toMatchObject({ kind: 'found',
                operation: { state: 'succeeded' } });
            expect(test.effects).toEqual(['power']);
            expect(test.nativeInputs).toContainEqual({ resource: machine.resource!.value, intent: 'stop' });
            expect(test.post.mock.calls.filter(([url]) => String(url).endsWith('/admit-policy'))).toHaveLength(1);
        } finally { await runtime.stop(); }
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
    it.each(['idle', 'configured-stop', 'configured-suspend', 'busy', 'unknown', 'activity-unavailable', 'missing-confirmation', 'approval-held', 'approval-approved', 'approval-rejected', 'approval-observation-failed',
        'within-window', 'refused-reopen', 'lost-probe-reply', 'aborted-probe'] as const)(
        'settles retention power with configured consent or its required review (%s)', async disposition => {
        vi.useFakeTimers({ toFake: disposition === 'unknown' ? ['Date', 'setTimeout', 'clearTimeout'] : ['Date'] });
        vi.setSystemTime(1_790_000_000_000);
        const intent = disposition === 'configured-suspend' ? 'suspend' : 'stop';
        const test = setup(undefined, undefined, intent);
        test.setMachine({ desired: 'start', retention: disposition.startsWith('approval-')
            ? { kind: 'deadline', at: Date.now(), effect: 'stop' }
            : { kind: 'unused', afterMs: 3_600_000, effect: 'stop' } });
        const machine = test.readMachine();
        const nativeController = machine.controller;
        if (!nativeController) throw new Error('The native fixture requires its installed controller.');
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/prepare-policy')) return { status: 200, data: ManagedPolicyAdmissionOutputV1Schema.parse({
                requestId: ManagedPolicyAdmissionInputV1Schema.parse(body).requestId, replayed: false,
                machine: { ...test.readMachine(), desired: intent, desiredWhen: 'now' },
            }) };
            if (String(url).endsWith('/admit-policy')) {
                const response = await home(url, body, config);
                if (!response || typeof response !== 'object' || !('data' in response)
                    || !response.data || typeof response.data !== 'object') throw new Error('Invalid Home admission fixture');
                test.setMachine({ desired: intent });
                return { ...response, data: { ...response.data, machine: test.readMachine() } };
            }
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
            } },
            commitIdleEvidence: (_target, idle) => signedIdle(test.readMachine(), idle.since, Date.now()) });
        const call = async (current: typeof machine, method: string, action?: 'begin' | 'resume') => {
            const handler = handlers.get(method);
            if (!handler) throw new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND);
            return ManagedActivityBridgeResultV1Schema.parse(await handler({ homeId: current.homeId,
                managedId: current.id, expectedRevision: current.intentRevision, controller: current.controller,
                ...(action ? { action } : {}) }, context));
        };
        const readGuestActivity = vi.fn((current: typeof machine) => call(current, MANAGED_ACTIVITY_READ_RPC_METHOD));
        const bridge = { read: async (current: typeof machine) => {
                if (disposition === 'activity-unavailable') throw new RpcError('Guest offline', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE);
                const result = await readGuestActivity(current);
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
                        ...(disposition.startsWith('approval-') || disposition.startsWith('configured-') ? {
                            runPolicyAction: (preview, runApproved) => executeManagedMachinePolicyAction({
                                machine: preview, purpose: { kind: 'retention' }, runApproved, serverId: 'home',
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
                        : readRpcErrorCode(error) ?? (error instanceof ManagedMachineControllerError ? error.code : 'drain_failed') }; }
                    finally { settled = true; }
                } });
            while (!settled) {
                if ((disposition.startsWith('approval-') || disposition.startsWith('configured-')) && storedApproval) break;
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
            } else if (disposition.startsWith('configured-')) {
                expect(storedApproval).toBeUndefined();
                await observed;
                await expect(controller.handlers.getV2({ operationId: 'unused-stop', waitForTerminal: true }))
                    .resolves.toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
                expect(test.effects).toEqual(['power']);
                expect(test.nativeInputs).toContainEqual({ resource: machine.resource!.value, intent });
                expect(test.post.mock.calls.filter(([url]) => String(url).endsWith('/admit-policy'))).toHaveLength(1);
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
                // Absolute-deadline effects retain review but do not drain guest work.
                expect(drain.isQuiescing()).toBe(false);
            } else if (disposition === 'unknown') {
                await expect(controller.handlers.getV2({ operationId: 'unused-stop' })).resolves.toMatchObject({ kind: 'found', operation: {
                    state: 'running', progress: { phase: 'managed.intent.activity-unknown' },
                } });
                expect(drain.isQuiescing()).toBe(false);
                await vi.advanceTimersByTimeAsync(3_600_000);
                expect(readGuestActivity).toHaveBeenCalledTimes(1);
                expect(test.effects).toEqual([]);
                expect(test.post.mock.calls.some(([url]) => String(url).endsWith('/admit-policy'))).toBe(false);
                missingCoverage = false;
                guestWork.notifyChanged();
                await vi.waitFor(async () => {
                    expect(readGuestActivity).toHaveBeenCalledTimes(2);
                    expect(await controller.handlers.getV2({ operationId: 'unused-stop' })).toMatchObject({ kind: 'found', operation: {
                        state: 'running', progress: { phase: 'managed.intent.waiting-idle' },
                    } });
                });
                expect(test.effects).toEqual([]);
                await vi.advanceTimersByTimeAsync(3_600_000);
                await observed;
                await expect(controller.handlers.getV2({ operationId: 'unused-stop' })).resolves.toMatchObject({ kind: 'found', operation: {
                    state: 'succeeded',
                } });
                expect(test.effects).toEqual(['power']);
            } else if (disposition === 'activity-unavailable') {
                await expect(controller.handlers.getV2({ operationId: 'unused-stop' })).resolves.toMatchObject({ kind: 'found', operation: {
                    state: 'failed', error: { errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE } } });
                expect(test.effects).toEqual([]);
                expect(test.post.mock.calls.some(([url]) => String(url).endsWith('/admit-policy'))).toBe(false);
                await observed;
            } else if (disposition === 'busy') {
                await expect(controller.handlers.getV2({ operationId: 'unused-stop' })).resolves.toMatchObject({ kind: 'found', operation: {
                    state: 'running', progress: { phase: 'managed.intent.busy' } } });
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
    it.each(['stop', 'suspend'] as const)('reconciles a Home-owned submitted %s without enrollment or repeating its native effect', async intent => {
        const observation = { observedAt: 10, availability: 'present' as const,
            power: intent === 'stop' ? 'stopped' as const : 'suspended' as const, storage: 'retained' as const };
        const test = setup(undefined, undefined, intent, observation);
        const original = test.readMachine();
        test.setMachine({ enrolledMachineId: undefined, retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' },
            submittedNativeEffect: { intentRevision: original.intentRevision, requestId: 'control', intent, controller: original.controller } });
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/admit-policy')) return { status: 200,
                data: { machine: test.readMachine(), requestId: 'control', replayed: true } };
            const response = await home(url, body, config);
            if (String(url).endsWith('/report-intent')) {
                const report = ManagedControllerIntentReportV1Schema.parse(body);
                if (doesManagedNativeObservationSettleIntent(intent, report.observation)) {
                    test.setMachine({ submittedNativeEffect: undefined });
                    return { status: 200, data: { machine: test.readMachine() } };
                }
            }
            return response;
        });
        await expect(test.driver.executePolicy(test.readMachine(), { kind: 'retention' }, {
            ...test.options, retentionContinuationRequestId: 'control',
        })).resolves.toMatchObject({ kind: 'accepted', managedId: original.id });
        // This testkit records effectful roles separately from native inspection.
        expect(test.effects).toEqual([]);
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'unknown' }, observation })]);
        expect(test.readActivity).not.toHaveBeenCalled();
        expect(test.readMachine()).toMatchObject({ observation, submittedNativeEffect: undefined });
    });
    it.each(['delete', 'stop', 'suspend'] as const)('does not let a submitted manual %s bypass unused retention evidence', async intent => {
        const test = setup(undefined, undefined, 'start');
        const machine = test.readMachine();
        test.setMachine({ desired: intent, enrolledMachineId: undefined, retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' },
            submittedNativeEffect: { intentRevision: machine.intentRevision, requestId: 'manual-control', intent, controller: machine.controller } });
        const result = await test.driver.executePolicy(test.readMachine(), { kind: 'retention' }, test.options).catch((error: unknown) => error);
        expect(test.post.mock.calls.filter(([url]) => String(url).endsWith('/prepare-policy'))).toHaveLength(0);
        expect(result).toMatchObject({ code: 'admission_unavailable' });
        expect(test.effects).toEqual([]);
        expect(test.readActivity).not.toHaveBeenCalled();
    });
    it.each(['delete', 'stop', 'suspend'] as const)('does not prepare retention during an unsubmitted manual %s', async intent => {
        const test = setup(undefined, undefined, 'start');
        test.setMachine({ desired: intent, retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' } });
        const result = await test.driver.executePolicy(test.readMachine(), { kind: 'retention' }, test.options).catch((error: unknown) => error);
        expect(test.post.mock.calls.filter(([url]) => String(url).endsWith('/prepare-policy'))).toHaveLength(0);
        expect(result).toMatchObject({ code: 'admission_unavailable' });
        expect(test.effects).toEqual([]);
        expect(test.readActivity).not.toHaveBeenCalled();
    });
    it.each([0, 12345])('deletes a parked guest only after its admitted source ends and drains (%s ms)', async afterMs => {
        const test = setup(undefined, undefined, 'delete');
        const scope = { effect: 'delete' as const, source: { kind: 'session' as const, sessionId: 'birth' } };
        test.setMachine({ desired: 'stop', retention: { kind: 'unused', effect: 'delete', afterMs }, creationScopeRetention: scope });
        await expect(test.driver.executePolicy(test.readMachine(), { kind: 'retention' }, test.options))
            .rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(test.effects).toEqual([]);
        expect(test.readActivity).not.toHaveBeenCalled();
        test.setMachine({ creationScopeRetention: { ...scope, endedAt: Date.now() } });
        const busy = createDeferred<void>();
        const drain = createDeferred<'activity'>();
        test.readActivity.mockImplementationOnce(async () => ({ kind: 'busy', reasons: ['finite'] }));
        test.waitForChange.mockImplementationOnce(async () => { busy.resolve(); return await drain.promise; });
        const work = test.driver.executePolicy(test.readMachine(), { kind: 'retention' }, test.options);
        await busy.promise;
        expect(test.effects).toEqual([]);
        expect(test.post.mock.calls.some(([url]) => String(url).endsWith('/admit-policy'))).toBe(false);
        drain.resolve('activity');
        await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
        expect(test.effects).toEqual(['destroy']);
        expect(test.readMachine().allocation).toBe('confirmed-absent');
    });
    it('keeps an explicit after-idle control failure when its guest target becomes unavailable', async () => {
        const test = setup();
        test.setMachine({ desiredWhen: 'after-idle' });
        test.readActivity.mockRejectedValue(new RpcError('RPC target unavailable', 'target_unavailable'));
        await expect(test.run()).rejects.toMatchObject({ rpcErrorCode: 'target_unavailable' });
        expect(test.effects).toEqual([]);
        expect(test.waitForChange).not.toHaveBeenCalled();
    });
    it.each(['ordinary', 'bound-live', 'bound-delay'] as const)(
        'refuses unenrolled unused retention without an ended immediate Session scope before opening its activity socket (%s)', async kind => {
        const test = setup();
        test.setMachine({ enrolledMachineId: undefined,
            retention: { kind: 'unused', afterMs: kind === 'bound-live' ? 0 : 60_000, effect: 'delete' },
            ...(kind === 'ordinary' ? {} : { acquisitionMode: 'resource-bound', creationScopeRetention: {
                effect: 'delete', source: { kind: 'session', sessionId: 'source-session' },
                ...(kind === 'bound-delay' ? { endedAt: 1, afterMs: 60_000 } : {}),
            } }),
        });
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
    it('observes bound retained Delete custody without invoking destroy on Check now', async () => {
        const test = setup(undefined, { kind: 'confirmed' }, 'delete', { observedAt: 123, availability: 'absent' }, undefined, undefined, true);
        const machine = test.readMachine();
        test.setMachine({ nativeOperationRef: { contributionRef: machine.resource!.contributionRef,
            schemaVersion: machine.resource!.schemaVersion, value: {} },
            submittedNativeEffect: { intentRevision: machine.intentRevision, requestId: 'control', intent: 'delete',
                controller: machine.controller } });

        await expect(test.driver.execute('machines.managed.inspect', { homeId: machine.homeId, managedId: machine.id }, test.options))
            .resolves.toMatchObject({ machine: { allocation: 'confirmed-absent' } });
        // The canonical custody testkit records effectful roles, not inspection.
        expect(test.effects).toEqual([]);
        expect(test.nativeInputs).toEqual([]);
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'unknown' },
            observation: expect.objectContaining({ availability: 'absent' }) })]);
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
    it.each(['confirmed', 'failed'] as const)('only resumes pending Delete after fresh exact native retry qualification (%s), while inspect remains observational', async ending => {
        const nativeResult: ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse> = { kind: 'unknown' };
        const test = setup(undefined, nativeResult, 'delete', undefined, undefined,
            { kind: 'unknown', recovery: { reference: 'owned-volume', reason: 'native_cleanup_unknown' } }, true, { kind: 'retryable' });
        test.setMachine({ allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} } });
        await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        await test.driver.execute('machines.managed.inspect', { homeId: test.readMachine().homeId, managedId: 'managed' }, test.options);
        expect(test.effects.filter(role => role === 'destroy')).toEqual(['destroy']);
        expect(test.readMachine().submittedNativeEffect).toMatchObject({ requestId: 'control', intentRevision: 1 });
        Object.assign(nativeResult, ending === 'confirmed' ? { kind: 'confirmed' } : { kind: 'unknown', code: 'native_request_failed' });
        if (ending === 'confirmed') {
            await expect(test.run()).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
            expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent' });
        } else {
            await expect(test.run()).rejects.toMatchObject({ code: 'native_request_failed' });
            expect(test.readMachine()).toMatchObject({ allocation: 'may-exist', nativeOperationRef: { value: {} },
                submittedNativeEffect: { intent: 'delete' } });
        }
        expect(test.effects.filter(role => role === 'destroy')).toEqual(['destroy', 'destroy']);
        expect(test.reports.at(-1)).toMatchObject({ requestId: 'control', expectedIntentRevision: 1,
            ...(ending === 'confirmed' ? { result: { kind: 'confirmed' }, observation: { availability: 'absent' } }
                : { result: { kind: 'unknown', code: 'native_request_failed' } }) });
    });
    it('deletes a canceled acquisition only after recovering its exact native resource from correlation', async () => {
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, true);
        test.setMachine({ creationState: 'canceled', allocation: 'may-exist', resource: undefined,
            nativeOperationRef: undefined, enrolledMachineId: undefined,
            cleanup: { disposition: 'pending', reason: 'creation_canceled' } });
        await expect(test.run()).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
        expect(test.effects).toEqual(['reconcile', 'destroy']);
        expect(test.nativeInputs[0]).toMatchObject({ correlation: {
            managedId: 'managed', requestId: 'control', launch: {},
        } });
        expect(test.nativeInputs[1]).toMatchObject({ resource: {} });
        expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent', resource: { value: {} },
            observation: { availability: 'absent' } });
    });
    it.each(['bound', 'unknown', 'pending', 'rejected'] as const)('reconciles a failed acquisition handle before Delete when identity is %s', async kind => {
        const handle = { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1,
            value: { requestId: 'managed' } };
        const resource = { ...handle, value: { guest: 'recovered' } };
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, true, undefined, {
            reconciliationResource: false,
            nativeRoleResults: {
                reconcile: kind === 'bound' ? { kind, resource } : kind === 'pending' ? { kind, nativeOperationRef: handle }
                    : kind === 'rejected' ? { kind, code: 'managed_not_found' }
                        : { kind, recovery: { reference: 'managed', reason: 'native_identity_unavailable' } },
                destroy: body => body && typeof body === 'object' && !Array.isArray(body) && 'resource' in body
                    ? { kind: 'confirmed' } : { kind: 'refused', code: 'invalid_request' },
            },
        });
        test.setMachine({ allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: handle, recovery: { reference: 'managed', reason: 'native_identity_unavailable' } });
        if (kind === 'bound' || kind === 'rejected') {
            await expect(test.run()).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
            expect(test.effects).toEqual(kind === 'bound' ? ['reconcile', 'destroy'] : ['reconcile']);
            if (kind === 'bound') expect(test.nativeInputs[1]).toEqual({ resource: resource.value });
            expect(test.readMachine()).toMatchObject({ allocation: 'confirmed-absent' });
        } else {
            await expect(test.run()).rejects.toMatchObject({ name: 'ManagedMachineControllerError',
                code: kind === 'pending' ? 'native_acquisition_pending' : 'native_identity_unavailable' });
            expect(test.effects).toEqual(['reconcile']);
            expect(test.readMachine()).toMatchObject({ allocation: 'may-exist', nativeOperationRef: handle });
            expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        }
    });
    it('recovers an unbound canceled native operation before entering the shared Delete path', async () => {
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, true);
        const machine = test.readMachine();
        test.setMachine({ creationState: 'canceled', allocation: 'may-exist', resource: undefined,
            nativeOperationRef: { contributionRef: machine.launch.provider, schemaVersion: 1, value: {} }, enrolledMachineId: undefined,
            cleanup: { disposition: 'pending', reason: 'creation_canceled' } });
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            const result = await home(url, body, config);
            if (String(url).endsWith('/report')) test.setMachine({ nativeOperationRef: undefined });
            return result;
        });
        await expect(test.run()).resolves.toMatchObject({ kind: 'accepted', managedId: 'managed' });
        expect(test.effects).toEqual(['reconcile', 'destroy']);
        expect(test.nativeInputs[0]).toMatchObject({ nativeOperation: {} });
        expect(test.nativeInputs[1]).toMatchObject({ resource: {} });
    });
    it.each(['active', 'canceled'] as const)('deletes proven-owned pending native attachments from an %s row without a Machine id', async creationState => {
        const handle = { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} };
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, true, undefined, {
            nativeRoleResults: { reconcile: { kind: 'pending', nativeOperationRef: handle } },
        });
        test.setMachine({ creationState, allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: handle });
        const machine = test.readMachine();
        const work = creationState === 'canceled'
            ? test.driver.executePolicy(machine, { kind: 'creation-cleanup' }, test.options)
            : test.run();
        await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: machine.id });
        expect(test.effects).toEqual(creationState === 'canceled' ? ['reconcile', 'destroy'] : ['destroy']);
        expect(test.nativeInputs.at(-1)).toEqual({ nativeOperation: handle.value });
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
        const handle = { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} };
        const test = setup(undefined, undefined, 'delete', undefined, undefined, undefined, true, undefined, {
            nativeRoleResults: { reconcile: { kind: 'pending', nativeOperationRef: handle } },
        });
        test.setMachine({ creationState: 'canceled', allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
            nativeOperationRef: handle });
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
            expect(test.effects).toEqual(['reconcile', 'destroy']);
            expect(test.nativeInputs.at(-1)).toEqual({ nativeOperation: handle.value });
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
            runPolicyAction: (policyMachine, runApproved) => executeManagedMachinePolicyAction({ machine: policyMachine, purpose: { kind: 'accepted-input-start', target },
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
                // Fresh Inspect already sees running compute; only guest startup remains.
                expect(test.effects).toEqual(['bootstrap']);
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
        expect(test.effects).toEqual(['bootstrap']);
        test.setMachine({ controller: undefined });
        const accountRequest = { ...request, params: { target: { ...target, controller: undefined,
            expectedIntentRevision: test.readMachine().intentRevision }, actionOrigin },
            authorization: ACTION_API_SERVER_ORIGIN };
        expect(await rpc.handleRequest(accountRequest)).toMatchObject({ errorCode: 'admission_unavailable' });
        expect(test.effects).toEqual(['bootstrap']);
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

    it.each(['refused', 'changed'] as const)('preserves bound rebuild identity when pre-bootstrap currentness is %s', async response => {
        const replacement = { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {},
            devcontainerObservation: { nativeResourceId: 'replacement', user: 'coder', workspaceFolder: '/work',
                storage: { kind: 'child' as const, childPath: '/work' } } };
        const test = setup(undefined, undefined, 'rebuild', undefined, undefined, { kind: 'bound', resource: replacement });
        const machine = test.readMachine();
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/report-intent')) {
                const report = ManagedControllerIntentReportV1Schema.parse(body);
                if (report.result.kind === 'bound') {
                    test.reports.push(report);
                    test.setMachine({ resource: report.result.resource, enrolledMachineId: undefined,
                        submittedNativeEffect: undefined, recovery: undefined, observation: undefined });
                    return { status: 200, data: { machine: test.readMachine() } };
                }
            }
            if (String(url).endsWith('/current')) {
                if (response === 'refused') return { status: 403, data: { code: 'permission_denied' } };
                test.setMachine({ intentRevision: 2 });
                return { status: 200, data: { machine: test.readMachine() } };
            }
            return await home(url, body, config);
        });
        const execution = test.driver.execute('machines.managed.rebuild', { homeId: machine.homeId,
            managedMachineId: machine.id, kind: 'rebuild', expectedRevision: machine.intentRevision,
            reviewedEffectDigest: 'reviewed-effects' }, test.options);
        if (response === 'refused') {
            await expect(execution).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown',
                details: { kind: 'managedControllerRequest', category: 'status', status: 403, code: 'permission_denied' } });
        } else {
            await expect(execution).rejects.toMatchObject({ code: 'intent_changed' });
        }
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'bound', resource: replacement } })]);
        expect(test.readMachine()).toMatchObject({ id: machine.id, homeId: machine.homeId, allocation: 'bound', resource: replacement });
        expect(test.readMachine().enrolledMachineId).toBeUndefined();
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
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
            if (path.endsWith('/admit-policy')) {
                admitted = true;
                test.setMachine({ cleanup: { disposition: 'pending', reason: 'delete_requested' } });
                return { status: 200, data: { ...response.data, machine: test.readMachine() } };
            }
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
            ? { kind: 'deadline', at: Date.now() + 3_600_000, effect: 'delete' }
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
    it.each(['busy', 'unknown'] as const)('waits for an activity change before an after-idle native effect (%s)', async kind => {
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
        let settled = false;
        const observed = operations.observeExecution({ actionId: 'machines.managed.delete', input: {}, actionRequestId: 'control',
            execute: async context => {
                work = test.driver.execute('machines.managed.delete', { homeId: machine.homeId, managedId: machine.id,
                    when: 'after-idle', intent: 'delete', reviewedDependencies: true },
                    { requestId: 'control', context, signal: context.signal });
                try { return { ok: true, result: await work }; }
                finally { settled = true; }
            } });
        try {
            while (test.waitForChange.mock.calls.length === 0 && !settled) await new Promise<void>(resolve => setImmediate(resolve));
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
    it.each(['running', 'stopped', 'startup-failed'] as const)('releases accepted input only after vendor wake observation and guest startup (%s)', async outcome => {
        if (outcome === 'stopped') vi.useFakeTimers();
        const observation: ProviderObservationV1 = { observedAt: 1, availability: 'present', power: 'stopped' };
        const inspectedAfterPower = createDeferred();
        let powerApplied = false;
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'confirmed' }, 'start', observation, () => {
            if (!powerApplied) {
                powerApplied = true;
                observation.power = outcome === 'stopped' ? 'stopped' : 'running';
            } else if (outcome === 'startup-failed') {
                throw new Error('The vendor bootstrap transport is unavailable.');
            }
        }, undefined, false, undefined, { onInspect: () => {
            if (powerApplied) inspectedAfterPower.resolve();
        } });
        test.setMachine({ enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });
        const machine = test.readMachine();
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest',
            expectedIntentRevision: machine.intentRevision, controller: machine.controller,
            origin: { kind: 'session-input' as const, session: { homeId: machine.homeId, sessionId: 'session' },
                pendingRequestId: 'pending', requestedAt: 1 }, reason: 'admitted-work' as const };
        const lifetime = new AbortController();
        const work = test.driver.executePolicy(machine, { kind: 'accepted-input-start', target }, { ...test.options, signal: lifetime.signal });
        let settled = false;
        void work.then(() => { settled = true; }, () => { settled = true; });
        try {
            if (outcome === 'running') await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: machine.id });
            else if (outcome === 'startup-failed') {
                await expect(work).rejects.toMatchObject({ code: 'plugin_action_execution_failed' });
                expect(test.readMachine().observation).toMatchObject({ availability: 'present', power: 'running' });
            } else {
                await inspectedAfterPower.promise;
                await vi.advanceTimersByTimeAsync(0);
                expect(settled).toBe(false);
                lifetime.abort();
                await expect(work).rejects.toMatchObject({ code: 'cancelled' });
            }
        } finally {
            lifetime.abort();
            await work.catch(() => undefined);
        }
        expect(test.effects.filter(role => role === 'power')).toEqual(['power']);
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
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'unknown' }, 'start',
            { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
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
        const test = setup({ kind: 'idle', since: 0 }, { kind: 'refused', code: 'native_denied' }, 'start',
            { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' });
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
        test.setMachine({ desired: 'start', retention: { kind: 'unused', afterMs: 1, effect: 'delete' } });
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
    it('dispatches reviewed immediate Delete while guest work is busy without treating uncertain cleanup as absence', async () => {
        const test = setup({ kind: 'busy', reasons: ['finite'] }, { kind: 'unknown' });
        await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        expect(test.effects).toEqual(['destroy']);
        expect(test.readActivity).not.toHaveBeenCalled();
        expect(test.reports).toEqual([expect.objectContaining({ result: { kind: 'unknown' },
            observation: { observedAt: 0, availability: 'present' } })]);
    });
    it('keeps busy work pending and dispatches nothing when canceled before unused-stop', async () => {
        const test = setup({ kind: 'busy', reasons: ['finite'] });
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
        test.setMachine({ desired: 'start', retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' } });
        const machine = test.readMachine();
        const work = test.driver.executePolicy(machine, { kind: 'retention', evidence: signedIdle(machine, 0, Date.now()) }, test.options);
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
    it('does not replay a confirmed power effect when the same admitted request is inspected again', async () => {
        const test = setup(undefined, undefined, 'stop');
        await test.run();
        await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        expect(test.effects).toEqual(['power']);
        expect(test.nativeInputs).toMatchObject([{ intent: 'stop' }]);
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
    it.each([
        { phase: 'idle', response: 'refused' },
        { phase: 'idle', response: 'changed' },
        { phase: 'previous-effect', response: 'refused' },
        { phase: 'previous-effect', response: 'changed' },
    ] as const)('distinguishes Home refusal from changed intent during $phase ($response)', async ({ phase, response }) => {
        const test = setup(undefined, undefined, 'delete', { observedAt: 1, availability: 'present', power: 'stopped' });
        const machine = test.readMachine();
        test.setMachine(phase === 'idle' ? { desiredWhen: 'after-idle' } : {
            intentRevision: 2,
            submittedNativeEffect: { intentRevision: 1, requestId: 'previous-control', intent: 'stop', controller: machine.controller },
        });
        const home = test.post.getMockImplementation()!;
        test.post.mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/current')) return response === 'refused'
                ? { status: 403, data: { code: 'permission_denied' } }
                : { status: 200, data: { machine: { ...test.readMachine(), intentRevision: 3 } } };
            const result = await home(url, body, config);
            if (phase === 'previous-effect' && String(url).endsWith('/report-intent')) {
                test.setMachine({ submittedNativeEffect: undefined });
                return { status: 200, data: { machine: test.readMachine() } };
            }
            return result;
        });
        if (response === 'refused') {
            await expect(test.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown',
                details: { kind: 'managedControllerRequest', category: 'status', status: 403, code: 'permission_denied' } });
        } else {
            await expect(test.run()).rejects.toMatchObject({ code: 'intent_changed' });
        }
        expect(test.effects).toEqual([]);
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        if (phase === 'previous-effect') expect(test.reports).toContainEqual(expect.objectContaining({
            requestId: 'previous-control', result: { kind: 'unknown' },
            observation: { observedAt: 1, availability: 'present', power: 'stopped' },
        }));
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
    it('completes an admitted drain under its captured controller and refuses the next request after withdrawal', async () => {
        const test = setup();
        test.setMachine({ desiredWhen: 'after-idle' });
        const captured = test.readMachine();
        const currentReads = () => test.post.mock.calls.filter(([url]) => String(url).endsWith('/current')).length;
        let readsAtConfirmation = 0;
        test.confirmIdle.mockImplementationOnce(async admitted => {
            expect(admitted.controller).toEqual(captured.controller);
            readsAtConfirmation = currentReads();
            // CD37: withdrawal during the admitted guest read applies to the
            // next request; it does not retroactively revoke this drain.
            test.setMachine({ controller: { machineId: 'moved', installationId: 'other' } });
            return { kind: 'idle', since: 0, evidence: signedIdle(admitted, 0, Date.now()) };
        });
        await expect(test.run()).resolves.toMatchObject({ kind: 'accepted', managedId: captured.id });
        expect(test.effects).toEqual(['destroy']);
        expect(test.reopen).not.toHaveBeenCalled();
        expect(currentReads()).toBe(readsAtConfirmation);
        await expect(test.run()).rejects.toMatchObject({ code: 'controller_unavailable' });
        expect(test.effects).toEqual(['destroy']);
    });
    it.each([false, true])('rechecks installed Account policy after guest work interrupts an approved unused Delete (creation scope: %s)', async scopeEnded => {
        const test = setup();
        test.setMachine({ desired: 'start', retention: { kind: 'unused', afterMs: scopeEnded ? 0 : 1, effect: 'delete' },
            ...(scopeEnded ? { creationScopeRetention: { effect: 'delete' as const, endedAt: Date.now(), source: { kind: 'session' as const, sessionId: 'source' } } } : {}),
        });
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
                return executeManagedMachinePolicyAction({ machine, purpose: { kind: 'retention' }, runApproved, serverId: 'home',
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
    it('cancels the admitted FIN scope locally after asynchronous final idle confirmation without issuing Delete', async () => {
        const test = setup();
        test.setMachine({ desiredWhen: 'after-idle' });
        const machine = test.readMachine();
        let sourceCurrent = true;
        const origin = await finScopeAuthorization(test, () => sourceCurrent);
        const cancellation = new AbortController();
        test.confirmIdle.mockImplementation(async () => {
            // Source withdrawal applies to the next admission. This already
            // admitted executor stops through its actual local cancellation.
            sourceCurrent = false;
            cancellation.abort();
            return { kind: 'idle', since: 0, evidence: signedIdle(machine, 0, Date.now()) };
        });
        const work = test.driver.execute('machines.managed.delete', { homeId: machine.homeId, managedId: machine.id,
            intent: 'delete', when: 'after-idle', reviewedDependencies: true }, { ...test.options, signal: cancellation.signal,
            context: { ...test.options.context, ...origin },
        });
        await expect(work).rejects.toMatchObject({ code: 'cancelled' });
        expect(test.effects).toEqual([]);
        expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        expect(test.reopen).toHaveBeenCalled();
    });
    it.each(['busy', 'interval'] as const)('cancels the admitted FIN scope locally during %s waiting after source withdrawal without native IO', async phase => {
        if (phase === 'interval') { vi.useFakeTimers(); vi.setSystemTime(0); }
        const test = setup(phase === 'interval' ? { kind: 'idle', since: 0 } : { kind: phase, reasons: ['finite'] });
        test.setMachine({ desiredWhen: 'after-idle', ...(phase === 'interval' ? { desiredAfterMs: 100 } : {}) });
        let sourceCurrent = true;
        const origin = await finScopeAuthorization(test, () => sourceCurrent);
        const cancellation = new AbortController();
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const waitForChange = test.waitForChange.getMockImplementation()!;
        test.waitForChange.mockImplementation(async signal => {
            sourceCurrent = false;
            entered();
            // The real activity boundary stays pending until pushed activity
            // or local cancellation; a resolved fake would spin while busy.
            return await waitForChange(signal);
        });
        const machine = test.readMachine();
        const work = test.driver.execute('machines.managed.delete', { homeId: machine.homeId, managedId: machine.id,
            intent: 'delete', when: 'after-idle', ...(phase === 'interval' ? { afterMs: 100 } : {}), reviewedDependencies: true },
            { ...test.options, signal: cancellation.signal, context: { ...test.options.context, ...origin } });
        const settled = work.then(value => ({ value }), error => ({ error }));
        try {
            expect(await Promise.race([waiting.then(() => 'waiting' as const), settled])).toBe('waiting');
            expect(sourceCurrent).toBe(false);
            expect(test.effects).toEqual([]);
            cancellation.abort();
            expect(await settled).toMatchObject({ error: { code: 'cancelled' } });
            expect(test.readMachine().submittedNativeEffect).toBeUndefined();
        } finally {
            cancellation.abort();
            await settled;
        }
    });
});
