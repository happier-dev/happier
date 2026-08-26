import { isPluginAgentCliAuthBackgroundCheckSafe } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './generated/bundledAgentDefinitions.js';
import { isAgentCliAuthBackgroundCheckSafe } from './auth.js';
import { AGENT_IDS } from './types.js';

describe('Agent CLI auth background-check safety', () => {
  it('derives every bundled Agent safety decision directly from the strict manifest auth declaration', () => {
    for (const agentId of AGENT_IDS) {
      const definition = BUNDLED_AGENT_DEFINITIONS_BY_ID[agentId];
      expect(isAgentCliAuthBackgroundCheckSafe(agentId)).toBe(
        isPluginAgentCliAuthBackgroundCheckSafe(definition.cli),
      );
    }
  });

  it('fails closed for unbundled Agents', () => {
    expect(isAgentCliAuthBackgroundCheckSafe('external-agent')).toBe(false);
  });
});
