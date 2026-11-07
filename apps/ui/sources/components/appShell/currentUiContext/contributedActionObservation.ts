import { isPluginError, PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type { DispatchPluginSurfaceActionInput } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { observePluginSurfaceActionRead } from '@/components/plugins/surfaces/pluginSurfaceActionReadObservation';
import { acquireCurrentContributedAction, isResolvedContributedActionCurrent } from './contributedActionInvocation';
import type { CurrentUiContextVoiceToolPort, CurrentUiContextVoiceInvocationOutcome } from './currentUiContextVoiceToolPort';

export async function observeCurrentContributedAction(input: Omit<Parameters<typeof acquireCurrentContributedAction>[0], 'identity' | 'signal' | 'isCurrent'> & Readonly<{
    request: Parameters<NonNullable<CurrentUiContextVoiceToolPort['observeAction']>>[0];
    invoke(observation: NonNullable<DispatchPluginSurfaceActionInput['readObservation']>, signal: AbortSignal,
        isCurrent: () => boolean): Promise<CurrentUiContextVoiceInvocationOutcome>;
}>): Promise<Disposable> {
    const { request } = input;
    const accountLifetime = input.admission?.read()?.accountLifetime;
    const isCallerCurrent = () => request.isCurrent() && accountLifetime?.isCurrent() !== false;
    for (;;) {
        const resolved = await acquireCurrentContributedAction({ ...input, identity: request.action,
            signal: request.signal, isCurrent: isCallerCurrent });
        if (!resolved) throw new PluginError({ code: request.signal?.aborted || !isCallerCurrent()
            ? 'plugin_action_generation_retired' : 'contributed_action_unavailable' });
        // The await hands control back to AppShell. If that exact registration
        // retired meanwhile, rejoin its push-driven acquisition before invoking.
        if (!isResolvedContributedActionCurrent(input.readProjection, request.action, resolved)) {
            if (!accountLifetime?.isCurrent()) throw new PluginError({ code: 'plugin_action_generation_retired' });
            continue;
        }
        const isCurrent = () => isCallerCurrent()
            && isResolvedContributedActionCurrent(input.readProjection, request.action, resolved);
        try {
            return await observePluginSurfaceActionRead({
                // Target retirement must still invalidate a live caller.
                signal: request.signal ?? new AbortController().signal, isCurrent: isCallerCurrent, invalidate: request.invalidate,
                async invoke(observation, signal) {
                    const outcome = await input.invoke(observation, signal, isCurrent);
                    if (!outcome.ok) throw new PluginError({ code: outcome.errorCode ?? outcome.code });
                    return outcome.result ?? null;
                },
            });
        } catch (error) {
            // Only an opening read observation can rejoin a verified successor.
            // This never replays an Action handler or an established watch;
            // the observation owner has already disposed its failed attachment.
            if (!request.signal?.aborted && isCallerCurrent() && accountLifetime?.isCurrent()
                && !isResolvedContributedActionCurrent(input.readProjection, request.action, resolved)
                && isPluginError(error) && (error.code === 'outcome_unknown'
                    || error.code === 'plugin_action_generation_retired' || error.code === 'plugin_action_read_observation_invalid')) continue;
            throw error;
        }
    }
}
