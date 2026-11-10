import type {
    NewSessionComposerAttachmentSeedV1,
    NewSessionDraft,
} from '@/sync/domains/state/persistence';
import { PluginUiNewSessionActionDefaultV1Schema, PluginUiNewSessionSeedOriginV1Schema } from '@happier-dev/protocol/plugins/ui';
import { SessionSpaceMembershipTargetV1Schema } from '@happier-dev/protocol/actions';
import { readSessionInstructionsAuthoringDraft } from '@/sync/domains/state/sessionInstructionsDraft';
import { nullable } from 'zod/mini';
import { ManagedMachineAcquisitionDraftSchema, ManagedMachineSelectionDraftSchema } from '@/sync/domains/state/newSessionManagedMachineDraft';

/**
 * A host-created, draft-addressed attachment request waiting for the mounted
 * Composer projection to admit it. This is local custody, not a synchronized
 * Composer attachment: the mounted Composer mints the canonical attachment
 * record and clears the request after that transaction succeeds.
 */
export type NewSessionDraftLocalState = Readonly<Pick<NewSessionDraft,
    | 'instructionsDraft'
    | 'entryIntent'
    | 'selectedSecretId'
    | 'selectedSecretIdByProfileIdByEnvVarName'
    | 'sessionOnlySecretValueEncByProfileIdByEnvVarName'
    | 'sessionConfigOptionOverrides'
    | 'backendNewSessionOptionStateByTargetKey'
    | 'windowsRemoteSessionLaunchModeOverride'
    | 'placementExplicit'
    | 'permissionModeExplicit'
    | 'placementCandidates'
    | 'teamCredentialBindings'
    | 'composerAttachmentSeeds'
    | 'authoringOrigin'
    | 'actionDefault'
    | 'spaceMembership'
    | 'managedMachineSelection'
    | 'managedMachineAcquisition'
    | 'targetServerId'
>>;

/** Device-local New Session choices that must not enter the synchronized document. */
export function buildNewSessionDraftLocalState(draft: NewSessionDraft): NewSessionDraftLocalState {
    return {
        ...(draft.placementExplicit === true ? { placementExplicit: true } : {}),
        ...(draft.permissionModeExplicit === true ? { permissionModeExplicit: true } : {}),
        ...(draft.instructionsDraft === undefined ? {} : { instructionsDraft: readSessionInstructionsAuthoringDraft(draft.instructionsDraft) }),
        entryIntent: draft.entryIntent ?? null,
        selectedSecretId: draft.selectedSecretId ?? null,
        selectedSecretIdByProfileIdByEnvVarName: draft.selectedSecretIdByProfileIdByEnvVarName ?? null,
        sessionOnlySecretValueEncByProfileIdByEnvVarName: draft.sessionOnlySecretValueEncByProfileIdByEnvVarName ?? null,
        sessionConfigOptionOverrides: draft.sessionConfigOptionOverrides ?? null,
        backendNewSessionOptionStateByTargetKey:
            draft.backendNewSessionOptionStateByTargetKey
            ?? draft.agentNewSessionOptionStateByAgentId
            ?? null,
        windowsRemoteSessionLaunchModeOverride: draft.windowsRemoteSessionLaunchModeOverride ?? null,
        ...(draft.managedMachineSelection === undefined ? {} : {
            managedMachineSelection: nullable(ManagedMachineSelectionDraftSchema).parse(draft.managedMachineSelection),
        }),
        ...(draft.managedMachineAcquisition === undefined ? {} : {
            managedMachineAcquisition: nullable(ManagedMachineAcquisitionDraftSchema).parse(draft.managedMachineAcquisition),
        }),
        ...(draft.managedMachineSelection === undefined && draft.managedMachineAcquisition === undefined ? {} : {
            // The local profile routing id is distinct from selection.homeId.
            targetServerId: draft.targetServerId ?? null,
        }),
        ...(draft.placementCandidates === undefined ? {} : { placementCandidates: draft.placementCandidates }),
        ...(draft.teamCredentialBindings === undefined ? {} : { teamCredentialBindings: draft.teamCredentialBindings }),
        ...(draft.composerAttachmentSeeds === undefined ? {} : { composerAttachmentSeeds: draft.composerAttachmentSeeds }),
        ...(draft.actionDefault === undefined ? {} : {
            actionDefault: PluginUiNewSessionActionDefaultV1Schema.parse(draft.actionDefault),
        }),
        ...(draft.authoringOrigin === undefined ? {} : {
            authoringOrigin: PluginUiNewSessionSeedOriginV1Schema.parse(draft.authoringOrigin),
        }),
        ...(draft.spaceMembership === undefined ? {} : {
            spaceMembership: nullable(SessionSpaceMembershipTargetV1Schema).parse(draft.spaceMembership),
        }),
    };
}
