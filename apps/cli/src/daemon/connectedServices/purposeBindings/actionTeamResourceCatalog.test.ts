import { describe, expect, it } from 'vitest';
import { createConnectedAccountActionTeamResourceCatalogReader } from './actionTeamResourceCatalog';

describe('optional Action Team catalog', () => {
  it.each(['teams_unavailable', 'feature_disabled', 'unsupported_action'])('preserves personal discovery when the Home reports %s', async code => {
    const read = createConnectedAccountActionTeamResourceCatalogReader({
      homeDomainAction: async () => ({ ok: false, errorCode: code, error: code }),
    });
    await expect(read(new AbortController().signal)).resolves.toEqual([]);
  });
  it('keeps authorization refusals visible', async () => {
    const read = createConnectedAccountActionTeamResourceCatalogReader({
      homeDomainAction: async () => ({ ok: false, errorCode: 'team_forbidden', error: 'team_forbidden' }),
    });
    await expect(read(new AbortController().signal)).rejects.toBeInstanceOf(Error);
  });
});
