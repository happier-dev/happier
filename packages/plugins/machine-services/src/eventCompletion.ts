import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import type { PluginActionInputById } from '@happier-dev/plugin-sdk/actions';

/** The native observation owner removes SDK bookkeeping before strict Action admission. */
export function projectNativeEventObservationAdmissionInput(
    observation: PluginEventObservationV1,
): Omit<PluginActionInputById['automation.event.admit'], 'definitions'> {
    const { sourceContractVersion: _contract, observedDelta: _delta, subjectContexts, ...input } = observation;
    return { ...input, ...(subjectContexts ? { subjectContexts: [...subjectContexts] } : {}) };
}

/** Native completion uses the ordinary admission host without manufacturing an Event trigger. */
export async function admitNativeActionCompletionObservation(
    context: PluginInvocationContext,
    observation: PluginEventObservationV1,
): Promise<void> {
    await context.services.actions.execute('automation.event.admit', {
        ...projectNativeEventObservationAdmissionInput(observation), definitions: [],
    }, { signal: context.signal });
}
