import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { AGENTS_CORE } from '../../manifest.js';

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
        provider: { backendMode: 'appServer', providerSessionId: 'runtime_thread' },
      },
      codexSessionId: 'legacy_thread',
    })).toBe('runtime_thread');
  });

  it('allows Pi resume when a session id is present', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'pi',
        metadata: { piSessionId: 'p1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'p1' });
  });

  it('prefers Pi absolute session-file metadata over bare session ids for resume', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'pi',
        metadata: {
          piSessionId: 'p1',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'pi',
            provider: {
              resumeStrategy: 'sessionFileAbsolutePreferred',
              providerSessionId: 'p1',
              sessionFile: '/tmp/pi/sessions/2026-05-27T00-00-00-000Z_p1.jsonl',
            },
          },
        },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: '/tmp/pi/sessions/2026-05-27T00-00-00-000Z_p1.jsonl' });
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

  it('allows runtime-checked experimental Cursor resume when a session id is present', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'cursor',
        metadata: { cursorSessionId: 'cursor-session-1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'cursor-session-1' });
  });

  it('keeps experimental Kiro resume disabled by default', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'kiro',
        metadata: { kiroSessionId: 'kiro-session-1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: false, reasonCode: 'experimental_disabled' });
  });

  it('allows ohMyPi resume when a session id is present', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'ohMyPi',
        metadata: { ohMyPiSessionId: 'omp-session-1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'omp-session-1' });
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
