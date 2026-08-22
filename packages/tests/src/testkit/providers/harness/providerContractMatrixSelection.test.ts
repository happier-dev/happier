import { describe, expect, it } from 'vitest';

import { runProviderContractMatrix } from '.';

describe('explicit provider contract matrix selection', () => {
  it('rejects an empty or duplicate requested provider set', async () => {
    await expect(runProviderContractMatrix({ providerIds: [] })).resolves.toEqual({
      ok: false,
      error: 'provider_contract_matrix_requested_providers_empty',
    });
    await expect(runProviderContractMatrix({ providerIds: ['codex', 'codex'] })).resolves.toEqual({
      ok: false,
      error: 'provider_contract_matrix_requested_provider_duplicate:codex',
    });
  });

  it('rejects a requested provider absent from the canonical catalog', async () => {
    await expect(runProviderContractMatrix({
      providerIds: ['not-a-canonical-agent'],
    })).resolves.toEqual({
      ok: false,
      error: 'provider_contract_matrix_requested_provider_missing:not-a-canonical-agent',
    });
  });
});
