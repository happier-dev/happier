import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import { validateCatalogAcpProbeSpawn } from './validateCatalogAcpProbeSpawn';

const envKeys = ['PATH', 'HAPPIER_CODEX_ACP_BIN'] as const;
let envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  vi.resetModules();
});

describe('validateCatalogAcpProbeSpawn', () => {
  it('uses the codex daemon spawn prerequisite hook to reject unavailable ACP spawn', async () => {
    envScope.patch({
      PATH: '',
      HAPPIER_CODEX_ACP_BIN: '/missing/codex-acp',
    });

    const result = await validateCatalogAcpProbeSpawn('codex');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ACP validation to fail');
    expect(result.reasonCode).toBe('codex_acp_unavailable');
    expect(result.errorMessage.toLowerCase()).toContain('codex-acp');
  });
});
