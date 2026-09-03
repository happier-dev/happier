import { describe, expect, it } from 'vitest';
import {
    HAPPIER_REPLAY_RECENT_MESSAGES_MAX_COUNT,
    HAPPIER_REPLAY_SEED_MAX_CHARS,
    HAPPIER_REPLAY_SEED_MIN_CHARS,
} from '@happier-dev/protocol';

import { ACCOUNT_DISPLAY_SETTING_DEFINITIONS } from './accountDisplaySettingDefinitions';

describe('ACCOUNT_DISPLAY_SETTING_DEFINITIONS', () => {
    it('defaults Happier run instructions on while preserving an explicit opt-out', () => {
        const definition = ACCOUNT_DISPLAY_SETTING_DEFINITIONS.executionRunsGuidanceEnabled;

        expect(definition.default).toBe(true);
        expect(definition.schema.parse(false)).toBe(false);
    });

    it('enables cockpit lateral session swiping by default as a synced account setting', () => {
        const definition = ACCOUNT_DISPLAY_SETTING_DEFINITIONS.sessionCockpitSwipeNavigationEnabled;

        expect(definition.default).toBe(true);
        expect(definition.storageScope).toBe('account');
        expect(definition.schema.safeParse(false).success).toBe(true);
        expect(definition.schema.safeParse('off').success).toBe(false);
    });

    // These two were declared as bare `z.number()`, so any budget or window was
    // storable — including one below the floor at which the seed builder
    // correctly produces nothing, which is how a user reached "no seed at all,
    // silently". Bounds now come from the one Replay-budget owner.
    it('bounds the replay seed budget at the measured floor and shared ceiling', () => {
        const schema = ACCOUNT_DISPLAY_SETTING_DEFINITIONS.sessionReplayMaxSeedChars.schema;

        expect(schema.safeParse(HAPPIER_REPLAY_SEED_MIN_CHARS - 1).success).toBe(false);
        expect(schema.safeParse(HAPPIER_REPLAY_SEED_MIN_CHARS).success).toBe(true);
        expect(schema.safeParse(HAPPIER_REPLAY_SEED_MAX_CHARS).success).toBe(true);
        expect(schema.safeParse(HAPPIER_REPLAY_SEED_MAX_CHARS + 1).success).toBe(false);
        expect(schema.safeParse(500).success).toBe(false);
    });

    it('bounds the replay recent-messages window at the window the resolver enforces', () => {
        const schema = ACCOUNT_DISPLAY_SETTING_DEFINITIONS.sessionReplayRecentMessagesCount.schema;

        expect(schema.safeParse(HAPPIER_REPLAY_RECENT_MESSAGES_MAX_COUNT).success).toBe(true);
        expect(schema.safeParse(HAPPIER_REPLAY_RECENT_MESSAGES_MAX_COUNT + 1).success).toBe(false);
        expect(schema.safeParse(10_000).success).toBe(false);
        expect(schema.safeParse(0).success).toBe(false);
    });
});
