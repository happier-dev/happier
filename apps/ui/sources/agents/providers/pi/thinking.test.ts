import { describe, expect, it } from 'vitest';

import { providers } from '@happier-dev/agents';

describe('applyPiThinkingLevelEnv', () => {
    it('sets env var when thinking level is valid', () => {
        const out = providers.pi.applyPiThinkingLevelEnv({ FOO: 'bar' }, 'high');
        expect(out).toEqual({ FOO: 'bar', [providers.pi.PI_THINKING_LEVEL_ENV]: 'high' });
    });

    it('does not set env var when thinking level is empty (default)', () => {
        const out = providers.pi.applyPiThinkingLevelEnv({ FOO: 'bar' }, '');
        expect(out).toEqual({ FOO: 'bar' });
    });

    it('ignores invalid thinking levels', () => {
        const out = providers.pi.applyPiThinkingLevelEnv({ FOO: 'bar' }, 'invalid-level');
        expect(out).toEqual({ FOO: 'bar' });
    });
});
