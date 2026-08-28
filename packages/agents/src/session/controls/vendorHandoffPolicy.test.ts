import { describe, expect, it } from 'vitest';
import { accountSettingsParse, buildBackendTargetKey } from '@happier-dev/protocol';

import { AGENTS_CORE } from '../../manifest.js';

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
        agentId: 'codex',
        provider: { backendMode: 'appServer', providerSessionId: 'runtime_thread' },
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

  it('rejects direct OpenCode handoff when the persisted runtime kind is acp', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'opencode',
        storageMode: 'direct',
        metadata: {
          opencodeSessionId: 'o1',
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            provider: {
              backendMode: 'acp',
              providerSessionId: 'o1',
            },
          },
        },
      }),
    ).toEqual({ eligible: false, reasonCode: 'storage_mode_unsupported' });
  });

  it('uses the declared Codex runtime default when session metadata has no runtime identity', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'codex',
        storageMode: 'persisted',
        metadata: { codexSessionId: 'x1' },
      }),
    ).toEqual({ eligible: true, vendorHandoffId: 'x1' });
  });

  it('allows codex handoff when the canonical runtime descriptor proves an eligible backend mode', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'codex',
        storageMode: 'persisted',
        metadata: {
          codexSessionId: 'x1',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: { backendMode: 'appServer', providerSessionId: 'x1' },
          },
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
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: { backendMode: 'acp', providerSessionId: 'x1' },
          },
          codexBackendMode: 'appServer',
        },
      }),
    ).toEqual({ eligible: false, reasonCode: 'handoff_unsupported' });
  });

  it('rejects when the backend is disabled by account settings', () => {
    expect(
      evaluateVendorHandoffEligibility({
        agentId: 'claude',
        storageMode: 'persisted',
        metadata: { claudeSessionId: 'c1' },
        // The fixture is the canonical PARSED projection, not a record keyed by
        // the same builder the policy used to call. Restating that builder here
        // made the assertion pass for any key vocabulary, including one the
        // catalog no longer stores.
        accountSettings: accountSettingsParse({
          backendEnabledByTargetKey: {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: false,
          },
        }) as unknown as Record<string, unknown>,
      }),
    ).toEqual({ eligible: false, reasonCode: 'backend_disabled_by_account_settings' });
  });
});
