import { describe, expect, it } from 'vitest';
import { FeaturesResponseSchema } from '../features/payload/featuresResponseSchema.js';

describe('change-feed transport negotiation', () => {
  it('admits only the known cursor-header epoch without invalidating unrelated Home capabilities', () => {
    const read = (changes: unknown) => FeaturesResponseSchema.parse({ features: {}, capabilities: {
      changes, session: { messages: { role: true, turns: true } },
    } });
    expect(read({ cursorHeaderVersion: 1 }).capabilities.changes?.cursorHeaderVersion).toBe(1);
    for (const changes of [undefined, false, {}, { cursorHeaderVersion: 2 }, { cursorHeaderVersion: '1' }]) {
      const parsed = read(changes);
      expect(parsed.capabilities.changes?.cursorHeaderVersion).toBeUndefined();
      expect(parsed.capabilities.session.messages.turns).toBe(true);
    }
  });
});
