import { describe, expect, it } from 'vitest';
import type { OrderedBot } from './botActivity';
import { isNotchBotFaceMember } from './notchBotFaces';

describe('notch face membership', () => {
    const bot = (activity: OrderedBot['activity']): OrderedBot => ({ activity, key: 'home:bot', serverId: 'home', sessionId: 'bot', face: { seed: 'bot', face: null }, meaningfulActivityAt: 1 });
    it('always includes needs-you, and includes only rail pins for working/always', () => {
        for (const mode of ['attention_only', 'active_sessions', 'always_when_enabled'] as const) {
            expect(isNotchBotFaceMember(bot('needsYou'), mode, false)).toBe(true);
        }
        expect(isNotchBotFaceMember(bot('working'), 'attention_only', true)).toBe(false);
        expect(isNotchBotFaceMember(bot('working'), 'active_sessions', true)).toBe(true);
        expect(isNotchBotFaceMember(bot('working'), 'active_sessions', false)).toBe(false);
        expect(isNotchBotFaceMember(bot('quiet'), 'active_sessions', true)).toBe(false);
        expect(isNotchBotFaceMember(bot('quiet'), 'always_when_enabled', true)).toBe(true);
        expect(isNotchBotFaceMember(bot('quiet'), 'always_when_enabled', false)).toBe(false);
    });
});
