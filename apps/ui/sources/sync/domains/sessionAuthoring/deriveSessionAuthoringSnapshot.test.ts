import { describe, expect, it } from 'vitest';
import type { CodexBackendMode } from '@happier-dev/agents';

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
                    codexBackendMode: 'acp',
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
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: null,
            profileId: 'profile-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
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
            codexBackendMode: 'acp',
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
        expect(snapshot.backendTarget?.kind).toBe('builtInAgent');
        expect(snapshot.agentId).toBe(snapshot.backendTarget?.kind === 'builtInAgent' ? snapshot.backendTarget.agentId : null);
        expect(snapshot.codexBackendMode).toBeNull();
        expect(snapshot.existingSessionId).toBe('session-2');
        expect(snapshot.sessionEncryptionMode).toBe('plain');
        expect(snapshot.sessionEncryptionKeyBase64).toBeNull();
        expect(snapshot.sessionEncryptionVariant).toBeNull();
    });

    it('normalizes legacy codex backend aliases from session metadata', () => {
        const snapshot = deriveSessionAuthoringSnapshot({
            session: {
                id: 'session-3',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/project',
                    host: 'qa-host',
                    codexBackendMode: legacyCodexBackendMode,
                },
                permissionMode: 'default',
                permissionModeUpdatedAt: null,
                modelMode: 'default',
                modelModeUpdatedAt: null,
            },
            sessionDekBase64: null,
        });

        expect(snapshot.codexBackendMode).toBe('acp');
    });
});
