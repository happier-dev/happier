import { randomBytes } from 'node:crypto';

import {
  accountSettingsParse,
  AccountSettingsPersistedObjectSchema,
  AccountSettingsV2GetResponseSchema,
  AccountSettingsV2UpdateResponseSchema,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountSettings,
  type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';

import { fetchJson } from './http';

type EncryptedAccountSettingsMaterial =
  | Readonly<{ secret: Uint8Array; material?: never }>
  | Readonly<{ secret?: never; material: AccountScopedCryptoMaterial }>;

export type EncryptedAccountSettingsV2Row = Readonly<{
  settings: AccountSettings;
  settingsVersion: number;
}>;

function resolveAccountSettingsMaterial(params: EncryptedAccountSettingsMaterial): AccountScopedCryptoMaterial {
  return params.material ?? { type: 'legacy', secret: params.secret };
}

async function fetchAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
}>) {
  const response = await fetchJson<unknown>(`${params.baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (response.status !== 200) {
    throw new Error(`Failed to fetch current account settings (status=${response.status})`);
  }
  const parsed = AccountSettingsV2GetResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error('Failed to parse current account settings response');
  }
  return parsed.data;
}

function openEncryptedAccountSettingsV2Row(
  current: Awaited<ReturnType<typeof fetchAccountSettingsV2>>,
  params: EncryptedAccountSettingsMaterial,
): EncryptedAccountSettingsV2Row {
  if (!current.content || current.content.t !== 'encrypted') {
    throw new Error(`Expected encrypted account settings content (received=${current.content?.t ?? 'null'})`);
  }
  const opened = openAccountScopedBlobCiphertext({
    kind: 'account_settings',
    material: resolveAccountSettingsMaterial(params),
    ciphertext: current.content.c,
  });
  const rawSettings = AccountSettingsPersistedObjectSchema.safeParse(opened?.value);
  if (!rawSettings.success) {
    throw new Error('Failed to decrypt encrypted account settings object');
  }
  return {
    settings: accountSettingsParse(rawSettings.data),
    settingsVersion: current.version,
  };
}

export async function readEncryptedAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
}> & EncryptedAccountSettingsMaterial): Promise<EncryptedAccountSettingsV2Row> {
  const current = await fetchAccountSettingsV2(params);
  return openEncryptedAccountSettingsV2Row(current, params);
}

export async function readEncryptedAccountSettingsV2OrEmpty(params: Readonly<{
  baseUrl: string;
  token: string;
}> & EncryptedAccountSettingsMaterial): Promise<EncryptedAccountSettingsV2Row> {
  const current = await fetchAccountSettingsV2(params);
  if (current.content === null) {
    return {
      settings: accountSettingsParse({}),
      settingsVersion: current.version,
    };
  }
  return openEncryptedAccountSettingsV2Row(current, params);
}

export async function upsertEncryptedAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
  settings: unknown;
  expectedVersion?: number;
}> & EncryptedAccountSettingsMaterial): Promise<number> {
  const expectedVersion = params.expectedVersion ?? (await fetchAccountSettingsV2(params)).version;

  const postRes = await fetchJson<unknown>(`${params.baseUrl}/v2/account/settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion,
      content: {
        t: 'encrypted',
        c: sealAccountScopedBlobCiphertext({
          kind: 'account_settings',
          material: resolveAccountSettingsMaterial(params),
          payload: params.settings,
          randomBytes: (length) => Uint8Array.from(randomBytes(length)),
        }),
      },
    }),
    timeoutMs: 20_000,
  });

  if (postRes.status !== 200) {
    throw new Error(`Failed to update encrypted account settings (status=${postRes.status})`);
  }
  const parsed = AccountSettingsV2UpdateResponseSchema.safeParse(postRes.data);
  if (!parsed.success) {
    throw new Error('Failed to parse encrypted account settings update response');
  }
  if (!parsed.data.success) {
    throw new Error(
      `Failed to update encrypted account settings due to version mismatch (expected=${expectedVersion}, current=${parsed.data.currentVersion})`,
    );
  }
  return parsed.data.version;
}
