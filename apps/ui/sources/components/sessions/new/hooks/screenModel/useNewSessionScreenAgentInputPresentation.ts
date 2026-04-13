import { useNewSessionAgentInputPresentation } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentInputPresentation';

type UseNewSessionAgentInputPresentationParams = Parameters<typeof useNewSessionAgentInputPresentation>[0];
type UseNewSessionAgentInputPresentationResult = ReturnType<typeof useNewSessionAgentInputPresentation>;

type UseNewSessionScreenAgentInputPresentationParams = Readonly<
    Omit<UseNewSessionAgentInputPresentationParams, 'showAutomationActionChips' | 'effectiveWindowsRemoteSessionLaunchMode'> & {
        showAutomationActionChipsFromAuthoringContext: boolean;
        effectiveWindowsRemoteSessionLaunchMode:
            UseNewSessionAgentInputPresentationParams['effectiveWindowsRemoteSessionLaunchMode'] | undefined;
    }
>;

export function useNewSessionScreenAgentInputPresentation(
    params: UseNewSessionScreenAgentInputPresentationParams,
): UseNewSessionAgentInputPresentationResult {
    const {
        showAutomationActionChipsFromAuthoringContext,
        effectiveWindowsRemoteSessionLaunchMode,
        ...agentInputPresentationParams
    } = params;

    return useNewSessionAgentInputPresentation({
        ...agentInputPresentationParams,
        showAutomationActionChips: showAutomationActionChipsFromAuthoringContext,
        effectiveWindowsRemoteSessionLaunchMode: effectiveWindowsRemoteSessionLaunchMode ?? null,
    });
}
