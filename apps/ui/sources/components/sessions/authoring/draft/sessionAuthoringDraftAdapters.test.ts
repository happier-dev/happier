import { describe, expect, it } from 'vitest';

import { decodeAutomationTemplate } from '@/sync/domains/automations/automationTemplateCodec';

import { buildAutomationTemplateFromSessionAuthoringDraft } from './buildAutomationTemplateFromSessionAuthoringDraft';
import { buildExistingSessionAuthoringDraftFromSession } from './buildExistingSessionAuthoringDraftFromSession';

describe('session authoring draft adapters', () => {
    it('builds a session automation template from the draft and preserves the existing-session id', () => {
        const template = buildAutomationTemplateFromSessionAuthoringDraft({
            targetType: 'existing_session',
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Send the daily summary',
            displayText: 'Send the daily summary',
            agentId: 'claude',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: 'resume-1',
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
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'e2ee',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
            automation: null,
        });

        expect(template).toEqual(expect.objectContaining({
            directory: '/tmp/project',
            prompt: 'Send the daily summary',
            displayText: 'Send the daily summary',
            agent: 'claude',
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            resume: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            existingSessionId: 'session-1',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
        }));
    });

    it('builds an existing-session draft from a live session snapshot', () => {
        const draft = buildExistingSessionAuthoringDraftFromSession({
            session: {
                id: 'session-1',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/project',
                    host: 'qa-host',
                    homeDir: '/tmp',
                    profileId: 'profile-1',
                    flavor: 'codex',
                    machineId: 'machine-1',
                },
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 123,
                modelMode: 'gpt-5',
                modelModeUpdatedAt: 456,
            } as any,
            message: 'Send the daily summary',
            sessionDekBase64: 'dek-base64',
        });

        expect(draft).toEqual(expect.objectContaining({
            targetType: 'existing_session',
            directory: '/tmp/project',
            prompt: 'Send the daily summary',
            displayText: 'Send the daily summary',
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'e2ee',
            sessionEncryptionKeyBase64: 'dek-base64',
        }));
    });

    it('decodes the session automation template without dropping the existing-session id', () => {
        const template = decodeAutomationTemplate(JSON.stringify({
            directory: '/tmp/project',
            prompt: 'Review the repo',
            displayText: 'Review the repo',
            existingSessionId: 'session-1',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
        }));

        expect(template?.existingSessionId).toBe('session-1');
    });
});

