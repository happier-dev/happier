import { describe, expect, it } from 'vitest';

import { projectNewSessionDraftSyncedAuthoringFields, projectSyncedSessionAuthoringFields, projectPredecessorSessionDraftAuthoringFields } from './sessionAuthoringDraftProjection';

describe('projectSyncedSessionAuthoringFields', () => {
    it('maps the predecessor configured selection and retains its definition without bundled fallback', () => {
        // ../0.2 e087d15a backendTargets/backendTargetRef.ts writes this exact selection.
        expect(projectPredecessorSessionDraftAuthoringFields({ agentId: 'customAcp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-a' } }, 10))
            .toMatchObject({ agentTarget: { kind: 'agent',
                identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-a' } });
    });
    it('projects every catalogued synchronized launch selection and excludes private or duplicate owners', () => {
        const projected = projectSyncedSessionAuthoringFields({
            targetType: 'new_session',
            executionTarget: {
                kind: 'machine',
                target: { serverId: 'server-a', machineId: 'machine-a' },
                selectionOrigin: {
                    kind: 'machine_pool',
                    poolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                },
            },
            directory: '/workspace/repo',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/drafts',
                baseRef: 'main',
            },
            organizationPlacement: { folderId: null, tagIds: [] },
            prompt: 'composer.text owns this',
            displayText: 'derived',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            transcriptStorage: 'persisted',
            profileId: 'profile-a',
            environmentVariables: { SECRET: 'never-sync' },
            resumeSessionId: null,
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: null,
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
            executionTarget: {
                kind: 'machine',
                target: { serverId: 'server-a', machineId: 'machine-a' },
                selectionOrigin: {
                    kind: 'machine_pool',
                    poolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                },
            },
            directory: '/workspace/repo',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
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

    it('rejects the retired flat launch-selection vocabulary instead of projecting it', () => {
        expect(projectSyncedSessionAuthoringFields({
            targetType: 'new_session',
            machineId: 'machine-a',
            serverId: 'server-a',
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            directory: '/workspace/repo',
        })).toEqual({
            targetType: 'new_session',
            directory: '/workspace/repo',
        });
    });

    it('isolates a malformed catalogued field without dropping valid siblings', () => {
        expect(projectSyncedSessionAuthoringFields({
            targetType: 'new_session',
            executionTarget: { kind: 'machine', target: { serverId: 'server-a', machineId: 'machine-a' } },
            directory: '',
            permissionMode: 'default',
        })).toEqual({
            targetType: 'new_session',
            executionTarget: { kind: 'machine', target: { serverId: 'server-a', machineId: 'machine-a' } },
            permissionMode: 'default',
        });
    });

    it('uses the synchronized draft schemas to reject private nested runtime and credential data', () => {
        expect(projectSyncedSessionAuthoringFields({
            executionTarget: { kind: 'machine', target: { serverId: 'server-a', machineId: 'machine-a' } },
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
        })).toEqual({
            executionTarget: { kind: 'machine', target: { serverId: 'server-a', machineId: 'machine-a' } },
        });
    });
});

describe('projectNewSessionDraftSyncedAuthoringFields', () => {
    it('normalizes the retired draft vocabulary onto the canonical execution and Agent targets', () => {
        expect(projectNewSessionDraftSyncedAuthoringFields({
            draft: {
                input: '',
                selectedMachineId: 'machine-b',
                selectedPath: '/repo',
                selectedProfileId: null,
                selectedSecretId: null,
                targetServerId: 'server-b',
                agentType: 'codex',
                permissionMode: 'default',
                acpSessionModeId: null,
                updatedAt: 1,
            },
            scopeServerId: 'server-a',
        })).toMatchObject({
            targetType: 'new_session',
            executionTarget: {
                kind: 'machine',
                target: { serverId: 'server-b', machineId: 'machine-b' },
            },
            directory: '/repo',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            permissionMode: 'default',
        });
    });

    it('falls back to the draft scope server when the compat selection names no server', () => {
        expect(projectNewSessionDraftSyncedAuthoringFields({
            draft: {
                input: '',
                selectedMachineId: 'machine-b',
                selectedPath: '/repo',
                selectedProfileId: null,
                selectedSecretId: null,
                agentType: 'codex',
                permissionMode: 'default',
                acpSessionModeId: null,
                updatedAt: 1,
            },
            scopeServerId: 'server-a',
        })).toMatchObject({
            executionTarget: {
                kind: 'machine',
                target: { serverId: 'server-a', machineId: 'machine-b' },
            },
        });
    });

    it('prefers the canonical draft selections over the retired compat fields', () => {
        expect(projectNewSessionDraftSyncedAuthoringFields({
            draft: {
                input: '',
                selectedMachineId: 'machine-compat',
                selectedPath: '/repo',
                selectedProfileId: null,
                selectedSecretId: null,
                targetServerId: 'server-compat',
                executionTarget: {
                    kind: 'machine',
                    target: { serverId: 'server-canonical', machineId: 'machine-canonical' },
                    selectionOrigin: {
                        kind: 'machine_pool',
                        poolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                    },
                },
                agentType: 'claude',
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                permissionMode: 'default',
                acpSessionModeId: null,
                updatedAt: 1,
            },
            scopeServerId: 'server-a',
        })).toMatchObject({
            executionTarget: {
                kind: 'machine',
                target: { serverId: 'server-canonical', machineId: 'machine-canonical' },
                selectionOrigin: {
                    kind: 'machine_pool',
                    poolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                },
            },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        });
    });
});
