import { describe, expect, it } from 'vitest';

import * as sessionStateBridge from './bridge';

describe('session model selection facade', () => {
    it('does not expose a direct model-intent metadata writer', () => {
        expect('publishModelOverrideToMetadata' in sessionStateBridge).toBe(false);
    });
});
