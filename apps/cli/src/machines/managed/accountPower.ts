import { createManagedNativeObservationWait, executeManagedMachinePowerIntent,
    ManagedMachineControllerError, ManagedMachineNativeEffectGuardRefusal } from '@happier-dev/cli-common/machines/managed';
import { ManagedAdmissionOutputV1Schema, ManagedControlAdmissionInputV1Schema, ManagedControllerCurrentnessV1Schema,
    ManagedControllerMachineOutputV1Schema, ManagedControllerSubmitOutputV1Schema,
    type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import type { StoredCredentials } from '@/persistence';
import { createCliManagedAccountNativeInvocation } from './accountNative';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';

/** Foreground Account execution consumes Home admission, not an invented controller identity. */
export async function executeCliManagedAccountPower(input: Readonly<{
    body: ManagedMachineActionInputV1<'machines.managed.power.set'>;
    context: ActionExecutorContext;
    credentials: StoredCredentials;
    serverUrl: string;
    signal?: AbortSignal;
    post<T>(path: string, body: unknown, schema: Readonly<{ parse(value: unknown): T }>, signal?: AbortSignal | null): Promise<T>;
}>) {
    const port = input.context.hostReviewedChild;
    const requestId = input.context.actionRequestId;
    if (!requestId || input.body.when === 'now' && !port) throw new ManagedMachineControllerError('admission_unavailable');
    const request = ManagedControlAdmissionInputV1Schema.parse({ action: 'machines.managed.power.set', input: input.body, requestId });
    const admitted = await input.post('admit-control', request, ManagedAdmissionOutputV1Schema);
    let machine = admitted.machine;
    // Home retains the deferred intent; the existing controller/guest drain
    // reconciler submits its native effect when activity has settled.
    if (input.body.when === 'after-idle') return ManagedIntentResultSchema.parse({
        kind: 'accepted', managedId: machine.id, intentRevision: machine.intentRevision,
        ...(input.context.operationAcceptance ? { operation: { operationId: input.context.operationAcceptance.operationId } } : {}),
    });
    if (machine.controller) throw new ManagedMachineControllerError('controller_unavailable');
    const provisioner = machine.reviewedFacts?.provisioner;
    if (!provisioner) throw new ManagedMachineControllerError('provider_unavailable');
    if (machine.desiredWhen !== 'now') throw new ManagedMachineControllerError('native_intent_unconfirmed');
    // Capture this finite operation's declaration once; provider dispatch still
    // owns native placement and materialization at its ordinary boundary.
    const selected = await readCurrentAccountPluginExecutionSelection({ pluginId: machine.launch.provider.pluginId,
        credentials: input.credentials, serverUrl: input.serverUrl, signal: input.signal });
    if (selected.kind !== 'available') throw new ManagedMachineControllerError('provider_unavailable');
    const correlation = ManagedControllerCurrentnessV1Schema.parse({ homeId: machine.homeId, managedId: machine.id,
        expectedIntentRevision: machine.intentRevision, requestId });
    const submitted = await input.post('submit-intent', correlation, ManagedControllerSubmitOutputV1Schema);
    machine = submitted.machine;
    if (!submitted.submitted) throw new ManagedMachineControllerError('native_intent_unconfirmed');
    const invoke = createCliManagedAccountNativeInvocation({ machine, provisioner, selected,
        context: input.context, signal: input.signal, requestId });
    let power: Awaited<ReturnType<typeof executeManagedMachinePowerIntent>>;
    try {
        power = await executeManagedMachinePowerIntent({ machine, invoke, io: { signal: input.signal },
            guestStartup: { transport: provisioner.bootstrapTransport,
                channel: resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label },
            waitForObservation: createManagedNativeObservationWait(input.signal) });
    } catch (error) {
        try {
            await input.post('report-intent', { ...correlation, result: {
                kind: error instanceof ManagedMachineNativeEffectGuardRefusal ? 'refused' : 'unknown',
                code: error instanceof ManagedMachineControllerError ? error.code : 'native_intent_unconfirmed',
            } }, ManagedControllerMachineOutputV1Schema, null);
        } catch (reportError) {
            logger.warn('[MANAGED MACHINE] Native outcome report failed', projectActionFailureCauseV1(reportError, 'machines.managed.power.set'));
        }
        throw error;
    }
    const nativeFailure = power.guestStartupError ?? (power.result.kind === 'refused'
        ? new ManagedMachineControllerError(power.result.code, undefined,
            power.result.nativeCause ? { kind: 'managedNative', nativeCause: power.result.nativeCause } : undefined) : undefined);
    try {
        await input.post('report-intent', { ...correlation, result: power.result, observation: power.observation }, ManagedControllerMachineOutputV1Schema, null);
    } catch (reportError) {
        if (!nativeFailure) throw reportError;
        logger.warn('[MANAGED MACHINE] Native outcome report failed', projectActionFailureCauseV1(reportError, 'machines.managed.power.set'));
    }
    if (nativeFailure) throw nativeFailure;
    if (power.result.kind !== 'confirmed' || !power.observation
        || (machine.desired === 'start' || machine.desired === 'resume') && (power.observation.availability !== 'present'
            || power.observation.storage === 'lost' || power.observation.power !== 'running')) {
        throw new ManagedMachineControllerError('native_intent_unconfirmed');
    }
    const operationId = input.context.operationAcceptance?.operationId;
    return ManagedIntentResultSchema.parse({ kind: 'accepted', managedId: machine.id, intentRevision: machine.intentRevision,
        ...(operationId ? { operation: { operationId } } : {}) });
}
