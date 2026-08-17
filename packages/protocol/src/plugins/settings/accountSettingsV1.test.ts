import { describe, expect, it } from 'vitest';

import {
  assertPluginAccountSettingsContentForModeV1,
  PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1,
  PluginAccountSettingsContentV1Schema,
  PluginAccountSettingsMutationRequestV1Schema,
  PluginAccountSettingsReadResponseV1Schema,
  PluginAccountSettingsValuesV1Schema,
} from './accountSettingsV1.js';
import { sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';

describe('Plugin Account Settings V1', () => {
  it('keeps the Account values record bounded and independent from its row revision', () => {
    expect(PluginAccountSettingsValuesV1Schema.parse({
      v: 1,
      values: {
        theme: 'dark',
        nested: { enabled: true },
      },
    })).toEqual({
      v: 1,
      values: {
        theme: 'dark',
        nested: { enabled: true },
      },
    });

    let tooDeep: unknown = 'leaf';
    for (let depth = 0; depth < 13; depth += 1) tooDeep = { child: tooDeep };
    expect(PluginAccountSettingsValuesV1Schema.safeParse({
      v: 1,
      values: { nested: tooDeep },
    }).success).toBe(false);

    expect(PluginAccountSettingsValuesV1Schema.safeParse({
      v: 1,
      values: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
        `field${index}`,
        index,
      ])),
    }).success).toBe(false);
  });

  it('makes Account mode content and row-CAS outcomes explicit without exposing a raw value in conflicts', () => {
    const content = PluginAccountSettingsContentV1Schema.parse({
      t: 'plain',
      v: { v: 1, values: { theme: 'dark' } },
    });
    expect(PluginAccountSettingsMutationRequestV1Schema.parse({
      expectedRevision: 'absent',
      content,
    })).toEqual({ expectedRevision: 'absent', content });
    expect(PluginAccountSettingsReadResponseV1Schema.parse({
      status: 'present',
      revision: 4,
      content,
    })).toEqual({ status: 'present', revision: 4, content });
    expect(PluginAccountSettingsReadResponseV1Schema.safeParse({
      status: 'conflict',
      revision: 4,
      content,
    }).success).toBe(false);
  });

  it('accepts only the declarative Settings cipher domain for E2EE content', () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(11) };
    const randomBytes = (length: number) => new Uint8Array(length).fill(5);
    const content = { v: 1 as const, values: { theme: 'dark' } };
    const settingsCiphertext = sealAccountScopedBlobCiphertext({
      kind: PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1,
      material,
      payload: content,
      randomBytes,
    });

    expect(assertPluginAccountSettingsContentForModeV1({
      t: 'encrypted',
      c: settingsCiphertext,
    }, 'e2ee')).toEqual({ t: 'encrypted', c: settingsCiphertext });
    expect(assertPluginAccountSettingsContentForModeV1({
      t: 'plain',
      v: content,
    }, 'plain')).toEqual({ t: 'plain', v: content });

    for (const kind of [
      'plugin_account_kv_private_payload',
      'plugin_collection_private_payload',
      'account_settings',
    ] as const) {
      const ciphertext = sealAccountScopedBlobCiphertext({
        kind,
        material,
        payload: content,
        randomBytes,
      });
      expect(() => assertPluginAccountSettingsContentForModeV1({
        t: 'encrypted',
        c: ciphertext,
      }, 'e2ee')).toThrow('Plugin Account Settings content');
    }

    expect(() => assertPluginAccountSettingsContentForModeV1({
      t: 'plain',
      v: content,
    }, 'e2ee')).toThrow('Plugin Account Settings content');
    expect(() => assertPluginAccountSettingsContentForModeV1({
      t: 'encrypted',
      c: settingsCiphertext,
    }, 'plain')).toThrow('Plugin Account Settings content');
  });
});
