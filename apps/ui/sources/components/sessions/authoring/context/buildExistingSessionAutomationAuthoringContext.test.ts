import { describe, expect, it } from 'vitest';

import type { ExistingSessionAutomationAvailability } from './sessionAuthoringContext';
import type { SessionAuthoringDraft } from '../draft/sessionAuthoringDraft';
import { buildExistingSessionAutomationAuthoringContext } from './buildExistingSessionAutomationAuthoringContext';

const BASE_DRAFT: SessionAuthoringDraft = {
    targetType: 'existing_session',
    directory: '/repo/project',
    checkoutCreationDraft: null,
    prompt: 'Summarize the latest changes',
    displayText: 'Summarize the latest changes',
    agentId: 'claude',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    transcriptStorage: 'direct',
    profileId: 'profile-1',
    environmentVariables: null,
    resumeSessionId: null,
    permissionMode: 'acceptEdits',
    permissionModeUpdatedAt: 123,
    modelId: 'gpt-5',
    modelUpdatedAt: 456,
    mcpSelection: null,
    connectedServices: null,
    terminal: { mode: 'integrated' },
    windowsRemoteSessionLaunchMode: null,
    windowsRemoteSessionConsole: null,
    experimentalCodexAcp: null,
    codexBackendMode: 'appServer',
    acpSessionModeId: null,
    sessionConfigOptionOverrides: null,
    existingSessionId: 'session-1',
    sessionEncryptionMode: 'e2ee',
    sessionEncryptionKeyBase64: 'dek-1',
    sessionEncryptionVariant: 'dataKey',
    automation: {
        enabled: true,
        name: 'Nightly summary',
        description: 'Summarize the latest state',
        scheduleKind: 'interval',
        everyMinutes: 60,
        cronExpr: '0 * * * *',
        timezone: 'Europe/Zurich',
    },
};

const READY_AVAILABILITY: ExistingSessionAutomationAvailability = {
    kind: 'ready',
    machineId: 'machine-1',
};

describe('buildExistingSessionAutomationAuthoringContext', () => {
    it('keeps the session snapshot and availability together for the automation composer', () => {
        const context = buildExistingSessionAutomationAuthoringContext({
            session: {
                id: 'session-1',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/repo/project',
                    host: 'qa-host',
                    profileId: 'profile-1',
                    flavor: 'claude',
                    machineId: 'machine-1',
                },
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 123,
                modelMode: 'gpt-5',
                modelModeUpdatedAt: 456,
            } as any,
            draft: BASE_DRAFT,
            availability: READY_AVAILABILITY,
        });

        expect(context.kind).toBe('automationExistingSession');
        expect(context.draft.prompt).toBe('Summarize the latest changes');
        expect(context.session.id).toBe('session-1');
        expect(context.availability.kind).toBe('ready');
    });
});

