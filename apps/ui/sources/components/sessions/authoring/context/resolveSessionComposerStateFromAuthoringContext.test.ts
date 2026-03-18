import { describe, expect, it } from 'vitest';

import type { SessionAuthoringDraft } from '../draft/sessionAuthoringDraft';
import type { ExistingSessionAutomationAuthoringContext } from './sessionAuthoringContext';
import { resolveSessionComposerStateFromAuthoringContext } from './resolveSessionComposerStateFromAuthoringContext';

const BASE_DRAFT: SessionAuthoringDraft = {
    targetType: 'existing_session',
    directory: '/repo/draft',
    checkoutCreationDraft: null,
    prompt: 'Summarize changes',
    displayText: 'Summarize changes',
    agentId: 'claude',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    transcriptStorage: 'direct',
    profileId: 'profile-draft',
    environmentVariables: null,
    resumeSessionId: null,
    permissionMode: 'default',
    permissionModeUpdatedAt: 123,
    modelId: 'gpt-5',
    modelUpdatedAt: 456,
    mcpSelection: null,
    connectedServices: null,
    terminal: { mode: 'integrated' },
    windowsRemoteSessionLaunchMode: null,
    windowsRemoteSessionConsole: null,
    experimentalCodexAcp: null,
    codexBackendMode: null,
    acpSessionModeId: null,
    sessionConfigOptionOverrides: null,
    existingSessionId: 'session-1',
    sessionEncryptionMode: 'e2ee',
    sessionEncryptionKeyBase64: 'dek-1',
    sessionEncryptionVariant: 'dataKey',
    automation: null,
};

describe('resolveSessionComposerStateFromAuthoringContext', () => {
    it('prefers the draft values for an existing-session automation composer', () => {
        const context: ExistingSessionAutomationAuthoringContext = {
            kind: 'automationExistingSession',
            session: {
                id: 'session-1',
                encryptionMode: 'e2ee',
                metadata: {
                    displayName: 'Builder',
                    host: 'qa-host',
                    machineId: 'machine-1',
                    path: '/repo/live',
                },
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 1,
                modelMode: 'claude-sonnet-4-5',
                modelModeUpdatedAt: 1,
            } as any,
            draft: BASE_DRAFT,
            availability: {
                kind: 'ready',
                machineId: 'machine-1',
            },
        };

        const state = resolveSessionComposerStateFromAuthoringContext(context);

        expect(state.agentId).toBe('claude');
        expect(state.machineName).toBe('Builder');
        expect(state.permissionMode).toBe('default');
        expect(state.modelMode).toBe('gpt-5');
        expect(state.profileId).toBe('profile-draft');
        expect(state.currentPath).toBe('/repo/draft');
    });
});

