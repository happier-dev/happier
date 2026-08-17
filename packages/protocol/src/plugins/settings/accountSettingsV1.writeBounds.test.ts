import { describe, expect, it } from 'vitest';

import { getAccountScopedBlobCiphertextBase64LengthV1 } from '../../crypto/accountScopedCipher.js';
import {
  PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1,
  PluginAccountSettingsContentV1Schema,
  PluginAccountSettingsMutationRequestV1Schema,
  PluginAccountSettingsReadResponseV1Schema,
} from './accountSettingsV1.js';

describe('Plugin Account Settings V1 encrypted write bounds', () => {
  it('keeps an oversized predecessor ciphertext readable while rejecting it as a current CAS write', () => {
    const maximumCiphertextBytes = getAccountScopedBlobCiphertextBase64LengthV1(
      PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumRecordEncodedBytes,
    );
    const maximumEnvelope = {
      t: 'encrypted' as const,
      c: 'x'.repeat(maximumCiphertextBytes),
    };
    const oversizedEnvelope = {
      t: 'encrypted' as const,
      c: 'x'.repeat(maximumCiphertextBytes + 1),
    };

    expect(
      PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumEncryptedCiphertextUtf8Bytes,
    ).toBe(maximumCiphertextBytes);
    expect(PluginAccountSettingsContentV1Schema.safeParse(maximumEnvelope).success).toBe(true);
    expect(PluginAccountSettingsMutationRequestV1Schema.safeParse({
      expectedRevision: 'absent',
      content: maximumEnvelope,
    }).success).toBe(true);

    // Reader compatibility remains broad so an old oversized E2EE record can
    // be inspected/recovered. Current writers must not reproduce it.
    expect(PluginAccountSettingsContentV1Schema.safeParse(oversizedEnvelope).success).toBe(true);
    expect(PluginAccountSettingsReadResponseV1Schema.safeParse({
      status: 'present',
      revision: 7,
      content: oversizedEnvelope,
    }).success).toBe(true);
    expect(PluginAccountSettingsMutationRequestV1Schema.safeParse({
      expectedRevision: 'absent',
      content: oversizedEnvelope,
    }).success).toBe(false);
  });
});
