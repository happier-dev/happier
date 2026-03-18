import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

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

  it('prefers vendor session ids from agentRuntimeDescriptorV1 over legacy top-level metadata', () => {
    expect(resolveVendorResumeIdFromSessionMetadata('codex', {
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer', vendorSessionId: 'runtime_thread' },
      },
      codexSessionId: 'legacy_thread',
    })).toBe('runtime_thread');
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

  it('allows codex resume when appServer is enabled by settings', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1' },
        accountSettings: { codexBackendMode: 'appServer' },
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'x1' });
  });

  it('prefers persisted codexBackendMode metadata over account settings for appServer sessions', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1', codexBackendMode: 'appServer' },
        accountSettings: { codexBackendMode: 'mcp' },
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'x1' });
  });

  it('prefers persisted codexBackendMode metadata over account settings for mcp sessions', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1', codexBackendMode: 'mcp' },
        accountSettings: { codexBackendMode: 'appServer' },
      }),
    ).toEqual({ eligible: false, reasonCode: 'experimental_disabled' });
  });

  it('prefers codexRuntimeDescriptorV1 over legacy codexBackendMode metadata', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: {
          codexSessionId: 'x1',
          codexRuntimeDescriptorV1: { v: 1, backendMode: 'appServer' },
          codexBackendMode: 'mcp',
        },
        accountSettings: { codexBackendMode: 'mcp' },
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'x1' });
  });

  it('infers appServer resume eligibility for legacy Codex sessions from generic codex control metadata', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: {
          codexSessionId: 'x1',
          sessionConfigOptionsV1: {
            v: 1,
            provider: 'codex',
            updatedAt: 1,
            options: [],
          },
        },
        accountSettings: { codexBackendMode: 'mcp' },
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'x1' });
  });

  it('rejects when the backend is disabled by account settings', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1' },
        accountSettings: {
          codexBackendMode: 'acp',
          backendEnabledByTargetKey: {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: false,
          },
        },
      }),
    ).toEqual({ eligible: false, reasonCode: 'backend_disabled_by_account_settings' });
  });
});
