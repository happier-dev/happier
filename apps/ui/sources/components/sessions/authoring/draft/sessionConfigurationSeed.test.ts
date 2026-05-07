import { describe, expect, it } from 'vitest';

import { buildNewSessionTempDataFromSessionConfiguration } from './sessionConfigurationSeed';

describe('sessionConfigurationSeed', () => {
    it('builds a promptless new-session seed from an existing session configuration', () => {
        const tempData = buildNewSessionTempDataFromSessionConfiguration({
            session: {
                id: 'session-1',
                encryptionMode: 'plain',
                metadata: {
                    path: '/workspace/source',
                    homeDir: '/workspace',
                    host: 'source.local',
                    flavor: 'codex',
                    profileId: 'profile-1',
                    transcriptStorage: 'direct',
                    codexBackendMode: 'appServer',
                    sessionModeOverrideV1: {
                        v: 1,
                        updatedAt: 100,
                        modeId: 'plan',
                    },
                    sessionConfigOptionOverridesV1: {
                        v: 1,
                        updatedAt: 101,
                        overrides: {
                            effort: { updatedAt: 101, value: 'high' },
                        },
                    },
                    mcpSelection: {
                        v: 1,
                        managedServersEnabled: false,
                        forceIncludeServerIds: ['portable'],
                        forceExcludeServerIds: ['disabled'],
                    },
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            github: { source: 'connected' },
                        },
                    },
                    terminal: {
                        mode: 'tmux',
                        tmux: { target: 'feature-pane' },
                    },
                },
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 200,
                modelMode: 'gpt-5',
                modelModeUpdatedAt: 201,
            },
            machineId: 'machine-target',
            directoryOverride: '/workspace/target',
        });

        expect(tempData).toEqual(expect.objectContaining({
            prompt: '',
            machineId: 'machine-target',
            directory: '/workspace/target',
            agentType: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelMode: 'gpt-5',
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 101,
                overrides: {
                    effort: { updatedAt: 101, value: 'high' },
                },
            },
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            },
            agentNewSessionOptionStateByAgentId: {
                'agent:codex': {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            github: { source: 'connected' },
                        },
                    },
                },
            },
            replacePersistedDraftSelections: true,
        }));
        expect(tempData.resumeSessionId).toBeUndefined();
        expect(tempData.checkoutCreationDraft).toBeNull();
    });
});
