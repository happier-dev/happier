import { describe, expect, it } from 'vitest';

import {
  explainAttachIneligibility,
  resolveDominantAttachIneligibilityCategory,
  type AttachIneligibilityExplanation,
} from './explainAttachIneligibility';
import type { CliSessionAttachEligibility } from './evaluateCliSessionAttachEligibility';

function ineligibility(overrides: Partial<Extract<CliSessionAttachEligibility, { eligible: false }>> = {}): Extract<CliSessionAttachEligibility, { eligible: false }> {
  return {
    eligible: false,
    agentId: 'codex',
    reasonCode: 'missing_local_attach_state',
    reason: 'No local attachment info found for this session on this computer.',
    metadata: null,
    ...overrides,
  };
}

describe('explainAttachIneligibility', () => {
  it('classifies plain terminal-host sessions as started outside tmux', () => {
    const result = explainAttachIneligibility({
      eligibility: ineligibility(),
      metadata: { terminal: { mode: 'plain' }, host: 'leeroy-mbp' },
      currentMachineHost: 'leeroy-mbp.local',
      tmuxAvailable: true,
      agentAttachStrategy: 'terminal_host',
    });

    expect(result.category).toBe('started_outside_tmux');
    expect(result.fullReason).toMatch(/started outside tmux/i);
  });

  it('classifies terminal plan failures separately from provider attach failures', () => {
    const terminal = explainAttachIneligibility({
      eligibility: ineligibility({ reasonCode: 'terminal_not_attachable', reason: 'Session does not include a tmux target.' }),
      metadata: { terminal: { mode: 'tmux' }, host: 'leeroy-mbp' },
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: true,
      agentAttachStrategy: 'terminal_host',
    });
    const provider = explainAttachIneligibility({
      eligibility: ineligibility({ reasonCode: 'provider_attach_unavailable', reason: 'Provider attach is unavailable.' }),
      metadata: { host: 'leeroy-mbp' },
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: true,
      agentAttachStrategy: 'provider_attach',
    });

    expect(terminal.category).toBe('no_local_state');
    expect(terminal.fullReason).toContain('tmux target');
    expect(provider.category).toBe('no_local_state');
    expect(provider.fullReason).toContain('Provider attach');
  });

  it('classifies another machine using normalized host comparison', () => {
    const result = explainAttachIneligibility({
      eligibility: ineligibility({ reasonCode: 'not_current_machine' }),
      metadata: { host: 'office-imac.local' },
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: true,
      agentAttachStrategy: 'terminal_host',
    });

    expect(result.category).toBe('remote_machine');
    expect(result.shortReason).toContain('office-imac');
  });
});

describe('resolveDominantAttachIneligibilityCategory', () => {
  function explanation(category: AttachIneligibilityExplanation['category']): AttachIneligibilityExplanation {
    return { category, shortReason: '', fullReason: '' };
  }

  it('returns the most common category', () => {
    expect(resolveDominantAttachIneligibilityCategory([
      explanation('started_outside_tmux'),
      explanation('remote_machine'),
      explanation('started_outside_tmux'),
    ])).toBe('started_outside_tmux');
  });
});
