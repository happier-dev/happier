import { resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { SessionAuthoringDraft } from './sessionAuthoringDraft';

export function buildExistingSessionAuthoringDraftFromSession(params: Readonly<{
    session: Session;
    message: string;
    sessionDekBase64?: string | null;
}>): SessionAuthoringDraft {
    const session = params.session;
    const metadata = session.metadata ?? null;
    const machineId = typeof metadata?.machineId === 'string' ? metadata.machineId : null;
    const path = typeof metadata?.path === 'string' && metadata.path.trim().length > 0 ? metadata.path : null;
    const homeDir = typeof metadata?.homeDir === 'string' && metadata.homeDir.trim().length > 0 ? metadata.homeDir : null;
    const directory = path ?? homeDir ?? '/';
    const agentId = resolveAgentIdFromFlavor(typeof metadata?.flavor === 'string' ? metadata.flavor : null) ?? null;

    return {
        targetType: 'existing_session',
        directory,
        checkoutCreationDraft: null,
        prompt: params.message.trim(),
        displayText: params.message.trim(),
        agentId,
        backendTarget: null,
        transcriptStorage: session.encryptionMode === 'plain' ? 'direct' : 'persisted',
        profileId: typeof metadata?.profileId === 'string' ? metadata.profileId : null,
        environmentVariables: null,
        resumeSessionId: session.id,
        permissionMode: typeof session.permissionMode === 'string' ? session.permissionMode : null,
        permissionModeUpdatedAt: typeof session.permissionModeUpdatedAt === 'number' ? session.permissionModeUpdatedAt : null,
        modelId: typeof session.modelMode === 'string' ? session.modelMode : null,
        modelUpdatedAt: typeof session.modelModeUpdatedAt === 'number' ? session.modelModeUpdatedAt : null,
        mcpSelection: null,
        connectedServices: null,
        terminal: metadata?.terminal ?? null,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        experimentalCodexAcp: null,
        codexBackendMode: typeof metadata?.codexBackendMode === 'string' ? metadata.codexBackendMode : null,
        acpSessionModeId: typeof metadata?.acpSessionModesV1?.currentModeId === 'string'
            ? metadata.acpSessionModesV1.currentModeId
            : null,
        sessionConfigOptionOverrides: metadata?.acpConfigOptionOverridesV1 ?? null,
        existingSessionId: session.id,
        sessionEncryptionMode: session.encryptionMode ?? 'e2ee',
        sessionEncryptionKeyBase64: params.sessionDekBase64 ?? null,
        sessionEncryptionVariant: params.sessionDekBase64 ? 'dataKey' : null,
        automation: null,
    };
}

