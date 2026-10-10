import { describe, expect, it } from 'vitest';

import {
  listConfiguredAcpBackendsFromAccountSettings,
  resolveConfiguredAcpBackendFromAccountSettings,
} from './resolveBackend';
import type { AcpCatalogRecordV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

describe('resolveConfiguredAcpBackendFromAccountSettings', () => {
  it('resolves a destination definition without a settings catalog and refuses unavailable authority', () => {
    const record = { v: 1, definitions: [{
      id: 'row-review', name: 'row-review', title: 'Row review', command: 'review-agent', args: ['acp'],
      env: { REGION: { t: 'literal', v: 'eu' } }, capabilities: {
        supportsLoadSession: true, supportsModes: 'yes', supportsModels: 'unknown',
        supportsConfigOptions: 'unknown', promptImageSupport: 'no',
      }, createdAt: 1, updatedAt: 2,
    }] } satisfies AcpCatalogRecordV1;
    expect(resolveConfiguredAcpBackendFromAccountSettings({}, 'row-review', { status: 'ready', record, revision: 4 }))
      .toMatchObject({ backendId: 'row-review', command: 'review-agent', args: ['acp'], env: { REGION: { t: 'literal', v: 'eu' } } });
    expect(() => resolveConfiguredAcpBackendFromAccountSettings({}, 'row-review', { status: 'unavailable', reason: 'locked' }))
      .toThrow(expect.objectContaining({ code: 'ACP_CATALOG_UNAVAILABLE' }));
    expect(() => resolveConfiguredAcpBackendFromAccountSettings({}, 'row-review', { status: 'loading' }))
      .toThrow(expect.objectContaining({ code: 'ACP_CATALOG_UNAVAILABLE' }));
  });
  it('returns null when the backend is missing', () => {
    const out = resolveConfiguredAcpBackendFromAccountSettings({}, 'missing', { status: 'ready', record: { v: 1, definitions: [] }, revision: 1 });
    expect(out).toBeNull();
  });

  it('lists only account-configured ACP backends', async () => {
    await expect(listConfiguredAcpBackendsFromAccountSettings({ settings: {}, catalogSnapshot: { status: 'ready', record: { v: 1, definitions: [] }, revision: 1 } })).resolves.toEqual([]);
  });

  it('returns backend launch configuration when present', () => {
    const out = resolveConfiguredAcpBackendFromAccountSettings({}, 'backend-1', { status: 'ready', revision: 1,
      record: {
        v: 1,
        definitions: [
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
            },
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
