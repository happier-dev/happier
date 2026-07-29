import { describe, expect, it } from 'vitest';

import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';

import type {
    ExistingSessionAutomationAuthoringContext,
    LiveSessionAuthoringContext,
} from './sessionAuthoringContext';
import { resolveSessionComposerStateFromAuthoringContext } from './resolveSessionComposerStateFromAuthoringContext';

const BASE_SNAPSHOT = {
    agentId: 'claude',
    permissionMode: 'acceptEdits',
    modelId: 'claude-sonnet-4-5',
    profileId: 'profile-snapshot',
    directory: '/repo/snapshot',
} as const;

const BASE_SESSION = {
    id: 'session-1',
    encryptionMode: 'e2ee',
    metadata: {
        displayName: 'Builder',
        host: 'qa-host',
        machineId: 'machine-1',
        path: '/repo/live',
        flavor: 'claude',
    },
    permissionMode: 'acceptEdits',
    permissionModeUpdatedAt: 1,
    modelMode: 'claude-sonnet-4-5',
    modelModeUpdatedAt: 1,
} as const;

const BASE_DRAFT: SessionAuthoringDraft = {
    targetType: 'existing_session',
    directory: '/repo/draft',
    checkoutCreationDraft: null,
    prompt: 'Summarize changes',
    displayText: 'Summarize changes',
    agentId: 'claude',
    backendTarget: { kind: 'backend', backendId: 'claude' },
    transcriptStorage: 'direct',
    profileId: 'profile-draft',
    environmentVariables: null,
    resumeSessionId: null,
    permissionMode: 'default',
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
    sessionEncryptionKeyBase64: 'dek-1',
    sessionEncryptionVariant: 'dataKey',
    automation: null,
};

describe('resolveSessionComposerStateFromAuthoringContext', () => {
    it('resolves live-session composer state from the snapshot with fallback agent support', () => {
        const context: LiveSessionAuthoringContext = {
            kind: 'liveSession',
            session: BASE_SESSION as any,
            snapshot: {
                ...BASE_SNAPSHOT,
                agentId: 'not-a-real-agent',
            } as any,
        };

        const state = resolveSessionComposerStateFromAuthoringContext(context, {
            fallbackAgentId: 'codex',
        });

        expect(state.agentId).toBe('codex');
        expect(state.machineName).toBe('Builder');
        expect(state.permissionMode).toBe('acceptEdits');
        expect(state.modelMode).toBe('claude-sonnet-4-5');
        expect(state.profileId).toBe('profile-snapshot');
        expect(state.currentPath).toBe('/repo/snapshot');
    });

    it('leaves the live-session agent unset when there is no valid snapshot agent and no fallback', () => {
        const context: LiveSessionAuthoringContext = {
            kind: 'liveSession',
            session: BASE_SESSION as any,
            snapshot: {
                ...BASE_SNAPSHOT,
                agentId: 'not-a-real-agent',
            } as any,
        };

        const state = resolveSessionComposerStateFromAuthoringContext(context);

        expect(state.agentId).toBeNull();
        expect(state.machineName).toBe('Builder');
        expect(state.permissionMode).toBe('acceptEdits');
        expect(state.modelMode).toBe('claude-sonnet-4-5');
        expect(state.profileId).toBe('profile-snapshot');
        expect(state.currentPath).toBe('/repo/snapshot');
    });

    it('reads the layout-v1 machine label only from the owner compatibility view', () => {
        const context: LiveSessionAuthoringContext = {
            kind: 'liveSession',
            session: {
                ...BASE_SESSION,
                metadataLayoutVersion: 1,
                metadata: {
                    v: 1,
                    summary: {
                        text: 'Shared title',
                        updatedAt: 1,
                    },
                },
                ownerMetadataView: {
                    displayName: 'Private builder',
                    host: 'private-host',
                    machineId: 'private-machine',
                },
            } as never,
            snapshot: BASE_SNAPSHOT as never,
        };

        expect(resolveSessionComposerStateFromAuthoringContext(context).machineName)
            .toBe('Private builder');
    });

    it('normalizes an Agent without a configured default model to the canonical default mode', () => {
        const context: LiveSessionAuthoringContext = {
            kind: 'liveSession',
            session: {
                ...BASE_SESSION,
                metadata: {
                    ...BASE_SESSION.metadata,
                    flavor: 'grok',
                },
            } as any,
            snapshot: {
                ...BASE_SNAPSHOT,
                agentId: 'grok',
                modelId: null,
            } as any,
        };

        expect(resolveSessionComposerStateFromAuthoringContext(context).modelMode).toBe('default');
    });

    it('prefers existing-session automation draft overrides over inherited snapshot values', () => {
        const context: ExistingSessionAutomationAuthoringContext = {
            kind: 'automationExistingSession',
            session: BASE_SESSION as any,
            draft: BASE_DRAFT,
            snapshot: BASE_SNAPSHOT as any,
            capabilities: {
                message: 'editable',
                permissionMode: 'editable',
                model: 'editable',
                backend: 'inherited',
                sessionEncryption: 'inherited',
                transcriptStorage: 'inherited',
                machine: 'inherited',
                path: 'editable',
                profile: 'editable',
                resumeSupport: 'hidden',
                mcp: 'hidden',
                connectedServices: 'hidden',
            },
            availability: {
                kind: 'ready',
                machineId: 'machine-1',
                eligibility: {
                    eligible: true,
                    strategy: 'happy_attach',
                    compatBackendId: 'review-bot',
                },
            },
        };

        const state = resolveSessionComposerStateFromAuthoringContext(context);

        expect(state.agentId).toBe('claude');
        expect(state.machineName).toBe('Builder');
        expect(state.permissionMode).toBe('default');
        expect(state.modelMode).toBe('gpt-5');
        expect(state.profileId).toBe('profile-draft');
        expect(state.currentPath).toBe('/repo/draft');
    });

    it('prefers the canonical provider-bound draft selection over the legacy model id', () => {
        const context: ExistingSessionAutomationAuthoringContext = {
            kind: 'automationExistingSession',
            session: BASE_SESSION as any,
            draft: {
                ...BASE_DRAFT,
                modelSelection: {
                    v: 1,
                    updatedAt: 500,
                    ref: {
                        agentTargetKey: 'backend:claude',
                        providerConnectionId: null,
                        modelId: 'claude-opus-4-7',
                    },
                },
            },
            snapshot: BASE_SNAPSHOT as any,
            capabilities: {} as any,
            availability: {} as any,
        };

        expect(resolveSessionComposerStateFromAuthoringContext(context).modelMode).toBe('claude-opus-4-7');
    });
});
