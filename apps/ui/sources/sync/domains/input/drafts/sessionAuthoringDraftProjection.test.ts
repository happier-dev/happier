import { describe, expect, it } from 'vitest';

import { projectSyncedSessionAuthoringFields } from './sessionAuthoringDraftProjection';

describe('projectSyncedSessionAuthoringFields', () => {
    it('projects every catalogued synchronized launch selection and excludes private or duplicate owners', () => {
        const projected = projectSyncedSessionAuthoringFields({
            targetType: 'new_session',
            machineId: 'machine-a',
            serverId: 'server-a',
            directory: '/workspace/repo',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/drafts',
                baseRef: 'main',
            },
            prompt: 'composer.text owns this',
            displayText: 'derived',
            agentId: 'codex',
            backendTarget: null,
            transcriptStorage: 'persisted',
            profileId: 'profile-a',
            environmentVariables: { SECRET: 'never-sync' },
            resumeSessionId: null,
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 124,
            mcpSelection: null,
            connectedServices: null,
            connectedServicesUpdatedAt: 125,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            existingSessionId: 'session-secret-owner',
            sessionEncryptionMode: 'e2ee',
            sessionEncryptionKeyBase64: 'never-sync-dek',
            sessionEncryptionVariant: 'dataKey',
            automation: null,
        });

        expect(projected).toEqual(expect.objectContaining({
            targetType: 'new_session',
            machineId: 'machine-a',
            serverId: 'server-a',
            directory: '/workspace/repo',
            agentId: 'codex',
            permissionMode: 'acceptEdits',
        }));
        expect(projected).not.toEqual(expect.objectContaining({
            prompt: expect.anything(),
            displayText: expect.anything(),
            environmentVariables: expect.anything(),
            permissionModeUpdatedAt: expect.anything(),
            modelUpdatedAt: expect.anything(),
            modelId: expect.anything(),
            connectedServicesUpdatedAt: expect.anything(),
            existingSessionId: expect.anything(),
            sessionEncryptionMode: expect.anything(),
            sessionEncryptionKeyBase64: expect.anything(),
            sessionEncryptionVariant: expect.anything(),
        }));
    });

    it('isolates a malformed catalogued field without dropping valid siblings', () => {
        expect(projectSyncedSessionAuthoringFields({
            targetType: 'new_session',
            machineId: 'machine-a',
            directory: '',
            permissionMode: 'default',
        })).toEqual({
            targetType: 'new_session',
            machineId: 'machine-a',
            permissionMode: 'default',
        });
    });

    it('uses the synchronized draft schemas to reject private nested runtime and credential data', () => {
        expect(projectSyncedSessionAuthoringFields({
            machineId: 'machine-a',
            terminal: {
                mode: 'tmux',
                tmux: { sessionName: 'safe-name', tmpDir: '/private/local/path' },
            },
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    github: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'profile-a',
                        token: 'must-not-sync',
                    },
                },
            },
            sessionConfigOptionOverrides: { apiKey: 'must-not-sync' },
            environmentVariables: { SECRET: 'must-not-sync' },
            sessionEncryptionKeyBase64: 'must-not-sync',
        })).toEqual({ machineId: 'machine-a' });
    });
});

