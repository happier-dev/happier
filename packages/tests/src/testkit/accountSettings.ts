import { randomBytes } from 'node:crypto';

import {
  AccountSettingsV2UpdateResponseSchema,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';

import { fetchJson } from './http';

type AccountSettingsV2GetResponse = Readonly<{
  content?: Readonly<{ t: 'plain'; v: unknown }> | Readonly<{ t: 'encrypted'; c: string }> | null;
  version?: unknown;
}>;

async function writePlainAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
  settings: unknown;
  expectedVersion: number;
}>): Promise<number> {
  const postRes = await fetchJson<unknown>(`${params.baseUrl}/v2/account/settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: params.expectedVersion,
      content: { t: 'plain', v: params.settings },
    }),
    timeoutMs: 20_000,
  });

  if (postRes.status !== 200) {
    throw new Error(`Failed to update plain account settings (status=${postRes.status})`);
  }
  const parsed = AccountSettingsV2UpdateResponseSchema.safeParse(postRes.data);
  if (!parsed.success) {
    throw new Error('Failed to parse plain account settings update response');
  }
  if (!parsed.data.success) {
    throw new Error(
      `Failed to update plain account settings due to version mismatch (expected=${params.expectedVersion}, current=${parsed.data.currentVersion})`,
    );
  }
  return parsed.data.version;
}

export async function upsertPlainAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
  settings: unknown;
  expectedVersion?: number;
}>): Promise<number> {
  const getRes = await fetchJson<AccountSettingsV2GetResponse>(`${params.baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (getRes.status !== 200 || typeof getRes.data?.version !== 'number') {
    throw new Error(`Failed to fetch current account settings version (status=${getRes.status})`);
  }
  if (getRes.data.content?.t === 'encrypted') {
    throw new Error('Cannot write plain account settings over encrypted account settings');
  }

  const expectedVersion = params.expectedVersion ?? getRes.data.version;
  return writePlainAccountSettingsV2({
    baseUrl: params.baseUrl,
    token: params.token,
    settings: params.settings,
    expectedVersion,
  });
}

export async function patchPlainAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
  settingsPatch: Readonly<Record<string, unknown>>;
}>): Promise<number> {
  const getRes = await fetchJson<AccountSettingsV2GetResponse>(`${params.baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (getRes.status !== 200 || typeof getRes.data?.version !== 'number') {
    throw new Error(`Failed to fetch current account settings version (status=${getRes.status})`);
  }
  if (getRes.data.content?.t === 'encrypted') {
    throw new Error('Cannot patch plain account settings over encrypted account settings');
  }

  const currentSettings = getRes.data.content?.t === 'plain'
    && typeof getRes.data.content.v === 'object'
    && getRes.data.content.v !== null
    && !Array.isArray(getRes.data.content.v)
    ? getRes.data.content.v as Record<string, unknown>
    : {};
  return writePlainAccountSettingsV2({
    baseUrl: params.baseUrl,
    token: params.token,
    expectedVersion: getRes.data.version,
    settings: {
      ...currentSettings,
      ...params.settingsPatch,
    },
  });
}

export async function upsertEncryptedAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
  secret: Uint8Array;
  settings: unknown;
}>): Promise<void> {
  const getRes = await fetchJson<any>(`${params.baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (getRes.status !== 200 || typeof getRes.data?.version !== 'number') {
    throw new Error(`Failed to fetch current account settings version (status=${getRes.status})`);
  }

  const postRes = await fetchJson<any>(`${params.baseUrl}/v2/account/settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: getRes.data.version,
      content: {
        t: 'encrypted',
        c: sealAccountScopedBlobCiphertext({
          kind: 'account_settings',
          material: { type: 'legacy', secret: params.secret },
          payload: params.settings,
          randomBytes: (length) => Uint8Array.from(randomBytes(length)),
        }),
      },
    }),
    timeoutMs: 20_000,
  });

  if (postRes.status !== 200 || postRes.data?.success !== true) {
    throw new Error(`Failed to update encrypted account settings (status=${postRes.status})`);
  }
}
