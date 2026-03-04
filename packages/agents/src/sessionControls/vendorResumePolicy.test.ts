import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '../manifest.js';

import {
  evaluateVendorResumeEligibility,
  resolveVendorResumeIdFromSessionMetadata,
} from './vendorResumePolicy.js';

describe('vendorResumePolicy', () => {
  it('exposes claudeSessionId as the Claude vendor resume id field', () => {
    expect(AGENTS_CORE.claude.resume.vendorResumeIdField).toBe('claudeSessionId');
  });

  it('resolves vendor resume ids from metadata (trimmed)', () => {
    expect(resolveVendorResumeIdFromSessionMetadata('claude', { claudeSessionId: ' c1 ' })).toBe('c1');
    expect(resolveVendorResumeIdFromSessionMetadata('claude', { claudeSessionId: '   ' })).toBeNull();
  });

  it('rejects unsupported agents', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'pi',
        metadata: { piSessionId: 'p1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: false, reasonCode: 'agent_unsupported' });
  });

  it('rejects when vendor resume id is missing', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'claude',
        metadata: { flavor: 'claude' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: false, reasonCode: 'vendor_resume_id_missing' });
  });

  it('rejects experimental codex resume when ACP is disabled by settings', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1' },
        accountSettings: { codexBackendMode: 'mcp' },
      }),
    ).toEqual({ eligible: false, reasonCode: 'experimental_disabled' });
  });

  it('allows experimental codex resume when ACP is enabled by settings', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1' },
        accountSettings: { codexBackendMode: 'acp' },
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'x1' });
  });

  it('rejects when the backend is disabled by account settings', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1' },
        accountSettings: { codexBackendMode: 'acp', backendEnabledById: { codex: false } },
      }),
    ).toEqual({ eligible: false, reasonCode: 'backend_disabled_by_account_settings' });
  });
});

