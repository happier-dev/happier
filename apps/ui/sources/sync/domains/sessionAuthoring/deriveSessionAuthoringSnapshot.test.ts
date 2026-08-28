import { describe, expect, it } from 'vitest';
import { SessionModelSelectionIntentV1Schema, type CodexBackendMode } from '@happier-dev/protocol';

import { deriveSessionAuthoringSnapshot } from './deriveSessionAuthoringSnapshot';

describe('deriveSessionAuthoringSnapshot', () => {
    const legacyCodexBackendMode = '  mcp_resume  ' as unknown as CodexBackendMode;

    it('derives the authoring-relevant live session snapshot from session metadata and overrides', () => {
        const snapshot = deriveSessionAuthoringSnapshot({
            session: {
                id: 'session-1',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/project',
                    host: 'qa-host',
                    homeDir: '/tmp',
                    profileId: 'profile-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-session-1',
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        agent: { backendMode: 'acp', providerSessionId: 'codex-session-1' },
                    },
                    permissionMode: 'read-only',
                    permissionModeUpdatedAt: 10,
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 20,
                        backendId: 'review-bot',
                        title: 'Review Bot',
                    },
                    mcpSelection: {
                        forceIncludeServerIds: ['managed-1'],
                        forceExcludeServerIds: [],
                    },
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            github: { source: 'connected' },
                        },
                    },
                    terminal: {
                        mode: 'tmux',
                        tmux: { target: 'happy-dev' },
                    },
                },
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 123,
                modelMode: 'gpt-5',
                modelModeUpdatedAt: 456,
            },
            sessionDekBase64: 'dek-base64',
        });

        expect(snapshot).toEqual({
            directory: '/tmp/project',
            agentId: null,
            backendTarget: {
                kind: 'backend',
                backendId: 'review-bot',
                sourceKind: 'configured',
                configuredBackendId: 'review-bot',
            },
            transcriptStorage: null,
            profileId: 'profile-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: {
                v: 1,
                updatedAt: 456,
                ref: {
                    agentTargetKey: 'backend:review-bot:configured:review-bot',
                    providerConnectionId: null,
                    modelId: 'gpt-5',
                },
            },
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            mcpSelection: {
                v: 1,
                managedServersEnabled: true,
                forceIncludeServerIds: ['managed-1'],
                forceExcludeServerIds: [],
            },
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    github: { source: 'connected' },
                },
            },
            terminal: { mode: 'tmux', tmux: { sessionName: 'happy-dev' } },
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'acp', providerSessionId: 'codex-session-1' },
            },
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'e2ee',
            sessionEncryptionKeyBase64: 'dek-base64',
            sessionEncryptionVariant: 'dataKey',
        });
    });

    it('falls back to the session home directory and plain session encryption state when path and dek are absent', () => {
        const snapshot = deriveSessionAuthoringSnapshot({
            session: {
                id: 'session-2',
                encryptionMode: 'plain',
                metadata: {
                    path: '/home/leeroy',
                    homeDir: '/home/leeroy',
                    host: 'qa-host',
                    agent: 'codex',
                },
                permissionMode: 'default',
                permissionModeUpdatedAt: null,
                modelMode: 'default',
                modelModeUpdatedAt: null,
            },
            sessionDekBase64: null,
        });

        expect(snapshot.directory).toBe('/home/leeroy');
        expect(snapshot.backendTarget?.kind).toBe('backend');
        expect(snapshot.agentId).toBe(snapshot.backendTarget?.kind === 'backend' ? snapshot.backendTarget.backendId : null);
        expect(snapshot.runtimeDescriptorV1).toBeNull();
        expect(snapshot.existingSessionId).toBe('session-2');
        expect(snapshot.sessionEncryptionMode).toBe('plain');
        expect(snapshot.sessionEncryptionKeyBase64).toBeNull();
        expect(snapshot.sessionEncryptionVariant).toBeNull();
    });

    it('normalizes Codex backend aliases from the plugin-owned runtime descriptor', () => {
        const snapshot = deriveSessionAuthoringSnapshot({
            session: {
                id: 'session-3',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/project',
                    host: 'qa-host',
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        agent: { backendMode: legacyCodexBackendMode },
                    },
                },
                permissionMode: 'default',
                permissionModeUpdatedAt: null,
                modelMode: 'default',
                modelModeUpdatedAt: null,
            },
            sessionDekBase64: null,
        });

        expect(snapshot.runtimeDescriptorV1).toMatchObject({
            agentId: 'codex',
            agent: { backendMode: 'acp' },
        });
    });

    it('does not treat the released top-level Codex selector as current authoring state', () => {
        const snapshot = deriveSessionAuthoringSnapshot({
            session: {
                id: 'session-released-codex-mode',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/project',
                    host: 'qa-host',
                    codexBackendMode: 'appServer',
                },
                permissionMode: 'default',
                permissionModeUpdatedAt: null,
                modelMode: 'default',
                modelModeUpdatedAt: null,
            },
            sessionDekBase64: null,
        });

        expect(snapshot.runtimeDescriptorV1).toBeNull();
    });

    it('reads permission mode through the canonical metadata resolver', () => {
        const snapshot = deriveSessionAuthoringSnapshot({
            session: {
                id: 'session-4',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/project',
                    host: 'qa-host',
                    permissionMode: 'acceptEdits',
                    permissionModeUpdatedAt: 42,
                },
                permissionMode: 'default',
                permissionModeUpdatedAt: null,
                modelMode: 'default',
                modelModeUpdatedAt: null,
            },
            sessionDekBase64: null,
        });

        expect(snapshot.permissionMode).toBe('safe-yolo');
        expect(snapshot.permissionModeUpdatedAt).toBe(42);
    });

    it('does not reinterpret a newer same-id presentation value as a native selection', () => {
        const snapshot = deriveSessionAuthoringSnapshot({
            session: {
                id: 'session-provider',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/project',
                    host: 'qa-host',
                    flavor: 'codex',
                    modelSelectionIntentV1: SessionModelSelectionIntentV1Schema.parse({
                        v: 1,
                        updatedAt: 20,
                        selection: {
                            agentTargetKey: 'backend:codex',
                            providerConnectionId: 'pc_01J00000000000000000000000',
                            modelId: 'shared-id',
                        },
                    }),
                },
                permissionMode: 'default',
                permissionModeUpdatedAt: null,
                modelMode: 'shared-id',
                modelModeUpdatedAt: 30,
            },
            sessionDekBase64: null,
        });

        expect(snapshot.modelSelection?.ref).toEqual({
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_01J00000000000000000000000',
            modelId: 'shared-id',
        });
    });

    it('does not let a newer different-id presentation value downgrade a Provider-bound selection', () => {
        const snapshot = deriveSessionAuthoringSnapshot({
            session: {
                id: 'session-provider-different-presentation',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/project',
                    host: 'qa-host',
                    flavor: 'codex',
                    modelSelectionIntentV1: SessionModelSelectionIntentV1Schema.parse({
                        v: 1,
                        updatedAt: 20,
                        selection: {
                            agentTargetKey: 'backend:codex',
                            providerConnectionId: 'pc_01J00000000000000000000000',
                            modelId: 'provider-model',
                        },
                    }),
                },
                permissionMode: 'default',
                permissionModeUpdatedAt: null,
                modelMode: 'native-presentation-model',
                modelModeUpdatedAt: 30,
            },
            sessionDekBase64: null,
        });

        expect(snapshot.modelSelection).toEqual({
            v: 1,
            updatedAt: 20,
            ref: {
                agentTargetKey: 'backend:codex',
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'provider-model',
            },
        });
    });
});
