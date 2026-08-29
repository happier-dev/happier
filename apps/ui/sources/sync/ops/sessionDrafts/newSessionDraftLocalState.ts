import type {
    NewSessionComposerAttachmentSeedV1,
    NewSessionDraft,
} from '@/sync/domains/state/persistence';

/**
 * A host-created, draft-addressed attachment request waiting for the mounted
 * Composer projection to admit it. This is local custody, not a synchronized
 * Composer attachment: the mounted Composer mints the canonical attachment
 * record and clears the request after that transaction succeeds.
 */
export type NewSessionDraftLocalState = Readonly<Pick<NewSessionDraft,
    | 'entryIntent'
    | 'selectedSecretId'
    | 'selectedSecretIdByProfileIdByEnvVarName'
    | 'sessionOnlySecretValueEncByProfileIdByEnvVarName'
    | 'sessionConfigOptionOverrides'
    | 'backendNewSessionOptionStateByTargetKey'
    | 'windowsRemoteSessionLaunchModeOverride'
    | 'placementCandidates'
    | 'composerAttachmentSeeds'
>>;

/** Device-local New Session choices that must not enter the synchronized document. */
export function buildNewSessionDraftLocalState(draft: NewSessionDraft): NewSessionDraftLocalState {
    return {
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
        ...(draft.placementCandidates === undefined ? {} : { placementCandidates: draft.placementCandidates }),
        ...(draft.composerAttachmentSeeds === undefined ? {} : { composerAttachmentSeeds: draft.composerAttachmentSeeds }),
    };
}
