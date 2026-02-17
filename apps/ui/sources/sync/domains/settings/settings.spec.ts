import { describe, it, expect } from 'vitest';
import { settingsParse, applySettings, settingsDefaults, type Settings, AIBackendProfileSchema } from './settings';
import { getBuiltInProfile } from '../profiles/profileUtils';

describe('settings', () => {
    const makeSettings = (overrides: Partial<Settings> = {}): Settings => ({
        ...settingsDefaults,
        ...overrides,
    });

    describe('settingsParse', () => {
        it('should return defaults when given invalid input', () => {
            expect(settingsParse(null)).toEqual(settingsDefaults);
            expect(settingsParse(undefined)).toEqual(settingsDefaults);
            expect(settingsParse('invalid')).toEqual(settingsDefaults);
            expect(settingsParse(123)).toEqual(settingsDefaults);
            expect(settingsParse([])).toEqual(settingsDefaults);
        });

        it('should return defaults when given empty object', () => {
            expect(settingsParse({})).toEqual(settingsDefaults);
        });

        it('should parse valid settings object', () => {
            const validSettings = {
                viewInline: true
            };
            expect(settingsParse(validSettings)).toEqual({
                ...settingsDefaults,
                viewInline: true
            });
        });

        it('should ignore invalid field types and use defaults', () => {
            const invalidSettings = {
                viewInline: 'not a boolean'
            };
            expect(settingsParse(invalidSettings)).toEqual(settingsDefaults);
        });

        it('should preserve unknown fields (loose schema)', () => {
            const settingsWithExtra = {
                viewInline: true,
                unknownField: 'some value',
                anotherField: 123
            };
            const result = settingsParse(settingsWithExtra);
            expect(result).toEqual({
                ...settingsDefaults,
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
                ...settingsDefaults,
                viewInline: true
            });
        });

        it('should handle settings with null/undefined values', () => {
            const settingsWithNull = {
                viewInline: null,
                someOtherField: undefined
            };
            expect(settingsParse(settingsWithNull)).toEqual({
                ...settingsDefaults,
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
                ...settingsDefaults,
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

        it('preserves explicit featureToggles when present', () => {
            const parsed = settingsParse({
                experiments: true,
                featureToggles: {
                    'session.typeSelector': true,
                },
            } as any);

            expect((parsed as any).featureToggles).toEqual({
                'session.typeSelector': true,
            });
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
            expect((parsed as any).sessionDefaultPermissionModeByAgent?.claude).toBe('default');
            expect((parsed as any).sessionDefaultPermissionModeByAgent?.codex).toBe('default');
            expect((parsed as any).sessionDefaultPermissionModeByAgent?.gemini).toBe('default');
        });

        it('defaults source-control commit strategy to atomic', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).scmCommitStrategy).toBe('atomic');
        });

        it('defaults source-control backend/diff/remote policies', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).scmGitRepoPreferredBackend).toBe('git');
            expect((parsed as any).scmRemoteConfirmPolicy).toBe('always');
            expect((parsed as any).scmPushRejectPolicy).toBe('prompt_fetch');
            expect((parsed as any).scmDefaultDiffModeByBackend).toEqual({});
            expect((parsed as any).scmReviewMaxFiles).toBe(25);
            expect((parsed as any).scmReviewMaxChangedLines).toBe(2000);
            expect((parsed as any).scmCommitMessageGeneratorEnabled).toBe(false);
            expect((parsed as any).scmCommitMessageGeneratorBackendId).toBe('claude');
            expect((parsed as any).scmCommitMessageGeneratorInstructions).toBe('');
            expect((parsed as any).scmIncludeCoAuthoredBy).toBe(false);
        });

        it('defaults actions settings', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).actionsSettingsV1).toEqual({ v: 1, actions: {} });
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
                actions: { 'review.start': { enabled: false, enabledPlacements: [], disabledSurfaces: [], disabledPlacements: [] } },
            });
        });

        it('defaults files diff syntax highlighting and editor settings', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).filesDiffSyntaxHighlightingMode).toBe('simple');
            expect((parsed as any).filesChangedFilesRowDensity).toBe('comfortable');
            expect((parsed as any).filesDiffTokenizationMaxBytes).toBeGreaterThan(0);
            expect((parsed as any).filesDiffTokenizationMaxLines).toBeGreaterThan(0);
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
        });

        it('defaults voice settings', () => {
            const parsed = settingsParse({} as any);
            expect((parsed as any).voice.providerId).toBe('realtime_elevenlabs');

            expect((parsed as any).voice.privacy.shareSessionSummary).toBe(true);
            expect((parsed as any).voice.privacy.shareRecentMessages).toBe(true);
            expect((parsed as any).voice.privacy.recentMessagesCount).toBe(3);
            expect((parsed as any).voice.privacy.shareToolNames).toBe(true);
            expect((parsed as any).voice.privacy.sharePermissionRequests).toBe(true);
            expect((parsed as any).voice.privacy.shareFilePaths).toBe(false);
            expect((parsed as any).voice.privacy.shareToolArgs).toBe(false);

            expect((parsed as any).voice.adapters.local_conversation.conversationMode).toBe('direct_session');
            expect((parsed as any).voice.adapters.local_conversation.agent.backend).toBe('daemon');
            expect((parsed as any).voice.adapters.local_conversation.handsFree.enabled).toBe(false);
            expect((parsed as any).voice.adapters.local_conversation.handsFree.endpointing.silenceMs).toBe(450);
            expect((parsed as any).voice.adapters.local_conversation.handsFree.endpointing.minSpeechMs).toBe(120);
            expect((parsed as any).voice.adapters.local_conversation.tts.bargeInEnabled).toBe(true);
            expect((parsed as any).voice.adapters.local_conversation.agent.permissionPolicy).toBe('read_only');
            expect((parsed as any).voice.adapters.local_conversation.agent.idleTtlSeconds).toBe(1800);
            expect((parsed as any).voice.adapters.local_conversation.agent.chatModelSource).toBe('custom');
            expect((parsed as any).voice.adapters.local_conversation.agent.chatModelId).toBe('default');
            expect((parsed as any).voice.adapters.local_conversation.agent.commitModelSource).toBe('chat');
            expect((parsed as any).voice.adapters.local_conversation.streaming.enabled).toBe(false);
            expect((parsed as any).voice.adapters.local_conversation.streaming.ttsEnabled).toBe(false);
            expect((parsed as any).voice.adapters.local_conversation.streaming.ttsChunkChars).toBe(200);
            expect((parsed as any).voice.adapters.local_conversation.agent.verbosity).toBe('short');
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

        it('migrates legacy lastUsedPermissionMode into per-agent defaults when missing', () => {
            const parsed = settingsParse({
                lastUsedAgent: 'claude',
                lastUsedPermissionMode: 'plan',
            } as any);
            expect((parsed as any).sessionDefaultPermissionModeByAgent?.claude).toBe('plan');
            // Non-Claude agents clamp unsupported modes to defaults when seeding.
            expect((parsed as any).sessionDefaultPermissionModeByAgent?.codex).toBe('default');
            expect((parsed as any).sessionDefaultPermissionModeByAgent?.gemini).toBe('default');
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
                        suggestedBackendId: 'claude',
                        suggestedModelId: 'claude-sonnet-4-5',
                        suggestedIntent: 'delegate',
                    },
                    {
                        id: 'rule-2',
                        description: 'Invalid backend id should be dropped',
                        enabled: true,
                        suggestedBackendId: 'not-a-real-agent',
                    },
                ],
            } as any);

            expect(parsed.viewInline).toBe(true);
            expect(parsed.executionRunsGuidanceEntries).toEqual([
                expect.objectContaining({
                    id: 'rule-1',
                    description: 'Prefer Claude for UI work',
                    suggestedBackendId: 'claude',
                    suggestedModelId: 'claude-sonnet-4-5',
                    suggestedIntent: 'delegate',
                }),
            ]);
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
            expect(settingsDefaults.schemaVersion).toBe(2);
            expect(settingsDefaults.experiments).toBe(false);
            expect(settingsDefaults.backendEnabledById).toMatchObject({
                claude: true,
                codex: true,
                opencode: true,
                gemini: true,
                auggie: true,
                qwen: true,
                kimi: true,
                kilo: true,
            });
            expect(settingsDefaults.codexBackendMode).toBe('mcp');
            expect(settingsDefaults.sessionDefaultPermissionModeByAgent).toMatchObject({
                claude: 'default',
                codex: 'default',
                gemini: 'default',
            });
            expect(settingsDefaults.toolViewDetailLevelDefault).toBe('summary');
            expect(settingsDefaults.toolViewDetailLevelDefaultLocalControl).toBe('title');
            expect(settingsDefaults.toolViewDetailLevelByToolName).toEqual({});
            expect((settingsDefaults as any).toolViewTapAction).toBe('expand');
            expect((settingsDefaults as any).toolViewExpandedDetailLevelDefault).toBe('full');
            expect((settingsDefaults as any).toolViewExpandedDetailLevelByToolName).toEqual({});
            expect(settingsDefaults.toolViewShowDebugByDefault).toBe(false);
            expect(settingsDefaults.terminalConnectLegacySecretExportEnabled).toBe(false);
            expect((settingsDefaults as any).connectedServicesDefaultProfileByServiceId).toEqual({});
            expect((settingsDefaults as any).connectedServicesProfileLabelByKey).toEqual({});
            expect((settingsDefaults as any).connectedServicesQuotaPinnedMeterIdsByKey).toEqual({});
            expect((settingsDefaults as any).connectedServicesQuotaSummaryStrategyByKey).toEqual({});
            expect((settingsDefaults as any).pinnedSessionKeysV1).toEqual([]);
            expect((settingsDefaults as any).sessionListGroupOrderV1).toEqual({});
            expect((settingsDefaults as any).notificationsSettingsV1).toEqual({
                v: 1,
                pushEnabled: true,
                ready: true,
                permissionRequest: true,
            });
            expect((settingsDefaults as any).expGemini).toBeUndefined();
            expect((settingsDefaults as any).sessionDefaultPermissionModeClaude).toBeUndefined();
            expect((settingsDefaults as any).sessionDefaultPermissionModeCodex).toBeUndefined();
            expect((settingsDefaults as any).sessionDefaultPermissionModeGemini).toBeUndefined();
        });

        it('should be a valid Settings object', () => {
            const parsed = settingsParse(settingsDefaults);
            expect(parsed).toEqual(settingsDefaults);
        });
    });

    describe('profiles', () => {
        it('accepts the built-in profiles schema', () => {
            const profile = getBuiltInProfile('anthropic');
            expect(profile).toBeTruthy();
            const parsed = AIBackendProfileSchema.safeParse(profile);
            expect(parsed.success).toBe(true);
        });
    });

    // Keep the remainder of the file intact; avoid pinning full defaults objects in tests.

    describe('forward/backward compatibility', () => {
        it('should handle settings from older version (missing new fields)', () => {
            const oldVersionSettings = {};
            const parsed = settingsParse(oldVersionSettings);
            expect(parsed).toEqual(settingsDefaults);
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

        it('should preserve unknown fields when applying changes', () => {
            const settingsWithFutureFields: any = {
                viewInline: false,
                futureField1: 'value1',
                futureField2: 42
            };
            const delta: Partial<Settings> = {
                viewInline: true
            };
            const result = applySettings(settingsWithFutureFields, delta);
            expect(result).toEqual({
                ...settingsDefaults,
                viewInline: true,
                futureField1: 'value1',
                futureField2: 42
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
            expect(parsed.secrets.length).toBe(1);
            expect(parsed.secrets[0]?.name).toBe('My Secret');
            // settingsParse should tolerate plaintext values (legacy/input form),
            // but the runtime should seal them before persisting.
            expect(parsed.secrets[0]?.encryptedValue?.value).toBe('sk-test');
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
            expect(parsed.secrets.length).toBe(1);
            expect(parsed.secrets[0]?.name).toBe('My Secret');
            expect(parsed.secrets[0]?.encryptedValue?.encryptedValue?.t).toBe('enc-v1');
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
                profiles: [
                    {
                        id: 'server-profile',
                        name: 'Server Profile',
                        environmentVariables: [],
                        defaultPermissionModeByAgent: {},
                        compatibility: { claude: true, codex: true, gemini: true },
                        envVarRequirements: [],
                        isBuiltIn: false,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        version: '1.0.0',
                    }
                ]
            };

            const pendingChanges: Partial<Settings> = {
                // User's local changes that haven't synced yet
                useEnhancedSessionWizard: true,
                profiles: [
                    {
                        id: 'local-profile',
                        name: 'Local Profile',
                        environmentVariables: [],
                        defaultPermissionModeByAgent: {},
                        compatibility: { claude: true, codex: true, gemini: true },
                        envVarRequirements: [],
                        isBuiltIn: false,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        version: '1.0.0',
                    }
                ]
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
                profiles: [{
                    id: 'test-profile',
                    name: 'Test',
                    environmentVariables: [],
                    defaultPermissionModeByAgent: {},
                    compatibility: { claude: true, codex: true, gemini: true },
                    envVarRequirements: [],
                    isBuiltIn: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    version: '1.0.0',
                }]
            };

            // Merge with server settings
            const merged = applySettings(serverSettings, pending2);

            // Both pending changes preserved
            expect(merged.useEnhancedSessionWizard).toBe(true);
            expect(merged.profiles).toHaveLength(1);
            expect(merged.profiles[0].id).toBe('test-profile');
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
                profiles: [{
                    id: 'device-b-profile',
                    name: 'Device B Profile',
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true },
                    isBuiltIn: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    version: '1.0.0',
                }]
            });

            // Device A's pending change
            const deviceAPending: Partial<Settings> = {
                useEnhancedSessionWizard: true
            };

            // Device A merges and retries
            const merged = applySettings(serverSettingsV11, deviceAPending);

            // Device A's flag preserved
            expect(merged.useEnhancedSessionWizard).toBe(true);
            // Device B's profile preserved
            expect(merged.profiles).toHaveLength(1);
            expect(merged.profiles[0].id).toBe('device-b-profile');
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
                profiles: [{
                    id: 'server-profile-1',
                    name: 'Server Profile',
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true },
                    envVarRequirements: [],
                    isBuiltIn: false,
                    createdAt: 1000,
                    updatedAt: 1000,
                    version: '1.0.0',
                }],
                dismissedCLIWarnings: {
                    perMachine: { 'machine-1': { claude: true } },
                    global: { codex: true }
                }
            });

            const pendingChanges: Partial<Settings> = {
                useEnhancedSessionWizard: true,
                profiles: [{
                    id: 'local-profile-1',
                    name: 'Local Profile',
                    environmentVariables: [],
                    defaultPermissionModeByAgent: {},
                    compatibility: { claude: true, codex: true, gemini: true },
                    envVarRequirements: [],
                    isBuiltIn: false,
                    createdAt: 2000,
                    updatedAt: 2000,
                    version: '1.0.0',
                }],
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
