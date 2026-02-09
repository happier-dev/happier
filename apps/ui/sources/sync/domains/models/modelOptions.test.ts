import { describe, expect, it } from 'vitest';

import {
    getModelOptionsForAgentType,
    getModelOptionsForModes,
    getModelOptionsForSession,
    hasDynamicModelListForSession,
    isModelSelectableForSession,
} from './modelOptions';

describe('modelOptions', () => {
    it('builds generic options for unknown modes', () => {
        const out = getModelOptionsForModes(['gpt-5-low', 'default']);
        expect(out.map((o) => o.value)).toEqual(['gpt-5-low', 'default']);
        expect(out[0].label).toBe('gpt-5-low');
        expect(out[0].description).toBe('');
    });

    it('returns options for agents with configurable model selection', () => {
        expect(getModelOptionsForAgentType('gemini').map((o) => o.value)).toEqual([
            'default',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
        ]);
    });

    it('returns a default-only option for selection-capable agents without static lists', () => {
        expect(getModelOptionsForAgentType('qwen').map((o) => o.value)).toEqual(['default']);
        expect(getModelOptionsForAgentType('kimi').map((o) => o.value)).toEqual(['default']);
    });

    it('returns basic options for codex (preflight can extend the list)', () => {
        const out = getModelOptionsForAgentType('codex');
        expect(out.map((o) => o.value)).toEqual(['default']);
    });

    it('includes a curated static list for Claude while still allowing freeform models', () => {
        const values = getModelOptionsForAgentType('claude').map((o) => o.value);
        expect(values[0]).toBe('default');
        expect(values.length).toBeGreaterThan(1);
    });

    it('prefers ACP session models when present', () => {
        const out = getModelOptionsForSession(
            'opencode',
            {
                acpSessionModelsV1: {
                    v: 1,
                    provider: 'opencode',
                    updatedAt: 1,
                    currentModelId: 'model-a',
                    availableModels: [
                        { id: 'model-a', name: 'Model A' },
                        { id: 'model-b', name: 'Model B', description: 'Accurate' },
                    ],
                },
            } as const,
        );

        expect(out.map((o) => o.value)).toEqual(['default', 'model-a', 'model-b']);
        expect(out[1]?.label).toBe('Model A');
        expect(out[2]?.description).toBe('Accurate');
    });

    it('treats ACP session models as selectable', () => {
        const metadata = {
            acpSessionModelsV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModelId: 'model-a',
                availableModels: [{ id: 'model-a', name: 'Model A' }],
            },
        } as const;

        expect(isModelSelectableForSession('opencode', metadata, 'model-a')).toBe(true);
        expect(isModelSelectableForSession('opencode', metadata, 'default')).toBe(true);
        // Some providers accept custom model IDs even when a dynamic list is available.
        expect(isModelSelectableForSession('opencode', metadata, 'not-a-model')).toBe(true);
    });

    it('treats static Gemini models as selectable', () => {
        expect(isModelSelectableForSession('gemini', null, 'gemini-2.5-pro')).toBe(true);
        expect(isModelSelectableForSession('gemini', null, 'default')).toBe(true);
        expect(isModelSelectableForSession('gemini', null, 'model-a')).toBe(false);
    });

    it('treats Claude models as freeform-selectable when configured', () => {
        expect(isModelSelectableForSession('claude', null, 'claude-3.5-sonnet')).toBe(true);
        expect(isModelSelectableForSession('claude', null, 'default')).toBe(true);
        expect(isModelSelectableForSession('claude', null, '   ')).toBe(false);
    });

    it('adds metadata override model into options for freeform providers when not in static list', () => {
        const out = getModelOptionsForSession(
            'claude',
            {
                modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'claude-custom-model' },
            } as const,
        );

        expect(out.some((option) => option.value === 'claude-custom-model')).toBe(true);
    });

    it('does not add metadata override model for providers without freeform selection', () => {
        const out = getModelOptionsForSession(
            'gemini',
            {
                modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'gemini-custom-model' },
            } as const,
        );

        expect(out.some((option) => option.value === 'gemini-custom-model')).toBe(false);
    });

    it('falls back to static options when dynamic list provider does not match agent', () => {
        const out = getModelOptionsForSession(
            'opencode',
            {
                acpSessionModelsV1: {
                    v: 1,
                    provider: 'claude',
                    updatedAt: 1,
                    currentModelId: 'model-a',
                    availableModels: [{ id: 'model-a', name: 'Model A' }],
                },
            } as const,
        );

        expect(out.map((option) => option.value)).toEqual(['default']);
    });

    it('detects dynamic list support only for matching provider metadata', () => {
        expect(
            hasDynamicModelListForSession(
                'opencode',
                {
                    acpSessionModelsV1: {
                        v: 1,
                        provider: 'opencode',
                        updatedAt: 1,
                        currentModelId: 'model-a',
                        availableModels: [{ id: 'model-a', name: 'Model A' }],
                    },
                } as const,
            ),
        ).toBe(true);

        expect(
            hasDynamicModelListForSession(
                'opencode',
                {
                    acpSessionModelsV1: {
                        v: 1,
                        provider: 'gemini',
                        updatedAt: 1,
                        currentModelId: 'model-a',
                        availableModels: [{ id: 'model-a', name: 'Model A' }],
                    },
                } as const,
            ),
        ).toBe(false);
    });
});
