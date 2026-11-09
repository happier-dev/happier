import { describe, expect, it } from 'vitest';
import { buildAccountIdentitiesChangeV1, buildConnectedServicesAccountChangeV1 } from '@happier-dev/protocol/changes';

import { changesRequireSavedSecretCatalogRefresh } from './savedSecretCatalogChangeInvalidation';

describe('changesRequireSavedSecretCatalogRefresh', () => {
  it.each([
    [{ kind: 'savedSecretResource', entityId: 'resource-a' }],
    [{ kind: 'account', entityId: 'teams' }],
    [{ kind: 'account', entityId: 'self', hint: { accountEncryptionTransitionId: 'transition-a' } }],
    [buildAccountIdentitiesChangeV1()],
    [{ kind: 'account', entityId: 'self', hint: { linkedProviders: true } }],
  ])('refreshes for material or Team/Group authorization changes', (change) => {
    expect(changesRequireSavedSecretCatalogRefresh([change])).toBe(true);
  });

  it('refreshes for service-scoped, broad, and retained connected-service changes', () => {
    const service = { pluginId: 'happier.voice.openai', localId: 'openai' };
    for (const change of [
      buildConnectedServicesAccountChangeV1(service),
      buildConnectedServicesAccountChangeV1(),
      { kind: 'account', entityId: 'self', hint: { connectedServices: true } },
    ]) {
      expect(changesRequireSavedSecretCatalogRefresh([change])).toBe(true);
    }
  });

  it('does not turn an unrelated live change into a material refresh', () => {
    expect(changesRequireSavedSecretCatalogRefresh([
      { kind: 'machine', entityId: 'machine-a' },
    ])).toBe(false);
    expect(changesRequireSavedSecretCatalogRefresh([
      { kind: 'account', entityId: 'self', hint: { settingsVersion: 8 } },
    ])).toBe(false);
  });
});
