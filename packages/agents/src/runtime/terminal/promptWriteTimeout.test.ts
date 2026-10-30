import { afterEach, describe, expect, it, vi } from 'vitest';

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

    it('counts real UTF-8 bytes rather than UTF-16 code units', () => {
        // The discriminator against a `text.length` byte budget: `é` is two
        // UTF-8 bytes, `€` three, and an astral emoji four while occupying two
        // UTF-16 code units.
        expect(resolveTerminalPromptWriteBudget('é').byteLength).toBe(2);
        expect(resolveTerminalPromptWriteBudget('€').byteLength).toBe(3);
        expect(resolveTerminalPromptWriteBudget('🙂').byteLength).toBe(4);
        expect(resolveTerminalPromptWriteBudget('a🙂€é').byteLength).toBe(10);
    });
});

describe('resolveTerminalPromptWriteBudget on a host without Node Buffer', () => {
    afterEach(() => {
        vi.doUnmock('node:buffer');
        vi.resetModules();
    });

    // `@happier-dev/agents` is a dependency of the Happier web app: its barrel
    // (`src/index.ts`) re-exports this module, so `apps/ui/sources/sync/sync.ts`
    // pulls it into the Metro web graph. A browser host has no `node:buffer`
    // builtin, and Metro's web platform does not shim it, so a web build that
    // reaches that specifier fails outright with
    // "Failed to get the SHA-1 for: node:buffer".
    //
    // The specifier is withheld here — the exact thing a bundler must resolve —
    // so a budget that imports a Node buffer boundary cannot load at all.
    it('computes the write budget with no Node buffer boundary available', async () => {
        vi.doMock('node:buffer', () => {
            throw new Error('node:buffer does not exist on this host');
        });
        vi.resetModules();

        const browserSafe = await import('./promptWriteTimeout.js');

        expect(browserSafe.resolveTerminalPromptWriteBudget('alpha\nbeta')).toEqual({
            timeoutMs: TERMINAL_PROMPT_BASE_WRITE_TIMEOUT_MS,
            byteLength: 10,
            newlineCount: 1,
            byteBudgetMs: 1_000,
            newlineBudgetMs: 50,
        });
        expect(browserSafe.resolveTerminalPromptWriteBudget('a🙂€é').byteLength).toBe(10);
        expect(browserSafe.resolveTerminalPromptWriteTimeoutMs('x'.repeat(128_000))).toBe(125_000);
    });
});
