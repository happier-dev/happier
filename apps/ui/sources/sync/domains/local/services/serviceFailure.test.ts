import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

import { resolveLocalServiceOutput } from './serviceFailure';

describe('a failed start\'s output', () => {
    it('reads one line per printed line, each once, however the supervisor reported them', () => {
        // The supervisor reports a stderr chunk as one diagnostic and, separately, a line it already holds.
        const output = resolveLocalServiceOutput(
            { diagnostics: [{ code: 'stderr', message: "Error: Cannot find module './config/lumen.local.json'\nLumen web exited before it was ready (exit 1)." }] } as never,
            { lastStderrLine: "Error: Cannot find module './config/lumen.local.json'" } as never,
        );
        expect(output?.lines).toEqual([
            "Error: Cannot find module './config/lumen.local.json'",
            'Lumen web exited before it was ready (exit 1).',
        ]);
    });
});
