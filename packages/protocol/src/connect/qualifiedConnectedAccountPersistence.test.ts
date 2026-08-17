import { describe, expect, it } from 'vitest';

import { compilePluginJsonSchema } from '../plugins/actions/jsonSchemaValidation.js';
import * as qualifiedConnectedAccountPersistence from './qualifiedConnectedAccountPersistence.js';

const {
  QualifiedConnectedAccountIdSchema,
  QualifiedConnectedAccountRefJsonSchema,
  QualifiedConnectedAccountRefSchema,
} = qualifiedConnectedAccountPersistence;

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

  it('rejects hostile identity objects before the canonical parser reads accessors', () => {
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
    const parsed = QualifiedConnectedAccountRefSchema.safeParse({
      service,
      accountId: 'work',
    });
    expect(parsed.success).toBe(false);
    expect(reads).toBe(0);
  });

  it('keeps the Account ID boundary at Unicode code points without a callback parser', () => {
    const service = { pluginId: 'acme.accounts', localId: 'git/hosting' };
    const atLimit = '😀'.repeat(256);
    const overLimit = '😀'.repeat(257);

    for (const [accountId, accepted] of [[atLimit, true], [overLimit, false]] as const) {
      expect(QualifiedConnectedAccountIdSchema.safeParse(accountId).success).toBe(accepted);
      expect(QualifiedConnectedAccountRefSchema.safeParse({ service, accountId }).success).toBe(accepted);
    }
  });

  it('projects the same acceptance contract as the canonical Zod owner', () => {
    const validate = compilePluginJsonSchema(QualifiedConnectedAccountRefJsonSchema);
    const service = { pluginId: 'acme.accounts', localId: 'git/hosting' };
    const cases = [
      [{ service, accountId: 'team/primary' }, true],
      [{ service, accountId: ' team/primary' }, false],
      [{ service, accountId: `${'a'.repeat(256)}` }, true],
      [{ service, accountId: `${'a'.repeat(257)}` }, false],
      [{ service, accountId: 'team/primary', extra: true }, false],
    ] as const;

    for (const [value, accepted] of cases) {
      expect(QualifiedConnectedAccountRefSchema.safeParse(value).success).toBe(accepted);
      expect(validate(value), JSON.stringify(value)).toBe(accepted);
    }
  });

});
