import { describe, expect, it } from 'vitest';

import {
  NON_PROOF_LOCAL_SUBSTEPS,
  isRecoveredProviderOutcomeProof,
  isTerminalProviderOutcomeProof,
  type ProviderOutcomeProofKind,
} from './providerOutcomeProof';

describe('providerOutcomeProof shared contract', () => {
  const recoveredKinds: ProviderOutcomeProofKind[] = [
    'provider_activity',
    'native_resume',
    'quota_probe_fresh',
    'account_adoption_verified',
  ];
  const intermediateKinds: ProviderOutcomeProofKind[] = [
    'fresh_candidate_selected',
  ];
  const terminalKinds: ProviderOutcomeProofKind[] = [
    'terminal_action_required',
    'terminal_exhausted',
  ];

  it('classifies every recovered proof kind as recovered (not terminal)', () => {
    for (const kind of recoveredKinds) {
      expect(isRecoveredProviderOutcomeProof(kind)).toBe(true);
      expect(isTerminalProviderOutcomeProof(kind)).toBe(false);
    }
  });

  it('classifies every terminal proof kind as terminal (not recovered)', () => {
    for (const kind of terminalKinds) {
      expect(isTerminalProviderOutcomeProof(kind)).toBe(true);
      expect(isRecoveredProviderOutcomeProof(kind)).toBe(false);
    }
  });

  it('keeps candidate-selection evidence as intermediate (not recovered, not terminal)', () => {
    for (const kind of intermediateKinds) {
      expect(isRecoveredProviderOutcomeProof(kind)).toBe(false);
      expect(isTerminalProviderOutcomeProof(kind)).toBe(false);
    }
  });

  it('treats null/undefined as no proof', () => {
    expect(isRecoveredProviderOutcomeProof(null)).toBe(false);
    expect(isRecoveredProviderOutcomeProof(undefined)).toBe(false);
    expect(isTerminalProviderOutcomeProof(null)).toBe(false);
    expect(isTerminalProviderOutcomeProof(undefined)).toBe(false);
  });

  it('documents the local substeps that are explicitly NOT proof', () => {
    expect(NON_PROOF_LOCAL_SUBSTEPS).toContain('local_switch_account');
    expect(NON_PROOF_LOCAL_SUBSTEPS).toContain('credential_refreshed');
    expect(NON_PROOF_LOCAL_SUBSTEPS).toContain('observed_generation');
    expect(NON_PROOF_LOCAL_SUBSTEPS).toContain('continuation_enqueued');
    expect(NON_PROOF_LOCAL_SUBSTEPS).toContain('same_account_hot_apply');
    expect(NON_PROOF_LOCAL_SUBSTEPS).toContain('transcript_echo_suppression');
  });

  it('keeps provider-activity as recovered proof while continuation enqueue remains non-proof', () => {
    expect(isRecoveredProviderOutcomeProof('provider_activity')).toBe(true);
    expect(NON_PROOF_LOCAL_SUBSTEPS).toContain('continuation_enqueued');
  });
});
