import { describe, expect, it } from 'vitest';

import { evaluateExistingSessionAutomationEligibility } from './existingSessionAutomationPolicy.js';

describe('evaluateExistingSessionAutomationEligibility', () => {
  it('accepts vendor-resumable sessions with a persisted resume id', () => {
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
  });

  it('rejects providers that do not support resuming existing sessions', () => {
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          flavor: 'pi',
          piSessionId: 'pi-session-1',
        },
      }),
    ).toEqual({
      eligible: false,
      reasonCode: 'agent_unsupported',
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
      agentId: 'customAcp',
      strategy: 'happy_attach',
    });
  });

  it('accepts runtime-descriptor sessions without legacy top-level vendor ids', () => {
    expect(
      evaluateExistingSessionAutomationEligibility({
        metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'opencode',
            provider: { backendMode: 'server', vendorSessionId: 'opencode-session-1' },
          },
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'opencode',
      strategy: 'vendor_resume',
    });
  });
});
