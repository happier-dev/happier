import { describe, expect, it } from 'vitest';

import {
    TERMINAL_PROMPT_BASE_WRITE_TIMEOUT_MS,
    TERMINAL_PROMPT_MAX_WRITE_TIMEOUT_MS,
    resolveTerminalPromptWriteBudget,
    resolveTerminalPromptWriteTimeoutMs,
} from './promptWriteTimeout.js';

describe('resolveTerminalPromptWriteTimeoutMs', () => {
    it('keeps the base timeout for ordinary prompts', () => {
        expect(resolveTerminalPromptWriteTimeoutMs('hello')).toBe(TERMINAL_PROMPT_BASE_WRITE_TIMEOUT_MS);
    });

    it('scales the timeout for large terminal prompts', () => {
        expect(resolveTerminalPromptWriteTimeoutMs('x'.repeat(128_000))).toBeGreaterThan(TERMINAL_PROMPT_BASE_WRITE_TIMEOUT_MS);
    });

    it('uses a conservative large-prompt byte budget for terminal host writes', () => {
        expect(resolveTerminalPromptWriteTimeoutMs('x'.repeat(128_000))).toBe(125_000);
    });

    it('returns diagnostic-safe write budget metadata without prompt text', () => {
        const budget = resolveTerminalPromptWriteBudget('alpha\nbeta');

        expect(budget).toEqual({
            timeoutMs: TERMINAL_PROMPT_BASE_WRITE_TIMEOUT_MS,
            byteLength: 10,
            newlineCount: 1,
            byteBudgetMs: 1_000,
            newlineBudgetMs: 50,
        });
        expect(JSON.stringify(budget)).not.toContain('alpha');
        expect(JSON.stringify(budget)).not.toContain('beta');
    });

    it('caps the timeout for pathological prompt sizes', () => {
        expect(TERMINAL_PROMPT_MAX_WRITE_TIMEOUT_MS).toBe(300_000);
        expect(resolveTerminalPromptWriteTimeoutMs('x'.repeat(5_000_000))).toBe(300_000);
    });
});
