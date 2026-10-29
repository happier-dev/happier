import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeEffectiveModelMode, readAppliedModelSelection } from './describeEffectiveModelMode';
import { getAgentCore } from '@/agents/catalog/catalog';
import type { Metadata } from '@happier-dev/session-core/state';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('describeEffectiveModelMode', () => {
    afterEach(() => {
        vi.doUnmock('@/agents/catalog/catalog');
    });

    it('treats Claude model overrides as next-prompt', () => {
        const out = describeEffectiveModelMode({
            agentType: 'claude',
            selectedModelId: 'claude-3.5-sonnet',
            metadata: null,
        });
        expect(out.applyScope).toBe('next_prompt');
        expect(out.effectiveModelId).toBe('claude-3.5-sonnet');
        // When a change takes effect is `applyScope`, not prose: a surface renders
        // that as one line, so the policy owner no longer ships a timing sentence
        // for a picker to print as a paragraph.
        expect(out.notes.some((note) => /next message/i.test(note))).toBe(false);
    });

    it('treats Codex MCP model overrides as spawn-only when ACP metadata is absent', () => {
        const out = describeEffectiveModelMode({ agentType: 'codex', selectedModelId: 'gpt-5-codex-high', metadata: null });
        expect(out.applyScope).toBe('spawn_only');
    });

    it('treats Codex session-control model overrides as live when generic metadata is present', () => {
        const out = describeEffectiveModelMode({
            agentType: 'codex',
            selectedModelId: 'gpt-5-codex-high',
            metadata: buildMetadata({
                sessionModesV1: { v: 1, agentId: 'codex', updatedAt: 1, currentModeId: 'ask', availableModes: [] },
            }),
        });
        expect(out.applyScope).toBe('live');
    });

    it('keeps the requested model selected while exposing the accepted applied model separately', () => {
        const out = describeEffectiveModelMode({
            agentType: 'codex',
            selectedModelId: 'gpt-5.6-sol',
            metadata: buildMetadata({
                sessionModelsV1: {
                    v: 1,
                    agentId: 'codex',
                    updatedAt: 10,
                    currentModelId: 'gpt-5.6-terra',
                    availableModels: [],
                },
                sessionAppliedModelV1: {
                    v: 1,
                    provider: 'codex',
                    updatedAt: 11,
                    modelId: 'gpt-5.6-terra',
                    selection: {
                        agentTargetKey: 'agent:happier.agent.codex/codex',
                        providerConnectionId: null,
                        modelId: 'gpt-5.6-terra',
                    },
                },
            }),
        });

        expect(out.selectedModelId).toBe('gpt-5.6-sol');
        expect(out.effectiveModelId).toBe('gpt-5.6-sol');
        expect(out.appliedModelId).toBe('gpt-5.6-terra');
    });

    it('shows actual runtime readback before acceptance while keeping the requested model selected', () => {
        const out = describeEffectiveModelMode({
            agentType: 'codex',
            selectedModelId: 'gpt-5.6-sol',
            metadata: buildMetadata({
                sessionModelsV1: {
                    v: 1,
                    agentId: 'codex',
                    updatedAt: 10,
                    currentModelId: 'actual-provider-model',
                    availableModels: [],
                },
            }),
        });

        expect(out.selectedModelId).toBe('gpt-5.6-sol');
        expect(out.appliedModelId).toBe('actual-provider-model');
    });

    it('does not let stale acceptance metadata override current runtime truth or invent a source-bound inherited model', () => {
        const metadata = buildMetadata({ sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: 20,
            currentModelId: 'actual-provider-model', availableModels: [] }, sessionAppliedModelV1: {
            v: 1, provider: 'codex', updatedAt: 10, modelId: 'configured-model',
        } });
        expect(describeEffectiveModelMode({ agentType: 'codex', selectedModelId: 'configured-model', metadata }).appliedModelId)
            .toBe('actual-provider-model');
        expect(readAppliedModelSelection({ agentId: 'codex', agentTargetKey: 'agent:happier.agent.codex/codex', metadata })).toBeNull();
    });

    it('inherits only canonical exact runtime evidence, independently of an alias used for launch', () => {
        const selection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'actual-provider-model' } as const;
        const metadata = buildMetadata({ sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: 20,
            currentModelId: selection.modelId, availableModels: [{ id: selection.modelId, name: 'Actual model' }],
            activeSelectionV1: { v: 1, source: 'runtime_readback', selection, runner: { pid: 42, processStartTimeMs: 10 } } } });
        expect(describeEffectiveModelMode({ agentType: 'codex', selectedModelId: 'default', metadata }).appliedModelId).toBe(selection.modelId);
        expect(readAppliedModelSelection({ agentId: 'codex', agentTargetKey: selection.agentTargetKey, metadata })).toEqual(selection);
        expect(describeEffectiveModelMode({ agentType: 'codex', selectedModelId: 'default', metadata,
            sessionActive: true, currentRunnerProcessIdentity: { pid: 99, processStartTimeMs: 20 } }).appliedModelStatus).toBe('last_reported');
        expect(describeEffectiveModelMode({ agentType: 'codex', selectedModelId: 'default', metadata,
            sessionActive: true, currentRunnerProcessIdentity: { pid: 42, processStartTimeMs: 10 } }).appliedModelStatus).toBe('running');
        expect(readAppliedModelSelection({ agentId: 'codex', agentTargetKey: 'agent:happier.agent.codex/codex:definition:other', metadata })).toBeNull();
    });

    it('accepts the Remote Dev predecessor applied-model fact', () => {
        const out = describeEffectiveModelMode({
            agentType: 'codex',
            selectedModelId: 'gpt-5.6-sol',
            metadata: buildMetadata({
                sessionAppliedModelV1: {
                    v: 1,
                    provider: 'codex',
                    updatedAt: 10,
                    modelId: 'gpt-5.6-terra',
                },
            }),
        });

        expect(out.appliedModelId).toBe('gpt-5.6-terra');
    });

    it('retains the provider-shaped 0.2 stored model vector through the legacy applied fact', () => {
        // Persisted boundary vector from 3482a9101e: api/types.ts and
        // backends/claude/sessionModels/effectiveModelUpdate.ts.
        const metadata = {
            path: '/tmp', host: 'h',
            sessionModelsV1: { v: 1, provider: 'claude', updatedAt: 10,
                currentModelId: 'claude-sonnet-4-5', availableModels: [] },
            sessionAppliedModelV1: { v: 1, provider: 'claude', updatedAt: 10,
                modelId: 'claude-sonnet-4-5' },
        } as unknown as Metadata;
        expect(describeEffectiveModelMode({ agentType: 'claude', selectedModelId: 'default', metadata }).appliedModelId)
            .toBe('claude-sonnet-4-5');
        expect(readAppliedModelSelection({ agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude', metadata }))
            .toEqual({ agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-sonnet-4-5' });
    });

    it('reads known applied model facts despite retired nested stored fields', () => {
        const retiredFields = { retired: true };
        const out = describeEffectiveModelMode({
            agentType: 'codex', selectedModelId: 'gpt-5.6-sol', metadata: buildMetadata({
                sessionAppliedModelV1: {
                    v: 1, provider: 'codex', updatedAt: 10, modelId: 'gpt-5.6-terra', ...retiredFields,
                    selection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null,
                        modelId: 'gpt-5.6-terra', ...retiredFields },
                },
            }),
        });
        expect(out.appliedModelId).toBe('gpt-5.6-terra');
    });

    it('adds a restart note for ACP providers that restart sessions on model change (Gemini)', () => {
        const out = describeEffectiveModelMode({
            agentType: 'gemini',
            selectedModelId: 'gemini-2.5-flash',
            metadata: buildMetadata({
                sessionModesV1: { v: 1, agentId: 'gemini', updatedAt: 1, currentModeId: 'default', availableModes: [] },
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

        expect(out.effectiveModelId).toBe(getAgentCore('gemini')?.model?.defaultMode);
        expect(out.notes.join(' ')).not.toMatch(/custom model ids|not validated/i);
    });

    it('uses the default sentinel when the provider has no selectable default model', async () => {
        vi.resetModules();
        vi.doMock('@/agents/catalog/catalog', async () => {
            const actual = await vi.importActual<typeof import('@/agents/catalog/catalog')>('@/agents/catalog/catalog');
            return {
                ...actual,
                getAgentCore: (agentId: Parameters<typeof actual.getAgentCore>[0]) => {
                    const core = actual.getAgentCore(agentId);
                    return core && agentId === 'gemini'
                        ? { ...core, model: { ...core.model, defaultMode: null } }
                        : core;
                },
            };
        });
        const { describeEffectiveModelMode: describeEffectiveModelModeWithMock } = await import('./describeEffectiveModelMode');

        const out = describeEffectiveModelModeWithMock({
            agentType: 'gemini',
            selectedModelId: null,
            metadata: null,
        });

        expect(out.effectiveModelId).toBe('default');
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
                    agentId: 'unexpected-provider',
                    updatedAt: 1,
                    currentModelId: 'gpt-5-codex',
                    availableModels: [],
                } as Metadata['acpSessionModelsV1'],
            }),
        });

        expect(out.applyScope).toBe('live');
    });

    it('falls back to legacy ACP metadata keys when generic session-control keys are absent', () => {
        const out = describeEffectiveModelMode({
            agentType: 'codex',
            selectedModelId: 'gpt-5-codex',
            metadata: buildMetadata({
                acpSessionModesV1: { v: 1, agentId: 'codex', updatedAt: 1, currentModeId: 'ask', availableModes: [] },
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

        expect(out.effectiveModelId).toBe(getAgentCore('codex')?.model?.defaultMode);
        expect(out.notes.join(' ')).not.toMatch(/custom model ids|not validated/i);
    });
});
