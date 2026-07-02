import { describe, expect, it } from 'vitest';

import {
  ProviderAccountUsageSnapshotV1Schema,
  buildProviderAccountUsageRecordId,
} from '@happier-dev/protocol';

import { resolveCodexUsageSubjectRef } from './identity.js';

type CodexUsageSnapshotModule = typeof import('./snapshot.js');

async function loadSnapshotModule(): Promise<CodexUsageSnapshotModule | null> {
  return await import('./snapshot.js').catch(() => null);
}

describe('mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot', () => {
  it('maps native app-server rate limits to a canonical provider account usage snapshot', async () => {
    const moduleRecord = await loadSnapshotModule();
    expect(moduleRecord).toEqual(expect.objectContaining({
      mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot: expect.any(Function),
    }));
    if (!moduleRecord) throw new Error('snapshot module missing');

    const subject = resolveCodexUsageSubjectRef({
      authStoreProviderAccountIdProof: {
        status: 'resolved',
        accountId: 'chatgpt-account-1',
      },
    });

    const snapshot = moduleRecord.mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject,
      rawSnapshot: {
        rateLimits: {
          planType: 'team',
          account: { email: 'alice@example.com' },
          primary: { usedPercent: 25, resetsAt: 1_768_010_000 },
        },
      },
      observedAtMs: 1_768_000_000_000,
      fetchedAtMs: 1_768_000_000_000,
      aliases: [{ kind: 'appServerNative', sessionId: 'session-a' }],
    });

    const parsed = ProviderAccountUsageSnapshotV1Schema.parse(snapshot);
    expect(parsed).toMatchObject({
      v: 1,
      providerId: 'openai-codex',
      source: 'runtimeSignal',
      confidence: 'confirmed',
      state: 'loaded_data',
      accountSubject: {
        kind: 'providerSubject',
        id: 'chatgpt-account-1',
      },
      planLabel: 'team',
      accountLabel: 'alice@example.com',
      aliases: [{
        kind: 'appServerNative',
        providerId: 'openai-codex',
        sessionId: 'session-a',
        accountSubjectId: 'chatgpt-account-1',
      }],
      meters: [expect.objectContaining({
        meterId: 'primary',
        utilizationPct: 25,
        resetsAt: 1_768_010_000_000,
      })],
    });
    expect(parsed.recordId).toBe(buildProviderAccountUsageRecordId(parsed.recordKey));
  });

  it('uses stable chatgpt_account_id evidence instead of email labels for record identity', async () => {
    const moduleRecord = await loadSnapshotModule();
    expect(moduleRecord).toEqual(expect.objectContaining({
      mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot: expect.any(Function),
    }));
    if (!moduleRecord) throw new Error('snapshot module missing');

    const stableSubject = resolveCodexUsageSubjectRef({
      authStoreProviderAccountIdProof: {
        status: 'resolved',
        accountId: 'chatgpt-account-1',
      },
    });
    const nativeSnapshot = moduleRecord.mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject: stableSubject,
      rawSnapshot: { account: { email: 'native@example.com' }, primary: { usedPercent: 10 } },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
      aliases: [{ kind: 'appServerNative', sessionId: 'session-a' }],
    });
    const connectedSnapshot = moduleRecord.mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject: stableSubject,
      rawSnapshot: { account: { email: 'connected@example.com' }, primary: { usedPercent: 20 } },
      observedAtMs: 2_000,
      fetchedAtMs: 2_000,
      aliases: [{
        kind: 'connectedServiceProfile',
        serviceId: 'openai-codex',
        profileId: 'work',
      }],
    });

    expect(nativeSnapshot.recordId).toBe(connectedSnapshot.recordId);

    const firstProvisional = moduleRecord.mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject: resolveCodexUsageSubjectRef({
        accountLabel: 'same@example.com',
        provisionalDiscriminator: 'native-home-a',
      }),
      rawSnapshot: { account: { email: 'same@example.com' }, primary: { usedPercent: 10 } },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
      aliases: [{ kind: 'appServerNative', sessionId: 'session-a' }],
    });
    const secondProvisional = moduleRecord.mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject: resolveCodexUsageSubjectRef({
        accountLabel: 'same@example.com',
        provisionalDiscriminator: 'native-home-b',
      }),
      rawSnapshot: { account: { email: 'same@example.com' }, primary: { usedPercent: 10 } },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
      aliases: [{ kind: 'appServerNative', sessionId: 'session-b' }],
    });

    expect(firstProvisional.recordId).not.toBe(secondProvisional.recordId);
  });

  it('uses a trusted account-label fallback for native snapshots whose rate-limit payload has no email', async () => {
    const moduleRecord = await loadSnapshotModule();
    expect(moduleRecord).toEqual(expect.objectContaining({
      mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot: expect.any(Function),
    }));
    if (!moduleRecord) throw new Error('snapshot module missing');

    const subject = resolveCodexUsageSubjectRef({
      authStoreProviderAccountIdProof: {
        status: 'resolved',
        accountId: 'chatgpt-account-1',
        accountEmail: 'codex-user@example.test',
      },
    });

    const snapshot = moduleRecord.mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
      subject,
      rawSnapshot: { primary: { usedPercent: 10 } },
      accountLabel: 'codex-user@example.test',
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
      aliases: [{ kind: 'appServerNative', sessionId: 'session-a' }],
    });

    expect(snapshot).toMatchObject({
      accountSubject: {
        kind: 'providerSubject',
        id: 'chatgpt-account-1',
      },
      accountLabel: 'codex-user@example.test',
    });
  });
});
