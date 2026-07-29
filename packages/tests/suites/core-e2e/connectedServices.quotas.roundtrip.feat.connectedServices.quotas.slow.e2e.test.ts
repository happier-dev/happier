import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  ProviderAccountUsageSnapshotV1Schema,
  buildProviderAccountUsageRecordId,
  openProviderAccountUsageSnapshotCiphertext,
  sealProviderAccountUsageSnapshotCiphertext,
  type ProviderAccountUsageRecordKeyV1,
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

  it('stores and returns a sealed provider-account usage snapshot without decrypting it', async () => {
    const testDir = run.testDir('provider-account-usage-sealed-roundtrip');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
      },
    });

    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const secret = Uint8Array.from(randomBytes(32));
    const now = Date.now();
    const recordKey = {
      providerId: 'openai-codex',
      accountSubjectId: 'acct-quota-roundtrip',
      subjectKind: 'account',
      quotaScope: 'account',
    } satisfies ProviderAccountUsageRecordKeyV1;
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
      v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey),
      recordKey,
      providerId: recordKey.providerId,
      accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
      observedAtMs: now,
      fetchedAtMs: now,
      staleAfterMs: 60_000,
      source: 'connectedServiceProbe',
      confidence: 'confirmed',
      state: 'loaded_data',
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

    const ciphertext = sealProviderAccountUsageSnapshotCiphertext({
      material: { type: 'legacy', secret },
      payload: snapshot,
      randomBytes,
    });

    const put = await fetchJson<{ success?: boolean; error?: string }>(
      `${serverBaseUrl}/v2/connect/provider-account-usage/${snapshot.recordId}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recordKey,
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
        }),
        timeoutMs: 20_000,
      },
    );
    expect(put.status).toBe(200);
    expect(put.data?.success).toBe(true);

    const get = await fetchJson<{
      sealed: { format: 'account_scoped_v1'; ciphertext: string };
      metadata: { fetchedAt: number; staleAfterMs: number; status: string };
    }>(`${serverBaseUrl}/v2/connect/provider-account-usage/${snapshot.recordId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      timeoutMs: 20_000,
    });

    expect(get.status).toBe(200);
    expect(get.data?.sealed?.ciphertext).toBe(ciphertext);

    const opened = openProviderAccountUsageSnapshotCiphertext({
      material: { type: 'legacy', secret },
      ciphertext: get.data!.sealed.ciphertext,
    });
    expect(opened?.value).toEqual(snapshot);
  }, 240_000);
});
