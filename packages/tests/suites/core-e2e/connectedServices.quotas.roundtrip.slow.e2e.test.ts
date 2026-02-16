import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  ConnectedServiceQuotaSnapshotV1Schema,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: connected services quotas sealed snapshot round-trip', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop().catch(() => {});
  });

  it('stores and returns a sealed quota snapshot without decrypting it', async () => {
    const testDir = run.testDir('connected-services-quotas-roundtrip');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
      },
    });

    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const secret = Uint8Array.from(randomBytes(32));
    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 60_000,
      planLabel: 'Pro',
      accountLabel: 'user@example.test',
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: 82,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        },
      ],
    });

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material: { type: 'legacy', secret },
      payload: snapshot,
      randomBytes,
    });

    const put = await fetchJson<{ success?: boolean }>(`${serverBaseUrl}/v2/connect/openai-codex/profiles/work/quotas`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
      }),
      timeoutMs: 20_000,
    });
    expect(put.status).toBe(200);
    expect(put.data?.success).toBe(true);

    const get = await fetchJson<{
      sealed: { format: 'account_scoped_v1'; ciphertext: string };
      metadata: { fetchedAt: number; staleAfterMs: number; status: string };
    }>(`${serverBaseUrl}/v2/connect/openai-codex/profiles/work/quotas`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      timeoutMs: 20_000,
    });

    expect(get.status).toBe(200);
    expect(get.data?.sealed?.ciphertext).toBe(ciphertext);

    const opened = openAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material: { type: 'legacy', secret },
      ciphertext: get.data!.sealed.ciphertext,
    });
    expect(opened?.value).toEqual(snapshot);
  }, 240_000);
});

