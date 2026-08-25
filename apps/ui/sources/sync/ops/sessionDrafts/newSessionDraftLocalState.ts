import type { NewSessionDraft } from '@/sync/domains/state/persistence';

export type NewSessionDraftLocalState = Readonly<Pick<NewSessionDraft,
    | 'entryIntent'
    | 'selectedSecretId'
    | 'selectedSecretIdByProfileIdByEnvVarName'
    | 'sessionOnlySecretValueEncByProfileIdByEnvVarName'
    | 'sessionConfigOptionOverrides'
    | 'backendNewSessionOptionStateByTargetKey'
    | 'windowsRemoteSessionLaunchModeOverride'
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
    };
}
