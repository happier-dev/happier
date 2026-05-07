import {
    AcpConfigOptionOverridesV1Schema,
    AcpSessionModeOverrideV1Schema,
} from '@happier-dev/protocol';
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

import type { ExistingSessionAuthoringSnapshotSession } from './sessionAuthoringDraftAdapters';
import {
    buildNewSessionAuthoringDraft,
    buildNewSessionTempDataFromAuthoringDraft,
} from './sessionAuthoringDraftAdapters';

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
}>): NewSessionData {
    const snapshot = deriveSessionAuthoringSnapshot({
        session: params.session,
    });
    const directoryOverride = normalizeOptionalString(params.directoryOverride);
    const draft = buildNewSessionAuthoringDraft({
        directory: directoryOverride ?? snapshot.directory,
        checkoutCreationDraft: null,
        prompt: '',
        displayText: '',
        agentId: snapshot.agentId,
        backendTarget: snapshot.backendTarget,
        transcriptStorage: snapshot.transcriptStorage,
        profileId: snapshot.profileId,
        environmentVariables: null,
        resumeSessionId: null,
        permissionMode: snapshot.permissionMode,
        permissionModeUpdatedAt: snapshot.permissionModeUpdatedAt,
        modelId: snapshot.modelId,
        modelUpdatedAt: snapshot.modelUpdatedAt,
        mcpSelection: snapshot.mcpSelection,
        connectedServices: snapshot.connectedServices,
        terminal: snapshot.terminal,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null,
        experimentalCodexAcp: null,
        codexBackendMode: snapshot.codexBackendMode,
        acpSessionModeId: readSessionModeOverrideId(params.session.metadata),
        sessionConfigOptionOverrides: readSessionConfigOptionOverrides(params.session.metadata),
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
