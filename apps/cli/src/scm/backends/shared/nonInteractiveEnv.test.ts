import { describe, expect, it } from 'vitest';

import { buildScmNonInteractiveEnv } from './nonInteractiveEnv';

describe('buildScmNonInteractiveEnv', () => {
    it('sets default non-interactive git environment values', () => {
        const env = buildScmNonInteractiveEnv();
        expect(env.GIT_TERMINAL_PROMPT).toBe('0');
        expect(env.GCM_INTERACTIVE).toBe('Never');
    });

    it('allows explicit overrides', () => {
        const env = buildScmNonInteractiveEnv({
            GIT_TERMINAL_PROMPT: '1',
            CUSTOM_VALUE: 'x',
        });
        expect(env.GIT_TERMINAL_PROMPT).toBe('1');
        expect(env.CUSTOM_VALUE).toBe('x');
    });
});
