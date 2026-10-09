import { useCreateNewSession } from '@/components/sessions/new/hooks/useCreateNewSession';
import { useNewSessionHostCreationProfile } from '@/components/sessions/new/navigation/newSessionHost';
import { resolveNewSessionCreationProfileAuthoringInput } from '@/components/sessions/new/modules/newSessionCreationProfile';

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
    providerLaunchError: UseCreateNewSessionResult['providerLaunchError'];
    retryProviderLaunch: UseCreateNewSessionResult['retryProviderLaunch'];
    managedMachineCreationProgress: UseCreateNewSessionResult['managedMachineCreationProgress'];
    retryManagedMachineInstallation: UseCreateNewSessionResult['retryManagedMachineInstallation'];
    retryManagedMachineSetup: UseCreateNewSessionResult['retryManagedMachineSetup'];
    continueWithoutManagedMachineSetup: UseCreateNewSessionResult['continueWithoutManagedMachineSetup'];
    deleteManagedMachineAfterFailedSetup: UseCreateNewSessionResult['deleteManagedMachineAfterFailedSetup'];
    cancelManagedMachineCreation: UseCreateNewSessionResult['cancelManagedMachineCreation'];
}> {
    const {
        currentAuthoringDraft,
        allowedTargetServerIds,
        resolvedSettingsAllowedServerIds,
        ...createSessionParams
    } = params;
    const profile = useNewSessionHostCreationProfile();
    const effective = resolveNewSessionCreationProfileAuthoringInput({
        modelMode: createSessionParams.modelMode,
        permissionMode: createSessionParams.permissionMode,
        modelSelection: currentAuthoringDraft?.modelSelection ?? null,
    }, profile);

    return useCreateNewSession({
        ...createSessionParams,
        modelMode: effective.modelMode,
        permissionMode: effective.permissionMode,
        authoringDraft: profile && currentAuthoringDraft
            ? {
                ...currentAuthoringDraft,
                ...(profile.allowedModels ? { modelSelection: effective.modelSelection } : {}),
                permissionMode: effective.permissionMode,
            }
            : currentAuthoringDraft,
        allowedTargetServerIds: allowedTargetServerIds.length > 0
            ? allowedTargetServerIds
            : resolvedSettingsAllowedServerIds,
    });
}
