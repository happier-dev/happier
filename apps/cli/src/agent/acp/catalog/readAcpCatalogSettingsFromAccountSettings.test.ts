import { describe, expect, it } from 'vitest';

import { readAcpCatalogSettingsFromAccountSettings } from './readAcpCatalogSettingsFromAccountSettings';

describe('readAcpCatalogSettingsFromAccountSettings', () => {
  it('returns empty settings when missing', () => {
    const out = readAcpCatalogSettingsFromAccountSettings({});
    expect(out).toEqual({
      v: 2,
      backends: [],
    });
  });

  it('parses settings when present', () => {
    const out = readAcpCatalogSettingsFromAccountSettings({
      acpCatalogSettingsV1: {
        v: 2,
        backends: [
          {
            id: 'custom-kiro',
            name: 'custom-kiro',
            title: 'Custom Kiro',
            command: 'kiro-cli',
            args: ['acp'],
            env: {},
            transportProfile: 'kiro',
            capabilities: {
              supportsLoadSession: true,
              supportsModes: 'yes',
              supportsModels: 'yes',
              supportsConfigOptions: 'unknown',
              promptImageSupport: 'yes',
            },
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    });

    expect(out.backends[0]?.id).toBe('custom-kiro');
    expect(out.backends[0]?.transportProfile).toBe('kiro');
  });
});
