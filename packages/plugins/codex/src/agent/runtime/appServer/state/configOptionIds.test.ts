import { describe, expect, it } from 'vitest';

import {
    CODEX_APP_SERVER_LEGACY_SPEED_CONFIG_OPTION_ID,
    CODEX_APP_SERVER_REASONING_EFFORT_CONFIG_OPTION_ID,
    CODEX_APP_SERVER_SERVICE_TIER_CONFIG_OPTION_ID,
    normalizeCodexAppServerConfigOptionId,
} from './configOptionIds';

describe('Codex app-server config option ids', () => {
    it('normalizes the legacy speed option id to the canonical service-tier option id', () => {
        expect(normalizeCodexAppServerConfigOptionId(CODEX_APP_SERVER_REASONING_EFFORT_CONFIG_OPTION_ID))
            .toBe(CODEX_APP_SERVER_REASONING_EFFORT_CONFIG_OPTION_ID);
        expect(normalizeCodexAppServerConfigOptionId(CODEX_APP_SERVER_SERVICE_TIER_CONFIG_OPTION_ID))
            .toBe(CODEX_APP_SERVER_SERVICE_TIER_CONFIG_OPTION_ID);
        expect(normalizeCodexAppServerConfigOptionId(CODEX_APP_SERVER_LEGACY_SPEED_CONFIG_OPTION_ID))
            .toBe(CODEX_APP_SERVER_SERVICE_TIER_CONFIG_OPTION_ID);
    });

    it('preserves unknown option ids so callers can ignore or handle them explicitly', () => {
        expect(normalizeCodexAppServerConfigOptionId('custom_option')).toBe('custom_option');
        expect(normalizeCodexAppServerConfigOptionId(null)).toBeNull();
        expect(normalizeCodexAppServerConfigOptionId('   ')).toBeNull();
    });
});
