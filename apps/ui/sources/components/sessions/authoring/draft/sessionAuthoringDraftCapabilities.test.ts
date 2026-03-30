import { describe, expect, it } from 'vitest';

import type { SessionAuthoringDraft } from './sessionAuthoringDraft';
import { resolveExistingSessionAuthoringCapabilities } from './sessionAuthoringDraftCapabilities';

const BASE_DRAFT: SessionAuthoringDraft = {
    targetType: 'existing_session',
    directory: '/repo/project',
    checkoutCreationDraft: null,
    prompt: 'Summarize the latest changes',
    displayText: 'Summarize the latest changes',
    agentId: 'codex',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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
    terminal: null,
    windowsRemoteSessionLaunchMode: null,
    windowsRemoteSessionConsole: null,
    experimentalCodexAcp: null,
    acpSessionModeId: null,
    existingSessionId: 'session-1',
    sessionEncryptionMode: 'e2ee',
    sessionEncryptionKeyBase64: 'secret',
    sessionEncryptionVariant: 'dataKey',
};

describe('resolveExistingSessionAuthoringCapabilities', () => {
    it('marks the composer fields as editable and inherited runtime rows as visible when the session is ready', () => {
        const capabilities = resolveExistingSessionAuthoringCapabilities({
            draft: BASE_DRAFT,
            availability: {
                kind: 'ready',
                machineId: 'machine-1',
                eligibility: {
                    eligible: true,
                    agentId: 'codex',
                    strategy: 'vendor_resume',
                },
            },
        });

        expect(capabilities).toEqual({
            message: 'editable',
            permissionMode: 'editable',
            model: 'editable',
            backend: 'inherited',
            sessionEncryption: 'inherited',
            transcriptStorage: 'inherited',
            machine: 'inherited',
            path: 'inherited',
            profile: 'inherited',
            resumeSupport: 'inherited',
            mcp: 'hidden',
            connectedServices: 'hidden',
        });
    });

    it('surfaces inherited MCP and connected-services context when the session draft carries them', () => {
        const capabilities = resolveExistingSessionAuthoringCapabilities({
            draft: {
                ...BASE_DRAFT,
                mcpSelection: {
                    forceIncludeServerIds: ['managed-1'],
                    forceExcludeServerIds: [],
                } as any,
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        github: { source: 'connected', profileId: 'github-1' },
                    },
                },
            },
            availability: {
                kind: 'ready',
                machineId: 'machine-1',
                eligibility: {
                    eligible: true,
                    agentId: 'codex',
                    strategy: 'vendor_resume',
                },
            },
        });

        expect(capabilities).toEqual({
            message: 'editable',
            permissionMode: 'editable',
            model: 'editable',
            backend: 'inherited',
            sessionEncryption: 'inherited',
            transcriptStorage: 'inherited',
            machine: 'inherited',
            path: 'inherited',
            profile: 'inherited',
            resumeSupport: 'inherited',
            mcp: 'inherited',
            connectedServices: 'inherited',
        });
    });

    it('hides inherited runtime rows when the target session is unavailable', () => {
        const capabilities = resolveExistingSessionAuthoringCapabilities({
            draft: {
                ...BASE_DRAFT,
                profileId: null,
            },
            availability: {
                kind: 'blocked',
                reason: 'session_not_found',
            },
        });

        expect(capabilities).toEqual({
            message: 'editable',
            permissionMode: 'editable',
            model: 'editable',
            backend: 'hidden',
            sessionEncryption: 'hidden',
            transcriptStorage: 'hidden',
            machine: 'hidden',
            path: 'hidden',
            profile: 'hidden',
            resumeSupport: 'hidden',
            mcp: 'hidden',
            connectedServices: 'hidden',
        });
    });
});
