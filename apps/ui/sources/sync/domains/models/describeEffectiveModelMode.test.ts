import { describe, expect, it } from 'vitest';

import { describeEffectiveModelMode } from './describeEffectiveModelMode';
import { getAgentCore } from '@/agents/catalog/catalog';
import type { Metadata } from './domains/state/storageTypes';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('describeEffectiveModelMode', () => {
    it('treats Claude model overrides as next-prompt', () => {
        const out = describeEffectiveModelMode({
            agentType: 'claude',
            selectedModelId: 'claude-3.5-sonnet',
            metadata: null,
        });
        expect(out.applyScope).toBe('next_prompt');
        expect(out.effectiveModelId).toBe('claude-3.5-sonnet');
        expect(out.notes.some((note) => /next message/i.test(note))).toBe(true);
    });

    it('treats Codex MCP model overrides as spawn-only when ACP metadata is absent', () => {
        const out = describeEffectiveModelMode({ agentType: 'codex', selectedModelId: 'gpt-5-codex-high', metadata: null });
        expect(out.applyScope).toBe('spawn_only');
    });

    it('treats Codex ACP model overrides as live when ACP metadata is present', () => {
        const out = describeEffectiveModelMode({
            agentType: 'codex',
            selectedModelId: 'gpt-5-codex-high',
            metadata: buildMetadata({
                acpSessionModesV1: { v: 1, provider: 'codex', updatedAt: 1, currentModeId: 'ask', availableModes: [] },
            }),
        });
        expect(out.applyScope).toBe('live');
    });

    it('adds a restart note for ACP providers that restart sessions on model change (Gemini)', () => {
        const out = describeEffectiveModelMode({
            agentType: 'gemini',
            selectedModelId: 'gemini-2.5-flash',
            metadata: buildMetadata({
                acpSessionModesV1: { v: 1, provider: 'gemini', updatedAt: 1, currentModeId: 'default', availableModes: [] },
            }),
        });
        expect(out.applyScope).toBe('live');
        expect(out.notes.some((note) => /restart/i.test(note))).toBe(true);
    });

    it('uses the provider default model when no model is selected and does not mark it as custom', () => {
        const out = describeEffectiveModelMode({
            agentType: 'gemini',
            selectedModelId: '',
            metadata: null,
        });

        expect(out.effectiveModelId).toBe(getAgentCore('gemini').model.defaultMode);
        expect(out.notes.join(' ')).not.toMatch(/custom model ids|not validated/i);
    });

    it('only shows the custom model note for explicit unknown model ids', () => {
        const known = describeEffectiveModelMode({
            agentType: 'claude',
            selectedModelId: 'claude-sonnet-4-5',
            metadata: null,
        });
        const custom = describeEffectiveModelMode({
            agentType: 'claude',
            selectedModelId: 'claude-custom-unlisted-model',
            metadata: null,
        });

        expect(known.notes.join(' ')).not.toMatch(/custom model ids|not validated/i);
        expect(custom.notes.join(' ')).toMatch(/custom model ids|not validated/i);
    });

    it('treats ACP metadata presence as live even when provider payload is malformed', () => {
        const out = describeEffectiveModelMode({
            agentType: 'codex',
            selectedModelId: 'gpt-5-codex',
            metadata: buildMetadata({
                acpSessionModelsV1: {
                    v: 1,
                    provider: 'unexpected-provider',
                    updatedAt: 1,
                    currentModelId: 'gpt-5-codex',
                    availableModels: [],
                } as Metadata['acpSessionModelsV1'],
            }),
        });

        expect(out.applyScope).toBe('live');
    });

    it('falls back to provider default model when selected model is whitespace', () => {
        const out = describeEffectiveModelMode({
            agentType: 'codex',
            selectedModelId: '   ',
            metadata: null,
        });

        expect(out.effectiveModelId).toBe(getAgentCore('codex').model.defaultMode);
        expect(out.notes.join(' ')).not.toMatch(/custom model ids|not validated/i);
    });
});
