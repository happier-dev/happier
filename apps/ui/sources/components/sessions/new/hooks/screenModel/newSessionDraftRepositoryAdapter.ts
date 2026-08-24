import type { SyncedSessionAuthoringValueV1 } from '@happier-dev/protocol';

import {
    buildNewSessionAuthoringDraft,
    buildPersistedNewSessionDraftFromAuthoringDraft,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { projectSyncedSessionAuthoringFields } from '@/sync/domains/input/drafts/sessionAuthoringDraftProjection';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import type {
    NewSessionDraftPatch,
    SessionDraftSnapshot,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

function readAuthoringValues(snapshot: SessionDraftSnapshot): Partial<SyncedSessionAuthoringValueV1> {
    if (snapshot.document.target.kind !== 'newSession') return {};
    const authoring = snapshot.document.target.authoring as Readonly<Record<string, Readonly<{ value: unknown }>>>;
    const values = Object.fromEntries(
        Object.entries(authoring).map(([fieldId, field]) => [fieldId, field.value]),
    );
    return projectSyncedSessionAuthoringFields(values);
}

export function readNewSessionDraftFromSnapshot(snapshot: SessionDraftSnapshot | null): NewSessionDraft | null {
    if (!snapshot || snapshot.address.kind !== 'newSession' || snapshot.document.target.kind !== 'newSession') {
        return null;
    }

    const authoring = readAuthoringValues(snapshot);
    const prompt = snapshot.document.composer.text.value;
    const authoringDraft = buildNewSessionAuthoringDraft({
        directory: authoring.directory ?? '/',
        checkoutCreationDraft: authoring.checkoutCreationDraft ?? null,
        prompt,
        displayText: prompt,
        agentId: authoring.agentId ?? null,
        backendTarget: authoring.backendTarget ?? null,
        transcriptStorage: authoring.transcriptStorage ?? null,
        profileId: authoring.profileId ?? null,
        environmentVariables: null,
        resumeSessionId: authoring.resumeSessionId ?? null,
        permissionMode: authoring.permissionMode ?? null,
        permissionModeUpdatedAt: null,
        modelId: authoring.modelId ?? null,
        modelUpdatedAt: null,
        mcpSelection: authoring.mcpSelection ?? null,
        connectedServices: authoring.connectedServices ?? null,
        terminal: authoring.terminal ?? null,
        windowsRemoteSessionLaunchMode: authoring.windowsRemoteSessionLaunchMode ?? null,
        windowsRemoteSessionConsole: authoring.windowsRemoteSessionConsole ?? null,
        windowsTerminalWindowName: authoring.windowsTerminalWindowName ?? null,
        experimentalCodexAcp: null,
        codexBackendMode: authoring.codexBackendMode ?? null,
        acpSessionModeId: authoring.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: null,
        automation: authoring.automation ?? null,
    });
    const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({
        draft: authoringDraft,
        machineId: authoring.machineId ?? null,
        selectedSecretId: null,
        selectedSecretIdByProfileIdByEnvVarName: null,
        sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
        agentNewSessionOptionStateByAgentId: null,
        targetServerId: authoring.serverId ?? null,
        updatedAt: snapshot.updatedAt,
    });
    const launchUserAttemptId = snapshot.localSupplement.launchUserAttemptId;
    return launchUserAttemptId ? { ...persisted, launchUserAttemptId } : persisted;
}

export function buildNewSessionDraftPatch(params: Readonly<{
    authoringDraft: SessionAuthoringDraft;
    machineId: string | null;
    serverId: string | null;
    text: string;
}>): NewSessionDraftPatch {
    return {
        text: params.text,
        authoring: projectSyncedSessionAuthoringFields({
            ...params.authoringDraft,
            machineId: params.machineId,
            serverId: params.serverId,
        }),
    };
}
