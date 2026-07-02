import { describe, expect, it } from 'vitest';

import { CLAUDE_STATIC_MODELS } from './models.js';

function model(id: string) {
    const found = CLAUDE_STATIC_MODELS.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`missing static model ${id}`);
    return found;
}

function ultracodeOption(id: string) {
    return model(id).modelOptions?.find((option) => option.id === 'ultracode') ?? null;
}

describe('CLAUDE_STATIC_MODELS ultracode option', () => {
    it('offers the ultracode boolean option only on xhigh-capable models', () => {
        for (const id of ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7']) {
            const option = ultracodeOption(id);
            expect(option, id).not.toBeNull();
            expect(option?.type).toBe('boolean');
            expect(option?.currentValue).toBe('false');
        }
        for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-5']) {
            expect(ultracodeOption(id), id).toBeNull();
        }
    });

    it('never models ultracode as a reasoning_effort level', () => {
        for (const descriptor of CLAUDE_STATIC_MODELS) {
            const effort = descriptor.modelOptions?.find((option) => option.id === 'reasoning_effort');
            const values = effort?.options?.map((option) => option.value) ?? [];
            expect(values).not.toContain('ultracode');
        }
    });
});

describe('CLAUDE_STATIC_MODELS extended-context variant declaration', () => {
    it('declares the [1m] variant only for opt-in 1M models', () => {
        expect(model('claude-sonnet-4-6').extendedContextModelId).toBe('claude-sonnet-4-6[1m]');
        expect(model('claude-opus-4-6').extendedContextModelId).toBe('claude-opus-4-6[1m]');
    });

    it('declares no variant for always-1M or non-1M models', () => {
        for (const id of ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-5']) {
            expect(model(id).extendedContextModelId, id).toBeUndefined();
        }
    });
});
