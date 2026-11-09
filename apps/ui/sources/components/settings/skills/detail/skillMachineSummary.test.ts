import { describe, expect, it } from 'vitest';

import type { SkillAgentFact, SkillMachineTruth } from './useSkillMachineTruth';
import { summarizeMachines } from './skillMachineSummary';

const names: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const agentNames = (agentIds: readonly string[]) => agentIds.map((agentId) => names[agentId] ?? agentId);

function entry(name: string, offline: boolean, delivered: string[] = [], pending: string[] = []): SkillMachineTruth {
  const facts = new Map<string, SkillAgentFact>();
  for (const agentId of delivered) facts.set(agentId, { kind: 'delivered' });
  for (const agentId of pending) facts.set(agentId, { kind: 'pending' });
  return {
    machine: { machineId: name, platform: 'posix', agentIds: [...delivered, ...pending], name, online: !offline, offline, lastSeenAt: null },
    skillAgents: [...delivered, ...pending], cannotLoad: [], facts, projectedAgents: [],
  };
}

describe('summarizeMachines', () => {
  it('names the Agents once per group of machines, never repeating a machine name, and keeps the offline count apart', () => {
    expect(summarizeMachines([entry('NLDW6', false, ['claude', 'codex']), entry('away-1', true), entry('away-2', true)], agentNames))
      .toEqual({ summary: 'Claude, Codex on NLDW6', note: '2 offline' });
    // One Agent list for the page's one fact, then how many machines: a second list would repeat names and truncate.
    expect(summarizeMachines([
      entry('a', false, ['claude', 'codex']), entry('b', false, ['claude', 'codex']), entry('c', false, ['claude']),
    ], agentNames).summary).toBe('Claude, Codex on 3 machines');
  });

  it('says it is checking while previews are pending, and nothing was delivered otherwise', () => {
    expect(summarizeMachines([entry('a', false, [], ['claude'])], agentNames)).toEqual({ summary: 'Checking…', note: undefined });
    expect(summarizeMachines([entry('a', false)], agentNames).summary).toBe('It isn’t on for any machine yet.');
  });
});
