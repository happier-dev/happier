import { describe, expect, it } from 'vitest';

import { getActionSpec } from '../actionSpecs.js';

describe('runtime Action descriptions', () => {
  it('keeps agent-only call instructions in agent guidance, never in the description people read', () => {
    const spec = getActionSpec('browser.context.attachToComposer');

    // Settings rows and the input form show the description (inputHints.description) to a person.
    expect(spec.description).not.toMatch(
      /activePage|browserSessionId|navigationGeneration/,
    );
    expect(spec.inputHints?.description).toBe(spec.description);
    // Agents still learn how to call it through the discovery guidance.
    expect(spec.prompting?.agentGuidance).toMatch(/source="activePage"/);
  });
});
