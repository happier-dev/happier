import { describe, expect, it } from 'vitest';

import { CLAUDE_FLAGSHIP_MODEL_ID } from './flagshipModel.js';
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
        for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7']) {
            const option = ultracodeOption(id);
            expect(option, id).not.toBeNull();
            expect(option?.type).toBe('boolean');
            expect(option?.currentValue).toBe('false');
        }
        for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-5']) {
            expect(ultracodeOption(id), id).toBeNull();
        }
    });

    // `/effort ultracode` actually RUNS at xhigh. The producer owns that fact: without it the UI
    // has to hardcode Claude's rule, and a user stored on `low` sees Low highlighted while the
    // agent runs xhigh.
    it('declares that ultracode overrides reasoning_effort and forces xhigh', () => {
        for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7']) {
            const option = ultracodeOption(id);
            expect(option?.overridesWhenOn, id).toEqual({
                optionIds: ['reasoning_effort'],
                forcedValue: 'xhigh',
            });
            // The forced value must be a real choice on the option it overrides, or the control
            // has nothing truthful to highlight.
            const effort = model(id).modelOptions?.find((candidate) => candidate.id === 'reasoning_effort');
            expect(effort?.options?.map((choice) => choice.value), id).toContain('xhigh');
        }
    });

    it('names the forced effort level in the ultracode description', () => {
        expect(ultracodeOption('claude-opus-5')?.description).toContain('XHigh');
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
        for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-5']) {
            expect(model(id).extendedContextModelId, id).toBeUndefined();
        }
    });
});

describe('CLAUDE_STATIC_MODELS current Sonnet facts', () => {
    it('publishes Sonnet 4.6 with max effort but no xhigh option', () => {
        const effort = model('claude-sonnet-4-6').modelOptions
            ?.find((option) => option.id === 'reasoning_effort');
        expect(effort).toMatchObject({
            currentValue: 'high',
            options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
                { value: 'max', name: 'Max' },
            ],
        });
    });

    it('publishes Sonnet 5 with its exact 1M context and five effort levels', () => {
        expect(model('claude-sonnet-5')).toMatchObject({
            name: 'Sonnet 5',
            contextWindowTokens: 1_000_000,
            modelOptions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'high',
                    options: [
                        { value: 'low', name: 'Low' },
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' },
                        { value: 'xhigh', name: 'XHigh' },
                        { value: 'max', name: 'Max' },
                    ],
                }),
            ]),
        });
    });
});

describe('CLAUDE_STATIC_MODELS limited-availability model facts', () => {
    it('publishes Mythos 5 with its exact 1M context and five effort levels', () => {
        expect(model('claude-mythos-5')).toMatchObject({
            name: 'Mythos 5',
            contextWindowTokens: 1_000_000,
            modelOptions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'high',
                    options: [
                        { value: 'low', name: 'Low' },
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' },
                        { value: 'xhigh', name: 'XHigh' },
                        { value: 'max', name: 'Max' },
                    ],
                }),
            ]),
        });
    });
});

describe('CLAUDE_STATIC_MODELS flagship default', () => {
    it('keeps the flagship Claude default pointing at a real catalog model', () => {
        expect(CLAUDE_STATIC_MODELS.some((candidate) => candidate.id === CLAUDE_FLAGSHIP_MODEL_ID)).toBe(true);
    });
});
