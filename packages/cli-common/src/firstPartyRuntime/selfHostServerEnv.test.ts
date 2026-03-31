import { describe, expect, it } from 'vitest';

import { applyEnvOverridesToEnvText } from './selfHostServerEnv.js';

describe('applyEnvOverridesToEnvText', () => {
    it('rejects env override keys with newlines', () => {
        expect(() => applyEnvOverridesToEnvText('PORT=3005\n', { 'BAD\nKEY': '1' })).toThrow(/env override/i);
    });

    it('rejects env override values with newlines', () => {
        expect(() => applyEnvOverridesToEnvText('PORT=3005\n', { PORT: '3005\nBAD=1' })).toThrow(/env override/i);
    });
});

