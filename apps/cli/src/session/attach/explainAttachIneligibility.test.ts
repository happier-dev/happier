import { describe, expect, it } from 'vitest';

import {
  explainAttachIneligibility,
  resolveDominantAttachIneligibilityCategory,
  type AgentAttachStrategyForExplainer,
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
  it('classifies plain-mode tmux-strategy sessions as started_outside_tmux', () => {
    const result = explainAttachIneligibility({
      eligibility: ineligibility({ reasonCode: 'missing_local_attach_state' }),
      metadata: { terminal: { mode: 'plain' }, host: 'leeroy-mbp' },
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: true,
      agentAttachStrategy: 'tmux',
    });
    expect(result.category).toBe('started_outside_tmux');
    expect(result.shortReason).toContain('outside tmux');
    expect(result.fullReason).toMatch(/started outside tmux/i);
    expect(result.nextStepHint).toMatch(/Spawn Sessions in Tmux/i);
  });

  it('classifies tmux-strategy sessions as tmux_unavailable when tmux is missing', () => {
    const result = explainAttachIneligibility({
      eligibility: ineligibility({ reasonCode: 'missing_local_attach_state' }),
      // Mode might be tmux or unknown — we still hit this branch when tmux
      // is not installed locally.
      metadata: { host: 'leeroy-mbp' },
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: false,
      agentAttachStrategy: 'tmux',
    });
    expect(result.category).toBe('tmux_unavailable');
    expect(result.shortReason).toContain('tmux');
    expect(result.nextStepHint).toMatch(/install tmux/i);
  });

  it('plain-mode wins over tmux-unavailable so the user sees the actionable cause', () => {
    // If both are true, "started outside tmux" is the more user-actionable
    // explanation for *this* session — installing tmux won't make a plain
    // session re-attachable.
    const result = explainAttachIneligibility({
      eligibility: ineligibility(),
      metadata: { terminal: { mode: 'plain' }, host: 'leeroy-mbp' },
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: false,
      agentAttachStrategy: 'tmux',
    });
    expect(result.category).toBe('started_outside_tmux');
  });

  it('classifies hidden Windows sessions separately instead of suggesting tmux or daemon restart', () => {
    const result = explainAttachIneligibility({
      eligibility: ineligibility({
        reasonCode: 'terminal_not_attachable',
        reason: 'This Windows session was started hidden and cannot be attached later.',
      }),
      metadata: {
        host: 'leeroy-mbp',
        terminal: { mode: 'plain', requested: 'windows_terminal' },
      },
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: true,
      agentAttachStrategy: 'tmux',
    });

    expect(result.category).toBe('windows_hidden');
    expect(result.fullReason).toBe('This Windows session was started hidden and cannot be attached later.');
    expect(result.nextStepHint).toMatch(/visible terminal/i);
  });

  it('classifies cross-machine sessions as remote_machine using metadata host', () => {
    const result = explainAttachIneligibility({
      eligibility: ineligibility({ reasonCode: 'not_current_machine' }),
      metadata: { host: 'leeroy-imac' },
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: true,
      agentAttachStrategy: 'tmux',
    });
    expect(result.category).toBe('remote_machine');
    expect(result.shortReason).toContain('leeroy-imac');
  });

  it('treats Bonjour-suffixed hosts as same machine (no false-positive remote)', () => {
    const result = explainAttachIneligibility({
      eligibility: ineligibility(),
      metadata: { host: 'leeroy-mbp', terminal: { mode: 'plain' } },
      currentMachineHost: 'leeroy-mbp.local',
      tmuxAvailable: true,
      agentAttachStrategy: 'tmux',
    });
    expect(result.category).toBe('started_outside_tmux');
  });

  it('classifies archived sessions as archived_or_inactive', () => {
    const result = explainAttachIneligibility({
      eligibility: ineligibility({ reasonCode: 'archived', reason: 'Session is archived and cannot be attached.' }),
      metadata: null,
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: true,
      agentAttachStrategy: 'tmux',
    });
    expect(result.category).toBe('archived_or_inactive');
    expect(result.nextStepHint).toMatch(/happier resume/i);
  });

  it('classifies metadata-unavailable sessions distinctly so we can suggest auth pair-remote', () => {
    const result = explainAttachIneligibility({
      eligibility: ineligibility({ reasonCode: 'metadata_unavailable', reason: 'Failed to decrypt session metadata.' }),
      metadata: null,
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: true,
      agentAttachStrategy: 'tmux',
    });
    expect(result.category).toBe('metadata_unreadable');
    expect(result.nextStepHint).toMatch(/pair-remote/i);
  });

  it('classifies unsupported-agent sessions as unsupported_agent', () => {
    const result = explainAttachIneligibility({
      eligibility: ineligibility({ reasonCode: 'local_control_unsupported' }),
      metadata: { host: 'leeroy-mbp' },
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: true,
      agentAttachStrategy: 'unsupported' as AgentAttachStrategyForExplainer,
    });
    expect(result.category).toBe('unsupported_agent');
  });

  it('falls back to no_local_state when no other category applies', () => {
    const result = explainAttachIneligibility({
      eligibility: ineligibility({ reasonCode: 'missing_local_attach_state' }),
      metadata: { host: 'leeroy-mbp' },
      currentMachineHost: 'leeroy-mbp',
      tmuxAvailable: true,
      agentAttachStrategy: 'tmux',
    });
    expect(result.category).toBe('no_local_state');
    expect(result.nextStepHint).toMatch(/daemon start/i);
  });
});

describe('resolveDominantAttachIneligibilityCategory', () => {
  function explanation(category: AttachIneligibilityExplanation['category']): AttachIneligibilityExplanation {
    return { category, shortReason: '', fullReason: '' };
  }

  it('returns null for an empty array', () => {
    expect(resolveDominantAttachIneligibilityCategory([])).toBeNull();
  });

  it('returns the most common category', () => {
    expect(resolveDominantAttachIneligibilityCategory([
      explanation('started_outside_tmux'),
      explanation('started_outside_tmux'),
      explanation('remote_machine'),
    ])).toBe('started_outside_tmux');
  });
});
