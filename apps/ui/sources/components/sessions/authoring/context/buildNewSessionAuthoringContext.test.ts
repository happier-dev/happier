import { describe, expect, it } from 'vitest';

import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';

import { buildNewSessionAuthoringContext } from './buildNewSessionAuthoringContext';

const BASE_DRAFT: SessionAuthoringDraft = {
    targetType: 'new_session',
    directory: '/repo/project',
    checkoutCreationDraft: null,
    prompt: 'Review changes',
    displayText: 'Review changes',
    agentId: 'claude',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    transcriptStorage: 'direct',
    profileId: null,
    environmentVariables: null,
    resumeSessionId: null,
    permissionMode: 'acceptEdits',
    permissionModeUpdatedAt: null,
    modelId: 'gpt-5',
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
    existingSessionId: null,
    sessionEncryptionMode: null,
    sessionEncryptionKeyBase64: null,
    sessionEncryptionVariant: null,
    automation: null,
};

describe('buildNewSessionAuthoringContext', () => {
    it('builds automation authoring context that allows offline-machine save and edit mode', () => {
        const context = buildNewSessionAuthoringContext({
            automationDraft: {
                enabled: true,
                name: 'Nightly summary',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            },
            automationFeatureEnabled: true,
            selectedMachineId: 'machine-1',
            selectedMachine: { id: 'machine-1', active: false, activeAt: 0 } as any,
            selectedPath: '/repo/project',
            automationEditId: 'automation-1',
            buildDraft: (effectiveAutomationDraft) => ({
                ...BASE_DRAFT,
                automation: effectiveAutomationDraft.enabled ? effectiveAutomationDraft : null,
            }),
        });

        expect(context.submissionMode).toBe('editAutomation');
        expect(context.submitAccessibilityLabelKey).toBe('automations.edit.saveAutomationLabel');
        expect(context.showAutomationActionChips).toBe(true);
        expect(context.effectiveAutomationDraft.enabled).toBe(true);
        expect(context.canSubmit).toBe(true);
        expect(context.draft.automation?.enabled).toBe(true);
    });

    it('builds automation authoring context that exposes the create label key for new automations', () => {
        const context = buildNewSessionAuthoringContext({
            automationDraft: {
                enabled: true,
                name: 'Nightly summary',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            },
            automationFeatureEnabled: true,
            selectedMachineId: 'machine-1',
            selectedMachine: { id: 'machine-1', active: true, activeAt: 0 } as any,
            selectedPath: '/repo/project',
            automationEditId: null,
            buildDraft: (effectiveAutomationDraft) => ({
                ...BASE_DRAFT,
                automation: effectiveAutomationDraft.enabled ? effectiveAutomationDraft : null,
            }),
        });

        expect(context.submissionMode).toBe('createAutomation');
        expect(context.submitAccessibilityLabelKey).toBe('automations.create.createButtonTitle');
        expect(context.canSubmit).toBe(true);
    });

    it('disables automation mode when feature support is unavailable and falls back to live launch gating', () => {
        const context = buildNewSessionAuthoringContext({
            automationDraft: {
                enabled: true,
                name: 'Nightly summary',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            },
            automationFeatureEnabled: false,
            selectedMachineId: 'machine-1',
            selectedMachine: { id: 'machine-1', active: false, activeAt: 0 } as any,
            selectedPath: '/repo/project',
            automationEditId: null,
            buildDraft: (effectiveAutomationDraft) => ({
                ...BASE_DRAFT,
                automation: effectiveAutomationDraft.enabled ? effectiveAutomationDraft : null,
            }),
        });

        expect(context.submissionMode).toBe('launch');
        expect(context.submitAccessibilityLabelKey).toBeUndefined();
        expect(context.showAutomationActionChips).toBe(false);
        expect(context.effectiveAutomationDraft.enabled).toBe(false);
        expect(context.canSubmit).toBe(false);
        expect(context.draft.automation).toBeNull();
    });
});
