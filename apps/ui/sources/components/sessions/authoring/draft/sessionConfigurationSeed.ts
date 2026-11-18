import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import {
    AcpConfigOptionOverridesV1Schema,
    AcpSessionModeOverrideV1Schema,
} from '@happier-dev/protocol/sessions/metadata/overrides';
import {
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
    readMetadataAliasValue,
    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
    SESSION_MODE_OVERRIDE_KEY,
} from '@happier-dev/agents';

import { deriveSessionAuthoringSnapshot } from '@/sync/domains/sessionAuthoring/deriveSessionAuthoringSnapshot';
import {
    normalizeOptionalString,
} from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import type { NewSessionData } from '@/utils/sessions/tempDataStore';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

import type { ExistingSessionAuthoringSnapshotSession } from './sessionAuthoringDraftAdapters';
import {
    buildNewSessionAuthoringDraft,
    buildNewSessionTempDataFromAuthoringDraft,
    rekeyCompatibilityModelSelection,
    buildNewSessionAuthoringDraftFromTempData,
    buildPersistedNewSessionDraftFromAuthoringDraft,
} from './sessionAuthoringDraftAdapters';

/** Translate incumbent rich ingress into the canonical durable draft before opening. */
export function buildNewSessionConfigurationDraft(data: NewSessionData) {
    return buildPersistedNewSessionDraftFromAuthoringDraft({
        draft: buildNewSessionAuthoringDraftFromTempData(data),
        machineId: data.machineId ?? null,
        selectedSecretId: null,
        selectedSecretIdByProfileIdByEnvVarName: null,
        sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
        backendNewSessionOptionStateByTargetKey: data.backendNewSessionOptionStateByTargetKey,
        updatedAt: Date.now(),
    });
}

function readMetadataRecord(metadata: unknown): Record<string, unknown> {
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : {};
}

function readSessionModeOverrideId(metadata: unknown): string | null {
    const parsed = AcpSessionModeOverrideV1Schema.safeParse(
        readMetadataAliasValue(
            readMetadataRecord(metadata),
            SESSION_MODE_OVERRIDE_KEY,
            LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
        ),
    );
    return parsed.success ? normalizeOptionalString(parsed.data.modeId) : null;
}

function readSessionConfigOptionOverrides(metadata: unknown) {
    const parsed = AcpConfigOptionOverridesV1Schema.safeParse(
        readMetadataAliasValue(
            readMetadataRecord(metadata),
            SESSION_CONFIG_OPTION_OVERRIDES_KEY,
            LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
        ),
    );
    return parsed.success ? parsed.data : null;
}

export function buildNewSessionTempDataFromSessionConfiguration(params: Readonly<{
    session: ExistingSessionAuthoringSnapshotSession;
    machineId: string | null;
    directoryOverride?: string | null;
    approvalProfile?: Pick<DecryptedArtifact, 'access'> | null;
}>): NewSessionData {
    const snapshot = deriveSessionAuthoringSnapshot({
        session: params.session,
    });
    const metadata = readSessionOwnerMetadataView(params.session);
    // Continuing from a no-folder session starts another no-folder session: each gets its own
    // private folder, so the source's is never seeded as a directory.
    const withoutFolder = readSessionDirectoryKind(metadata) === 'managed';
    const directoryOverride = normalizeOptionalString(params.directoryOverride);
    const draft = buildNewSessionAuthoringDraft({
        executionTarget: null,
        directory: withoutFolder ? '' : directoryOverride ?? snapshot.directory,
        ...(withoutFolder ? { directoryKind: 'managed' as const } : {}),
        checkoutCreationDraft: null,
        organizationPlacement: { folderId: null, tagIds: [] },
        prompt: '',
        displayText: '',
        agentTarget: snapshot.agentTarget,
        transcriptStorage: snapshot.transcriptStorage,
        profileId: snapshot.profileId,
        // Acceptance belongs to the source subject. Only own profile IDs remain explicit on a copy.
        approvalProfileId: typeof snapshot.approvalProfileId === 'string'
            && (metadata?.approvalProfileTeamOrGroupDerived === true || params.approvalProfile?.access !== 'owner')
            ? undefined : snapshot.approvalProfileId,
        environmentVariables: null,
        resumeSessionId: null,
        permissionMode: snapshot.permissionMode,
        permissionModeUpdatedAt: snapshot.permissionModeUpdatedAt,
        modelSelection: snapshot.modelUpdatedAt === null
            ? undefined
            : rekeyCompatibilityModelSelection(snapshot.modelSelection, snapshot.agentTarget),
        capabilitySelection: snapshot.capabilitySelection,
        connectedServices: snapshot.connectedServices,
        terminal: snapshot.terminal,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null,
        runtimeDescriptorV1: snapshot.runtimeDescriptorV1,
        acpSessionModeId: readSessionModeOverrideId(metadata),
        sessionConfigOptionOverrides: readSessionConfigOptionOverrides(metadata),
        automation: null,
    });

    return {
        ...buildNewSessionTempDataFromAuthoringDraft({
            draft,
            machineId: params.machineId,
        }),
        replacePersistedDraftSelections: true,
    };
}
