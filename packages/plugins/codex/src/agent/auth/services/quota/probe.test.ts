import { describe, expect, it } from 'vitest';

import { resolveCodexRuntimeQuotaProbeSupport } from './probe.js';

describe('Codex runtime quota probe support', () => {
  it('allows app-server and unspecified backend modes', () => {
    expect(resolveCodexRuntimeQuotaProbeSupport({ backendMode: 'appServer' })).toEqual({ supported: true });
    expect(resolveCodexRuntimeQuotaProbeSupport({ provider: { backendMode: 'appServer' } })).toEqual({ supported: true });
    expect(resolveCodexRuntimeQuotaProbeSupport({})).toEqual({ supported: true });
  });

  it('rejects non-app-server backend modes', () => {
    expect(resolveCodexRuntimeQuotaProbeSupport({ provider: { backendMode: 'acp' } })).toEqual({
      supported: false,
      reason: 'codex_quota_probe_unsupported_for_backend_mode',
    });
  });
});
