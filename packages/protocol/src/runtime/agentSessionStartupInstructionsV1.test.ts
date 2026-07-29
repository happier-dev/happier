import { describe, expect, it } from 'vitest';

import {
  AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_UTF8_BYTES,
  AgentSessionStartupInstructionsMarkerV1Schema,
  AgentSessionStartupInstructionsV1Schema,
} from './agentSessionStartupInstructionsV1.js';

describe('AgentSessionStartupInstructionsV1Schema', () => {
  const canonical = {
    v: 1 as const,
    id: 'happier.global_voice_agent',
    revision: 1,
  };

  it('accepts the canonical identity and exactly-at-limit UTF-8 instructions', () => {
    const instructions = 'x'.repeat(
      AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_UTF8_BYTES,
    );

    const parsed = AgentSessionStartupInstructionsV1Schema.parse({
      ...canonical,
      instructions,
    });

    expect(parsed).toEqual({
      ...canonical,
      instructions,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('accepts only the strict secret-free applied marker shape', () => {
    const parsed = AgentSessionStartupInstructionsMarkerV1Schema.parse(canonical);

    expect(parsed).toEqual(canonical);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      AgentSessionStartupInstructionsMarkerV1Schema.safeParse({
        ...canonical,
        instructions: 'must not be persisted',
      }).success,
    ).toBe(false);
  });

  it.each([
    ['empty instructions', { ...canonical, instructions: '' }],
    ['blank instructions', { ...canonical, instructions: '   ' }],
    ['oversized instructions', {
      ...canonical,
      instructions: 'x'.repeat(
        AGENT_SESSION_STARTUP_INSTRUCTIONS_V1_MAX_UTF8_BYTES + 1,
      ),
    }],
    ['invalid Unicode', { ...canonical, instructions: '\uD800' }],
    ['non-normalized Unicode', { ...canonical, instructions: 'e\u0301' }],
    ['malformed id', { ...canonical, id: 'Happier Voice', instructions: 'ok' }],
    ['zero revision', { ...canonical, revision: 0, instructions: 'ok' }],
    ['negative revision', { ...canonical, revision: -1, instructions: 'ok' }],
    ['out-of-range revision', {
      ...canonical,
      revision: 2_147_483_648,
      instructions: 'ok',
    }],
    ['unknown field', { ...canonical, instructions: 'ok', rawPromptHash: 'no' }],
  ])('rejects %s', (_label, input) => {
    expect(AgentSessionStartupInstructionsV1Schema.safeParse(input).success)
      .toBe(false);
  });
});
