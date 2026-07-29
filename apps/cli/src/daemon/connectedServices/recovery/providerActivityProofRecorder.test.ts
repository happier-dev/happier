import { describe, expect, it, vi } from 'vitest';

import {
  createConnectedServiceProviderActivityProofRecorder,
  isProviderActivityTurnLifecycleEvent,
} from './providerActivityProofRecorder';

describe('createConnectedServiceProviderActivityProofRecorder', () => {
  it('forwards exact provider outcome targets without continuation state', async () => {
    const markProviderOutcomeProofByIdentity = vi.fn(async () => undefined);
    const recorder = createConnectedServiceProviderActivityProofRecorder({
      runtimeAuthRecovery: { markProviderOutcomeProofByIdentity },
      nowMs: () => 1_100,
    });

    await recorder({
      sessionId: 'session-1',
      observedAtMs: 1_050,
      providerOutcomeTargets: [{
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        groupGeneration: 7,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      }],
    });

    expect(markProviderOutcomeProofByIdentity).toHaveBeenCalledWith({
      sessionId: 'session-1',
      proofKind: 'provider_activity',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      groupGeneration: 7,
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      observedAtMs: 1_050,
    });
  });

  it('accepts completed provider output but rejects task dispatch and failed terminal output', () => {
    expect(isProviderActivityTurnLifecycleEvent('task_started')).toBe(false);
    expect(isProviderActivityTurnLifecycleEvent('assistant_message_end', 'completed')).toBe(true);
    expect(isProviderActivityTurnLifecycleEvent('assistant_message_end', 'failed')).toBe(false);
  });

  it('does not clear recovery from activity without an exact provider outcome target', async () => {
    const markProviderOutcomeProofByIdentity = vi.fn(async () => undefined);
    const recorder = createConnectedServiceProviderActivityProofRecorder({
      runtimeAuthRecovery: { markProviderOutcomeProofByIdentity },
    });

    await recorder({ sessionId: 'session-1' });

    expect(markProviderOutcomeProofByIdentity).not.toHaveBeenCalled();
  });
});
