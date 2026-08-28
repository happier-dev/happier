import { describe, expect, it } from 'vitest';

import {
  listConfiguredAcpBackendsFromAccountSettings,
  resolveConfiguredAcpBackendFromAccountSettings,
} from './resolveBackend';

describe('resolveConfiguredAcpBackendFromAccountSettings', () => {
  it('returns null when the backend is missing', () => {
    const out = resolveConfiguredAcpBackendFromAccountSettings({}, 'missing');
    expect(out).toBeNull();
  });

  it('lists only account-configured ACP backends', async () => {
    await expect(listConfiguredAcpBackendsFromAccountSettings({ settings: {} })).resolves.toEqual([]);
  });

  it('returns backend launch configuration when present', () => {
    const out = resolveConfiguredAcpBackendFromAccountSettings({
      acpCatalogSettingsV1: {
        v: 2,
        backends: [
          {
            id: 'backend-1',
            name: 'backend-1',
            title: 'Backend 1',
            command: 'kiro-cli',
            args: ['acp', '--agent', 'spec'],
            env: {
              REGION: { t: 'literal', v: 'eu' },
              EXTRA: { t: 'literal', v: '1' },
            },
            auth: {
              support: 'login_terminal',
              machineLoginKey: 'kiro-cli',
              loginCommand: { command: 'kiro-cli', args: ['login'] },
              statusCommand: ['whoami', '--format', 'json'],
              parser: 'kiroWhoamiJson',
            },
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
    }, 'backend-1');

    expect(out).toMatchObject({
      backendId: 'backend-1',
      title: 'Backend 1',
      command: 'kiro-cli',
      args: ['acp', '--agent', 'spec'],
    });
    expect(out?.env).toEqual({
      REGION: { t: 'literal', v: 'eu' },
      EXTRA: { t: 'literal', v: '1' },
    });
    expect(out?.auth).not.toHaveProperty('parser');
    expect(out).not.toHaveProperty('transportProfile');
    expect(out?.capabilities.supportsLoadSession).toBe(true);
  });
});
