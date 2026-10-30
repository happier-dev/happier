import { describe, expect, it } from 'vitest';

import { evaluateExistingSessionAutomationEligibility } from './existingSessionAutomationPolicy.js';

describe('evaluateExistingSessionAutomationEligibility', () => {
  it('accepts Claude sessions on the recorded id alone, with or without a transcript path', () => {
    // `AM-24`: the transcript path is a successor-facing pointer, not a resume
    // gate. Automation resumes from the persisted id like every other Agent.
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          flavor: 'claude',
          claudeSessionId: 'claude-session-1',
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'claude',
      strategy: 'vendor_resume',
    });

    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          flavor: 'claude',
          claudeSessionId: 'claude-session-1',
          claudeTranscriptPath: '/tmp/claude-session-1.jsonl',
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'claude',
      strategy: 'vendor_resume',
    });
  });

  it('accepts Pi sessions with a persisted resume id', () => {
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          flavor: 'pi',
          piSessionId: 'pi-session-1',
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'pi',
      strategy: 'vendor_resume',
    });
  });

  it('accepts configured ACP session flavors without requiring a vendor resume id', () => {
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          flavor: 'acp:custom-backend',
        },
      }),
    ).toEqual({
      eligible: true,
      strategy: 'happy_attach',
      compatBackendId: 'custom-backend',
    });
  });

  it('rejects configured ACP compat metadata that still points at the customAcp placeholder', () => {
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          flavor: 'acp:customAcp',
        },
      }),
    ).toEqual({
      eligible: false,
      reasonCode: 'agent_unknown',
    });
  });

  it('does not interpret native resume ids from the opaque runtimeDescriptorV1 payload', () => {
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            agent: { backendMode: 'server', providerSessionId: 'private-descriptor-session' },
          },
        },
      }),
    ).toEqual({ eligible: false, reasonCode: 'vendor_resume_id_missing' });
  });

  it('does not interpret native resume ids from the legacy descriptor payload', () => {
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            provider: { backendMode: 'server', providerSessionId: 'private-descriptor-session' },
          },
        },
      }),
    ).toEqual({ eligible: false, reasonCode: 'vendor_resume_id_missing' });
  });
});
