import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/providerSpecs';

describe('providers: codex ACP spawn fallback', () => {
  it('enables explicit npx fallback for codex ACP provider runs', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const codex = providers.find((provider) => provider.id === 'codex');

    expect(codex).toBeTruthy();
    expect(codex?.cli?.env?.HAPPIER_CODEX_ACP_ALLOW_NPX).toBe('1');
  });
});
