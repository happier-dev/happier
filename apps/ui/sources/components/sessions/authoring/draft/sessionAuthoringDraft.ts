import type { BackendTargetRefV1, SessionMcpSelectionV1, WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';

import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';

export type SessionAuthoringCheckoutCreationDraft = Readonly<{
    kind: 'git_worktree';
    displayName: string;
    baseRef: string | null;
}>;

export type SessionAuthoringDraft = Readonly<{
    targetType: 'new_session' | 'existing_session';
    directory: string;
    checkoutCreationDraft: SessionAuthoringCheckoutCreationDraft | null;
    prompt: string;
    displayText: string;
    agentId: string | null;
    backendTarget: BackendTargetRefV1 | null;
    transcriptStorage: 'persisted' | 'direct' | null;
    profileId: string | null;
    environmentVariables: Record<string, string> | null;
    resumeSessionId: string | null;
    permissionMode: string | null;
    permissionModeUpdatedAt: number | null;
    modelId: string | null;
    modelUpdatedAt: number | null;
    mcpSelection: SessionMcpSelectionV1 | null;
    connectedServices: Record<string, unknown> | null;
    terminal: unknown;
    windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchMode | null;
    windowsRemoteSessionConsole: 'hidden' | 'visible' | null;
    experimentalCodexAcp: boolean | null;
    codexBackendMode: string | null;
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: Record<string, unknown> | null;
    existingSessionId: string | null;
    sessionEncryptionMode: 'e2ee' | 'plain' | null;
    sessionEncryptionKeyBase64: string | null;
    sessionEncryptionVariant: 'dataKey' | null;
    automation: NewSessionAutomationDraft | null;
}>;

