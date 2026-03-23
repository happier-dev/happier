import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { AGENTS_CORE } from '../manifest.js';

import {
  evaluateVendorHandoffEligibility,
  resolveVendorHandoffIdFromSessionMetadata,
} from './vendorHandoffPolicy.js';

describe('vendorHandoffPolicy', () => {
  it('exposes provider-general session storage support in the manifest', () => {
    expect(AGENTS_CORE.claude.sessionStorage).toEqual({ direct: true, persisted: true });
    expect(AGENTS_CORE.opencode.sessionStorage).toEqual({ direct: true, persisted: true });
    expect(AGENTS_CORE.codex.sessionStorage).toEqual({ direct: true, persisted: true });
    expect(AGENTS_CORE.pi.sessionStorage).toEqual({ direct: false, persisted: true });
  });

  it('resolves vendor handoff ids from metadata using the vendor resume field', () => {
    expect(resolveVendorHandoffIdFromSessionMetadata('claude', { claudeSessionId: ' c1 ' })).toBe('c1');
    expect(resolveVendorHandoffIdFromSessionMetadata('claude', { claudeSessionId: '   ' })).toBeNull();
  });

  it('prefers vendor session ids from agentRuntimeDescriptorV1 for handoff ids', () => {
    expect(resolveVendorHandoffIdFromSessionMetadata('codex', {
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer', vendorSessionId: 'runtime_thread' },
      },
      codexSessionId: 'legacy_thread',
    })).toBe('runtime_thread');
  });

  it('rejects unsupported direct handoff when the provider does not support direct session storage', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'pi',
        storageMode: 'direct',
        metadata: { piSessionId: 'p1' },
      }),
    ).toEqual({ eligible: false, reasonCode: 'storage_mode_unsupported' });
  });

  it('rejects providers whose vendor state transfer is unsupported', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'pi',
        storageMode: 'persisted',
        metadata: { piSessionId: 'p1' },
      }),
    ).toEqual({ eligible: false, reasonCode: 'handoff_unsupported' });
  });

  it('rejects when the vendor handoff id is missing', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'claude',
        storageMode: 'persisted',
        metadata: { flavor: 'claude' },
      }),
    ).toEqual({ eligible: false, reasonCode: 'vendor_handoff_id_missing' });
  });

  it('allows supported providers with a vendor handoff id', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'claude',
        storageMode: 'persisted',
        metadata: { claudeSessionId: 'c1' },
      }),
    ).toEqual({ eligible: true, vendorHandoffId: 'c1' });
  });

  it('marks codex handoff as experimental', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'codex',
        storageMode: 'persisted',
        metadata: { codexSessionId: 'x1' },
      }),
    ).toEqual({ eligible: false, reasonCode: 'experimental_disabled' });
  });

  it('allows codex handoff when the canonical runtime descriptor proves an eligible backend mode', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'codex',
        storageMode: 'persisted',
        metadata: {
          codexSessionId: 'x1',
          codexRuntimeDescriptorV1: { v: 1, backendMode: 'appServer' },
        },
      }),
    ).toEqual({ eligible: true, vendorHandoffId: 'x1' });
  });

  it('prefers the canonical runtime descriptor over legacy codex backend metadata', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'codex',
        storageMode: 'persisted',
        metadata: {
          codexSessionId: 'x1',
          codexRuntimeDescriptorV1: { v: 1, backendMode: 'mcp' },
          codexBackendMode: 'appServer',
        },
      }),
    ).toEqual({ eligible: false, reasonCode: 'experimental_disabled' });
  });

  it('rejects when the backend is disabled by account settings', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'claude',
        storageMode: 'persisted',
        metadata: { claudeSessionId: 'c1' },
        accountSettings: {
          backendEnabledByTargetKey: {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: false,
          },
        },
      }),
    ).toEqual({ eligible: false, reasonCode: 'backend_disabled_by_account_settings' });
  });
});
