import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import { getModelOptionsForAgentTypeOrPreflight } from './modelOptions';

describe('modelOptions preflight', () => {
    it('merges preflight models with canonical agent models instead of dropping catalog options', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'claude',
            preflight: {
                availableModels: [
                    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
                    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
                    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
                    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
                    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
                ],
                supportsFreeform: true,
            },
        });

        expect(out.map((option) => option.value)).toEqual([
            'default',
            'claude-opus-4-8',
            'claude-opus-4-7',
            'claude-opus-4-6',
            'claude-sonnet-4-6',
            'claude-haiku-4-5',
            'claude-opus-5',
            'claude-fable-5',
            'claude-opus-4-5',
            'claude-sonnet-4-5',
        ]);

        // Preflight model lists often omit per-model option metadata; we must preserve catalog
        // options so controls like Claude "Thinking" can still render.
        expect(out.find((option) => option.value === 'claude-opus-4-8')).toMatchObject({
            modelOptions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'high',
                    options: expect.arrayContaining([
                        expect.objectContaining({ value: 'xhigh' }),
                    ]),
                }),
            ]),
        });
        expect(out.find((option) => option.value === 'claude-opus-4-7')).toMatchObject({
            modelOptions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'xhigh',
                    options: expect.arrayContaining([
                        expect.objectContaining({ value: 'xhigh' }),
                    ]),
                }),
            ]),
        });
        expect(out.find((option) => option.value === 'claude-opus-4-6')).toMatchObject({
            modelOptions: expect.arrayContaining([
                expect.objectContaining({ id: 'reasoning_effort' }),
            ]),
        });
    });

    it('prefers preflight model list and always includes Default first', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'opencode',
            preflight: {
                availableModels: [
                    { id: 'model-a', name: 'Model A' },
                    { id: 'default', name: 'Default (Agent)' },
                    { id: 'model-b', name: 'Model B', description: 'desc' },
                    { id: 'model-a', name: 'Model A (dup)' },
                ],
                supportsFreeform: false,
            },
        });

        expect(out[0]?.value).toBe('default');
        expect(out[0]?.description).toBe('');
        expect(typeof out[0]?.label).toBe('string');
        expect(String(out[0]?.label).trim().length).toBeGreaterThan(0);
        expect(out.some((o) => o.value === 'model-a')).toBe(true);
        expect(out.some((o) => o.value === 'model-b' && o.description === 'desc')).toBe(true);
        expect(out.filter((o) => o.value === 'model-a')).toHaveLength(1);
        expect(out.filter((o) => o.value === 'default')).toHaveLength(1);
    });

    it('does not append missing catalog models for non-freeform dynamic preflight lists', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'codex',
            preflight: {
                availableModels: [
                    { id: 'default', name: 'Default' },
                    { id: 'gpt-5.5', name: 'GPT 5.5' },
                    { id: 'gpt-5.4-mini', name: 'GPT 5.4 Mini' },
                ],
                supportsFreeform: false,
            },
        });

        expect(out.map((option) => option.value)).toEqual([
            'default',
            'gpt-5.5',
            'gpt-5.4-mini',
        ]);
        expect(out.some((option) => option.value === 'gpt-5.2-codex')).toBe(false);
        expect(out.some((option) => option.value === 'gpt-5.1-codex-max')).toBe(false);
    });

    it('ignores a dynamic preflight list from a different backend target', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'gemini',
            currentTargetKey: 'backend:gemini',
            preflightTargetKey: 'backend:opencode',
            preflight: {
                availableModels: [
                    { id: 'gpt-5.5', name: 'GPT 5.5' },
                    { id: 'opencode/big-pickle', name: 'Big Pickle' },
                ],
                supportsFreeform: true,
            },
        });

        expect(out.map((option) => option.value)).toEqual([
            'default',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-3-flash-preview',
            'gemini-3-pro-preview',
            'gemini-3.1-pro-preview',
        ]);
        expect(out.some((option) => option.value === 'gpt-5.5')).toBe(false);
        expect(out.some((option) => option.value === 'opencode/big-pickle')).toBe(false);
    });

    it('ignores an unscoped dynamic preflight list when the current backend target is known', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'gemini',
            currentTargetKey: 'backend:gemini',
            preflight: {
                availableModels: [
                    { id: 'gpt-5.5', name: 'GPT 5.5' },
                    { id: 'opencode/big-pickle', name: 'Big Pickle' },
                ],
                supportsFreeform: true,
            },
        });

        expect(out.some((option) => option.value === 'gpt-5.5')).toBe(false);
        expect(out.some((option) => option.value === 'opencode/big-pickle')).toBe(false);
        expect(out.some((option) => option.value === 'gemini-2.5-pro')).toBe(true);
    });

    it('drops malformed preflight entries and still keeps Default first', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'opencode',
            preflight: {
                availableModels: [
                    { id: 'default', name: 'Default (Agent)' },
                    { id: 'valid-1', name: 'Valid 1' },
                    { id: '', name: 'Invalid empty id' },
                    { id: 'valid-2', name: 'Valid 2', description: 'desc-2' },
                    { id: 123 as unknown as string, name: 'Invalid non-string id' },
                    { id: 'missing-name', name: undefined as unknown as string },
                ],
                supportsFreeform: true,
            },
        });

        expect(out[0]?.value).toBe('default');
        expect(out[0]?.description).toBe('');
        expect(typeof out[0]?.label).toBe('string');
        expect(String(out[0]?.label).trim().length).toBeGreaterThan(0);
        expect(out.some((opt) => opt.value === 'valid-1')).toBe(true);
        expect(out.some((opt) => opt.value === 'valid-2' && opt.description === 'desc-2')).toBe(true);
        expect(out.some((opt) => opt.value === '')).toBe(false);
        expect(out.some((opt) => opt.value === 'missing-name')).toBe(false);
    });
});
