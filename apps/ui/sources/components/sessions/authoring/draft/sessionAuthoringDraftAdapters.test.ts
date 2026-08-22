import { describe, expect, it } from 'vitest';
import {
    SessionModelSelectionV1Schema,
    SessionServerStartSpawnDraftV1Schema,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import {
    buildAutomationTemplateFromSessionAuthoringDraft,
    buildExistingSessionAutomationFallbackDraft,
    buildExistingSessionAuthoringDraftFromSessionSnapshot,
    buildNewSessionAuthoringDraft,
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildNewSessionAuthoringDraftFromPersistedDraft,
    buildNewSessionAuthoringDraftFromTempData,
    buildSessionAuthoringDraftFromServerStartSpawnDraftV1,
    buildSessionServerStartSpawnDraftV1FromAuthoringDraft,
    buildPersistedNewSessionDraftFromAuthoringDraft,
    buildSessionSpawnNewInputV2FromAuthoringDraft,
    buildSpawnSessionOptionsFromAuthoringDraft,
    buildNewSessionTempDataFromAuthoringDraft,
    hydrateSessionAuthoringDraftFromAutomationTemplate,
    mergeExistingSessionAutomationTemplateDraft,
    refreshExistingSessionAuthoringDraftFromSessionSnapshot,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { decodeAutomationTemplate } from '@/sync/domains/automations/automationTemplateCodec';

function modelSelection(
    agentTargetKey: string,
    modelId = 'gpt-5',
    updatedAt = 456,
    providerConnectionId: string | null = null,
): SessionModelSelectionV1 {
    return SessionModelSelectionV1Schema.parse({
        v: 1 as const,
        updatedAt,
        ref: {
            agentTargetKey,
            providerConnectionId,
            modelId,
        },
    });
}

describe('sessionAuthoringDraftAdapters', () => {
    it('hydrates every representable strict server-start field through an exact catalog Agent target', () => {
        const spawn = SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/workspace/project',
            organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'acme.review-agent', localId: 'review-agent' },
            },
            modelSelection: modelSelection('backend:review-agent', 'review-model', 30, 'provider-1'),
            profileId: 'profile-1',
            permissionMode: 'plan',
            agentModeId: 'plan',
            configuration: {
                mode: { value: 'plan', updatedAtMs: 10 },
                model: { value: 'review-model', updatedAtMs: 30 },
                permissionIntent: { value: 'plan', updatedAtMs: 20 },
                options: {
                    reasoning: { value: 'high', updatedAtMs: 40 },
                    safe: { value: true, updatedAtMs: 41 },
                },
                providerSessionResume: {
                    kind: 'provider_session.v1',
                    providerSessionId: 'provider-session-1',
                },
            },
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    github: { source: 'connected', selection: 'profile', profileId: 'github-1' },
                },
            },
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['review'],
                forceExcludeServerIds: ['legacy'],
            },
            transcriptStorage: 'direct',
            terminal: {
                mode: 'tmux',
                tmux: { sessionName: 'review-automation' },
                windows: { launchMode: 'windows_terminal', console: 'visible', windowName: 'review' },
            },
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'Review branch',
                baseRef: 'main',
            },
        });

        const result = buildSessionAuthoringDraftFromServerStartSpawnDraftV1({
            spawn,
            prompt: 'Review the changed files',
            agentTargetCatalog: [{
                agentTarget: spawn.agentTarget,
                agentId: 'reviewAgent',
                backendTarget: { kind: 'backend', backendId: 'review-agent' },
            }],
        });

        expect(result).toEqual({
            kind: 'available',
            draft: expect.objectContaining({
                targetType: 'new_session',
                directory: '/workspace/project',
                prompt: 'Review the changed files',
                displayText: 'Review the changed files',
                agentId: 'reviewAgent',
                backendTarget: { kind: 'backend', backendId: 'review-agent' },
                modelSelection: modelSelection('backend:review-agent', 'review-model', 30, 'provider-1'),
                profileId: 'profile-1',
                permissionMode: 'plan',
                permissionModeUpdatedAt: 20,
                acpSessionModeId: 'plan',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 41,
                    overrides: {
                        reasoning: { value: 'high', updatedAt: 40 },
                        safe: { value: true, updatedAt: 41 },
                    },
                },
                resumeSessionId: 'provider-session-1',
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        github: { source: 'connected', selection: 'profile', profileId: 'github-1' },
                    },
                },
                mcpSelection: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['review'],
                    forceExcludeServerIds: ['legacy'],
                },
                transcriptStorage: 'direct',
                terminal: {
                    mode: 'tmux',
                    tmux: { sessionName: 'review-automation' },
                    windows: { launchMode: 'windows_terminal', console: 'visible', windowName: 'review' },
                },
                windowsRemoteSessionLaunchMode: 'windows_terminal',
                windowsRemoteSessionConsole: 'visible',
                windowsTerminalWindowName: 'review',
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: 'Review branch',
                    baseRef: 'main',
                },
            }),
        });
    });

    it('fails closed instead of selecting a fallback Agent when the strict target is absent from the current catalog', () => {
        const spawn = SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/workspace/project',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'acme.review-agent', localId: 'review-agent' },
            },
            permissionMode: 'default',
            configuration: {
                mode: { value: null, updatedAtMs: 10 },
                model: { value: null, updatedAtMs: 10 },
                permissionIntent: { value: 'default', updatedAtMs: 10 },
                options: {},
            },
        });

        expect(buildSessionAuthoringDraftFromServerStartSpawnDraftV1({
            spawn,
            prompt: 'Review the changed files',
            agentTargetCatalog: [{
                agentTarget: {
                    kind: 'agent',
                    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                },
                agentId: 'codex',
                backendTarget: { kind: 'backend', backendId: 'codex' },
            }],
        })).toEqual({
            kind: 'unavailable',
            reason: 'agent_target_unavailable',
        });
    });

    it('rejects a server-start configuration that cannot be represented without changing its target-bound model', () => {
        const spawn = SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/workspace/project',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'acme.review-agent', localId: 'review-agent' },
            },
            modelSelection: modelSelection('backend:review-agent', 'review-model', 30),
            permissionMode: 'default',
            configuration: {
                mode: { value: null, updatedAtMs: 10 },
                model: { value: 'other-model', updatedAtMs: 30 },
                permissionIntent: { value: 'default', updatedAtMs: 10 },
                options: {},
            },
        });

        expect(buildSessionAuthoringDraftFromServerStartSpawnDraftV1({
            spawn,
            prompt: 'Review the changed files',
            agentTargetCatalog: [{
                agentTarget: spawn.agentTarget,
                agentId: 'reviewAgent',
                backendTarget: { kind: 'backend', backendId: 'review-agent' },
            }],
        })).toEqual({
            kind: 'unavailable',
            reason: 'configuration_model_mismatch',
        });
    });

    it('builds the reserved server-start draft without caller-selected creation or initial-input facts', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review this',
            displayText: 'Review this',
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: 'vendor-session-1',
            permissionMode: 'default',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:codex'),
            mcpSelection: null,
            connectedServices: null,
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const spawn = buildSessionServerStartSpawnDraftV1FromAuthoringDraft({
            draft,
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            permissionMode: 'default',
            configurationUpdatedAtMs: 999,
        });

        expect(spawn).toMatchObject({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            configuration: {
                providerSessionResume: {
                    kind: 'provider_session.v1',
                    providerSessionId: 'vendor-session-1',
                },
            },
            terminal: { mode: 'integrated' },
        });
        expect('creationKey' in spawn).toBe(false);
        expect('initialMessage' in spawn).toBe(false);
    });

    it('carries an externally installed Agent model choice onto the strict spawn input', () => {
        // C1 parity: an Agent contributed by an external plugin ships no bundled
        // catalog core, so the authored selection is the only model fact the
        // spawn owner has. It must reach both the canonical selection seam and
        // the derived strict configuration, exactly as a bundled Agent's does.
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review this',
            displayText: 'Review this',
            agentId: 'mercury',
            backendTarget: { kind: 'backend', backendId: 'mercury' },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'default',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:mercury', 'mercury-pro', 789),
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft,
            creationKey: 'attempt-external-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'com.acme.mercury', localId: 'mercury' },
            },
            permissionMode: 'default',
            configurationUpdatedAtMs: 999,
        })).toMatchObject({
            modelSelection: modelSelection('backend:mercury', 'mercury-pro', 789),
            configuration: {
                model: { value: 'mercury-pro', updatedAtMs: 789 },
            },
        });
    });

    it('maps authored resume and Windows launch intent through the strict V2 nested owners', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review this',
            displayText: 'Review this',
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: 'vendor-session-1',
            permissionMode: 'default',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:codex'),
            mcpSelection: null,
            connectedServices: null,
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'windows_terminal',
            windowsRemoteSessionConsole: 'visible',
            windowsTerminalWindowName: 'happier-qa',
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            draft,
            creationKey: 'attempt-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            permissionMode: 'default',
            configurationUpdatedAtMs: 999,
        })).toMatchObject({
            configuration: {
                providerSessionResume: {
                    kind: 'provider_session.v1',
                    providerSessionId: 'vendor-session-1',
                },
            },
            terminal: {
                mode: 'integrated',
                windows: {
                    launchMode: 'windows_terminal',
                    console: 'visible',
                    windowName: 'happier-qa',
                },
            },
        });
    });

    it('carries a source-context continuation recipe onto the strict spawn input, and omits it otherwise', () => {
        const draft = buildNewSessionAuthoringDraftFromTempData({
            machineId: 'machine-1',
            directory: '/repo',
            agentType: 'codex',
        } as any);
        const base = {
            draft,
            creationKey: 'attempt-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            agentTarget: {
                kind: 'agent' as const,
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            permissionMode: 'default' as const,
            configurationUpdatedAtMs: 999,
        };

        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({
            ...base,
            sourceContext: {
                v: 1,
                kind: 'session_replay',
                sourceSessionId: 'parent_1',
                forkPoint: { type: 'seq', upToSeqInclusive: 12 },
            },
        }).sourceContext).toEqual({
            v: 1,
            kind: 'session_replay',
            sourceSessionId: 'parent_1',
            forkPoint: { type: 'seq', upToSeqInclusive: 12 },
        });

        expect(buildSessionSpawnNewInputV2FromAuthoringDraft({ ...base, sourceContext: null }).sourceContext)
            .toBeUndefined();
        expect(buildSessionSpawnNewInputV2FromAuthoringDraft(base).sourceContext).toBeUndefined();
    });

    it('preserves an absent draft model selection so migrated profile intent can fill it on read', () => {
        const draft = buildNewSessionAuthoringDraftFromTempData({
            prompt: 'Review this',
            directory: '/tmp/project',
            agentType: 'claude',
            backendTarget: { kind: 'backend', backendId: 'claude' },
            selectedProfileId: 'deepseek',
        });

        expect(Object.prototype.hasOwnProperty.call(draft, 'modelSelection')).toBe(false);
    });

    it('hydrates an existing-session automation template into a shared authoring draft', () => {
        const template = decodeAutomationTemplate(JSON.stringify({
            directory: '/tmp/project',
            prompt: 'Summarize the latest changes',
            displayText: 'Summarize the latest changes',
            agent: 'codex',
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { OPENAI_API_KEY: 'secret' },
            resume: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:codex'),
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
            windowsTerminalWindowName: 'happier-qa',
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
            modelSelection: modelSelection('backend:codex'),
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
            windowsTerminalWindowName: 'happier-qa',
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
            backendTarget: { kind: 'backend', backendId: 'codex' },
            transcriptStorage: 'persisted',
            profileId: 'profile-1',
            environmentVariables: { FOO: 'bar' },
            resumeSessionId: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:codex'),
            mcpSelection: null,
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'visible',
            windowsTerminalWindowName: 'happier-qa',
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
            modelSelection: modelSelection('backend:codex'),
            connectedServices: { github: { installationId: '123' } },
            terminal: { mode: 'integrated' },
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'visible',
            windowsTerminalWindowName: 'happier-qa',
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { FOO: 'bar' },
            resumeSessionId: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
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
            windowsTerminalWindowName: 'happier-qa',
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            profileId: 'profile-1',
            permissionMode: 'acceptEdits',
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
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
            backendTarget: {
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
            },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { FOO: 'bar' },
            resume: 'resume-1',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            agentModeId: 'plan',
            agentModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
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
            windowsTerminalWindowName: 'happier-qa',
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
                backendTarget: { kind: 'backend', backendId: 'claude' },
                transcriptStorage: 'persisted',
                profileId: null,
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode: null,
                permissionModeUpdatedAt: null,
                modelSelection: null,
                mcpSelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: null,
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
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            transcriptStorage: 'direct',
            profileId: null,
            environmentVariables: { FOO: 'bar' },
            resumeSessionId: null,
            permissionMode: 'readOnly',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:codex'),
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
            windowsTerminalWindowName: null,
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

    it('preserves a provider-bound model literally named default across authoring boundaries', () => {
        const explicitDefault = modelSelection('backend:codex', 'default', 456, 'pc_openrouter');
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Run the review',
            displayText: 'Run the review',
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: null,
            permissionModeUpdatedAt: null,
            modelSelection: explicitDefault,
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const template = buildAutomationTemplateFromSessionAuthoringDraft(draft);
        const hydrated = hydrateSessionAuthoringDraftFromAutomationTemplate({
            targetType: 'new_session',
            template,
        });
        const spawnOptions = buildSpawnSessionOptionsFromAuthoringDraft({
            draft: hydrated,
            machineId: 'machine-1',
        });
        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: hydrated,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            updatedAt: 987,
        });

        expect(template.modelSelection).toEqual(explicitDefault);
        expect(template).not.toHaveProperty('modelId');
        expect(hydrated.modelSelection).toEqual(explicitDefault);
        expect(spawnOptions.modelSelection).toEqual(explicitDefault);
        expect(spawnOptions).not.toHaveProperty('modelId');
        expect(persistedDraft.modelSelection).toEqual(explicitDefault);
        expect(persistedDraft).not.toHaveProperty('modelMode');
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            profileId: 'profile-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
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
                backendTarget: { kind: 'backend', backendId: 'codex' },
                transcriptStorage: null,
                profileId: 'profile-1',
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 123,
                modelSelection: modelSelection('backend:codex'),
                mcpSelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: null,
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
            modelSelection: modelSelection('backend:codex'),
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            profileId: 'profile-live',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
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
                backendTarget: { kind: 'backend', backendId: 'codex' },
                transcriptStorage: 'persisted',
                profileId: 'template-profile',
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode: 'read-only',
                permissionModeUpdatedAt: 12,
                modelSelection: modelSelection('backend:codex', 'template-model', 34),
                mcpSelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: null,
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
                backendTarget: { kind: 'backend', backendId: 'codex' },
                transcriptStorage: 'persisted',
                profileId: 'old-profile',
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 123,
                modelSelection: modelSelection('backend:codex'),
                mcpSelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: null,
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            profileId: 'live-profile',
            prompt: 'Keep my edited message',
            displayText: 'Keep my edited message',
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:codex'),
            sessionEncryptionKeyBase64: 'new-dek',
            automation: expect.objectContaining({
                name: 'Current automation',
                everyMinutes: 60,
            }),
        }));
    });

    it('preserves an explicit Automatic model choice instead of inheriting a fallback selection', () => {
        const merged = mergeExistingSessionAutomationTemplateDraft({
            hydratedTemplateDraft: {
                targetType: 'existing_session', directory: '/template', checkoutCreationDraft: null,
                prompt: 'Template', displayText: 'Template', agentId: 'codex',
                backendTarget: { kind: 'backend', backendId: 'codex' }, transcriptStorage: 'persisted',
                profileId: null, environmentVariables: null, resumeSessionId: null,
                permissionMode: 'default', permissionModeUpdatedAt: 1, modelSelection: null,
                mcpSelection: null, connectedServices: null, terminal: null,
                windowsRemoteSessionLaunchMode: null, windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: null, experimentalCodexAcp: null, codexBackendMode: null,
                acpSessionModeId: null, sessionConfigOptionOverrides: null, existingSessionId: 'session-1',
                sessionEncryptionMode: 'e2ee', sessionEncryptionKeyBase64: null,
                sessionEncryptionVariant: null, automation: null,
            },
            targetSession: {
                id: 'session-1', encryptionMode: 'e2ee',
                metadata: {
                    path: '/live', host: 'host', flavor: 'codex',
                    modelSelectionIntentV1: {
                        v: 1, updatedAt: 20,
                        selection: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'gpt-5.5' },
                    },
                },
                permissionMode: 'default', permissionModeUpdatedAt: 1,
                modelMode: 'gpt-5.5', modelModeUpdatedAt: 20,
            },
            currentDraft: null,
            sessionDekBase64: null,
            seededAutomationDraft: null,
        });

        expect(merged.modelSelection).toBeNull();
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
                backendTarget: { kind: 'backend', backendId: 'claude' },
                transcriptStorage: 'persisted',
                profileId: 'template-profile',
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode: 'readOnly',
                permissionModeUpdatedAt: 12,
                modelSelection: modelSelection('backend:claude', 'claude-sonnet-4-6', 34),
                mcpSelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: null,
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
            modelSelection: modelSelection('backend:claude', 'claude-sonnet-4-6', 34),
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
        expect(tempData.backendNewSessionOptionStateByTargetKey).toBeUndefined();
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
            backendTarget: { kind: 'backend', backendId: 'codex' },
            transcriptStorage: 'persisted',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:codex'),
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: 'happier-qa',
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
                backendTarget: { kind: 'backend', backendId: 'codex' },
                transcriptStorage: 'persisted',
                profileId: null,
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 123,
                modelSelection: modelSelection('backend:codex'),
                mcpSelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: null,
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { OPENAI_API_KEY: 'secret' },
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
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
            windowsTerminalWindowName: null,
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: { OPENAI_API_KEY: 'secret' },
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
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
            windowsTerminalWindowName: null,
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

        const composerAttachments = [{
            v: 1 as const,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: {
                label: 'Issue #42',
                typeLabel: 'Issue',
            },
        }];
        const persistedDraftInput = {
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
                    GITHUB_TOKEN: { _isSecretValue: true as const, value: 'enc::token' },
                },
            },
            backendNewSessionOptionStateByTargetKey: {
                codex: {
                    experimentalCodexAcp: true,
                },
            },
            composerAttachments,
            updatedAt: 987,
        };
        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft(persistedDraftInput);

        expect(persistedDraft).toEqual({
            input: 'Review the queued invoices',
            selectedMachineId: 'machine-1',
            selectedPath: '/tmp/project',
            composerAttachments,
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
            acpSessionModeId: 'plan',
            codexBackendMode: 'appServer',
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable'],
                forceExcludeServerIds: ['disabled'],
            },
            resumeSessionId: 'resume-1',
            backendNewSessionOptionStateByTargetKey: {
                'backend:codex': {
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

    it('persists new-session target server and Windows launch override alongside authoring state', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Open the workspace',
            displayText: 'Open the workspace',
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'default',
            permissionModeUpdatedAt: null,
            modelId: null,
            modelUpdatedAt: null,
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            targetServerId: '  server-b  ',
            windowsRemoteSessionLaunchModeOverride: {
                machineId: 'machine-1',
                mode: 'console',
            },
            updatedAt: 987,
        });

        expect(persistedDraft).toEqual(expect.objectContaining({
            targetServerId: 'server-b',
            windowsRemoteSessionLaunchModeOverride: {
                machineId: 'machine-1',
                mode: 'console',
            },
        }));
    });

    it('omits blank new-session target server and Windows launch override payloads', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Open the workspace',
            displayText: 'Open the workspace',
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'default',
            permissionModeUpdatedAt: null,
            modelId: null,
            modelUpdatedAt: null,
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            targetServerId: '   ',
            windowsRemoteSessionLaunchModeOverride: {
                machineId: '   ',
                mode: 'console',
            },
            updatedAt: 987,
        });

        expect(persistedDraft).not.toEqual(expect.objectContaining({
            targetServerId: expect.anything(),
        }));
        expect(persistedDraft).not.toEqual(expect.objectContaining({
            windowsRemoteSessionLaunchModeOverride: expect.anything(),
        }));
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
            mcpSelection: null,
            connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            environmentVariables: null,
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
            mcpSelection: null,
            connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
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
            backendNewSessionOptionStateByTargetKey: {
                ['backend:review-bot:configured:review-bot']: {
                    connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'connected' } } },
                },
            },
            updatedAt: 987,
        });

        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persistedDraft)).toEqual(expect.objectContaining({
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: 'profile-1',
            resumeSessionId: 'resume-1',
            permissionMode: 'safe-yolo',
            modelSelection: modelSelection('backend:review-bot:configured:review-bot'),
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

    it('persists a canonical built-in fallback instead of the legacy customAcp sentinel for configured ACP backend drafts', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: null,
            modelUpdatedAt: null,
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            updatedAt: 987,
        });

        expect(persistedDraft).toEqual(expect.objectContaining({
            agentType: 'codex',
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
        }));
        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persistedDraft)).toEqual(expect.objectContaining({
            agentId: null,
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
        }));
    });

    it('ignores a legacy customAcp preferred persisted agent when autosaving configured ACP backend drafts', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentId: null,
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: null,
            modelUpdatedAt: null,
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            preferredPersistedAgentId: 'customAcp',
            updatedAt: 987,
        });

        expect(persistedDraft).toEqual(expect.objectContaining({
            agentType: DEFAULT_AGENT_ID,
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
        }));
    });

    it('does not manufacture the legacy customAcp sentinel in temp data for configured ACP backend drafts', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review the queued invoices',
            displayText: 'Review the queued invoices',
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            transcriptStorage: 'direct',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: null,
            modelUpdatedAt: null,
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const tempData = buildNewSessionTempDataFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
        });

        expect(tempData).toEqual(expect.objectContaining({
            agentType: 'codex',
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
        }));
        expect(tempData.agentType).not.toBe('customAcp');
    });

    it('does not collapse plugin backend targets into the custom ACP sentinel when persisting drafts', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Run the plugin backend',
            displayText: 'Run the plugin backend',
            agentId: null,
            backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
            transcriptStorage: 'direct',
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
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            preferredPersistedAgentId: 'claude',
            updatedAt: 987,
        });

        expect(persistedDraft).toEqual(expect.objectContaining({
            agentType: 'claude',
            backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
        }));

        expect(buildNewSessionAuthoringDraftFromPersistedDraft(persistedDraft)).toEqual(expect.objectContaining({
            agentId: null,
            backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
        }));
    });

    it('defaults plugin backend drafts to the global default agent type when no preferred agent id is available', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Run the plugin backend',
            displayText: 'Run the plugin backend',
            agentId: null,
            backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
            transcriptStorage: 'direct',
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
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        const persistedDraft = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            preferredPersistedAgentId: null,
            updatedAt: 987,
        });

        expect(persistedDraft.agentType).toBe(DEFAULT_AGENT_ID);
        expect(persistedDraft.agentType).not.toBe('customAcp');
        expect(persistedDraft.backendTarget).toEqual({ kind: 'backend', backendId: 'acme.review.backend' });
    });

    it('builds plugin backend spawn options with the canonical V2 backend target', () => {
        const draft = buildNewSessionAuthoringDraft({
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Run the plugin backend',
            displayText: 'Run the plugin backend',
            agentId: null,
            backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
            transcriptStorage: 'direct',
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
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            codexBackendMode: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

        expect(buildSpawnSessionOptionsFromAuthoringDraft({
            draft,
            machineId: 'machine-1',
        }).backendTarget).toEqual({
            kind: 'backend',
            backendId: 'acme.review.backend',
        });
    });

    it('round-trips configured ACP backend targets and session config overrides through the shared new-session authoring draft', () => {
        const draft = {
            targetType: 'new_session',
            directory: '/tmp/project',
            checkoutCreationDraft: null,
            prompt: 'Review the repo state',
            displayText: 'Review the repo state',
            agentId: null,
            backendTarget: { kind: 'backend' as const, backendId: 'review-bot', configuredBackendId: 'review-bot' },
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
            windowsTerminalWindowName: null,
            experimentalCodexAcp: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
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
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
        }));
        expect(hydrated).toEqual(expect.objectContaining({
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
            automation: null,
        }));
        expect(tempData).toEqual(expect.objectContaining({
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    reasoning: { updatedAt: 789, value: 'high' },
                },
            },
        }));
        expect(tempData.automationDraft).toBeUndefined();
    });
});
