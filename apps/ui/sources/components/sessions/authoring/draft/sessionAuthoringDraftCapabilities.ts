import type { ExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';

import type { SessionAuthoringDraft } from './sessionAuthoringDraft';

export type SessionAuthoringFieldCapability = 'editable' | 'inherited' | 'hidden';

export type ExistingSessionAuthoringCapabilities = Readonly<{
    message: SessionAuthoringFieldCapability;
    permissionMode: SessionAuthoringFieldCapability;
    model: SessionAuthoringFieldCapability;
    backend: SessionAuthoringFieldCapability;
    sessionEncryption: SessionAuthoringFieldCapability;
    transcriptStorage: SessionAuthoringFieldCapability;
    machine: SessionAuthoringFieldCapability;
    path: SessionAuthoringFieldCapability;
    profile: SessionAuthoringFieldCapability;
    resumeSupport: SessionAuthoringFieldCapability;
    mcp: SessionAuthoringFieldCapability;
    connectedServices: SessionAuthoringFieldCapability;
}>;

export function resolveExistingSessionAuthoringCapabilities(params: Readonly<{
    draft: SessionAuthoringDraft;
    availability: ExistingSessionAutomationAvailability;
}>): ExistingSessionAuthoringCapabilities {
    const inheritedRuntimeVisible = params.availability.kind === 'ready';
    const hasBackend = !!params.draft.backendTarget
        || (typeof params.draft.agentId === 'string' && params.draft.agentId.trim().length > 0);
    const hasSessionEncryption = params.draft.sessionEncryptionMode === 'e2ee' || params.draft.sessionEncryptionMode === 'plain';
    const hasTranscriptStorage = params.draft.transcriptStorage === 'direct' || params.draft.transcriptStorage === 'persisted';
    const hasProfile = typeof params.draft.profileId === 'string' && params.draft.profileId.trim().length > 0;
    const hasMcpSelection = !!params.draft.mcpSelection
        && (
            (Array.isArray(params.draft.mcpSelection.forceIncludeServerIds) && params.draft.mcpSelection.forceIncludeServerIds.length > 0)
            || (Array.isArray(params.draft.mcpSelection.forceExcludeServerIds) && params.draft.mcpSelection.forceExcludeServerIds.length > 0)
            || params.draft.mcpSelection.managedServersEnabled === false
        );
    const connectedServices = params.draft.connectedServices;
    const hasConnectedServices = !!connectedServices
        && typeof connectedServices === 'object'
        && !Array.isArray(connectedServices)
        && typeof (connectedServices as { v?: unknown }).v === 'number'
        && !!(connectedServices as { bindingsByServiceId?: unknown }).bindingsByServiceId
        && Object.values((connectedServices as { bindingsByServiceId: Record<string, { source?: unknown }> }).bindingsByServiceId)
            .some((binding) => binding?.source === 'connected');

    return {
        message: 'editable',
        permissionMode: 'editable',
        model: 'editable',
        backend: inheritedRuntimeVisible && hasBackend ? 'inherited' : 'hidden',
        sessionEncryption: inheritedRuntimeVisible && hasSessionEncryption ? 'inherited' : 'hidden',
        transcriptStorage: inheritedRuntimeVisible && hasTranscriptStorage ? 'inherited' : 'hidden',
        machine: inheritedRuntimeVisible ? 'inherited' : 'hidden',
        path: inheritedRuntimeVisible ? 'inherited' : 'hidden',
        profile: inheritedRuntimeVisible && hasProfile ? 'inherited' : 'hidden',
        resumeSupport: inheritedRuntimeVisible ? 'inherited' : 'hidden',
        mcp: inheritedRuntimeVisible && hasMcpSelection ? 'inherited' : 'hidden',
        connectedServices: inheritedRuntimeVisible && hasConnectedServices ? 'inherited' : 'hidden',
    };
}
