import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';

/** Native completion uses the ordinary admission host without manufacturing an Event trigger. */
export async function admitNativeActionCompletionObservation(
    context: PluginInvocationContext,
    observation: PluginEventObservationV1,
): Promise<void> {
    const { sourceContractVersion: _contract, observedDelta: _delta, subjectContexts, ...input } = observation;
    const result = await context.services.actions.execute('automation.event.admit', { ...input, ...(subjectContexts ? { subjectContexts: [...subjectContexts] } : {}), definitions: [] }, { signal: context.signal });
    if ('ok' in result && !result.ok) throw new PluginError({ code: result.errorCode });
}
