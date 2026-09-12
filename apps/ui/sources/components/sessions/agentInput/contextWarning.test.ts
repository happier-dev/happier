import { describe, expect, it } from 'vitest';

import { lightTheme } from '@/theme';

import {
    formatContextTokenCount,
    formatContextUsagePercent,
    getContextUsageState,
    getContextWarning,
} from './contextWarning';
import {
    resolveContextWarningWindowTokens,
    resolveContextWindowTokens,
} from './resolveContextWarningWindowTokens';

describe('context warning window resolution', () => {
    it('returns null for non-Claude providers when no supported context window is known', () => {
        expect(resolveContextWindowTokens({
            agentId: 'codex',
            metadata: null,
        } as any)).toBeNull();
    });

    it('uses dynamic model context-window metadata for non-Claude providers when resolving the actual window size', () => {
        expect(resolveContextWindowTokens({
            agentId: 'codex',
            metadata: {
                sessionModelsV1: {
                    v: 1,
                    provider: 'codex',
                    updatedAt: 1,
                    currentModelId: 'gpt-5.4',
                    availableModels: [
                        {
                            id: 'gpt-5.4',
                            name: 'GPT 5.4',
                            contextWindowTokens: 400_000,
                        },
                    ],
                },
            } as any,
        })).toBe(400_000);
    });

    it('prefers live usage telemetry over metadata when resolving the actual window size', () => {
        expect(resolveContextWindowTokens({
            agentId: 'codex',
            metadata: null,
            usageData: {
                inputTokens: 700,
                outputTokens: 250,
                cacheCreation: 0,
                cacheRead: 200,
                contextSize: 1_200,
                contextWindowTokens: 258_400,
            },
        } as any)).toBe(258_400);
    });

    it('uses dynamic model context-window metadata for non-Claude providers', () => {
        expect(resolveContextWarningWindowTokens({
            agentId: 'codex',
            metadata: {
                sessionModelsV1: {
                    v: 1,
                    provider: 'codex',
                    updatedAt: 1,
                    currentModelId: 'gpt-5.4',
                    availableModels: [
                        {
                            id: 'gpt-5.4',
                            name: 'GPT 5.4',
                            contextWindowTokens: 400_000,
                        },
                    ],
                },
            } as any,
        })).toBe(380_000);
    });

    it('uses the 1M warning window when Claude is explicitly set to a [1m] model override', () => {
        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata: {
                modelOverrideV1: {
                    v: 1,
                    updatedAt: 1,
                    modelId: 'sonnet[1m]',
                },
            } as any,
        })).toBe(950_000);
    });

    it('uses the 1M warning window when Claude session state reports a [1m] current model', () => {
        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata: {
                sessionModelsV1: {
                    v: 1,
                    provider: 'claude',
                    updatedAt: 1,
                    currentModelId: 'claude-sonnet-4-6[1m]',
                    availableModels: [],
                },
            } as any,
        })).toBe(950_000);
    });

    it('uses the 1M warning window for legacy Claude Opus 4.7 session metadata without context-window fields', () => {
        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata: {
                sessionModelsV1: {
                    v: 1,
                    provider: 'claude',
                    updatedAt: 1,
                    currentModelId: 'claude-opus-4-7',
                    availableModels: [
                        {
                            id: 'claude-opus-4-7',
                            name: 'Opus 4.7',
                            description: 'Newest highest-capability Claude model for the hardest coding and reasoning tasks.',
                        },
                    ],
                },
            } as any,
        })).toBe(950_000);
    });

    it('prefers reported Claude session model context window over the static Opus catalog fallback', () => {
        const metadata = {
            modelOverrideV1: {
                v: 1,
                updatedAt: 1,
                modelId: 'claude-opus-4-7',
            },
            sessionModelsV1: {
                v: 1,
                provider: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-opus-4-7',
                availableModels: [
                    {
                        id: 'claude-opus-4-7',
                        name: 'Opus 4.7',
                        contextWindowTokens: 200_000,
                    },
                ],
            },
        } as any;

        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata,
        })).toBe(200_000);
        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata,
        })).toBe(190_000);
    });

    it('uses the 1M warning window when the active Claude model description reports a 1 million context window', () => {
        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata: {
                sessionModelsV1: {
                    v: 1,
                    provider: 'claude',
                    updatedAt: 1,
                    currentModelId: 'claude-opus-4-6',
                    availableModels: [
                        {
                            id: 'claude-opus-4-6',
                            name: 'Opus 4.6',
                            description: '1 million token context window',
                        },
                    ],
                },
            } as any,
        })).toBe(950_000);
    });

    it('keeps the legacy warning window for non-1M models', () => {
        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata: {
                modelOverrideV1: {
                    v: 1,
                    updatedAt: 1,
                    modelId: 'claude-sonnet-4-6',
                },
            } as any,
        })).toBe(190_000);
    });

    it('resolves the 1M window for an always-1M Claude model reported with its BASE id (Unified adoption)', () => {
        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata: {
                sessionModelsV1: {
                    v: 1,
                    provider: 'claude',
                    updatedAt: 1,
                    currentModelId: 'claude-fable-5',
                    availableModels: [],
                },
            } as any,
        })).toBe(1_000_000);
    });

    it('bumps a stale Claude default window when observed usage exceeds it (incident: 733k > 200k)', () => {
        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata: null,
            usageData: {
                inputTokens: 700_000,
                outputTokens: 250,
                cacheCreation: 3_000,
                cacheRead: 30_000,
                contextSize: 733_000,
            },
        } as any)).toBe(1_000_000);
    });

    it('keeps the Claude default window when observed usage fits', () => {
        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata: null,
            usageData: {
                inputTokens: 100_000,
                outputTokens: 250,
                cacheCreation: 0,
                cacheRead: 50_000,
                contextSize: 150_000,
            },
        } as any)).toBe(200_000);
    });

    it('bumps a stale Claude session-models window when observed usage exceeds it', () => {
        expect(resolveContextWindowTokens({
            agentId: 'claude',
            metadata: {
                sessionModelsV1: {
                    v: 1,
                    provider: 'claude',
                    updatedAt: 1,
                    currentModelId: 'claude-sonnet-4-6',
                    availableModels: [
                        {
                            id: 'claude-sonnet-4-6',
                            name: 'Sonnet 4.6',
                            contextWindowTokens: 200_000,
                        },
                    ],
                },
            } as any,
            usageData: {
                inputTokens: 700_000,
                outputTokens: 250,
                cacheCreation: 3_000,
                cacheRead: 30_000,
                contextSize: 733_000,
            },
        } as any)).toBe(1_000_000);
    });

    it('does not apply the Claude window ladder to non-Claude providers', () => {
        expect(resolveContextWindowTokens({
            agentId: 'codex',
            metadata: null,
            usageData: {
                inputTokens: 300_000,
                outputTokens: 250,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 300_000,
                contextWindowTokens: 258_400,
            },
        } as any)).toBe(258_400);
    });
});

describe('getContextUsageState overflow guard', () => {
    it('does not synthesize zero usage when exact context telemetry is unavailable', () => {
        expect(getContextUsageState(undefined, true, 258_000)).toBeNull();
    });

    it('never reports more than 100% usage even when used tokens exceed a stale window', () => {
        const usageState = getContextUsageState(733_000, true, 200_000);
        expect(usageState?.usedPercentage).toBe(100);
        expect(usageState?.usedRatio).toBe(1);
        expect(usageState?.severity).toBe('critical');
        // Raw token counts stay honest for the "used/total" detail copy.
        expect(usageState?.usedTokens).toBe(733_000);
        expect(usageState?.contextWindowTokens).toBe(200_000);
    });
});

describe('getContextWarning', () => {
    it('keeps always-visible 1M usage in a neutral tone when the session is not near the warning threshold', () => {
        const usageState = getContextUsageState(200_000, true, 1_000_000);
        expect(usageState?.severity).toBe('neutral');
        expect(formatContextUsagePercent(usageState?.usedPercentage ?? 0)).toBe('20%');
        expect(formatContextTokenCount(usageState?.usedTokens ?? 0)).toBe('200k');

        const warning = getContextWarning(200_000, true, lightTheme, 1_000_000);
        expect(warning?.color).toBe(lightTheme.colors.text.secondary);
        expect(warning?.text).toContain('79');
    });
});
