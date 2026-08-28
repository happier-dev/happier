import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('Auggie agent definition', () => {
  it('keeps the public Agent definition free of private runtime aggregates', () => {
    expect(AGENT_DEFINITION.id).toBe('auggie');
    expect(AGENT_DEFINITION).not.toHaveProperty('runtimeContributions');
  });
});
