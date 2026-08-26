import { describe, expect, it } from 'vitest';

import type { SessionDraftSnapshot } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import {
    buildNewSessionDraftPatch,
    readNewSessionDraftFromSnapshot,
} from './newSessionDraftRepositoryAdapter';

const DRAFT_ID = '8e0a5dd1-b1df-43dd-b51e-b7787b30362e';

function field<T>(mutationId: string, value: T) {
    return { mutationId, value };
}

describe('newSessionDraftRepositoryAdapter', () => {
    it('hydrates the existing new-session authoring owner from one exact draft document', () => {
        const snapshot = {
            address: { kind: 'newSession', draftId: DRAFT_ID },
            document: {
                v: 1,
                composer: {
                    text: field('text-1', 'Ship the fix'),
                    mentions: field('mentions-1', []),
                    attachments: field('attachments-1', []),
                },
                target: {
                    kind: 'newSession',
                    authoring: {
                        targetType: field('target-1', 'new_session'),
                        machineId: field('machine-1', 'machine-a'),
                        serverId: field('server-1', 'server-a'),
                        directory: field('directory-1', '/repo/a'),
                        checkoutCreationDraft: field('checkout-1', null),
                        agentId: field('agent-1', 'codex'),
                        backendTarget: field('backend-1', { kind: 'builtInAgent', agentId: 'codex' }),
                        transcriptStorage: field('transcript-1', 'direct'),
                        profileId: field('profile-1', 'profile-a'),
                        resumeSessionId: field('resume-1', 'resume-a'),
                        permissionMode: field('permission-1', 'acceptEdits'),
                        modelId: field('model-1', 'gpt-5.4'),
                        mcpSelection: field('mcp-1', null),
                        codexBackendMode: field('codex-mode-1', 'acp'),
                        acpSessionModeId: field('session-mode-1', 'plan'),
                        automation: field('automation-1', null),
                    },
                },
                extensions: {},
            },
            status: 'clean',
            conflict: null,
            createdAt: 10,
            updatedAt: 20,
            materialized: true,
            localSupplement: { launchUserAttemptId: 'attempt-a' },
        } as unknown as SessionDraftSnapshot;

        expect(readNewSessionDraftFromSnapshot(snapshot)).toEqual(expect.objectContaining({
            input: 'Ship the fix',
            launchUserAttemptId: 'attempt-a',
            selectedMachineId: 'machine-a',
            selectedPath: '/repo/a',
            targetServerId: 'server-a',
            agentType: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            transcriptStorage: 'direct',
            selectedProfileId: 'profile-a',
            resumeSessionId: 'resume-a',
            permissionMode: 'acceptEdits',
            modelMode: 'gpt-5.4',
            codexBackendMode: 'acp',
            acpSessionModeId: 'plan',
            updatedAt: 20,
        }));
    });

    it('preserves an omitted permission mode so agent defaults can hydrate it', () => {
        const snapshot = {
            address: { kind: 'newSession', draftId: DRAFT_ID },
            document: {
                v: 1,
                composer: {
                    text: field('text-1', ''),
                    mentions: field('mentions-1', []),
                    attachments: field('attachments-1', []),
                },
                target: {
                    kind: 'newSession',
                    authoring: {
                        targetType: field('target-1', 'new_session'),
                        machineId: field('machine-1', 'machine-a'),
                        serverId: field('server-1', 'server-a'),
                        directory: field('directory-1', '/repo/a'),
                        agentId: field('agent-1', 'codex'),
                        backendTarget: field('backend-1', { kind: 'builtInAgent', agentId: 'codex' }),
                        permissionMode: field('permission-1', null),
                    },
                },
                extensions: {},
            },
            status: 'clean',
            conflict: null,
            createdAt: 10,
            updatedAt: 20,
            materialized: true,
            localSupplement: {},
        } as unknown as SessionDraftSnapshot;

        const draft = readNewSessionDraftFromSnapshot(snapshot);

        expect(draft).not.toBeNull();
        expect(draft).not.toHaveProperty('permissionMode');
    });

    it('projects only the synchronized authoring catalog plus composer text', () => {
        const patch = buildNewSessionDraftPatch({
            authoringDraft: {
                targetType: 'new_session',
                directory: '/repo/b',
                prompt: 'Draft B',
                displayText: 'Draft B',
                agentId: 'codex',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                transcriptStorage: 'persisted',
                profileId: null,
                environmentVariables: { SECRET: 'must-not-sync' },
                resumeSessionId: null,
                permissionMode: 'default',
                permissionModeUpdatedAt: 123,
                modelId: null,
                modelUpdatedAt: 456,
                mcpSelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                experimentalCodexAcp: null,
                codexBackendMode: null,
                acpSessionModeId: null,
                sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: {} },
                existingSessionId: null,
                sessionEncryptionMode: null,
                sessionEncryptionKeyBase64: null,
                sessionEncryptionVariant: null,
                checkoutCreationDraft: null,
                automation: null,
            },
            machineId: 'machine-b',
            serverId: 'server-b',
            text: 'Draft B',
        });

        expect(patch.text).toBe('Draft B');
        expect(patch.authoring).toEqual(expect.objectContaining({
            targetType: 'new_session',
            directory: '/repo/b',
            machineId: 'machine-b',
            serverId: 'server-b',
        }));
        expect(patch.authoring).not.toHaveProperty('prompt');
        expect(patch.authoring).not.toHaveProperty('environmentVariables');
        expect(patch.authoring).not.toHaveProperty('sessionConfigOptionOverrides');
    });
});
