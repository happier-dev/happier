import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import {
    buildAutomationTemplateFromSessionAuthoringDraft,
    buildExistingSessionAutomationFallbackDraft,
    buildExistingSessionAuthoringDraftFromSessionSnapshot,
    buildNewSessionAuthoringDraft,
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildNewSessionAuthoringDraftFromPersistedDraft,
    buildNewSessionAuthoringDraftFromTempData,
    buildPersistedNewSessionDraftFromAuthoringDraft,
    buildSpawnSessionOptionsFromAuthoringDraft,
    buildNewSessionTempDataFromAuthoringDraft,
    hydrateSessionAuthoringDraftFromAutomationTemplate,
    mergeExistingSessionAutomationTemplateDraft,
    refreshExistingSessionAuthoringDraftFromSessionSnapshot,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { decodeAutomationTemplate } from '@/sync/domains/automations/automationTemplateCodec';

describe('sessionAuthoringDraftAdapters', () => {
    it('hydrates an existing-session automation template into a shared authoring draft', () => {
        const template = decodeAutomationTemplate(JSON.stringify({
            directory: '/tmp/project',
            prompt: 'Summarize the latest changes',
            displayText: 'Summarize the latest changes',
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { OPENAI_API_KEY: 'secret' },
            resume: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            },
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'hidden',
            experimentalCodexAcp: true,
            codexBackendMode: 'acp',
            agentModeId: 'plan',
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'plain',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
        }));
        expect(template).not.toBeNull();
        if (!template) return;

        const draft = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'existing_session',
            template,
        });

        expect(draft).toEqual(expect.objectContaining({
            targetType: 'existing_session',
            directory: '/tmp/project',
            prompt: 'Summarize the latest changes',
            displayText: 'Summarize the latest changes',
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { OPENAI_API_KEY: 'secret' },
            resumeSessionId: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            },
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'hidden',
            experimentalCodexAcp: null,
            codexBackendMode: 'acp',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: null,
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'plain',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
            automation: null,
        }));
    });

    it('builds a new-session automation template from the shared draft without leaking existing-session-only fields', () => {
        const template = buildAutomationTemplateFromSessionAuthoringDraft({
            targetType: 'new_session',
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Open the repository and run checks',
            displayText: 'Open the repository and run checks',
            agentId: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            transcriptStorage: 'persisted',
            profileId: 'profile-1',
            environmentVariables: { FOO: 'bar' },
            resumeSessionId: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            mcpSelection: null,
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'visible',
            experimentalCodexAcp: null,
            codexBackendMode: 'acp',
            acpSessionModeId: 'plan',
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'plain',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
        } satisfies SessionAuthoringDraft);

        expect(template).toEqual(expect.objectContaining({
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Open the repository and run checks',
            displayText: 'Open the repository and run checks',
            agent: 'codex',
            transcriptStorage: 'persisted',
            profileId: 'profile-1',
            environmentVariables: { FOO: 'bar' },
            resume: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'visible',
            codexBackendMode: 'acp',
            agentModeId: 'plan',
        }));
        expect(template.experimentalCodexAcp).toBeUndefined();
        expect((template as any).sessionConfigOptionOverrides).toBeUndefined();
        expect(template.existingSessionId).toBeUndefined();
        expect(template.sessionEncryptionKeyBase64).toBeUndefined();
        expect(template.sessionEncryptionVariant).toBeUndefined();
    });

    it('builds a new-session authoring draft and launch payload from the shared adapter layer', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Run the nightly maintenance checklist',
            displayText: 'Run the nightly maintenance checklist',
            agentId: 'codex',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { FOO: 'bar' },
            resumeSessionId: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            },
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'visible',
            experimentalCodexAcp: true,
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
        });

        expect(draft).toEqual(expect.objectContaining({
            targetType: 'new_session',
            directory: '/tmp/project',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            profileId: 'profile-1',
            permissionMode: 'acceptEdits',
            modelId: 'gpt-5',
            transcriptStorage: 'direct',
            acpSessionModeId: 'plan',
            codexBackendMode: 'appServer',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
        }));

        const spawnOptions = buildSpawnSessionOptionsFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            serverId: 'server-a',
            approvedNewDirectoryCreation: true,
            agentModeUpdatedAt: 123,
        });

        expect(spawnOptions).toEqual(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            directory: '/tmp/project',
            approvedNewDirectoryCreation: true,
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { FOO: 'bar' },
            resume: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            agentModeId: 'plan',
            agentModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            },
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'visible',
            codexBackendMode: 'appServer',
        }));
        expect(spawnOptions).not.toHaveProperty('workspaceId');
        expect(spawnOptions).not.toHaveProperty('workspaceLocationId');
        expect(spawnOptions).not.toHaveProperty('workspaceCheckoutId');
    });

    it('omits legacy spawn token passthrough from authoring draft spawn options', () => {
        const spawnOptions = buildSpawnSessionOptionsFromAuthoringDraft({
            draft: {
                targetType: 'new_session',
                directory: '/tmp/project',
                checkoutCreationDraft: null,
                prompt: 'Prompt',
                displayText: 'Prompt',
                agentId: 'claude',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                transcriptStorage: 'persisted',
                profileId: null,
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode: null,
                permissionModeUpdatedAt: null,
                modelId: null,
                modelUpdatedAt: null,
                mcpSelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                experimentalCodexAcp: null,
                codexBackendMode: null,
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                existingSessionId: null,
                sessionEncryptionMode: null,
                sessionEncryptionKeyBase64: null,
                sessionEncryptionVariant: null,
                automation: null,
            },
            machineId: 'machine-1',
            token: 'legacy-spawn-token',
        } as any);

        expect(spawnOptions).not.toHaveProperty('token');
    });

    it('round-trips an existing-session authoring draft through the shared automation template adapter', () => {
        const initialDraft = {
            targetType: 'existing_session',
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Send the daily reminder',
            displayText: 'Send the daily reminder',
            agentId: null,
            backendTarget: null,
            transcriptStorage: 'direct',
            profileId: null,
            environmentVariables: { FOO: 'bar' },
            resumeSessionId: null,
            permissionMode: 'readOnly',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: [],
            },
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: null,
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'plain',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
            automation: null,
        } satisfies SessionAuthoringDraft;

        const template = buildAutomationTemplateFromSessionAuthoringDraft(initialDraft);
        const hydrated = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'existing_session',
            template,
        });

        expect(hydrated).toEqual(initialDraft);
    });

    it('hydrates an existing-session authoring draft from a live session snapshot', () => {
        const draft = buildExistingSessionAuthoringDraftFromSessionSnapshot({
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
            message: 'Send the daily summary',
            sessionDekBase64: 'dek-base64',
        });

        expect(draft).toEqual(expect.objectContaining({
            targetType: 'existing_session',
            directory: '/tmp/project',
            prompt: 'Send the daily summary',
            displayText: 'Send the daily summary',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            profileId: 'profile-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            terminal: { mode: 'tmux', tmux: { sessionName: 'happy-dev' } },
            experimentalCodexAcp: null,
            codexBackendMode: 'acp',
            existingSessionId: 'session-1',
            sessionEncryptionMode: 'e2ee',
            sessionEncryptionKeyBase64: 'dek-base64',
            sessionEncryptionVariant: 'dataKey',
        }));
    });

    it('refreshes an existing-session draft from the live snapshot while preserving editable fields', () => {
        const refreshed = refreshExistingSessionAuthoringDraftFromSessionSnapshot({
            session: {
                id: 'session-1',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/project-next',
                    host: 'qa-host',
                    homeDir: '/tmp',
                    profileId: 'profile-2',
                    flavor: 'codex',
                    codexSessionId: 'codex-session-2',
                },
                permissionMode: 'default',
                permissionModeUpdatedAt: 999,
                modelMode: 'default',
                modelModeUpdatedAt: 111,
            },
            currentDraft: {
                targetType: 'existing_session',
                directory: '/tmp/project-old',
                checkoutCreationDraft: null,
                prompt: 'Keep this message',
                displayText: 'Keep this message',
                agentId: 'codex',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                transcriptStorage: null,
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
                codexBackendMode: null,
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                existingSessionId: 'session-1',
                sessionEncryptionMode: 'e2ee',
                sessionEncryptionKeyBase64: 'old-dek',
                sessionEncryptionVariant: 'dataKey',
                automation: {
                    enabled: true,
                    name: 'Scheduled message',
                    description: '',
                    scheduleKind: 'interval',
                    everyMinutes: 60,
                    cronExpr: '0 * * * *',
                    timezone: null,
                },
            },
            sessionDekBase64: 'new-dek',
            fallbackAutomationDraft: {
                enabled: true,
                name: 'Default automation',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '*/30 * * * *',
                timezone: null,
            },
        });

        expect(refreshed).toEqual(expect.objectContaining({
            directory: '/tmp/project-next',
            profileId: 'profile-2',
            prompt: 'Keep this message',
            displayText: 'Keep this message',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            existingSessionId: 'session-1',
            sessionEncryptionKeyBase64: 'new-dek',
            automation: expect.objectContaining({
                name: 'Scheduled message',
                everyMinutes: 60,
            }),
        }));
    });

    it('builds an existing-session automation fallback draft from the live snapshot and message', () => {
        const fallbackDraft = buildExistingSessionAutomationFallbackDraft({
            targetSession: {
                id: 'session-1',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/tmp/project-live',
                    host: 'qa-host',
                    homeDir: '/tmp',
                    profileId: 'profile-live',
                    flavor: 'codex',
                    codexSessionId: 'codex-session-3',
                    codexBackendMode: 'acp',
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 20,
                        backendId: 'review-bot',
                        title: 'Review Bot',
                    },
                },
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 123,
                modelMode: 'gpt-5',
                modelModeUpdatedAt: 456,
            },
            message: 'Keep the latest review summary',
            sessionDekBase64: 'dek-live',
        });

        expect(fallbackDraft).toEqual(expect.objectContaining({
            targetType: 'existing_session',
            directory: '/tmp/project-live',
            prompt: 'Keep the latest review summary',
            displayText: 'Keep the latest review summary',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            profileId: 'profile-live',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            codexBackendMode: 'acp',
            existingSessionId: 'session-1',
            sessionEncryptionKeyBase64: 'dek-live',
        }));
    });

    it('merges an existing-session automation template draft with the live snapshot while preserving current editable fields', () => {
        const merged = mergeExistingSessionAutomationTemplateDraft({
            hydratedTemplateDraft: {
                targetType: 'existing_session',
                directory: '/template/project',
                checkoutCreationDraft: null,
                prompt: 'Template prompt',
                displayText: '',
                agentId: 'codex',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                transcriptStorage: 'persisted',
                profileId: 'template-profile',
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode: 'read-only',
                permissionModeUpdatedAt: 12,
                modelId: 'template-model',
                modelUpdatedAt: 34,
                mcpSelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                experimentalCodexAcp: null,
                codexBackendMode: null,
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                existingSessionId: 'session-1',
                sessionEncryptionMode: 'e2ee',
                sessionEncryptionKeyBase64: null,
                sessionEncryptionVariant: null,
                automation: null,
            },
            targetSession: {
                id: 'session-1',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/live/project',
                    host: 'qa-host',
                    homeDir: '/tmp',
                    profileId: 'live-profile',
                    flavor: 'codex',
                    codexSessionId: 'codex-session-9',
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 20,
                        backendId: 'review-bot',
                        title: 'Review Bot',
                    },
                },
                permissionMode: 'default',
                permissionModeUpdatedAt: 999,
                modelMode: 'default',
                modelModeUpdatedAt: 111,
            },
            currentDraft: {
                targetType: 'existing_session',
                directory: '/old/project',
                checkoutCreationDraft: null,
                prompt: 'Keep my edited message',
                displayText: 'Keep my edited message',
                agentId: 'codex',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                transcriptStorage: 'persisted',
                profileId: 'old-profile',
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
                codexBackendMode: null,
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                existingSessionId: 'session-1',
                sessionEncryptionMode: 'e2ee',
                sessionEncryptionKeyBase64: 'old-dek',
                sessionEncryptionVariant: 'dataKey',
                automation: {
                    enabled: true,
                    name: 'Current automation',
                    description: '',
                    scheduleKind: 'interval',
                    everyMinutes: 60,
                    cronExpr: '0 * * * *',
                    timezone: null,
                },
            },
            sessionDekBase64: 'new-dek',
            seededAutomationDraft: {
                enabled: true,
                name: 'Seeded automation',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '*/30 * * * *',
                timezone: null,
            },
        });

        expect(merged).toEqual(expect.objectContaining({
            directory: '/live/project',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            profileId: 'live-profile',
            prompt: 'Keep my edited message',
            displayText: 'Keep my edited message',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            sessionEncryptionKeyBase64: 'new-dek',
            automation: expect.objectContaining({
                name: 'Current automation',
                everyMinutes: 60,
            }),
        }));
    });

    it('preserves persisted template permission and model overrides when hydrating against a live session snapshot', () => {
        const merged = mergeExistingSessionAutomationTemplateDraft({
            hydratedTemplateDraft: {
                targetType: 'existing_session',
                directory: '/template/project',
                checkoutCreationDraft: null,
                prompt: 'Template prompt',
                displayText: 'Template prompt',
                agentId: 'claude',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                transcriptStorage: 'persisted',
                profileId: 'template-profile',
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode: 'readOnly',
                permissionModeUpdatedAt: 12,
                modelId: 'claude-sonnet-4-6',
                modelUpdatedAt: 34,
                mcpSelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                experimentalCodexAcp: null,
                codexBackendMode: null,
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                existingSessionId: 'session-1',
                sessionEncryptionMode: 'e2ee',
                sessionEncryptionKeyBase64: 'template-dek',
                sessionEncryptionVariant: 'dataKey',
                automation: null,
            },
            targetSession: {
                id: 'session-1',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/live/project',
                    host: 'qa-host',
                    homeDir: '/Users/leeroy',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-1',
                },
                permissionMode: 'default',
                permissionModeUpdatedAt: 999,
                modelMode: 'default',
                modelModeUpdatedAt: 111,
            },
            currentDraft: null,
            sessionDekBase64: 'live-dek',
            seededAutomationDraft: {
                enabled: true,
                name: 'Scheduled message',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            },
        });

        expect(merged).toEqual(expect.objectContaining({
            directory: '/live/project',
            prompt: 'Template prompt',
            displayText: 'Template prompt',
            permissionMode: 'readOnly',
            permissionModeUpdatedAt: 12,
            modelId: 'claude-sonnet-4-6',
            modelUpdatedAt: 34,
            sessionEncryptionKeyBase64: 'live-dek',
            automation: {
                enabled: true,
                name: 'Scheduled message',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            },
        }));
    });

    it('keeps codex backend mode canonical when hydrating a legacy automation template', () => {
        const template = decodeAutomationTemplate(JSON.stringify({
            directory: '/tmp/project',
            prompt: 'Review the repo',
            displayText: 'Review the repo',
            agent: 'codex',
            experimentalCodexAcp: true,
        }));
        expect(template).not.toBeNull();
        if (!template) return;

        const draft = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'new_session',
            template,
        });
        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft: {
                ...draft,
                automation: {
                    enabled: true,
                    name: 'Nightly',
                    description: '',
                    scheduleKind: 'interval',
                    everyMinutes: 15,
                    cronExpr: '0 * * * *',
                    timezone: null,
                },
            },
            machineId: 'machine-1',
        });

        expect(draft.codexBackendMode).toBe('acp');
        expect(draft.experimentalCodexAcp).toBeNull();
        expect(tempData.codexBackendMode).toBe('acp');
        expect(tempData.agentNewSessionOptionStateByAgentId).toBeUndefined();
        expect(tempData.automationDraft).toEqual({
            enabled: true,
            name: 'Nightly',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 15,
            cronExpr: '0 * * * *',
            timezone: null,
        });
    });

    it('round-trips new-session worktree intent through the shared automation template adapter into temp data', () => {
        const draft = {
            targetType: 'new_session',
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Open the feature branch worktree',
            displayText: 'Open the feature branch worktree',
            agentId: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            transcriptStorage: 'persisted',
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
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: null,
            existingSessionId: null,
            sessionEncryptionMode: null,
            sessionEncryptionKeyBase64: null,
            sessionEncryptionVariant: null,
            automation: {
                enabled: true,
                name: 'Nightly',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 15,
                cronExpr: '0 * * * *',
                timezone: null,
            },
        } satisfies SessionAuthoringDraft;

        const template = buildAutomationTemplateFromSessionAuthoringDraft(draft);
        const hydrated = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'new_session',
            template,
        });
        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft: {
                ...hydrated,
                automation: draft.automation,
            },
            machineId: 'machine-1',
        });

        expect(hydrated).toEqual({
            ...draft,
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
                branchMode: 'new',
            },
            automation: null,
        });
        expect(tempData).toEqual(expect.objectContaining({
            codexBackendMode: 'appServer',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
                branchMode: 'new',
            },
            automationDraft: draft.automation,
        }));
    });

    it('preserves ACP session mode when building temp new-session data from the shared draft', () => {
        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft: {
                targetType: 'new_session',
                directory: '/tmp/project',
                checkoutCreationDraft: null,
                prompt: 'Run the review',
                displayText: 'Run the review',
                agentId: 'codex',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                transcriptStorage: 'persisted',
                profileId: null,
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
                acpSessionModeId: 'plan',
                existingSessionId: null,
                sessionEncryptionMode: null,
                sessionEncryptionKeyBase64: null,
                sessionEncryptionVariant: null,
                automation: {
                    enabled: true,
                    name: 'Nightly',
                    description: '',
                    scheduleKind: 'interval',
                    everyMinutes: 15,
                    cronExpr: '0 * * * *',
                    timezone: null,
                },
            },
            machineId: 'machine-1',
        });

        expect(tempData.acpSessionModeId).toBe('plan');
        expect(tempData.automationDraft).toEqual({
            enabled: true,
            name: 'Nightly',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 15,
            cronExpr: '0 * * * *',
            timezone: null,
        });
    });

    it('builds a new-session authoring draft from resolved inputs', () => {
        const draft = buildNewSessionAuthoringDraftFromResolvedInputs({
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Review the queued invoices',
            agentId: 'codex',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { OPENAI_API_KEY: 'secret' },
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            },
            connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
            terminal: { mode: 'tmux', tmux: { sessionName: 'nightly' } },
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
            automation: {
                enabled: true,
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                scheduleKind: 'interval',
                everyMinutes: 120,
                cronExpr: '0 * * * *',
                timezone: 'Europe/Zurich',
            },
        });

        expect(draft).toEqual(expect.objectContaining({
            targetType: 'new_session',
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { OPENAI_API_KEY: 'secret' },
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            },
            connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
            terminal: { mode: 'tmux', tmux: { sessionName: 'nightly' } },
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
            automation: {
                enabled: true,
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                scheduleKind: 'interval',
                everyMinutes: 120,
                cronExpr: '0 * * * *',
                timezone: 'Europe/Zurich',
            },
        }));
    });

    it('builds a persisted new-session draft from the shared authoring draft', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentId: 'codex',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            },
            connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
            terminal: { mode: 'tmux', tmux: { sessionName: 'nightly' } },
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            experimentalCodexAcp: null,
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            automation: {
                enabled: true,
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                scheduleKind: 'interval',
                everyMinutes: 120,
                cronExpr: '0 * * * *',
                timezone: 'Europe/Zurich',
            },
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: 'secret-1',
            selectedSecretIdByProfileIdByEnvVarName: {
                'profile-1': {
                    OPENAI_API_KEY: 'secret-1',
                },
            },
            sessionOnlySecretValueEncByProfileIdByEnvVarName: {
                'profile-1': {
                    GITHUB_TOKEN: { _isSecretValue: true, value: 'enc::token' },
                },
            },
            agentNewSessionOptionStateByAgentId: {
                codex: {
                    experimentalCodexAcp: true,
                },
            },
            updatedAt: 987,
        });

        expect(persistedDraft).toEqual({
            input: 'Review the queued invoices',
            selectedMachineId: 'machine-1',
            selectedPath: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            selectedProfileId: 'profile-1',
            selectedSecretId: 'secret-1',
            selectedSecretIdByProfileIdByEnvVarName: {
                'profile-1': {
                    OPENAI_API_KEY: 'secret-1',
                },
            },
            sessionOnlySecretValueEncByProfileIdByEnvVarName: {
                'profile-1': {
                    GITHUB_TOKEN: { _isSecretValue: true, value: 'enc::token' },
                },
            },
            agentType: 'codex',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelMode: 'gpt-5',
            acpSessionModeId: 'plan',
            codexBackendMode: 'appServer',
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            },
            resumeSessionId: 'resume-1',
            agentNewSessionOptionStateByAgentId: {
                codex: {
                    experimentalCodexAcp: true,
                },
            },
            automationDraft: {
                enabled: true,
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                scheduleKind: 'interval',
                everyMinutes: 120,
                cronExpr: '0 * * * *',
                timezone: 'Europe/Zurich',
            },
            updatedAt: 987,
        });
    });

    it('hydrates temp new-session data into the shared authoring draft including automation and connected services', () => {
        const sourceDraft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentId: 'codex',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            mcpSelection: null,
            connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            experimentalCodexAcp: null,
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
            automation: {
                enabled: true,
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                scheduleKind: 'interval',
                everyMinutes: 120,
                cronExpr: '0 * * * *',
                timezone: 'Europe/Zurich',
            },
        });

        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft: sourceDraft,
            machineId: 'machine-1',
        });

        expect(tempData.directory).toBe('/tmp/project');
        expect(tempData.path).toBeUndefined();
        expect(buildNewSessionAuthoringDraftFromTempData(tempData)).toEqual(expect.objectContaining({
            directory: '/tmp/project',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            modelId: 'gpt-5',
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
            connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
            automation: {
                enabled: true,
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                scheduleKind: 'interval',
                everyMinutes: 120,
                cronExpr: '0 * * * *',
                timezone: 'Europe/Zurich',
            },
        }));
    });

    it('hydrates a persisted new-session draft into the shared authoring draft including automation and connected services', () => {
        const sourceDraft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentId: 'codex',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            mcpSelection: null,
            connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            experimentalCodexAcp: null,
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
            automation: {
                enabled: true,
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                scheduleKind: 'interval',
                everyMinutes: 120,
                cronExpr: '0 * * * *',
                timezone: 'Europe/Zurich',
            },
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: sourceDraft,
            machineId: 'machine-1',
            selectedSecretId: 'secret-1',
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            agentNewSessionOptionStateByAgentId: {
                [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'review-bot' })]: {
                    connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
                },
            },
            updatedAt: 987,
        });

        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persistedDraft)).toEqual(expect.objectContaining({
            directory: '/tmp/project',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            modelId: 'gpt-5',
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    speed: { updatedAt: 789, value: 'fast' },
                },
            },
            connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
            automation: {
                enabled: true,
                name: 'Nightly summary',
                description: 'Summarize the nightly state',
                scheduleKind: 'interval',
                everyMinutes: 120,
                cronExpr: '0 * * * *',
                timezone: 'Europe/Zurich',
            },
        }));
    });

    it('round-trips configured ACP backend targets through the shared new-session authoring draft', () => {
        const draft = {
            targetType: 'new_session',
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review the repo state',
            displayText: 'Review the repo state',
            agentId: null,
            backendTarget: { kind: 'configuredAcpBackend' as const, backendId: 'review-bot' },
            transcriptStorage: 'persisted' as const,
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelId: null,
            modelUpdatedAt: null,
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            experimentalCodexAcp: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            existingSessionId: null,
            sessionEncryptionMode: null,
            sessionEncryptionKeyBase64: null,
            sessionEncryptionVariant: null,
            automation: {
                enabled: true,
                name: 'Backend review',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: null,
            },
        } satisfies SessionAuthoringDraft;

        const template = buildAutomationTemplateFromSessionAuthoringDraft(draft);
        const hydrated = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'new_session',
            template,
        });
        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft: hydrated,
            machineId: 'machine-1',
        });

        expect(template).toEqual(expect.objectContaining({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        }));
        expect(hydrated).toEqual(expect.objectContaining({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            automation: null,
        }));
        expect(tempData).toEqual(expect.objectContaining({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        }));
        expect(tempData.automationDraft).toBeUndefined();
    });
});
