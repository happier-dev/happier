import type { NewSessionDraft } from '@/sync/domains/state/persistence';

export type NewSessionDraftLocalState = Readonly<Pick<NewSessionDraft,
    | 'entryIntent'
    | 'selectedSecretId'
    | 'selectedSecretIdByProfileIdByEnvVarName'
    | 'sessionOnlySecretValueEncByProfileIdByEnvVarName'
    | 'sessionConfigOptionOverrides'
    | 'agentNewSessionOptionStateByAgentId'
    | 'windowsRemoteSessionLaunchModeOverride'
>>;

/** Fields that remain device-local while the canonical authoring document is synchronized. */
export function buildNewSessionDraftLocalState(draft: NewSessionDraft): NewSessionDraftLocalState {
    return {
        entryIntent: draft.entryIntent ?? null,
        selectedSecretId: draft.selectedSecretId ?? null,
        selectedSecretIdByProfileIdByEnvVarName: draft.selectedSecretIdByProfileIdByEnvVarName ?? null,
        sessionOnlySecretValueEncByProfileIdByEnvVarName: draft.sessionOnlySecretValueEncByProfileIdByEnvVarName ?? null,
        sessionConfigOptionOverrides: draft.sessionConfigOptionOverrides ?? null,
        agentNewSessionOptionStateByAgentId: draft.agentNewSessionOptionStateByAgentId ?? null,
        windowsRemoteSessionLaunchModeOverride: draft.windowsRemoteSessionLaunchModeOverride ?? null,
    };
}
