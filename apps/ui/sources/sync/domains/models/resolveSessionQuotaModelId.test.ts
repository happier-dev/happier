import { describe, expect, it } from 'vitest';

import type { AgentId } from '@/agents/catalog/catalog';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { resolveSessionQuotaModelId } from './resolveSessionQuotaModelId';

function metadata(provider: string, currentModelId: string): Metadata {
    return { path: '/tmp', host: 'test', sessionModelsV1: { v: 1, provider, currentModelId, updatedAt: 10, availableModels: [] } };
}

describe('resolveSessionQuotaModelId', () => {
    it('resolves a default AGY picker choice to the model reported by the active ACP runtime', () => {
        expect(resolveSessionQuotaModelId({ agentId: 'agy', modelMode: 'default', metadata: metadata('agy', 'gemini-3.7-flash-high') })).toBe('gemini-3.7-flash-high');
    });

    it('keeps an explicit selection ahead of the previous runtime model', () => {
        expect(resolveSessionQuotaModelId({ agentId: 'agy', modelMode: 'claude-opus-5-5', metadata: metadata('agy', 'gemini-3.8-flash') })).toBe('claude-opus-5-5');
    });

    it('uses the newest valid canonical or legacy runtime metadata through the existing reader', () => {
        const state = metadata('agy', 'old');
        state.acpSessionModelsV1 = { v: 1, provider: 'agy', currentModelId: 'new', updatedAt: 20, availableModels: [] };
        expect(resolveSessionQuotaModelId({ agentId: 'agy', modelMode: 'default', metadata: state })).toBe('new');
    });

    it.each(['codex', 'claude'] as AgentId[])('does not borrow AGY runtime metadata for a %s session', (agentId) => {
        expect(resolveSessionQuotaModelId({ agentId, modelMode: 'default', metadata: metadata('agy', 'gemini-3.8-flash') })).toBeNull();
        expect(resolveSessionQuotaModelId({ agentId, modelMode: 'chosen', metadata: metadata('agy', 'gemini-3.8-flash') })).toBe('chosen');
    });

    it.each(['codex', 'claude'] as AgentId[])('accepts matching %s model metadata', (agentId) => {
        expect(resolveSessionQuotaModelId({ agentId, modelMode: 'default', metadata: metadata(agentId, 'runtime-model') })).toBe('runtime-model');
    });

    it('does not invent a model when neither selection nor runtime state identifies it', () => {
        expect(resolveSessionQuotaModelId({ agentId: 'agy', modelMode: 'default', metadata: null })).toBeNull();
        expect(resolveSessionQuotaModelId({ agentId: 'agy', modelMode: '', metadata: metadata('agy', 'default') })).toBeNull();
    });
});
