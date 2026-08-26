import { randomBytes } from 'node:crypto';

import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { fetchJson } from './http';

type AccountSettingsV2GetResponse = Readonly<{
  content?: Readonly<{ t: 'plain'; v: unknown }> | Readonly<{ t: 'encrypted'; c: string }> | null;
  version?: unknown;
}>;

export async function upsertPlainAccountSettingsV2(params: Readonly<{
  baseUrl: string;
  token: string;
  settings: unknown;
}>): Promise<void> {
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

  const postRes = await fetchJson<{ success?: unknown }>(`${params.baseUrl}/v2/account/settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: getRes.data.version,
      content: { t: 'plain', v: params.settings },
    }),
    timeoutMs: 20_000,
  });

  if (postRes.status !== 200 || postRes.data?.success !== true) {
    throw new Error(`Failed to update plain account settings (status=${postRes.status})`);
  }
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
