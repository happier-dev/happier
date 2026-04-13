import { useCreateNewSession } from '@/components/sessions/new/hooks/useCreateNewSession';

type UseCreateNewSessionParams = Parameters<typeof useCreateNewSession>[0];
type UseCreateNewSessionResult = ReturnType<typeof useCreateNewSession>;

type UseNewSessionCreateSessionActionParams = Readonly<
    Omit<UseCreateNewSessionParams, 'authoringDraft' | 'allowedTargetServerIds'> & {
        currentAuthoringDraft: UseCreateNewSessionParams['authoringDraft'];
        allowedTargetServerIds: ReadonlyArray<string>;
        resolvedSettingsAllowedServerIds: ReadonlyArray<string>;
    }
>;

export function useNewSessionCreateSessionAction(params: UseNewSessionCreateSessionActionParams): Readonly<{
    handleCreateSession: UseCreateNewSessionResult['handleCreateSession'];
}> {
    const {
        currentAuthoringDraft,
        allowedTargetServerIds,
        resolvedSettingsAllowedServerIds,
        ...createSessionParams
    } = params;

    const { handleCreateSession } = useCreateNewSession({
        ...createSessionParams,
        authoringDraft: currentAuthoringDraft,
        allowedTargetServerIds: allowedTargetServerIds.length > 0
            ? allowedTargetServerIds
            : resolvedSettingsAllowedServerIds,
    });

    return {
        handleCreateSession,
    };
}
