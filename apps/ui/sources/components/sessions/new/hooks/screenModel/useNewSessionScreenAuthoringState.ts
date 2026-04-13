import { useNewSessionAuthoringState } from '@/components/sessions/new/hooks/screenModel/useNewSessionAuthoringState';

type UseNewSessionAuthoringStateParams = Parameters<typeof useNewSessionAuthoringState>[0];
type UseNewSessionAuthoringStateResult = ReturnType<typeof useNewSessionAuthoringState>;

type UseNewSessionScreenAuthoringStateParams = Readonly<
    Omit<UseNewSessionAuthoringStateParams, 'effectiveWindowsRemoteSessionLaunchMode' | 'getSessionOnlySecretValueEncByProfileIdByEnvVarName'> & {
        effectiveWindowsRemoteSessionLaunchMode:
            UseNewSessionAuthoringStateParams['effectiveWindowsRemoteSessionLaunchMode'] | undefined;
        getSessionOnlySecretValueEncByProfileIdByEnvVarName: () =>
            ReturnType<UseNewSessionAuthoringStateParams['getSessionOnlySecretValueEncByProfileIdByEnvVarName']> | null | undefined;
    }
>;

export function useNewSessionScreenAuthoringState(
    params: UseNewSessionScreenAuthoringStateParams,
): UseNewSessionAuthoringStateResult {
    const {
        effectiveWindowsRemoteSessionLaunchMode,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        ...authoringStateParams
    } = params;

    return useNewSessionAuthoringState({
        ...authoringStateParams,
        effectiveWindowsRemoteSessionLaunchMode: effectiveWindowsRemoteSessionLaunchMode ?? null,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => getSessionOnlySecretValueEncByProfileIdByEnvVarName() ?? {},
    });
}
