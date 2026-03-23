import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import {
  accountSettingsParse,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountSettingsStoredContentEnvelope,
  type AccountSettingsV2UpdateResponse,
} from '@happier-dev/protocol';

import { updateAccountSettingsV2WithRetry } from './updateAccountSettingsV2WithRetry';

type LegacyCredentialsStub = Credentials & Readonly<{ encryption: Readonly<{ type: 'legacy'; secret: Uint8Array }> }>;

function createLegacyCredentialsStub(): LegacyCredentialsStub {
  return {
    token: 't',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

function mutableConfigurationForTest(): {
  serverUrl: string;
  apiServerUrl: string;
  publicServerUrl: string;
  webappUrl: string;
} {
  return configuration as unknown as {
    serverUrl: string;
    apiServerUrl: string;
    publicServerUrl: string;
    webappUrl: string;
  };
}

describe('updateAccountSettingsV2WithRetry', () => {
  const originalServerUrl = configuration.serverUrl;
  const originalApiServerUrl = configuration.apiServerUrl;
  const originalPublicServerUrl = configuration.publicServerUrl;
  const originalWebappUrl = configuration.webappUrl;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(mutableConfigurationForTest(), {
      serverUrl: originalServerUrl,
      apiServerUrl: originalApiServerUrl,
      publicServerUrl: originalPublicServerUrl,
      webappUrl: originalWebappUrl,
    });
  });

  it('updates plain v2 content and posts plain content back', async () => {
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutate: (settings: Readonly<Record<string, unknown>>) => ({
        ...settings,
        mcpServersSettingsV1: { v: 1, strictMode: false, servers: [], bindings: [] },
      }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2 }) },
          version: 5,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 6 };
        },
      },
    });

    expect(result.version).toBe(6);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.expectedVersion).toBe(5);
    expect(calls[0]?.content?.t).toBe('plain');
    expect((calls[0]?.content as any)?.v?.mcpServersSettingsV1).toEqual({ v: 1, strictMode: false, servers: [], bindings: [] });
  });

  it('decrypts encrypted v2 content, applies mutation, and posts encrypted content back', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = { ...accountSettingsParse({ schemaVersion: 2 }), someKey: 'before' };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: initial,
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings: Readonly<Record<string, unknown>>) => ({ ...settings, someKey: 'after' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 11 };
        },
        randomBytes: () => new Uint8Array(24).fill(2),
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.expectedVersion).toBe(10);
    expect(calls[0]?.content?.t).toBe('encrypted');

    const postedCiphertext = (calls[0]?.content as any)?.c ?? '';
    const opened = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: postedCiphertext,
    });
    expect(opened?.value).toMatchObject({ someKey: 'after' });
  });

  it('retries when the server reports a version mismatch', async () => {
    const credentials = createLegacyCredentialsStub();
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];
    let attempt = 0;

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings: Readonly<Record<string, unknown>>) => ({ ...settings, hello: 'world' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2 }) },
          version: 1,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          attempt += 1;
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          if (attempt === 1) {
            return {
              success: false,
              error: 'version-mismatch',
              currentVersion: 2,
              currentContent: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2, otherKey: 'changed' }) },
            };
          }
          return { success: true, version: 3 };
        },
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.expectedVersion).toBe(1);
    expect(calls[1]?.expectedVersion).toBe(2);
    expect((calls[1]?.content as any)?.v).toMatchObject({ otherKey: 'changed', hello: 'world' });
  });

  it('uses apiServerUrl for fetch and update requests when canonical serverUrl differs', async () => {
    Object.assign(mutableConfigurationForTest(), {
      serverUrl: 'https://public.example.test',
      apiServerUrl: 'http://127.0.0.1:3005',
      publicServerUrl: 'https://public.example.test',
      webappUrl: 'https://public.example.test',
    });

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        version: 5,
        content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 6 }) },
      },
    } as any);
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { success: true, version: 6 },
    } as any);

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutate: (settings) => ({ ...settings, hello: 'world' }),
    });

    expect(result.version).toBe(6);
    expect(getSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3005/v2/account/settings',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
    expect(postSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3005/v2/account/settings',
      expect.objectContaining({
        content: { t: 'plain', v: expect.objectContaining({ hello: 'world' }) },
        expectedVersion: 5,
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
  });
});
