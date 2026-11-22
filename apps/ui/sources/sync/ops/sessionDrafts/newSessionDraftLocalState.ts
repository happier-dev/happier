import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import type { NewSessionTargetFolderV1 } from '@/sync/domains/session/folders/newSessionTargetFolder';

export type NewSessionDraftLocalState = Readonly<Pick<NewSessionDraft,
    | 'entryIntent'
    | 'selectedSecretId'
    | 'selectedSecretIdByProfileIdByEnvVarName'
    | 'sessionOnlySecretValueEncByProfileIdByEnvVarName'
    | 'sessionConfigOptionOverrides'
    | 'agentNewSessionOptionStateByAgentId'
    | 'windowsRemoteSessionLaunchModeOverride'
> & {
    /** Folder staged by 'New session in folder'; kept device-local with the draft. */
    targetFolder?: NewSessionTargetFolderV1 | null;
}>;

/** Fields that remain device-local while the canonical authoring document is synchronized. */
export function buildNewSessionDraftLocalState(
    draft: NewSessionDraft,
    extras?: Readonly<{ targetFolder?: NewSessionTargetFolderV1 | null }>,
): NewSessionDraftLocalState {
    return {
        entryIntent: draft.entryIntent ?? null,
        selectedSecretId: draft.selectedSecretId ?? null,
        selectedSecretIdByProfileIdByEnvVarName: draft.selectedSecretIdByProfileIdByEnvVarName ?? null,
        sessionOnlySecretValueEncByProfileIdByEnvVarName: draft.sessionOnlySecretValueEncByProfileIdByEnvVarName ?? null,
        sessionConfigOptionOverrides: draft.sessionConfigOptionOverrides ?? null,
        agentNewSessionOptionStateByAgentId: draft.agentNewSessionOptionStateByAgentId ?? null,
        windowsRemoteSessionLaunchModeOverride: draft.windowsRemoteSessionLaunchModeOverride ?? null,
        ...(extras?.targetFolder ? { targetFolder: extras.targetFolder } : {}),
    };
}
