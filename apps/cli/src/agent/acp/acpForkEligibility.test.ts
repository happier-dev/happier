import { describe, expect, it } from 'vitest';

import { isAcpForkEligibleForProvider } from './acpForkEligibility';

describe('isAcpForkEligibleForProvider', () => {
  it('treats canonical codex runtime metadata as ACP eligibility for codex', () => {
    expect(
      isAcpForkEligibleForProvider({
        providerId: 'codex',
        metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: { backendMode: 'acp', vendorSessionId: 'codex_parent' },
          },
          codexSessionId: 'codex_parent',
        },
      }),
    ).toBe(true);
  });

  it('does not treat stale ACP breadcrumbs as eligible when codex runtime metadata proves a non-ACP backend', () => {
    expect(
      isAcpForkEligibleForProvider({
        providerId: 'codex',
        metadata: {
          acpHistoryImportV1: { v: 1, provider: 'codex' },
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: { backendMode: 'appServer', vendorSessionId: 'codex_parent' },
          },
          codexSessionId: 'codex_parent',
        },
      }),
    ).toBe(false);
  });

  it('treats generic acpTransportV1 metadata as ACP eligibility for the matching provider', () => {
    expect(
      isAcpForkEligibleForProvider({
        providerId: 'opencode',
        metadata: {
          acpTransportV1: { v: 1, provider: 'opencode' },
          opencodeBackendMode: 'server',
        },
      }),
    ).toBe(true);
  });

  it('does not treat acpTransportV1 from a different provider as eligible', () => {
    expect(
      isAcpForkEligibleForProvider({
        providerId: 'opencode',
        metadata: {
          acpTransportV1: { v: 1, provider: 'codex' },
        },
      }),
    ).toBe(false);
  });

  it('treats legacy opencodeBackendMode=acp metadata as ACP eligibility for opencode', () => {
    expect(
      isAcpForkEligibleForProvider({
        providerId: 'opencode',
        metadata: {
          opencodeBackendMode: 'acp',
        },
      }),
    ).toBe(true);
  });
});
