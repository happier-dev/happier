import { executeManagedMachineAcquire, reconcileManagedMachine, createManagedNativeBootstrapIO,
    createManagedNativeObservationWait, readManagedGuestDiagnostics, ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { ManagedControllerContextOutputV1Schema, type ManagedAcquireInputV1,
    type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveManagedMachineEnrollmentAdminAccessV1, resolveManagedMachineEnrollmentAgentIsolationV1 }
    from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readRuntimeFetchHost } from '@/utils/system/runtimeFetch';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { resolveDefaultNativeSshSystemTaskCapability } from '@/components/systemTasks/bridges/native';
import { createUiManagedAccountCredential } from './managedMachineAccountCredential';
import { createUiManagedAccountNative, readUiManagedAccountAdmission } from './managedMachineAccountNative';
import { createUiManagedAccountHome, createUiManagedAccountHomeRequest } from './managedMachineAccountHome';
import { completeUiManagedAccountGuest } from './managedMachineAccountGuest';
import { runUiManagedMachineEnrollment, type UiManagedMachineEnrollmentDependencies } from './managedMachineEnrollment';

type UiManagedAccountRecipeParams = Readonly<{
    account: LazyActionAccountContext;
    context: ActionExecutorContext;
    requestId: string;
    input: ManagedAcquireInputV1 | ManagedMachineActionInputV1<'machines.managed.bootstrap.retry'>;
    signal?: AbortSignal;
    installNativePayload?: UiManagedMachineEnrollmentDependencies['installNativePayload'];
}>;

/** Foreground Account work owns no fictitious Machine Action operation. */
export async function executeUiManagedAccountAcquire(params: UiManagedAccountRecipeParams & { input: ManagedAcquireInputV1 }) {
    const admitted = readUiManagedAccountAdmission(params.context);
    const client = createUiManagedAccountHome({ ...params, provisioner: admitted.provisioner });
    const host = await readRuntimeFetchHost(params.account.endpointUrl);
    const requestEnvelopeDigest = params.context.externalActionExecutionAuthorization?.binding.requestEnvelopeDigest
        ?? computeExternalActionRequestEnvelopeDigestV1(ExternalActionRequestEnvelopeV1Schema.parse({
            v: 1, requestId: params.requestId, input: admitted.input,
        }));
    const acquired = await executeManagedMachineAcquire({
        host, provisioner: admitted.provisioner,
        admit: () => client.admit(admitted.input, requestEnvelopeDigest),
        onAccepted: () => {},
        run: machine => runUiManagedAccountRecipe(params, admitted, client, machine, 'machines.managed.acquire'),
    });
    return { managedId: acquired.result.id };
}

/** Home returns the retained creation correlation before the same native recipe resumes. */
export async function executeUiManagedAccountRecovery(params: Omit<UiManagedAccountRecipeParams, 'input'> & Readonly<{
    action: 'machines.managed.inspect' | 'machines.managed.bootstrap.retry';
    input: ManagedMachineActionInputV1<'machines.managed.inspect'> | ManagedMachineActionInputV1<'machines.managed.bootstrap.retry'>;
    machine: ManagedMachineV1;
}>) {
    const retained = await createUiManagedAccountHomeRequest(params)('context', {
        homeId: params.machine.homeId, managedId: params.machine.id,
        expectedIntentRevision: 'expectedIntentRevision' in params.input ? params.input.expectedIntentRevision : params.machine.intentRevision,
    }, ManagedControllerContextOutputV1Schema);
    const admitted = readUiManagedAccountAdmission(params.context, retained.machine);
    const recipe = { ...params, requestId: retained.requestId };
    const client = createUiManagedAccountHome({ ...recipe, provisioner: admitted.provisioner });
    const machine = await runUiManagedAccountRecipe(recipe, admitted, client, retained.machine, params.action);
    if (params.action !== 'machines.managed.inspect') return { managedId: machine.id };
    if (!('includeGuestDiagnostics' in params.input) || !params.input.includeGuestDiagnostics) return { machine };
    const guestDiagnostics = await readManagedGuestDiagnostics({ machine, requesterAccountId: params.account.accountId,
        transport: admitted.provisioner.bootstrapTransport, channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(), signal: params.signal,
        native: { exec: request => {
            const credential = createUiManagedAccountCredential({ account: params.account, home: client.home, signal: params.signal });
            const native = createUiManagedAccountNative(recipe, admitted, () => machine, () => undefined, credential);
            return createManagedNativeBootstrapIO({ resource: machine.resource! }, native.invoke).exec(request);
        } },
    });
    return { machine, guestDiagnostics };
}

function runUiManagedAccountRecipe(params: Omit<UiManagedAccountRecipeParams, 'input'> & {
    input: UiManagedAccountRecipeParams['input'] | ManagedMachineActionInputV1<'machines.managed.inspect'>;
}, admitted: ReturnType<typeof readUiManagedAccountAdmission>, client: ReturnType<typeof createUiManagedAccountHome>,
machine: ManagedMachineV1, action: 'machines.managed.acquire' | 'machines.managed.inspect' | 'machines.managed.bootstrap.retry') {
    const credential = createUiManagedAccountCredential({ account: params.account, home: client.home, signal: params.signal });
    return reconcileManagedMachine({
            machine, action, requestId: params.requestId, signal: params.signal,
            provisioner: admitted.provisioner, home: client.home,
            createNative: (readMachine, readRevision) => createUiManagedAccountNative(params, admitted, readMachine, readRevision, credential),
            waitForObservation: createManagedNativeObservationWait(params.signal),
            bootstrap: {
                preflight: async () => {
                    const kind = admitted.provisioner.bootstrapCredential?.kind
                        ?? (admitted.provisioner.bootstrapTransport ? undefined : 'ssh');
                    if (kind === 'native-token' || kind === 'ssh' && !resolveDefaultNativeSshSystemTaskCapability().available) {
                        throw new ManagedMachineControllerError('provider_unavailable');
                    }
                    // These demanded guest effects need the ordinary retained
                    // managedContinuation transport; never accept and omit them.
                    const creation = 'selection' in params.input ? params.input : machine;
                    if (creation.reviewedFacts?.setup !== undefined
                        || resolveManagedMachineEnrollmentAdminAccessV1(creation.enrollmentIdentity)
                        || resolveManagedMachineEnrollmentAgentIsolationV1(creation.enrollmentIdentity)) {
                        throw new ManagedMachineControllerError('admission_unavailable');
                    }
                },
                prepareCredential: credential.prepare,
                readCredential: credential.read,
                enroll: async enrollment => {
                    if (!('selection' in params.input) && !('expectedIntentRevision' in params.input)) {
                        throw new ManagedMachineControllerError('admission_unavailable');
                    }
                    const target = await params.account.resolveHomeTarget();
                    await runUiManagedMachineEnrollment({
                        correlation: enrollment.correlation, carrier: enrollment.carrier, target,
                        channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(), operationId: params.context.operationAcceptance?.operationId ?? params.requestId,
                        onInstalled: enrollment.onInstalled,
                        credentials: params.account.credentials, context: params.context, reviewedAction: params.input, signal: params.signal,
                        ...(enrollment.guestHostPublicKey ? { guestHostPublicKey: enrollment.guestHostPublicKey } : {}),
                    }, {
                        readCurrentManagedRow: () => client.home.row('current', client.home.correlation(enrollment.machine)),
                        native: createManagedNativeBootstrapIO(enrollment.correlation, enrollment.invoke),
                        readBootstrapCredential: async () => (await credential.read(enrollment.machine, enrollment.credentialRevision)).value,
                        ...(params.installNativePayload ? { installNativePayload: params.installNativePayload } : {}),
                    });
                    // Ordinary Account pairing is the enrollment writer; observe its
                    // resulting row once, rather than inventing an /enrolled mutation.
                    const machine = await client.home.row('current', client.home.correlation(enrollment.machine));
                    return 'selection' in params.input
                        ? await completeUiManagedAccountGuest({ ...params, input: params.input, machine }) : machine;
                },
            },
        });
}
