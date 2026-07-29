import { describe, expect, it } from 'vitest';

import { QualifiedConnectedAccountRefSchema } from './qualifiedConnectedAccountPersistence.js';

describe('qualified connected-account identity', () => {
  it('retains the exact qualified service and account id', () => {
    expect(QualifiedConnectedAccountRefSchema.parse({
      service: { pluginId: 'acme.accounts', localId: 'git/hosting' },
      accountId: 'team/primary',
    })).toEqual({
      service: { pluginId: 'acme.accounts', localId: 'git/hosting' },
      accountId: 'team/primary',
    });
  });

  it('rejects extra authority and hostile accessor-bearing identity objects', () => {
    expect(QualifiedConnectedAccountRefSchema.safeParse({
      service: { pluginId: 'acme.accounts', localId: 'git' },
      accountId: 'work',
      serviceId: 'github',
    }).success).toBe(false);

    let reads = 0;
    const service = Object.defineProperty({ localId: 'git' }, 'pluginId', {
      enumerable: true,
      get() {
        reads += 1;
        return 'acme.accounts';
      },
    });
    expect(QualifiedConnectedAccountRefSchema.safeParse({
      service,
      accountId: 'work',
    }).success).toBe(false);
    expect(reads).toBe(0);
  });
});
