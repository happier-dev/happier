import { describe, expect, it } from 'vitest';

import { AcpCatalogSettingsV1Schema } from './settingsV1.js';

describe('AcpCatalogSettingsV1Schema', () => {
  it('accepts provider-owned auth parser and transport profile ids', () => {
    const result = AcpCatalogSettingsV1Schema.safeParse({
      v: 2,
      backends: [
        {
          id: 'custom-vendor',
          name: 'custom-vendor',
          title: 'Custom Vendor',
          command: 'vendor-cli',
          args: ['acp'],
          env: {
            VENDOR_REGION: { t: 'literal', v: 'eu' },
          },
          auth: {
            support: 'login_terminal',
            machineLoginKey: 'vendor-cli',
            loginCommand: { command: 'vendor-cli', args: ['login'] },
            statusCommand: ['whoami', '--format', 'json'],
            parser: 'vendorWhoamiJson',
          },
          transportProfile: 'vendor-profile',
          defaultMode: 'default',
          defaultModel: 'vendor-pro',
          capabilities: {
            supportsLoadSession: true,
            supportsModes: 'yes',
            supportsModels: 'yes',
            promptImageSupport: 'yes',
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('defaults empty input to an empty v2 catalog', () => {
    const parsed = AcpCatalogSettingsV1Schema.parse({});
    expect(parsed).toEqual({
      v: 2,
      backends: [],
    });
  });

  it('rejects duplicate backend ids', () => {
    const result = AcpCatalogSettingsV1Schema.safeParse({
      v: 2,
      backends: [
        {
          id: 'dup',
          name: 'dup',
          title: 'One',
          command: 'agent-a',
          args: [],
          env: {},
          transportProfile: 'generic',
          capabilities: {
            supportsLoadSession: false,
            supportsModes: 'no',
            supportsModels: 'no',
            promptImageSupport: 'no',
          },
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 'dup',
          name: 'dup-two',
          title: 'Two',
          command: 'agent-b',
          args: [],
          env: {},
          transportProfile: 'generic',
          capabilities: {
            supportsLoadSession: false,
            supportsModes: 'no',
            supportsModels: 'no',
            promptImageSupport: 'no',
          },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate backend names', () => {
    const result = AcpCatalogSettingsV1Schema.safeParse({
      v: 2,
      backends: [
        {
          id: 'backend',
          name: 'backend',
          title: 'Backend',
          command: 'agent',
          args: [],
          env: {},
          transportProfile: 'generic',
          capabilities: {
            supportsLoadSession: false,
            supportsModes: 'no',
            supportsModels: 'no',
            promptImageSupport: 'no',
          },
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 'backend-two',
          name: 'backend',
          title: 'Backend Two',
          command: 'agent-two',
          args: [],
          env: {},
          transportProfile: 'generic',
          capabilities: {
            supportsLoadSession: false,
            supportsModes: 'no',
            supportsModels: 'no',
            promptImageSupport: 'no',
          },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects legacy preset-based catalogs', () => {
    const result = AcpCatalogSettingsV1Schema.safeParse({
      v: 1,
      backends: [],
      presets: [],
    });

    expect(result.success).toBe(false);
  });
});
