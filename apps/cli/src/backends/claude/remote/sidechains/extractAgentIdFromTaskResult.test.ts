import { describe, expect, it } from 'vitest';

import { extractAgentIdFromTaskResultText } from './extractAgentIdFromTaskResult';

describe('extractAgentIdFromTaskResultText', () => {
  it('extracts agent_id values that include @ (agent teams)', () => {
    const res = extractAgentIdFromTaskResultText('Spawned successfully.\nagent_id: alpha@happier-ui-sidechain\nteam_name: happier-ui-sidechain\n');
    expect(res.agentId).toBe('alpha@happier-ui-sidechain');
  });

  it('extracts agentId values without @ (hashed ids)', () => {
    const res = extractAgentIdFromTaskResultText('done\nagentId: a6ca4a6\n');
    expect(res.agentId).toBe('a6ca4a6');
  });
});
