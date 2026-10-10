import type {
    NewSessionComposerAttachmentSeedV1,
    NewSessionDraft,
} from '@/sync/domains/state/persistence';
import { PluginUiNewSessionSeedOriginV1Schema } from '@happier-dev/protocol/plugins/ui';
import { SessionIdentityAdditionsV1Schema } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { SessionPromptStackV1Schema } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { readSessionInstructionsAuthoringDraft } from '@/sync/ops/promptLibrary/sessionInstructions';
import { nullable } from 'zod/mini';
import { ManagedMachineAcquisitionDraftSchema, ManagedMachineSelectionDraftSchema } from '@/sync/domains/state/newSessionManagedMachineDraft';

/**
 * A host-created, draft-addressed attachment request waiting for the mounted
 * Composer projection to admit it. This is local custody, not a synchronized
 * Composer attachment: the mounted Composer mints the canonical attachment
 * record and clears the request after that transaction succeeds.
 */
export type NewSessionDraftLocalState = Readonly<Pick<NewSessionDraft,
    | 'sessionName'
    | 'initialSessionFacts'
    | 'memoryEnabled'
    | 'promptStack'
    | 'instructionsDraft'
    | 'entryIntent'
    | 'selectedSecretId'
    | 'selectedSecretIdByProfileIdByEnvVarName'
    | 'sessionOnlySecretValueEncByProfileIdByEnvVarName'
    | 'sessionConfigOptionOverrides'
    | 'backendNewSessionOptionStateByTargetKey'
    | 'windowsRemoteSessionLaunchModeOverride'
    | 'placementCandidates'
    | 'teamCredentialBindings'
    | 'composerAttachmentSeeds'
    | 'zenTaskSource'
    | 'authoringOrigin'
    | 'managedMachineSelection'
    | 'managedMachineAcquisition'
    | 'targetServerId'
>>;

/** Device-local New Session choices that must not enter the synchronized document. */
export function buildNewSessionDraftLocalState(draft: NewSessionDraft): NewSessionDraftLocalState {
    return {
        ...(draft.sessionName === undefined ? {} : { sessionName: draft.sessionName }),
        ...(draft.initialSessionFacts === undefined ? {} : {
            initialSessionFacts: SessionIdentityAdditionsV1Schema.parse(draft.initialSessionFacts),
        }),
        ...(draft.memoryEnabled === undefined ? {} : { memoryEnabled: draft.memoryEnabled }),
        ...(draft.promptStack === undefined ? {} : { promptStack: SessionPromptStackV1Schema.parse(draft.promptStack) }),
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
        ...(draft.zenTaskSource === undefined ? {} : { zenTaskSource: draft.zenTaskSource }),
        ...(draft.authoringOrigin === undefined ? {} : {
            authoringOrigin: PluginUiNewSessionSeedOriginV1Schema.parse(draft.authoringOrigin),
        }),
    };
}
