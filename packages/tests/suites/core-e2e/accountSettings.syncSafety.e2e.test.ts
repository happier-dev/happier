import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  AccountSettingsV2GetResponseSchema,
  AccountSettingsV2UpdateResponseSchema,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountSettingsStoredContentEnvelope,
} from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });
const accountSettingsSecret = new Uint8Array(32).fill(17);

type JsonRecord = Record<string, unknown>;

function sealSettings(payload: JsonRecord, fill: number): AccountSettingsStoredContentEnvelope {
  return {
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: accountSettingsSecret },
      payload,
      randomBytes: (length) => new Uint8Array(length).fill(fill),
    }),
  };
}

function openSettings(content: AccountSettingsStoredContentEnvelope | null): JsonRecord {
  if (!content || content.t !== 'encrypted') {
    throw new Error('Expected encrypted account settings content');
  }
  const opened = openAccountScopedBlobCiphertext({
    kind: 'account_settings',
    material: { type: 'legacy', secret: accountSettingsSecret },
    ciphertext: content.c,
  });
  if (!opened?.value || typeof opened.value !== 'object' || Array.isArray(opened.value)) {
    throw new Error('Expected readable encrypted account settings object');
  }
  return opened.value as JsonRecord;
}

async function fetchSettings(baseUrl: string, token: string) {
  const response = await fetchJson<unknown>(`${baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 20_000,
  });
  expect(response.status).toBe(200);
  return AccountSettingsV2GetResponseSchema.parse(response.data);
}

async function postSettings(params: Readonly<{
  baseUrl: string;
  token: string;
  expectedVersion: number;
  content: AccountSettingsStoredContentEnvelope;
}>) {
  const response = await fetchJson<unknown>(`${params.baseUrl}/v2/account/settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: params.expectedVersion,
      content: params.content,
    }),
    timeoutMs: 20_000,
  });
  expect(response.status).toBe(200);
  return AccountSettingsV2UpdateResponseSchema.parse(response.data);
}

describe('core e2e: account settings sync safety', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('converges sparse pending writes through v2 CAS without dropping unrelated raw fields', async () => {
    const testDir = run.testDir(`account-settings-sync-safety-${randomUUID()}`);
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const initial = await fetchSettings(server.baseUrl, auth.token);
    const seedRaw = {
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-preserved',
      unknownFutureKey: { preserved: true },
      scmIncludeCoAuthoredBy: false,
    };
    const seedWrite = await postSettings({
      baseUrl: server.baseUrl,
      token: auth.token,
      expectedVersion: initial.version,
      content: sealSettings(seedRaw, 1),
    });
    expect(seedWrite).toMatchObject({ success: true, version: initial.version + 1 });

    const firstWriterBaseline = await fetchSettings(server.baseUrl, auth.token);
    const firstWriterRaw = openSettings(firstWriterBaseline.content);
    expect(firstWriterRaw.usageLimitRecoverySettingsV1).toBe('malformed-but-preserved');

    const secondWriterRaw = {
      ...firstWriterRaw,
      otherClientSparseField: 'from-second-writer',
    };
    const secondWrite = await postSettings({
      baseUrl: server.baseUrl,
      token: auth.token,
      expectedVersion: firstWriterBaseline.version,
      content: sealSettings(secondWriterRaw, 2),
    });
    expect(secondWrite).toMatchObject({ success: true, version: firstWriterBaseline.version + 1 });

    const staleFirstWriterRaw = {
      ...firstWriterRaw,
      scmIncludeCoAuthoredBy: true,
    };
    const staleWrite = await postSettings({
      baseUrl: server.baseUrl,
      token: auth.token,
      expectedVersion: firstWriterBaseline.version,
      content: sealSettings(staleFirstWriterRaw, 3),
    });
    expect(staleWrite.success).toBe(false);
    if (staleWrite.success) throw new Error('Expected version mismatch');
    expect(staleWrite.error).toBe('version-mismatch');
    expect(staleWrite.currentVersion).toBe(firstWriterBaseline.version + 1);

    const retryBaseRaw = openSettings(staleWrite.currentContent);
    const retryWrite = await postSettings({
      baseUrl: server.baseUrl,
      token: auth.token,
      expectedVersion: staleWrite.currentVersion,
      content: sealSettings({
        ...retryBaseRaw,
        scmIncludeCoAuthoredBy: true,
      }, 4),
    });
    expect(retryWrite).toMatchObject({ success: true, version: staleWrite.currentVersion + 1 });

    const final = await fetchSettings(server.baseUrl, auth.token);
    expect(final.version).toBe(staleWrite.currentVersion + 1);
    expect(openSettings(final.content)).toEqual({
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-preserved',
      unknownFutureKey: { preserved: true },
      scmIncludeCoAuthoredBy: true,
      otherClientSparseField: 'from-second-writer',
    });
  }, 240_000);
});
