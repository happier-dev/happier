import { describe, it, expect } from 'vitest';
import {
    buildBackendTargetKey,
    DEFAULT_ACTIONS_SETTINGS_V1,
    DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
} from '@happier-dev/protocol';
import { DEFAULT_AGENT_ID } from '@/agents/registry/registryCore';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { settingsParse, applySettings, settingsDefaults, type Settings } from './settings';
import { AIBackendProfileSchema } from '../profiles/profileCompatibility';
import type { AIBackendProfile } from '../profiles/profileCompatibility';
import type { SavedSecret } from './savedSecretTypes';
import { getBuiltInProfile } from '../profiles/profileUtils';
import {
    VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS,
    readLocalConversationVoiceSettings,
} from './voiceSettings';

describe('settings', () => {
    const makeSettings = (overrides: Partial<Settings> = {}): Settings => ({
        ...settingsDefaults,
        ...overrides,
    });
    const parsedSettingsDefaults = {
        ...settingsDefaults,
        backendCliSourcePreferenceByTargetKey: {},
    } as Settings & {
        backendCliSourcePreferenceByTargetKey: Record<string, never>;
    };
    const makeProfile = (overrides: Partial<AIBackendProfile> = {}): AIBackendProfile => AIBackendProfileSchema.parse({
        id: 'profile',
        name: 'Profile',
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibility: { claude: true, codex: true, gemini: true },
        compatibilityByTargetKey: {
            'agent:claude': true,
            'agent:codex': true,
            'agent:gemini': true,
        },
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
        ...overrides,
    });

    describe('settingsParse', () => {
        it('should return defaults when given invalid input', () => {
            expect(settingsParse(null)).toEqual(settingsDefaults);
            expect(settingsParse(undefined)).toEqual(settingsDefaults);
            expect(settingsParse('invalid')).toEqual(settingsDefaults);
            expect(settingsParse(123)).toEqual(settingsDefaults);
            expect(settingsParse([])).toEqual(parsedSettingsDefaults);
        });

        it('should return defaults when given empty object', () => {
            expect(settingsParse({})).toEqual(parsedSettingsDefaults);
        });

        it('defaults session list presentation to narrow agent logos with activity-and-attention active color', () => {
            const settings = settingsParse({});
            expect((settings as any).sessionListDensity).toBe('narrow');
            expect((settings as any).sessionListIdentityDisplay).toBe('agentLogo');
            expect((settings as any).sessionListOrderingModeV1).toBe('custom');
            expect((settings as any).sessionListFolderSortModeV1).toBe('foldersFirst');
            expect((settings as any).sessionListAttentionPromotionModeV1).toBe('off');
            expect((settings as any).sessionListWorkingPlacementModeV1).toBe('off');
            expect((settings as any).sessionListSeparateBackgroundWorkV1).toBe(false);
            expect((settings as any).compactSessionView).toBe(true);
            expect((settings as any).compactSessionViewMinimal).toBe(true);
            expect((settings as any).sessionListActiveColorModeV1).toBe('activityAndAttention');
        });

        it('accepts session list identity display preferences separately from avatar style', () => {
            const parsed = settingsParse({ sessionListIdentityDisplay: 'agentLogo' });

            expect((parsed as any).sessionListIdentityDisplay).toBe('agentLogo');
        });

        it('includes installables policy map by default', () => {
            const settings = settingsParse({});
            expect((settings as any).installablesPolicyByMachineId).toEqual({});
        });

        it('includes mcpServersSettingsV1 by default', () => {
            const settings = settingsParse({});
            expect((settings as any).mcpServersSettingsV1).toEqual({
                v: 1,
                strictMode: false,
                servers: [],
                bindings: [],
            });
        });

        it('includes acpCatalogSettingsV1 by default', () => {
            const settings = settingsParse({});
            expect((settings as any).acpCatalogSettingsV1).toEqual({
                v: 2,
                backends: [],
            });
        });

        it('includes promptStacksV1 by default', () => {
            const settings = settingsParse({});
            expect((settings as any).promptStacksV1).toEqual({
                v: 1,
                surfaces: {
                    coding: [],
                    voice: [],
                    profilesById: {},
                },
            });
        });

        it('includes codingPromptBehaviorV1 by default', () => {
            const settings = settingsParse({});
            expect((settings as any).codingPromptBehaviorV1).toEqual({
                v: 1,
                sessionTitleUpdates: 'ongoing',
                responseOptions: 'agent',
            });
        });

        it('includes promptInvocationsV1 by default', () => {
            const settings = settingsParse({});
            expect((settings as any).promptInvocationsV1).toEqual({
                v: 1,
                entries: [],
            });
        });

        it('includes promptFoldersV1 by default', () => {
            const settings = settingsParse({});
            expect((settings as any).promptFoldersV1).toEqual({
                v: 1,
                folders: [],
            });
        });

        it('includes session folder preferences by default without exposing migrated folder definitions', () => {
            const settings = settingsParse({});
            expect(settings).not.toHaveProperty('sessionFoldersV1');
            expect((settings as any).sessionFolderViewModeV1).toBe('off');
        });

        it('includes promptRegistrySourcesV1 by default', () => {
            const settings = settingsParse({});
            expect((settings as any).promptRegistrySourcesV1).toEqual({
                v: 1,
                sources: [],
            });
        });

        it('includes contextSelectionsV1 by default', () => {
            const settings = settingsParse({});
            expect((settings as any).contextSelectionsV1).toEqual({
                v: 1,
                selectionsByKey: {},
            });
        });

        it('includes promptExternalLinksV1 by default', () => {
            const settings = settingsParse({});
            expect((settings as any).promptExternalLinksV1).toEqual({
                v: 1,
                links: [],
            });
        });

        it('should parse valid settings object', () => {
            const validSettings = {
                viewInline: true
            };
            expect(settingsParse(validSettings)).toEqual({
                ...parsedSettingsDefaults,
                viewInline: true
            });
        });

        it('should ignore invalid field types and use defaults', () => {
            const invalidSettings = {
                viewInline: 'not a boolean'
            };
            expect(settingsParse(invalidSettings)).toEqual(parsedSettingsDefaults);
        });

        it('should preserve unknown fields (loose schema)', () => {
            const settingsWithExtra = {
                viewInline: true,
                unknownField: 'some value',
                anotherField: 123
            };
            const result = settingsParse(settingsWithExtra);
            expect(result).toEqual({
                ...parsedSettingsDefaults,
                viewInline: true,
                unknownField: 'some value',
                anotherField: 123
            });
        });

        it('should handle partial settings and merge with defaults', () => {
            const partialSettings = {
                viewInline: true
            };
            expect(settingsParse(partialSettings)).toEqual({
                ...parsedSettingsDefaults,
                viewInline: true
            });
        });

        it('should handle settings with null/undefined values', () => {
            const settingsWithNull = {
                viewInline: null,
                someOtherField: undefined
            };
            expect(settingsParse(settingsWithNull)).toEqual({
                ...parsedSettingsDefaults,
                someOtherField: undefined
            });
        });

        it('should handle nested objects as extra fields', () => {
            const settingsWithNested = {
                viewInline: false,
                image: {
                    url: 'http://example.com',
                    width: 100,
                    height: 200
                }
            };
            const result = settingsParse(settingsWithNested);
            expect(result).toEqual({
                ...parsedSettingsDefaults,
                viewInline: false,
                image: {
                    url: 'http://example.com',
                    width: 100,
                    height: 200
                }
            });
        });

        it('defaults featureToggles to empty even when experiments is true', () => {
            const parsed = settingsParse({
                experiments: true,
                // Note: per-feature toggles intentionally omitted.
            } as any);

            expect((parsed as any).featureToggles).toEqual({});
        });

        it('parses account-synced keyboard shortcut settings without accepting malformed entries', () => {
            const parsed = settingsParse({
                commandPaletteEnabled: false,
                keyboardShortcutsV2Enabled: true,
                keyboardSingleKeyShortcutsEnabled: true,
                keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open', '', 123],
                keyboardShortcutOverridesV1: {
                    'commandPalette.open': [{ binding: 'Mod+K', conflictScope: 'global', nativeConsumable: false }],
                    'bad.command': [{ binding: '' }, { nope: true }],
                },
            } as any);

            expect(parsed.commandPaletteEnabled).toBe(false);
            expect(parsed.keyboardShortcutsV2Enabled).toBe(true);
            expect(parsed.keyboardSingleKeyShortcutsEnabled).toBe(true);
            expect(parsed.keyboardShortcutDisabledCommandIdsV1).toEqual(['commandPalette.open']);
            expect(parsed.keyboardShortcutOverridesV1).toEqual({
                'commandPalette.open': [{ binding: 'Mod+K', conflictScope: 'global', nativeConsumable: false }],
            });
        });

        it('drops legacy exp* keys on parse (hard cutover)', () => {
            const parsed = settingsParse({
                experiments: true,
                expUsageReporting: true,
                expFileViewer: true,
                expScmOperations: true,
                expShowThinkingMessages: true,
                expSessionType: true,
                expAutomations: true,
                expZen: true,
                expInboxFriends: true,
            } as any);

            expect((parsed as any).expUsageReporting).toBeUndefined();
            expect((parsed as any).expFileViewer).toBeUndefined();
            expect((parsed as any).expScmOperations).toBeUndefined();
            expect((parsed as any).expShowThinkingMessages).toBeUndefined();
            expect((parsed as any).expSessionType).toBeUndefined();
            expect((parsed as any).expAutomations).toBeUndefined();
            expect((parsed as any).expZen).toBeUndefined();
            expect((parsed as any).expInboxFriends).toBeUndefined();
        });

        it('drops accidentally account-scoped session MRU order while preserving other unknown account settings', () => {
            const parsed = settingsParse({
                sessionMruOrderV1: ['server-a:session-a'],
                unknownAccountSetting: 'preserved',
            } as any);

            expect((parsed as any).sessionMruOrderV1).toBeUndefined();
            expect((parsed as any).unknownAccountSetting).toBe('preserved');
        });

        it('ignores migrated session organization fields as active account settings while preserving unrelated unknown keys', () => {
            const parsed = settingsParse({
                pinnedSessionKeysV1: ['server-a:session-a'],
                sessionFoldersV1: { v: 1, folders: [] },
                sessionTagsV1: { 'server-a:session-a': ['tag-a'] },
                sessionListGroupOrderV1: { 'pinned-v1': ['server-a:session-a'] },
                sessionWorkspaceOrderV1: { 'server:server-a:workspaces': ['workspace:/repo'] },
                workspaceLabelsV1: { 'server:server-a:workspace:/repo': 'Repo' },
                collapsedGroupKeysV1: { 'server-a:group-a': true },
                futureAccountSetting: 'kept',
            } as any);

            expect(parsed).not.toHaveProperty('pinnedSessionKeysV1');
            expect(parsed).not.toHaveProperty('sessionFoldersV1');
            expect(parsed).not.toHaveProperty('sessionTagsV1');
            expect(parsed).not.toHaveProperty('sessionListGroupOrderV1');
            expect(parsed).not.toHaveProperty('sessionWorkspaceOrderV1');
            expect(parsed).not.toHaveProperty('workspaceLabelsV1');
            expect(parsed).not.toHaveProperty('collapsedGroupKeysV1');
            expect((parsed as any).futureAccountSetting).toBe('kept');
        });

        it('preserves explicit featureToggles when present', () => {
            const parsed = settingsParse({
                experiments: true,
                featureToggles: {
                    'sessions.direct': true,
                },
            } as any);

            expect((parsed as any).featureToggles).toEqual({
                'sessions.direct': true,
            });
        });

        it('migrates legacy schemaVersion=2 files.editor=false into the new enabled-by-default behavior', () => {
            const parsed = settingsParse({
                schemaVersion: 2,
                experiments: false,
                featureToggles: {
                    'files.editor': false,
                },
            } as any);

            expect((parsed as any).featureToggles?.['files.editor']).toBeUndefined();
            expect((parsed as any).schemaVersion).toBe(7);
        });

        it('keeps explicit disable for files.editor when schemaVersion matches current (user intent)', () => {
            const parsed = settingsParse({
                schemaVersion: 7,
                experiments: false,
                featureToggles: {
                    'files.editor': false,
                },
            } as any);

            expect((parsed as any).featureToggles?.['files.editor']).toBe(false);
            expect((parsed as any).schemaVersion).toBe(7);
        });

        it('migrates legacy filesDiffPresentationStyle=split to unified (new default) for old schema versions', () => {
            const parsed = settingsParse({
                schemaVersion: 4,
                filesDiffPresentationStyle: 'split',
            } as any);

            expect((parsed as any).filesDiffPresentationStyle).toBe('unified');
            expect((parsed as any).schemaVersion).toBe(7);
        });

        it('keeps explicit filesDiffPresentationStyle=split when schemaVersion matches current (user intent)', () => {
            const parsed = settingsParse({
                schemaVersion: 7,
                filesDiffPresentationStyle: 'split',
            } as any);

            expect((parsed as any).filesDiffPresentationStyle).toBe('split');
            expect((parsed as any).schemaVersion).toBe(7);
        });

        it('migrates legacy sessionListDensity=compact to cozy', () => {
            const parsed = settingsParse({
                sessionListDensity: 'compact',
            } as any);

            expect((parsed as any).sessionListDensity).toBe('cozy');
        });

        it('derives sessionListDensity from legacy compact session view flags when the enum is missing', () => {
            expect(settingsParse({
                compactSessionView: true,
                compactSessionViewMinimal: false,
            } as any).sessionListDensity).toBe('cozy');

            expect(settingsParse({
                compactSessionView: true,
                compactSessionViewMinimal: true,
            } as any).sessionListDensity).toBe('narrow');

            expect(settingsParse({
                compactSessionView: false,
            } as any).sessionListDensity).toBe('detailed');
        });

        it('migrates missing session identity display to avatar for non-narrow session lists', () => {
            expect(settingsParse({
                compactSessionView: true,
                compactSessionViewMinimal: false,
            } as any).sessionListIdentityDisplay).toBe('avatar');

            expect(settingsParse({
                compactSessionView: false,
            } as any).sessionListIdentityDisplay).toBe('avatar');

            expect(settingsParse({
                sessionListDensity: 'cozy',
            } as any).sessionListIdentityDisplay).toBe('avatar');
        });

        it('preserves narrow and explicit session identity display during identity migration', () => {
            expect(settingsParse({
                compactSessionView: true,
                compactSessionViewMinimal: true,
            } as any).sessionListIdentityDisplay).toBe('agentLogo');

            expect(settingsParse({
                sessionListDensity: 'detailed',
                sessionListIdentityDisplay: 'agentLogo',
            } as any).sessionListIdentityDisplay).toBe('agentLogo');
        });

        it('migrates featureToggles inbox.friends to social.friends (hard cutover)', () => {
            const parsed = settingsParse({
                experiments: true,
                featureToggles: {
                    'inbox.friends': true,
                },
            } as any);

            expect((parsed as any).featureToggles?.['inbox.friends']).toBeUndefined();
            expect((parsed as any).featureToggles?.['social.friends']).toBe(true);
        });

        it('drops legacy experimentalFeatureToggles', () => {
            const parsed = settingsParse({
                experiments: true,
                experimentalFeatureToggles: { automations: true },
            } as any);

            expect((parsed as any).experimentalFeatureToggles).toBeUndefined();
            expect((parsed as any).featureToggles).toEqual({});
        });

        it('defaults per-agent new-session permission modes', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).sessionDefaultPermissionModeByTargetKey?.[resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' })]).toBe('default');
            expect((parsed as any).sessionDefaultPermissionModeByTargetKey?.[resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]).toBe('default');
            expect((parsed as any).sessionDefaultPermissionModeByTargetKey?.[resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]).toBe('default');
        });

        it('defaults source-control commit strategy to atomic', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).scmCommitStrategy).toBe('atomic');
        });

        it('defaults source-control backend/diff/remote policies', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).scmGitRepoPreferredBackend).toBe('git');
            expect(parsed.scmGitRepoPreferredBackendQualifiedId).toBeNull();
            expect((parsed as any).scmRemoteConfirmPolicy).toBe('always');
            expect((parsed as any).scmPushRejectPolicy).toBe('prompt_fetch');
            expect((parsed as any).scmDefaultDiffModeByBackend).toEqual({});
            expect((parsed as any).scmReviewMaxFiles).toBe(25);
            expect((parsed as any).scmReviewMaxChangedLines).toBe(2000);
            expect((parsed as any).scmDiffCacheMaxEntries).toBe(30);
            expect((parsed as any).scmDiffCacheMaxTotalBytes).toBe(20 * 1024 * 1024);
            expect((parsed as any).scmReviewPrefetchAheadCountWeb).toBeGreaterThan(0);
            expect((parsed as any).scmReviewPrefetchBehindCountWeb).toBeGreaterThanOrEqual(0);
            expect((parsed as any).scmReviewPrefetchAheadCountNative).toBeGreaterThan(0);
            expect((parsed as any).scmReviewPrefetchBehindCountNative).toBeGreaterThanOrEqual(0);
            expect((parsed as any).scmReviewPrefetchConcurrency).toBeGreaterThan(0);
            expect((parsed as any).scmReviewPrefetchDebounceMs).toBeGreaterThanOrEqual(0);
            expect((parsed as any).scmCommitMessageGeneratorEnabled).toBe(true);
            expect((parsed as any).scmCommitMessageGeneratorBackendId).toBe(DEFAULT_AGENT_ID);
            expect((parsed as any).scmCommitMessageGeneratorInstructions).toBe('');
            expect((parsed as any).scmIncludeCoAuthoredBy).toBe(false);
        });

        it('keeps the released source-control backend field strict while accepting a qualified selection separately', () => {
            const parsed = settingsParse({
                scmGitRepoPreferredBackend: 'acme.scm/stacked',
                scmGitRepoPreferredBackendQualifiedId: 'acme.scm/stacked',
            });

            expect(parsed.scmGitRepoPreferredBackend).toBe('git');
            expect(parsed.scmGitRepoPreferredBackendQualifiedId).toBe('acme.scm/stacked');
        });

        it('accepts pull-only source-control remote confirmation policy', () => {
            const parsed = settingsParse({ scmRemoteConfirmPolicy: 'pull_only' } as any);
            expect((parsed as any).scmRemoteConfirmPolicy).toBe('pull_only');
        });

        it('defaults actions settings', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).actionsSettingsV1).toEqual(DEFAULT_ACTIONS_SETTINGS_V1);
        });

        it('keeps valid actions settings action ids when one entry is invalid', () => {
            const parsed = settingsParse({
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'review.start': { enabled: false },
                        'unknown.action': { enabled: false },
                    },
                },
            } as any);
            expect((parsed as any).actionsSettingsV1).toEqual({
                v: 1,
                actions: {
                    'review.start': {
                        enabled: false,
                        enabledPlacements: [],
                        disabledSurfaces: [],
                        disabledPlacements: [],
                        approvalRequiredSurfaces: [],
                        toolExposureModes: {},
                    },
                },
            });
        });

        it('keeps valid sparse action tool exposure overrides', () => {
            const parsed = settingsParse({
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'review.start': {
                            toolExposureModes: {
                                agent: 'direct',
                                mcp: 'discoverable_only',
                                cli: 'invalid',
                                voice: 'direct',
                            },
                        },
                    },
                },
            } as any);

            expect((parsed as any).actionsSettingsV1).toEqual({
                v: 1,
                actions: {
                    'review.start': {
                        enabledPlacements: [],
                        disabledSurfaces: [],
                        disabledPlacements: [],
                        approvalRequiredSurfaces: [],
                        toolExposureModes: {
                            agent: 'direct',
                            mcp: 'discoverable_only',
                        },
                    },
                },
            });
        });

        it('normalizes legacy cli action surface overrides to cli', () => {
            const parsed = settingsParse({
                actionsSettingsV1: {
                    v: 1,
                    actions: {
                        'review.start': { disabledSurfaces: ['cli'] },
                    },
                },
            } as any);

            expect((parsed as any).actionsSettingsV1).toEqual({
                v: 1,
                actions: {
                    'review.start': {
                        enabledPlacements: [],
                        disabledSurfaces: ['cli'],
                        disabledPlacements: [],
                        approvalRequiredSurfaces: [],
                        toolExposureModes: {},
                    },
                },
            });
        });

        it('defaults files diff syntax highlighting and editor settings', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).filesDiffSyntaxHighlightingMode).toBe('simple');
            expect((parsed as any).filesDiffRendererMode).toBe('pierre');
            expect((parsed as any).filesDiffPresentationStyle).toBe('unified');
            expect((parsed as any).filesDiffFileListVirtualizationMinFiles).toBeGreaterThan(0);
            expect((parsed as any).filesDiffInlineVirtualizationLineThreshold).toBeGreaterThan(0);
            expect((parsed as any).filesDiffReviewCommentsInlineVirtualizationLineThreshold).toBeGreaterThan(0);
            expect((parsed as any).filesDiffReviewCommentsInlineVirtualizationLineThreshold)
                .toBeLessThanOrEqual((parsed as any).filesDiffInlineVirtualizationLineThreshold);
            expect((parsed as any).filesChangedFilesRowDensity).toBe('comfortable');
            expect((parsed as any).filesDiffFoldingEnabled).toBe(true);
            expect((parsed as any).filesDiffFoldingContextThreshold).toBeGreaterThan(0);
            expect((parsed as any).filesDiffFoldingContextRadius).toBeGreaterThan(0);
            expect((parsed as any).filesDiffIntraLineWordDiffEnabled).toBe(true);
            expect((parsed as any).filesDiffIntraLineWordDiffMaxPatchLines).toBeGreaterThan(0);
            expect((parsed as any).filesDiffIntraLineWordDiffMaxPairs).toBeGreaterThan(0);
            expect((parsed as any).filesDiffIntraLineWordDiffMaxLineLength).toBeGreaterThan(0);
            expect((parsed as any).filesDiffTokenizationMaxBytes).toBeGreaterThan(0);
            expect((parsed as any).filesDiffTokenizationMaxLines).toBeGreaterThan(0);
            expect((parsed as any).filesCodeViewJsonInferenceMaxBytes).toBeGreaterThan(0);
            expect((parsed as any).filesImagePreviewCacheMaxEntries).toBe(32);
            expect((parsed as any).filesImagePreviewCacheMaxTotalBytes).toBe(96 * 1024 * 1024);
            expect((parsed as any).filesImagePreviewMaxBytes).toBe(16 * 1024 * 1024);
            expect((parsed as any).filesEditorChangeDebounceMs).toBeGreaterThan(0);
            expect((parsed as any).filesEditorMaxFileBytes).toBeGreaterThan(0);
        });

        it('defaults permission mode apply timing to immediate', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).sessionPermissionModeApplyTiming).toBe('immediate');
        });

        it('defaults agent input history scope to perSession', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).agentInputHistoryScope).toBe('perSession');
        });

        it('defaults app-level replay resume settings', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).sessionReplayEnabled).toBe(false);
            expect((parsed as any).sessionReplayStrategy).toBe('recent_messages');
            expect((parsed as any).sessionReplayRecentMessagesCount).toBeGreaterThan(0);
            expect((parsed as any).sessionReplaySummaryRunnerV1).toBe(null);
        });

        it('defaults session message sending to server pending queue mode', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).sessionMessageSendMode).toBe('server_pending');
            expect((parsed as any).sessionPendingQueueDrainMode).toBe('one_at_a_time');
            expect((parsed as any).sessionPendingQueueDeliveryTiming).toBe('after_foreground_ready');
        });

	        it('defaults voice settings', () => {
	            const parsed = settingsParse({} as any);
                const localConversation = readLocalConversationVoiceSettings(parsed.voice);
             expect((parsed as any).voice.providerId).toBe(null);

            expect((parsed as any).voice.privacy.shareSessionSummary).toBe(true);
            expect((parsed as any).voice.privacy.shareRecentMessages).toBe(true);
            expect((parsed as any).voice.privacy.recentMessagesCount).toBe(3);
            expect((parsed as any).voice.privacy.shareToolNames).toBe(true);
            expect((parsed as any).voice.privacy.sharePermissionRequests).toBe(true);
            expect((parsed as any).voice.privacy.shareFilePaths).toBe(false);
            expect((parsed as any).voice.privacy.shareToolArgs).toBe(false);

	            expect(localConversation.conversationMode).toBe('direct_session');
	            expect(localConversation.agent.backend).toBe('daemon');
	            expect(localConversation.handsFree.enabled).toBe(false);
	            expect(localConversation.handsFree.endpointing.silenceMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs);
	            expect(localConversation.handsFree.endpointing.minSpeechMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs);
	            expect(localConversation.tts.bargeInEnabled).toBe(true);
	            expect(localConversation.agent.permissionIntent).toBe('read-only');
	            expect(localConversation.agent.idleTtlSeconds).toBe(1800);
            expect(localConversation.agent.chatModelSource).toBe('custom');
            expect(localConversation.agent.chatModelId).toBe('default');
            expect(localConversation.agent.commitModelSource).toBe('chat');
            expect(localConversation.streaming.enabled).toBe(true);
            expect(localConversation.streaming.ttsEnabled).toBe(true);
            expect(localConversation.streaming.ttsChunkChars).toBe(200);
            expect(localConversation.agent.verbosity).toBe('short');
        });

        it('does not mutate voice defaults while parsing a partial voice config', () => {
            const parsed1 = settingsParse({
                voice: {
                    privacy: {
                        shareFilePaths: true,
                    },
                },
            } as any);
            // Privacy hardening: shareFilePaths is forced off even if persisted true.
            expect((parsed1 as any).voice.privacy.shareFilePaths).toBe(false);

            const parsed2 = settingsParse({} as any);
            // Defaults must remain stable across calls.
            expect((parsed2 as any).voice.privacy.shareFilePaths).toBe(false);
        });

        it('defaults server-selection settings', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).serverSelectionGroups).toEqual([]);
            expect((parsed as any).serverSelectionActiveTargetKind).toBeNull();
            expect((parsed as any).serverSelectionActiveTargetId).toBeNull();
        });

        it('defaults environment badge visibility to enabled', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).showEnvironmentBadge).toBe(true);
        });

        it('parses environment badge visibility when explicitly disabled', () => {
            const parsed = settingsParse({
                showEnvironmentBadge: false,
            } as any);
            expect((parsed as any).showEnvironmentBadge).toBe(false);
        });

        it('parses server-selection settings values when provided', () => {
            const parsed = settingsParse({
                serverSelectionGroups: [
                    {
                        id: 'dev-work',
                        name: 'Dev Work',
                        serverIds: ['server-a', 'server-b'],
                        presentation: 'flat-with-badge',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'dev-work',
            } as any);
            expect((parsed as any).serverSelectionGroups).toEqual([
                {
                    id: 'dev-work',
                    name: 'Dev Work',
                    serverIds: ['server-a', 'server-b'],
                    presentation: 'flat-with-badge',
                },
            ]);
            expect((parsed as any).serverSelectionActiveTargetKind).toBe('group');
            expect((parsed as any).serverSelectionActiveTargetId).toBe('dev-work');
        });

        it('parses active server target fields when provided', () => {
            const parsed = settingsParse({
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'dev-work',
            } as any);

            expect((parsed as any).serverSelectionActiveTargetKind).toBe('group');
            expect((parsed as any).serverSelectionActiveTargetId).toBe('dev-work');
        });

        it('ignores legacy multi-server settings keys (hard cutover)', () => {
            const parsed = settingsParse({
                multiServerProfiles: [
                    {
                        id: 'dev-work',
                        name: 'Dev Work',
                        serverIds: ['server-a', 'server-b'],
                        presentation: 'grouped',
                    },
                ],
                multiServerActiveProfileId: 'dev-work',
                activeServerTargetKind: 'group',
                activeServerTargetId: 'dev-work',
            } as any);

            expect((parsed as any).serverSelectionGroups).toEqual([]);
            expect((parsed as any).serverSelectionActiveTargetKind).toBeNull();
            expect((parsed as any).serverSelectionActiveTargetId).toBeNull();
            expect((parsed as any).multiServerProfiles).toBeUndefined();
            expect((parsed as any).multiServerActiveProfileId).toBeUndefined();
            expect((parsed as any).activeServerTargetKind).toBeUndefined();
            expect((parsed as any).activeServerTargetId).toBeUndefined();
        });

        it('migrates legacy sessionBusySteerSendPolicy=queue_for_review to server_pending', () => {
            const parsed = settingsParse({
                schemaVersion: 2,
                sessionBusySteerSendPolicy: 'queue_for_review',
            } as any);
            expect((parsed as any).sessionBusySteerSendPolicy).toBe('server_pending');
        });

        it('migrates legacy groupInactiveSessionsByProject into sessionListInactiveGroupingV1 when missing', () => {
            const parsed = settingsParse({
                groupInactiveSessionsByProject: true,
            } as any);

            expect((parsed as any).sessionListInactiveGroupingV1).toBe('project');
        });

        it('defaults the session list section mode to activity grouping', () => {
            const parsed = settingsParse({});

            expect((parsed as any).sessionListSectionModeV1).toBe('activity');
        });

        it('parses the unified session list section mode', () => {
            const parsed = settingsParse({
                sessionListSectionModeV1: 'single',
            } as any);

            expect((parsed as any).sessionListSectionModeV1).toBe('single');
        });

        it('parses the session list active color mode setting', () => {
            const parsed = settingsParse({
                sessionListActiveColorModeV1: 'attentionOnly',
            } as any);

            expect((parsed as any).sessionListActiveColorModeV1).toBe('attentionOnly');
        });

        it('parses the session list attention promotion mode setting', () => {
            const parsed = settingsParse({
                sessionListAttentionPromotionModeV1: 'withinGroups',
            } as any);

            expect((parsed as any).sessionListAttentionPromotionModeV1).toBe('withinGroups');
            expect((settingsParse({
                sessionListAttentionPromotionModeV1: 'invalid',
            } as any) as any).sessionListAttentionPromotionModeV1).toBe('off');
        });

        it('parses the session list working placement mode setting', () => {
            const parsed = settingsParse({
                sessionListWorkingPlacementModeV1: 'global',
            } as any);

            expect((parsed as any).sessionListWorkingPlacementModeV1).toBe('global');
            expect((settingsParse({
                sessionListWorkingPlacementModeV1: 'invalid',
            } as any) as any).sessionListWorkingPlacementModeV1).toBe('off');
        });

        it('parses the session list separate background work setting', () => {
            expect((settingsParse({
                sessionListSeparateBackgroundWorkV1: true,
            } as any) as any).sessionListSeparateBackgroundWorkV1).toBe(true);
            expect((settingsParse({
                sessionListSeparateBackgroundWorkV1: 'true',
            } as any) as any).sessionListSeparateBackgroundWorkV1).toBe(false);
        });

        it('parses new-session persistence defaults', () => {
            const codexTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });
            const claudeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
            const parsed = settingsParse({
                newSessionDefaultPersistenceModeV1: 'direct',
                newSessionDefaultPersistenceModeByTargetKeyV1: {
                    [codexTargetKey]: 'direct',
                    [claudeTargetKey]: 'persisted',
                    invalid: 'nope',
                },
            } as any);

            expect((parsed as any).newSessionDefaultPersistenceModeV1).toBe('direct');
            expect((parsed as any).newSessionDefaultPersistenceModeByTargetKeyV1).toEqual({
                [codexTargetKey]: 'direct',
                [claudeTargetKey]: 'persisted',
            });
        });

        it('migrates legacy lastUsedPermissionMode into per-agent defaults when missing', () => {
            const parsed = settingsParse({
                lastUsedAgent: 'claude',
                lastUsedPermissionMode: 'plan',
            } as any);
            // Legacy mapping: "plan" is now a session behavior mode; treat it as read-only at the
            // permission layer when seeding per-agent defaults.
            expect((parsed as any).sessionDefaultPermissionModeByTargetKey?.[resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' })]).toBe('read-only');
            expect((parsed as any).sessionDefaultPermissionModeByTargetKey?.[resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]).toBe('read-only');
            expect((parsed as any).sessionDefaultPermissionModeByTargetKey?.[resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]).toBe('read-only');
        });

        it('should keep valid secrets when one secret entry is invalid', () => {
            const validSecret = {
                id: 'secret-1',
                name: 'My Secret',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'abc' },
                createdAt: 1,
                updatedAt: 1,
            };
            const invalidSecret = {
                id: '',
                name: '',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'def' },
                createdAt: 2,
                updatedAt: 2,
            };
            const parsed = settingsParse({
                viewInline: true,
                secrets: [validSecret, invalidSecret],
            } as any);

            expect(parsed.viewInline).toBe(true);
            expect(parsed.secrets).toEqual([validSecret]);
        });

        it('should keep valid execution runs guidance entries when one entry is invalid', () => {
            const parsed = settingsParse({
                viewInline: true,
                executionRunsGuidanceEntries: [
                    {
                        id: 'rule-1',
                        description: 'Prefer Claude for UI work',
                        enabled: true,
                        suggestedBackendTarget: { kind: 'backend', backendId: 'claude' },
                        suggestedModelId: 'claude-sonnet-4-5',
                        suggestedIntent: 'delegate',
                    },
                    {
                        id: 'rule-2',
                        description: 'Invalid backend id should be dropped',
                        enabled: true,
                        suggestedBackendTarget: { kind: 'backend', backendId: 'not-a-real-agent' },
                    },
                ],
            } as any);

            expect(parsed.viewInline).toBe(true);
            expect(parsed.executionRunsGuidanceEntries).toEqual([
                expect.objectContaining({
                    id: 'rule-1',
                    description: 'Prefer Claude for UI work',
                    suggestedBackendTarget: { kind: 'backend', backendId: 'claude' },
                    suggestedModelId: 'claude-sonnet-4-5',
                    suggestedIntent: 'delegate',
                }),
            ]);
        });

        it('defaults transcript grouping settings', () => {
            const parsed = settingsParse({});
            expect((parsed as any).transcriptGroupingMode).toBe('turns');
            expect((parsed as any).transcriptGroupToolCalls).toBe(true);
            expect((parsed as any).transcriptTurnToolCallsGroupStrategy).toBe('consecutive_tools');
            expect((parsed as any).transcriptToolCallsCollapsedPreviewCount).toBe(3);
            expect((parsed as any).transcriptToolCallsGroupShowBackground).toBe(true);
            expect((parsed as any).transcriptMessageTimestampDisplayMode).toBe('hover_web_hidden_mobile');
            expect((parsed as any).transcriptMessageTimestampsEnabled).toBeUndefined();
            expect((parsed as any).transcriptTurnGroupToolCalls).toBeUndefined();
            expect((parsed as any).transcriptTurnToolCallsCollapsedPreviewCount).toBeUndefined();
            expect((parsed as any).transcriptTurnToolCallsGroupShowBackground).toBeUndefined();
        });

        it('preserves consecutive tool-call grouping across schema migrations', () => {
            expect((settingsParse({
                schemaVersion: 6,
                transcriptTurnToolCallsGroupStrategy: 'consecutive_tools',
            }) as any).transcriptTurnToolCallsGroupStrategy).toBe('consecutive_tools');

            expect((settingsParse({
                transcriptTurnToolCallsGroupStrategy: 'consecutive_tools',
            }) as any).transcriptTurnToolCallsGroupStrategy).toBe('consecutive_tools');

            expect((settingsParse({
                schemaVersion: 7,
                transcriptTurnToolCallsGroupStrategy: 'consecutive_tools',
            }) as any).transcriptTurnToolCallsGroupStrategy).toBe('consecutive_tools');
        });

        it('migrates the legacy transcript timestamp toggle to the display mode setting', () => {
            expect((settingsParse({ transcriptMessageTimestampsEnabled: true }) as any).transcriptMessageTimestampDisplayMode).toBe('always');
            expect((settingsParse({ transcriptMessageTimestampsEnabled: false }) as any).transcriptMessageTimestampDisplayMode).toBe('hover_web_hidden_mobile');
            expect((settingsParse({ transcriptMessageTimestampDisplayMode: 'never', transcriptMessageTimestampsEnabled: true }) as any).transcriptMessageTimestampDisplayMode).toBe('never');
        });

        it('defaults thinking to inline (summary)', () => {
            const parsed = settingsParse({});
            expect((parsed as any).sessionThinkingDisplayMode).toBe('inline');
            expect((parsed as any).sessionThinkingInlinePresentation).toBe('summary');
            expect((parsed as any).sessionThinkingInlineChrome).toBe('plain');
        });

        it('migrates pre-v4 inline thinking to inline (full) when no inline presentation is set', () => {
            const parsed = settingsParse({ schemaVersion: 3, sessionThinkingDisplayMode: 'inline' } as any);
            expect((parsed as any).schemaVersion).toBeGreaterThanOrEqual(4);
            expect((parsed as any).sessionThinkingDisplayMode).toBe('inline');
            expect((parsed as any).sessionThinkingInlinePresentation).toBe('full');
        });

        it('does not override explicit sessionThinkingInlinePresentation in pre-v4 settings', () => {
            const parsed = settingsParse({ schemaVersion: 3, sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'summary' } as any);
            expect((parsed as any).sessionThinkingInlinePresentation).toBe('summary');
        });

        it('migrates pre-v5 settings to preserve inline thinking chrome (defaults legacy users to card)', () => {
            const parsed = settingsParse({ schemaVersion: 4, sessionThinkingDisplayMode: 'inline' } as any);
            expect((parsed as any).schemaVersion).toBeGreaterThanOrEqual(5);
            expect((parsed as any).sessionThinkingInlineChrome).toBe('card');
        });

        it('does not override explicit sessionThinkingInlineChrome in pre-v5 settings', () => {
            const parsed = settingsParse({ schemaVersion: 4, sessionThinkingInlineChrome: 'plain' } as any);
            expect((parsed as any).sessionThinkingInlineChrome).toBe('plain');
        });

        it('defaults tool timeline chrome settings', () => {
            const parsed = settingsParse({});
            expect((parsed as any).toolViewTimelineChromeMode).toBe('activity_feed');
            expect((parsed as any).toolViewTimelineFeedDefaultExpanded).toBe(false);
            expect((parsed as any).toolViewTimelineFeedTapAction).toBeUndefined();
            expect((parsed as any).toolViewTimelineDensity).toBeUndefined();
            expect((parsed as any).toolViewDetailLevelDefault).toBe('default');
            expect((parsed as any).toolViewTapAction).toBe('expand');
            expect((parsed as any).toolViewExpandedDetailLevelDefault).toBe('default');
        });

        it('preserves legacy toolViewTimelineDensity as an unknown key (ignored by rendering)', () => {
            const parsed = settingsParse({ toolViewTimelineDensity: 'compact' } as any);
            expect((parsed as any).toolViewTimelineDensity).toBe('compact');
        });

        it('defaults transcript motion settings', () => {
            const parsed = settingsParse({});
            expect((parsed as any).transcriptMotionPreset).toBe('subtle');
            expect((parsed as any).transcriptMotionFreshnessMs).toBe(60_000);
            expect((parsed as any).transcriptAnimateNewItemsEnabled).toBe(true);
            expect((parsed as any).transcriptAnimateToolExpandCollapseEnabled).toBe(true);
            expect((parsed as any).transcriptAnimateToolExpandCollapseFreshOnly).toBe(true);
            expect((parsed as any).transcriptAnimateThinkingEnabled).toBe(true);
        });

        it('defaults transcript scroll pin settings', () => {
            const parsed = settingsParse({});
            expect((parsed as any).transcriptScrollPinEnabled).toBe(true);
            expect((parsed as any).transcriptScrollPinOffsetThresholdPx).toBe(72);
            expect((parsed as any).transcriptScrollAutoFollowWhenPinned).toBe(true);
            expect((parsed as any).transcriptScrollJumpToBottomEnabled).toBe(true);
            expect((parsed as any).transcriptScrollJumpToBottomMinNewCount).toBe(1);
            expect((parsed as any).transcriptScrollJumpToBottomRevealViewportRatio).toBe(0.4);
            expect((parsed as any).transcriptScrollJumpToBottomAnimateScroll).toBe(true);
        });

        it('defaults permission prompt surface settings', () => {
            const parsed = settingsParse({});
            expect((parsed as any).permissionPromptSurface).toBe('composer');
        });

        it('parses favorite backend targets and the last new-session picker view', () => {
            const codexTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });
            const claudeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
            const parsed = settingsParse({
                favoriteBackendTargetKeysV1: [
                    codexTargetKey,
                    claudeTargetKey,
                    codexTargetKey,
                    '',
                    42,
                ],
                lastNewSessionAgentPickerViewV1: {
                    kind: 'backend',
                    backendTargetKey: codexTargetKey,
                },
            } as any);

            expect((parsed as any).favoriteBackendTargetKeysV1).toEqual([
                codexTargetKey,
                claudeTargetKey,
            ]);
            expect((parsed as any).lastNewSessionAgentPickerViewV1).toEqual({
                kind: 'backend',
                backendTargetKey: codexTargetKey,
            });

            expect(settingsParse({
                lastNewSessionAgentPickerViewV1: { kind: 'favoriteModels' },
            } as any).lastNewSessionAgentPickerViewV1).toEqual({ kind: 'favoriteModels' });
        });

        it('parses remembered engine selections and drops invalid entries', () => {
            const parsed = settingsParse({
                rememberLastEngineSelectionsV1: true,
                lastEngineSelectionsByScopeV1: {
                    'server-1:backend:codex': {
                        v: 1,
                        modelId: 'gpt-5.4',
                        acpSessionModeId: 'plan',
                        sessionConfigOptionOverrides: {
                            v: 1,
                            updatedAt: 123,
                            overrides: {
                                reasoning_effort: {
                                    updatedAt: 123,
                                    value: 'high',
                                },
                            },
                        },
                        updatedAt: 123,
                    },
                    'server-1:backend:broken': {
                        v: 1,
                        modelId: '',
                        updatedAt: 123,
                    },
                },
            } as any);

            expect((parsed as any).rememberLastEngineSelectionsV1).toBe(true);
            expect((parsed as any).lastEngineSelectionsByScopeV1).toEqual({
                'server-1:backend:codex': {
                    v: 1,
                    modelId: 'gpt-5.4',
                    acpSessionModeId: 'plan',
                    sessionConfigOptionOverrides: {
                        v: 1,
                        updatedAt: 123,
                        overrides: {
                            reasoning_effort: {
                                updatedAt: 123,
                                value: 'high',
                            },
                        },
                    },
                    updatedAt: 123,
                },
            });
        });
    });

    describe('applySettings', () => {
        it('should apply delta to existing settings', () => {
            const currentSettings = makeSettings({ schemaVersion: 1, avatarStyle: 'gradient' });
            const delta: Partial<Settings> = { viewInline: true };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...currentSettings,
                schemaVersion: 1, // Preserved from currentSettings
                viewInline: true,
            });
        });

        it('should merge with defaults', () => {
            const currentSettings = makeSettings({ schemaVersion: 1, avatarStyle: 'gradient', viewInline: true });
            const delta: Partial<Settings> = {};
            expect(applySettings(currentSettings, delta)).toEqual(currentSettings);
        });

        it('should override existing values with delta', () => {
            const currentSettings = makeSettings({ schemaVersion: 1, avatarStyle: 'gradient', viewInline: true });
            const delta: Partial<Settings> = { viewInline: false };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...currentSettings,
                viewInline: false
            });
        });

        it('should handle empty delta', () => {
            const currentSettings = makeSettings({ schemaVersion: 1, avatarStyle: 'gradient', viewInline: true });
            expect(applySettings(currentSettings, {})).toEqual(currentSettings);
        });

        it('should handle extra fields in current settings', () => {
            const currentSettings: any = {
                viewInline: true,
                extraField: 'value'
            };
            const delta: Partial<Settings> = {
                viewInline: false
            };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...settingsDefaults,
                viewInline: false,
                extraField: 'value'
            });
        });

        it('should handle extra fields in delta', () => {
            const currentSettings = makeSettings({ schemaVersion: 1, avatarStyle: 'gradient', viewInline: true });
            const delta: any = {
                viewInline: false,
                newField: 'new value'
            };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...currentSettings,
                viewInline: false,
                newField: 'new value'
            });
        });

        it('should preserve unknown fields from both current and delta', () => {
            const currentSettings: any = {
                viewInline: true,
                existingExtra: 'keep me'
            };
            const delta: any = {
                viewInline: false,
                newExtra: 'add me'
            };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...settingsDefaults,
                viewInline: false,
                existingExtra: 'keep me',
                newExtra: 'add me'
            });
        });
    });

        describe('settingsDefaults', () => {
            it('should have correct default values', () => {
            expect(settingsDefaults.schemaVersion).toBe(7);
            expect(settingsDefaults.experiments).toBe(false);
            expect(settingsDefaults.backendEnabledByTargetKey).toMatchObject({
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' })]: true,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]: true,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'opencode' })]: true,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: true,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'auggie' })]: true,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'qwen' })]: true,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'kimi' })]: true,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'kilo' })]: true,
            });
            expect((settingsDefaults as any).profileEnabledById).toEqual({});
            expect((settingsDefaults as any).backendCliSourcePreferenceByTargetKey).toEqual({});
            expect(settingsDefaults).not.toHaveProperty('codexBackendMode');
            expect(settingsDefaults.sessionReplayMaxSeedChars).toBe(120_000);
            expect(settingsDefaults.sessionMessageSendMode).toBe('server_pending');
            expect((settingsDefaults as any).sessionPendingQueueDrainMode).toBe('one_at_a_time');
            expect((settingsDefaults as any).sessionPendingQueueDeliveryTiming).toBe('after_foreground_ready');
            expect(settingsDefaults.sessionDefaultPermissionModeByTargetKey).toMatchObject({
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' })]: 'default',
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]: 'default',
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: 'default',
            });
            expect(settingsDefaults.toolViewDetailLevelDefault).toBe('default');
            expect(settingsDefaults.toolViewDetailLevelDefaultLocalControl).toBe('title');
            expect(settingsDefaults.toolViewDetailLevelByToolName).toEqual({});
            expect((settingsDefaults as any).toolViewTapAction).toBe('expand');
            expect((settingsDefaults as any).toolViewExpandedDetailLevelDefault).toBe('default');
            expect((settingsDefaults as any).toolViewExpandedDetailLevelByToolName).toEqual({});
            expect(settingsDefaults.toolViewShowDebugByDefault).toBe(false);
            expect(settingsDefaults.terminalConnectLegacySecretExportEnabled).toBe(false);
            expect((settingsDefaults as any).connectedServicesDefaultProfileByServiceId).toEqual({});
            expect((settingsDefaults as any).connectedServicesProfileLabelByKey).toEqual({});
            expect((settingsDefaults as any).connectedServicesQuotaPinnedMeterIdsByKey).toEqual({});
            expect((settingsDefaults as any).connectedServicesCollapsedItemKeysV1).toEqual({});
            expect((settingsDefaults as any).connectedServicesQuotaSummaryStrategyByKey).toEqual({});
            expect(settingsDefaults).not.toHaveProperty('pinnedSessionKeysV1');
            expect(settingsDefaults).not.toHaveProperty('sessionFoldersV1');
            expect(settingsDefaults).not.toHaveProperty('sessionListGroupOrderV1');
            expect((settingsDefaults as any).sessionListOrderingModeV1).toBe('custom');
            expect((settingsDefaults as any).sessionListFolderSortModeV1).toBe('foldersFirst');
            expect((settingsDefaults as any).notificationsSettingsV1).toEqual({
                v: 1,
                pushEnabled: true,
                ready: true,
                readyIncludeMessageText: true,
                foregroundBehavior: 'full',
                permissionRequest: true,
                userActionRequest: true,
                connectedServiceAccountSwitch: true,
                connectedServiceQuotaBlocked: true,
                connectedServiceQuotaRecovered: true,
            });
            expect((settingsDefaults as any).notificationChannelsV1).toEqual([
                {
                    v: 1,
                    id: 'builtin:expo_push',
                    kind: 'expo_push',
                    enabled: true,
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                        connectedServiceAccountSwitch: true,
                        connectedServiceQuotaBlocked: true,
                        connectedServiceQuotaRecovered: true,
                    },
                    readyIncludeMessageText: true,
                },
            ]);
            expect((settingsDefaults as any).attentionDeliveryPolicyV1).toEqual(DEFAULT_ATTENTION_DELIVERY_POLICY_V1);
            expect((settingsDefaults as any).attachmentsUploadsUploadLocation).toBe('workspace');
            expect((settingsDefaults as any).attachmentsUploadsWorkspaceRelativeDir).toBe('.happier/uploads');
            expect((settingsDefaults as any).attachmentsUploadsVcsIgnoreStrategy).toBe('git_info_exclude');
            expect((settingsDefaults as any).attachmentsUploadsVcsIgnoreWritesEnabled).toBe(true);
            expect((settingsDefaults as any).attachmentsUploadsMaxFileBytes).toBe(25 * 1024 * 1024);
            expect((settingsDefaults as any).expGemini).toBeUndefined();
            expect((settingsDefaults as any).sessionDefaultPermissionModeClaude).toBeUndefined();
            expect((settingsDefaults as any).sessionDefaultPermissionModeCodex).toBeUndefined();
            expect((settingsDefaults as any).sessionDefaultPermissionModeGemini).toBeUndefined();
        });

        it('should be a valid Settings object', () => {
            const parsed = settingsParse(settingsDefaults);
            expect(parsed).toEqual(parsedSettingsDefaults);
        });

        it('drops deprecated session-only tool view keys', () => {
            const parsed = settingsParse({
                toolViewDetailLevelDefaultActivityFeed: 'title',
                toolViewExpandedDetailLevelDefaultActivityFeed: 'summary',
                toolViewCardDensity: 'compact',
            } as any);

            expect((parsed as any).toolViewDetailLevelDefaultActivityFeed).toBeUndefined();
            expect((parsed as any).toolViewExpandedDetailLevelDefaultActivityFeed).toBeUndefined();
            expect((parsed as any).toolViewCardDensity).toBeUndefined();
        });
    });

    describe('profiles', () => {
        it('accepts the built-in profiles schema', () => {
            const profile = getBuiltInProfile('anthropic');
            expect(profile).toBeTruthy();
            const parsed = AIBackendProfileSchema.safeParse(profile);
            expect(parsed.success).toBe(true);
        });

        it('accepts per-agent persistence mode defaults on profiles', () => {
            const profile = {
                id: 'profile-1',
                name: 'Profile 1',
                environmentVariables: [],
                defaultPermissionModeByAgent: {},
                defaultPersistenceModeByAgent: { codex: 'direct', claude: 'persisted' },
                compatibility: { codex: true, claude: true, gemini: true },
                envVarRequirements: [],
                isBuiltIn: false,
                createdAt: 1,
                updatedAt: 1,
                version: '1.0.0',
            };

            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });
    });

    // Keep the remainder of the file intact; avoid pinning full defaults objects in tests.

    describe('forward/backward compatibility', () => {
        it('should handle settings from older version (missing new fields)', () => {
            const oldVersionSettings = {};
            const parsed = settingsParse(oldVersionSettings);
            expect(parsed).toEqual(parsedSettingsDefaults);
        });

        it('opaque-preserves legacy plugin settings when upgrading a pre-v6 payload', () => {
            const parsed = settingsParse({ schemaVersion: 5, codexBackendMode: 'mcp' } as any);
            expect(parsed.schemaVersion).toBe(7);
            expect((parsed as any).codexBackendMode).toBe('mcp');
        });

        it('keeps valid backend CLI source preferences when parsing forward-compatible settings', () => {
            const parsed = settingsParse({
                backendCliSourcePreferenceById: {
                    codex: 'managed-first',
                    gemini: 'system-first',
                    invalid: 'nope',
                },
            } as any);

            expect((parsed as any).backendCliSourcePreferenceByTargetKey).toEqual({
                'backend:codex': 'managed-first',
                'backend:gemini': 'system-first',
            });
        });

        it('should handle settings from newer version (extra fields)', () => {
            const newVersionSettings = {
                viewInline: true,
                futureFeature: 'some value',
                anotherNewField: { complex: 'object' }
            };
            const parsed = settingsParse(newVersionSettings);
            expect(parsed.viewInline).toBe(true);
            expect((parsed as any).futureFeature).toBe('some value');
            expect((parsed as any).anotherNewField).toEqual({ complex: 'object' });
        });

        it('should preserve unknown fields when applying changes (but drop deprecated session-only tool view keys)', () => {
            const settingsWithFutureFields: any = {
                viewInline: false,
                futureField1: 'value1',
                futureField2: 42,
                toolViewDetailLevelDefaultActivityFeed: 'title',
                toolViewExpandedDetailLevelDefaultActivityFeed: 'summary',
                toolViewCardDensity: 'compact',
            };
            const delta: Partial<Settings> = {
                viewInline: true
            };
            const result = applySettings(settingsWithFutureFields, delta);
            expect(result).toEqual({
                ...settingsDefaults,
                viewInline: true,
                futureField1: 'value1',
                futureField2: 42,
            });
        });
    });

    describe('edge cases', () => {
        it('should handle circular references gracefully', () => {
            const circular: any = { viewInline: true };
            circular.self = circular;

            // Should not throw and should return defaults due to parse error
            expect(() => settingsParse(circular)).not.toThrow();
        });

        it('should handle very large objects', () => {
            const largeSettings: any = { viewInline: true };
            for (let i = 0; i < 1000; i++) {
                largeSettings[`field${i}`] = `value${i}`;
            }
            const parsed = settingsParse(largeSettings);
            expect(parsed.viewInline).toBe(true);
            expect(Object.keys(parsed).length).toBeGreaterThan(1000);
        });

        it('should handle settings with prototype pollution attempts', () => {
            const maliciousSettings = {
                viewInline: true,
                '__proto__': { evil: true },
                'constructor': { prototype: { evil: true } },
                'prototype': { evil: true },
            };
            const parsed = settingsParse(maliciousSettings);
            expect(parsed.viewInline).toBe(true);
            expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(parsed, 'constructor')).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(parsed, 'prototype')).toBe(false);
            expect(({} as any).evil).toBeUndefined();
        });
    });

    describe('AIBackendProfile validation', () => {
        it('validates built-in Anthropic profile', () => {
            const profile = getBuiltInProfile('anthropic');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in DeepSeek profile', () => {
            const profile = getBuiltInProfile('deepseek');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in Z.AI profile', () => {
            const profile = getBuiltInProfile('zai');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in OpenAI profile', () => {
            const profile = getBuiltInProfile('openai');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in Azure OpenAI profile', () => {
            const profile = getBuiltInProfile('azure-openai');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in Codex profile', () => {
            const profile = getBuiltInProfile('codex');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in Gemini profile', () => {
            const profile = getBuiltInProfile('gemini');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in Gemini API key profile', () => {
            const profile = getBuiltInProfile('gemini-api-key');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in Gemini Vertex profile', () => {
            const profile = getBuiltInProfile('gemini-vertex');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('accepts all 7 permission modes', () => {
            const modes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo'];
            modes.forEach(mode => {
                const profile = {
                    id: crypto.randomUUID(),
                    name: 'Test Profile',
                    defaultPermissionMode: mode,
                    compatibility: { claude: true, codex: true },
                };
                expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
            });
        });

        it('rejects invalid permission mode', () => {
            const profile = {
                id: crypto.randomUUID(),
                name: 'Test Profile',
                defaultPermissionMode: 'invalid-mode',
                compatibility: { claude: true, codex: true },
            };
            expect(() => AIBackendProfileSchema.parse(profile)).toThrow();
        });

        it('validates environment variable names', () => {
            const validProfile = {
                id: crypto.randomUUID(),
                name: 'Test Profile',
                environmentVariables: [
                    { name: 'VALID_VAR_123', value: 'test' },
                    { name: 'API_KEY', value: '${SECRET}' },
                ],
                compatibility: { claude: true, codex: true },
            };
            expect(() => AIBackendProfileSchema.parse(validProfile)).not.toThrow();
        });

        it('rejects invalid environment variable names', () => {
            const invalidProfile = {
                id: crypto.randomUUID(),
                name: 'Test Profile',
                environmentVariables: [
                    { name: 'invalid-name', value: 'test' },
                ],
                compatibility: { claude: true, codex: true },
            };
            expect(() => AIBackendProfileSchema.parse(invalidProfile)).toThrow();
        });

        it('accepts profiles with multiple required secret env vars', () => {
            const profile = {
                id: crypto.randomUUID(),
                name: 'Test Profile',
                envVarRequirements: [
                    { name: 'OPENAI_API_KEY', kind: 'secret', required: true },
                    { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', required: true },
                ],
                compatibility: { claude: true, codex: true, gemini: true },
            };
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('accepts machine-login profiles that also declare secret requirements', () => {
            const profile = {
                id: crypto.randomUUID(),
                name: 'Test Profile',
                authMode: 'machineLogin',
                requiresMachineLogin: 'claude-code',
                envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
                compatibility: { claude: true, codex: true, gemini: true },
            };
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('rejects requiresMachineLogin when authMode is not machineLogin', () => {
            const invalidProfile = {
                id: crypto.randomUUID(),
                name: 'Test Profile',
                authMode: undefined,
                requiresMachineLogin: 'claude-code',
                envVarRequirements: [],
                compatibility: { claude: true, codex: true, gemini: true },
            };
            expect(() => AIBackendProfileSchema.parse(invalidProfile)).toThrow();
        });
    });

    describe('SavedSecret validation', () => {
        it('accepts valid secrets entries in settingsParse', () => {
            const now = Date.now();
            const parsed = settingsParse({
                secrets: [
                    { id: 'k1', name: 'My Secret', kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: 'sk-test' }, createdAt: now, updatedAt: now },
                ],
            });
            const secrets = parsed.secrets as SavedSecret[];
            expect(secrets.length).toBe(1);
            expect(secrets[0]?.name).toBe('My Secret');
            // settingsParse should tolerate plaintext values (legacy/input form),
            // but the runtime should seal them before persisting.
            expect(secrets[0]?.encryptedValue?.value).toBe('sk-test');
        });

        it('drops invalid secrets entries (missing value)', () => {
            const parsed = settingsParse({
                secrets: [
                    { id: 'k1', name: 'Missing value', kind: 'apiKey', encryptedValue: { _isSecretValue: true } },
                ],
            } as any);
            // settingsParse validates per-field, so invalid field should fall back to default.
            expect(parsed.secrets).toEqual([]);
        });

        it('accepts encrypted-at-rest secrets entries (SecretString.encryptedValue)', () => {
            const now = Date.now();
            const parsed = settingsParse({
                secrets: [
                    { id: 'k1', name: 'My Secret', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'Zm9v' } }, createdAt: now, updatedAt: now },
                ],
            } as any);
            const secrets = parsed.secrets as SavedSecret[];
            expect(secrets.length).toBe(1);
            expect(secrets[0]?.name).toBe('My Secret');
            expect(secrets[0]?.encryptedValue?.encryptedValue?.t).toBe('enc-v1');
        });
    });

    describe('secretBindingsByProfileId', () => {
        it('defaults to an empty object', () => {
            const parsed = settingsParse({});
            expect(parsed.secretBindingsByProfileId).toEqual({});
        });
    });

    // Voice settings intentionally do not migrate legacy flat voice keys.

    describe('voice privacy settings', () => {
        it('forces voice.privacy.shareToolArgs to false even if persisted true', () => {
            const parsed = settingsParse({ voice: { privacy: { shareToolArgs: true } } } as any);
            expect((parsed as any).voice.privacy.shareToolArgs).toBe(false);
        });
    });

    describe('version-mismatch scenario (bug fix)', () => {
        it('should preserve pending changes when merging server settings', () => {
            // Simulates the bug scenario:
            // 1. User enables useEnhancedSessionWizard (local change)
            // 2. Version-mismatch occurs (server has newer version from another device)
            // 3. Server settings don't have the flag (it was added by this device)
            // 4. Merge should preserve the pending change

            const serverSettings: Partial<Settings> = {
                // Server settings from another device (version 11)
                // Missing useEnhancedSessionWizard because other device doesn't have it
                viewInline: true,
                profiles: [makeProfile({ id: 'server-profile', name: 'Server Profile', createdAt: Date.now(), updatedAt: Date.now() })]
            };

            const pendingChanges: Partial<Settings> = {
                // User's local changes that haven't synced yet
                useEnhancedSessionWizard: true,
                profiles: [makeProfile({ id: 'local-profile', name: 'Local Profile', createdAt: Date.now(), updatedAt: Date.now() })]
            };

            // Parse server settings (fills in defaults for missing fields)
            const parsedServerSettings = settingsParse(serverSettings);

            // Verify server settings default useEnhancedSessionWizard to false
            expect(parsedServerSettings.useEnhancedSessionWizard).toBe(false);

            // Apply pending changes on top of server settings
            const mergedSettings = applySettings(parsedServerSettings, pendingChanges);

            // CRITICAL: Pending changes should override defaults
            expect(mergedSettings.useEnhancedSessionWizard).toBe(true);
            expect(mergedSettings.profiles).toEqual(pendingChanges.profiles);
            expect(mergedSettings.viewInline).toBe(true); // Preserved from server
        });

        it('should handle multiple pending changes during version-mismatch', () => {
            const serverSettings = settingsParse({
                viewInline: false,
                experiments: false
            });

            const pendingChanges: Partial<Settings> = {
                useEnhancedSessionWizard: true,
                experiments: true,
                profiles: []
            };

            const merged = applySettings(serverSettings, pendingChanges);

            expect(merged.useEnhancedSessionWizard).toBe(true);
            expect(merged.experiments).toBe(true);
            expect(merged.viewInline).toBe(false); // From server
        });

        it('should handle empty server settings (server reset scenario)', () => {
            const serverSettings = settingsParse({});  // Server has no settings

            const pendingChanges: Partial<Settings> = {
                useEnhancedSessionWizard: true
            };

            const merged = applySettings(serverSettings, pendingChanges);

            // Pending change should override default
            expect(merged.useEnhancedSessionWizard).toBe(true);
            // Other fields use defaults
            expect(merged.viewInline).toBe(false);
        });

        it('should preserve user flag when server lacks field', () => {
            // Exact bug scenario:
            // Server has old settings without useEnhancedSessionWizard
            const serverSettings = settingsParse({
                schemaVersion: 1,
                viewInline: false,
                // useEnhancedSessionWizard: NOT PRESENT
            });

            // User enabled flag locally (in pending)
            const pendingChanges: Partial<Settings> = {
                useEnhancedSessionWizard: true
            };

            // Merge for version-mismatch retry
            const merged = applySettings(serverSettings, pendingChanges);

            // BUG WOULD BE: merged.useEnhancedSessionWizard = false (from defaults)
            // FIX IS: merged.useEnhancedSessionWizard = true (from pending)
            expect(merged.useEnhancedSessionWizard).toBe(true);
        });

        it('should handle accumulating pending changes across syncs', () => {
            // Scenario: User makes multiple changes before sync completes

            // Initial state from server
            const serverSettings = settingsParse({
                viewInline: false,
                experiments: false
            });

            // First pending change
            const pending1: Partial<Settings> = {
                useEnhancedSessionWizard: true
            };

            // Accumulate second change (simulates line 298: this.pendingSettings = { ...this.pendingSettings, ...delta })
            const pending2: Partial<Settings> = {
                ...pending1,
                profiles: [makeProfile({ id: 'test-profile', name: 'Test', createdAt: Date.now(), updatedAt: Date.now() })]
            };

            // Merge with server settings
            const merged = applySettings(serverSettings, pending2);
            const profiles = merged.profiles as AIBackendProfile[];

            // Both pending changes preserved
            expect(merged.useEnhancedSessionWizard).toBe(true);
            expect(profiles).toHaveLength(1);
            expect(profiles[0]?.id).toBe('test-profile');
            // Server settings preserved
            expect(merged.viewInline).toBe(false);
            expect(merged.experiments).toBe(false);
        });

        it('should handle multi-device conflict: Device A flag + Device B profile', () => {
            // Device A and B both at version 10
            // Device A enables flag, Device B adds profile
            // Both POST to server simultaneously
            // One wins (becomes v11), other gets version-mismatch

            // Server accepted Device B's change first (v11)
            const serverSettingsV11 = settingsParse({
                profiles: [makeProfile({
                    id: 'device-b-profile',
                    name: 'Device B Profile',
                    compatibility: { claude: true, codex: true, gemini: true },
                    compatibilityByTargetKey: { 'agent:claude': true, 'agent:codex': true, 'agent:gemini': true },
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                })]
            });

            // Device A's pending change
            const deviceAPending: Partial<Settings> = {
                useEnhancedSessionWizard: true
            };

            // Device A merges and retries
            const merged = applySettings(serverSettingsV11, deviceAPending);
            const profiles = merged.profiles as AIBackendProfile[];

            // Device A's flag preserved
            expect(merged.useEnhancedSessionWizard).toBe(true);
            // Device B's profile preserved
            expect(profiles).toHaveLength(1);
            expect(profiles[0]?.id).toBe('device-b-profile');
        });

        it('should handle Device A and B both changing same field', () => {
            // Device A sets flag to true
            // Device B sets flag to false
            // One POSTs first, other gets version-mismatch

            const serverSettings = settingsParse({
                useEnhancedSessionWizard: false  // Device B won
            });

            const deviceAPending: Partial<Settings> = {
                useEnhancedSessionWizard: true  // Device A's conflicting change
            };

            // Device A merges (its pending overrides server)
            const merged = applySettings(serverSettings, deviceAPending);

            // Device A's value wins (last-write-wins for pending changes)
            expect(merged.useEnhancedSessionWizard).toBe(true);
        });

        it('should handle server settings with extra fields + pending changes', () => {
            // Server has newer schema version with new fields
            const serverSettings = settingsParse({
                viewInline: true,
                futureFeature: 'some value',  // Field this device doesn't know about
                anotherNewField: 123
            });

            const pendingChanges: Partial<Settings> = {
                useEnhancedSessionWizard: true,
                experiments: true
            };

            const merged = applySettings(serverSettings, pendingChanges);

            // Pending changes applied
            expect(merged.useEnhancedSessionWizard).toBe(true);
            expect(merged.experiments).toBe(true);
            // Server fields preserved
            expect(merged.viewInline).toBe(true);
            expect((merged as any).futureFeature).toBe('some value');
            expect((merged as any).anotherNewField).toBe(123);
        });

        it('should handle empty pending (no local changes)', () => {
            const serverSettings = settingsParse({
                useEnhancedSessionWizard: true,
                viewInline: true
            });

            const pendingChanges: Partial<Settings> = {};

            const merged = applySettings(serverSettings, pendingChanges);

            // Server settings unchanged
            expect(merged).toEqual(serverSettings);
        });

        it('should handle delta overriding multiple server fields', () => {
            const serverSettings = settingsParse({
                viewInline: false,
                experiments: false,
                useEnhancedSessionWizard: false,
                analyticsOptOut: false
            });

            const pendingChanges: Partial<Settings> = {
                viewInline: true,
                useEnhancedSessionWizard: true,
                analyticsOptOut: true
            };

            const merged = applySettings(serverSettings, pendingChanges);

            // All pending changes applied
            expect(merged.viewInline).toBe(true);
            expect(merged.useEnhancedSessionWizard).toBe(true);
            expect(merged.analyticsOptOut).toBe(true);
            // Un-changed field from server
            expect(merged.experiments).toBe(false);
        });

        it('should preserve complex nested structures during merge', () => {
            const serverSettings = settingsParse({
                profiles: [makeProfile({
                    id: 'server-profile-1',
                    name: 'Server Profile',
                    compatibility: { claude: true, codex: true, gemini: true },
                    compatibilityByTargetKey: { 'agent:claude': true, 'agent:codex': true, 'agent:gemini': true },
                    createdAt: 1000,
                    updatedAt: 1000,
                })],
                dismissedCLIWarnings: {
                    perMachine: { 'machine-1': { claude: true } },
                    global: { codex: true }
                }
            });

            const pendingChanges: Partial<Settings> = {
                useEnhancedSessionWizard: true,
                profiles: [makeProfile({
                    id: 'local-profile-1',
                    name: 'Local Profile',
                    createdAt: 2000,
                    updatedAt: 2000,
                })],
                dismissedCLIWarnings: {
                    perMachine: { 'machine-2': { claude: true } },
                    global: {}
                }
            };

            const merged = applySettings(serverSettings, pendingChanges);

            // Pending changes completely override (not deep merge)
            expect(merged.useEnhancedSessionWizard).toBe(true);
            expect(merged.profiles).toEqual(pendingChanges.profiles);
            expect(merged.dismissedCLIWarnings).toEqual(pendingChanges.dismissedCLIWarnings);
        });
    });
});
