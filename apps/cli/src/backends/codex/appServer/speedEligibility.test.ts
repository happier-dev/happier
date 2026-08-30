import { describe, expect, it } from 'vitest';

import {
    isCodexAppServerFastModelEligible,
    isCodexAppServerFastServiceTier,
    isCodexAppServerSpeedEligible,
} from './speedEligibility';

describe('Codex app-server Speed eligibility', () => {
    it('uses the model catalog for current Fast tier support', () => {
        expect(isCodexAppServerFastModelEligible({
            serviceTiers: [{ id: 'priority', name: 'Fast' }],
        })).toBe(true);
        expect(isCodexAppServerFastModelEligible({
            serviceTiers: [],
            additionalSpeedTiers: [],
        })).toBe(false);
    });

    it('accepts the deprecated catalog field without falling back to model ids', () => {
        expect(isCodexAppServerFastModelEligible({
            additionalSpeedTiers: ['fast'],
        })).toBe(true);
        expect(isCodexAppServerFastModelEligible()).toBe(false);
    });

    it('keeps the existing auth eligibility gate', () => {
        const modelRecord = { serviceTiers: [{ id: 'priority', name: 'Fast' }] };

        expect(isCodexAppServerSpeedEligible({
            authMethod: 'oauth_cli',
            modelRecord,
        })).toBe(true);
        expect(isCodexAppServerSpeedEligible({
            authMethod: 'api_key_env',
            modelRecord,
        })).toBe(false);
    });

    it('recognizes both app-server and legacy Fast request values', () => {
        expect(isCodexAppServerFastServiceTier('priority')).toBe(true);
        expect(isCodexAppServerFastServiceTier('fast')).toBe(true);
        expect(isCodexAppServerFastServiceTier('flex')).toBe(false);
        expect(isCodexAppServerFastServiceTier(null)).toBe(false);
    });
});
