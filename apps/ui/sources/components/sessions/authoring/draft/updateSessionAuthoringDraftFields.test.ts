import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema, SessionModelSelectionV1Schema } from '@happier-dev/protocol';

import type { SessionAuthoringDraft } from './sessionAuthoringDraft';
import { updateSessionAuthoringDraftModelMode } from './updateSessionAuthoringDraftFields';

const BASE_DRAFT: SessionAuthoringDraft = {
    targetType: 'existing_session',
    directory: '/repo/project',
    checkoutCreationDraft: null,
    prompt: 'Summarize the latest changes',
    displayText: 'Summarize the latest changes',
    agentId: 'claude',
    backendTarget: { kind: 'backend', backendId: 'claude' },
    transcriptStorage: 'direct',
    profileId: null,
    environmentVariables: null,
    resumeSessionId: null,
    permissionMode: 'acceptEdits',
    permissionModeUpdatedAt: 123,
    modelId: null,
    modelUpdatedAt: null,
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

describe('updateSessionAuthoringDraftModelMode', () => {
    it('preserves the exact Provider tuple when a legacy composer repeats its current model id', () => {
        const providerSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 456,
            ref: {
                agentTargetKey: 'backend:claude',
                providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
                modelId: 'vendor/model',
            },
        });
        const draft = { ...BASE_DRAFT, modelSelection: providerSelection };

        const updated = updateSessionAuthoringDraftModelMode(draft, 'vendor/model', 999);

        expect(updated.modelSelection).toBe(providerSelection);
        expect(updated.modelSelection?.ref).toEqual({
            agentTargetKey: 'backend:claude',
            providerConnectionId: 'pc_work',
            modelId: 'vendor/model',
        });
    });

    it('creates a native tuple only when the composer selects a different model id', () => {
        const providerSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 456,
            ref: {
                agentTargetKey: 'backend:claude',
                providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
                modelId: 'vendor/model',
            },
        });

        const updated = updateSessionAuthoringDraftModelMode(
            { ...BASE_DRAFT, modelSelection: providerSelection },
            'claude-sonnet-4-6',
            999,
        );

        expect(updated.modelSelection).toEqual({
            v: 1,
            updatedAt: 999,
            ref: {
                agentTargetKey: 'backend:claude',
                providerConnectionId: null,
                modelId: 'claude-sonnet-4-6',
            },
        });
    });
});
