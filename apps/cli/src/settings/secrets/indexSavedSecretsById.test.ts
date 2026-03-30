import { describe, expect, it } from 'vitest';

import { indexSavedSecretsByIdFromAccountSettings } from './indexSavedSecretsById';

describe('indexSavedSecretsByIdFromAccountSettings', () => {
  it('returns an empty map when settings are missing or invalid', () => {
    expect(indexSavedSecretsByIdFromAccountSettings(null).size).toBe(0);
    expect(indexSavedSecretsByIdFromAccountSettings({}).size).toBe(0);
    expect(indexSavedSecretsByIdFromAccountSettings({ secrets: null }).size).toBe(0);
    expect(indexSavedSecretsByIdFromAccountSettings({ secrets: {} }).size).toBe(0);
  });

  it('indexes valid secrets and ignores invalid entries', () => {
    const out = indexSavedSecretsByIdFromAccountSettings({
      secrets: [
        null,
        123,
        {},
        { id: '' },
        { id: 's-empty', encryptedValue: {} },
        {
          id: 's-1',
          encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'abc' } },
        },
      ],
    });

    expect(out.size).toBe(1);
    expect(out.get('s-1')).toEqual({ _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'abc' } });
  });
});

