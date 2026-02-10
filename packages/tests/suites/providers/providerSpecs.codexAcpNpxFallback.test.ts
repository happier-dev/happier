import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';

describe('providers: codex ACP spawn fallback', () => {
  it('enables explicit npx fallback for codex ACP provider runs', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const codex = providers.find((provider) => provider.id === 'codex');

    expect(codex).toBeTruthy();
    // Codex ACP uses the npx fallback when the optional `codex-acp` capability is not installed.
    // We keep this enabled by default for E2E provider runs to avoid local machine setup friction.
    expect(codex?.cli?.env?.HAPPIER_CODEX_ACP_NPX_MODE).toBe('auto');
  });
});
