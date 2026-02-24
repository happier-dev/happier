import { describe, expect, it } from 'vitest';

import { DEFAULT_ENCRYPTION_CAPABILITIES, EncryptionCapabilitiesSchema } from './encryptionCapabilities.js';

describe('EncryptionCapabilitiesSchema', () => {
  it('parses defaults when fields are missing', () => {
    const parsed = EncryptionCapabilitiesSchema.parse({
      storagePolicy: 'optional',
      allowAccountOptOut: true,
      defaultAccountMode: 'plain',
    });
    expect(parsed.plainAccountSettingsAtRest).toBe('server_sealed');
    expect(parsed.plainAccountCredentialsAtRest).toBe('server_sealed');
  });

  it('matches DEFAULT_ENCRYPTION_CAPABILITIES shape', () => {
    const parsed = EncryptionCapabilitiesSchema.parse(DEFAULT_ENCRYPTION_CAPABILITIES);
    expect(parsed).toEqual(DEFAULT_ENCRYPTION_CAPABILITIES);
  });
});

