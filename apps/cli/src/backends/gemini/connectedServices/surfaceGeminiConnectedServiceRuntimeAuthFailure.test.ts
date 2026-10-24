import { sanitizeConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import { buildUsageLimitIssueFingerprint, type SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { beforeEach, describe, expect, it } from 'vitest';

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRuntimeAuthRecoveryScheduledResult } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoveryProjection';
import { resetConnectedServiceRuntimeAuthFailureReportDedupeForTests } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { computeConnectedServiceAccessTokenFingerprint } from '@/daemon/connectedServices/refresh/credentialFreshness/tokenFingerprint';

import {
  classifyGeminiConnectedServiceRuntimeAuthFailure,
  surfaceGeminiConnectedServiceRuntimeAuthFailure,
  type GeminiRuntimeAuthFailureSessionClient,
} from './surfaceGeminiConnectedServiceRuntimeAuthFailure';

const GEMINI_GROUP_SELECTION_ENV: NodeJS.ProcessEnv = {
  HAPPIER_GEMINI_CONNECTED_SERVICE_PROVIDER_ACCOUNT_ID: 'google-account-1',
  HAPPIER_GEMINI_CONNECTED_SERVICE_PROVIDER_EMAIL: 'user@example.com',
  HAPPIER_GEMINI_CONNECTED_SERVICE_CREDENTIAL_FINGERPRINT:
    computeConnectedServiceAccessTokenFingerprint('gemini-access-token'),
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
    {
      kind: 'group',
      serviceId: 'gemini',
      groupId: 'gemini-main',
      activeProfileId: 'leeroy',
      fallbackProfileId: 'backup',
      generation: 2,
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    },
  ]),
};

beforeEach(() => {
  resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
});

function buildSessionClient(): GeminiRuntimeAuthFailureSessionClient & {
  events: unknown[];
  metadataUpdates: number;
} {
  const events: unknown[] = [];
  const client = {
    sessionId: 'happier-session-1',
    events,
    metadataUpdates: 0,
    sendSessionEvent(event: unknown) {
      events.push(event);
    },
    updateMetadata() {
      client.metadataUpdates += 1;
    },
  };
  return client as typeof client & GeminiRuntimeAuthFailureSessionClient;
}

describe('classifyGeminiConnectedServiceRuntimeAuthFailure', () => {
  it('classifies RESOURCE_EXHAUSTED provider errors as usage_limit against the selected group', () => {
    const classification = classifyGeminiConnectedServiceRuntimeAuthFailure({
      error: {
        source: 'gemini_stderr',
        message: '{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}',
      },
      env: GEMINI_GROUP_SELECTION_ENV,
    });

    expect(classification).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      serviceId: 'gemini',
      profileId: 'leeroy',
      groupId: 'gemini-main',
      groupGeneration: 2,
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      sourceProviderAccountId: 'google-account-1',
      sourceAccountLabel: 'user@example.com',
      failingAccessTokenFingerprint: computeConnectedServiceAccessTokenFingerprint('gemini-access-token'),
    });
  });

  it('classifies plain 429 rate-limit provider errors as rate_limit', () => {
    const classification = classifyGeminiConnectedServiceRuntimeAuthFailure({
      error: {
        source: 'gemini_stderr',
        status: 429,
        message: 'GaxiosError: request failed with status 429: rate limit',
      },
      env: GEMINI_GROUP_SELECTION_ENV,
    });

    expect(classification).toMatchObject({
      kind: 'rate_limit',
      limitCategory: 'rate_limit',
      serviceId: 'gemini',
      profileId: 'leeroy',
      groupId: 'gemini-main',
    });
  });

  it('classifies authentication failures as auth_expired/auth_invalid', () => {
    const classification = classifyGeminiConnectedServiceRuntimeAuthFailure({
      error: {
        status: 401,
        message: 'Authentication required. Login required to continue.',
      },
      env: GEMINI_GROUP_SELECTION_ENV,
    });

    expect(classification).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'gemini',
      profileId: 'leeroy',
      groupId: 'gemini-main',
    });
  });

  it('returns null when the session has no gemini connected-service selection', () => {
    const classification = classifyGeminiConnectedServiceRuntimeAuthFailure({
      error: { status: 429, message: 'RESOURCE_EXHAUSTED' },
      env: {},
    });

    expect(classification).toBeNull();
  });

  it('returns null for unclassifiable provider errors', () => {
    const classification = classifyGeminiConnectedServiceRuntimeAuthFailure({
      error: { message: 'something completely unrelated happened' },
      env: GEMINI_GROUP_SELECTION_ENV,
    });

    expect(classification).toBeNull();
  });
});

describe('surfaceGeminiConnectedServiceRuntimeAuthFailure', () => {
  it('reports each accepted terminal quota occurrence without waiting for durable failure publication', async () => {
    const reportOutboxDir = await mkdtemp(join(tmpdir(), 'gemini-failure-occurrences-'));
    let releaseWrite: () => void = () => {};
    const writePending = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const acceptedIssues: SessionRuntimeIssueV1[] = [];
    const lifecycle = createSessionTurnLifecycle({ sessionId: 'gemini-occurrences', enqueueSessionTurn: async (mutation) => {
      if (mutation.action === 'fail' && mutation.issue) { acceptedIssues.push(mutation.issue); await writePending; }
    } });
    const session = { ...buildSessionClient(), sessionTurnLifecycle: lifecycle };
    const classification = classifyGeminiConnectedServiceRuntimeAuthFailure({
      error: { status: 429, message: 'RESOURCE_EXHAUSTED' }, env: GEMINI_GROUP_SELECTION_ENV });
    if (!classification) throw new Error('Expected quota classification');
    const fingerprints: Array<string | null | undefined> = [];
    try {
      for (let turn = 0; turn < 2; turn += 1) {
        await lifecycle.beginTurn({ provider: 'gemini' });
        for (let observer = 0; observer < 2; observer += 1) await surfaceGeminiConnectedServiceRuntimeAuthFailure({ session, classification, failedTurn: {},
          reportOutboxDir, notify: async (body) => {
            fingerprints.push(sanitizeConnectedServiceRuntimeFailureClassification(body.classification)?.runtimeIssueFingerprint);
            return { ok: true, result: { status: 'recovery_superseded', reason: 'source_tuple_mismatch', serviceId: 'gemini' } };
          } });
      }
      expect(fingerprints).toEqual(acceptedIssues.map((issue) => buildUsageLimitIssueFingerprint(issue)));
      expect(fingerprints).toHaveLength(2);
      expect(fingerprints[0]).not.toBe(fingerprints[1]);
    } finally { releaseWrite(); }
  });

  it('projects the truthful interrupted-turn status when the exact source tuple was superseded', async () => {
    const reportOutboxDir = await mkdtemp(join(tmpdir(), 'gemini-runtime-auth-report-'));
    const session = buildSessionClient();
    const classification = classifyGeminiConnectedServiceRuntimeAuthFailure({
      error: {
        source: 'gemini_stderr',
        message: 'RESOURCE_EXHAUSTED: quota exceeded for model gemini-3-pro',
      },
      env: GEMINI_GROUP_SELECTION_ENV,
    });
    expect(classification).not.toBeNull();

    const report = await surfaceGeminiConnectedServiceRuntimeAuthFailure({
      session,
      classification: classification!,
      reportOutboxDir,
      notify: async () => ({
        ok: true,
        result: {
          status: 'recovery_superseded',
          reason: 'source_tuple_mismatch',
          serviceId: 'gemini',
          groupId: 'gemini-main',
          profileId: 'leeroy',
        },
      }),
    });

    expect(report).toMatchObject({
      handled: true,
      statusCode: 'recovery_superseded_source_tuple_mismatch',
      statusMessage: 'Connected-service account already updated; the old turn was interrupted.',
    });
    expect(session.events).toEqual([{
      type: 'message',
      message: 'Connected-service account already updated; the old turn was interrupted.',
    }]);
    expect(session.metadataUpdates).toBe(0);
  });

  it('reports the structured classification to the daemon and leaves typed transcript projection to the daemon', async () => {
    const reportOutboxDir = await mkdtemp(join(tmpdir(), 'gemini-runtime-auth-report-'));
    const session = buildSessionClient();
    const classification = classifyGeminiConnectedServiceRuntimeAuthFailure({
      error: {
        source: 'gemini_stderr',
        message: 'RESOURCE_EXHAUSTED: quota exceeded for model gemini-3-pro',
      },
      env: GEMINI_GROUP_SELECTION_ENV,
    });
    expect(classification).not.toBeNull();

    const notified: unknown[] = [];
    const report = await surfaceGeminiConnectedServiceRuntimeAuthFailure({
      session,
      classification: classification!,
      reportOutboxDir,
      notify: async (body) => {
        notified.push(body);
        return {
          ok: true,
          result: buildRuntimeAuthRecoveryScheduledResult({
            classification: classification!,
            recovery: { status: 'scheduled', nextRetryAtMs: 1_234_567, attemptCount: 1 },
          }),
        };
      },
    });

    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      sessionId: 'happier-session-1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'gemini',
        profileId: 'leeroy',
        groupId: 'gemini-main',
      },
    });
    expect(report.handled).toBe(true);
    expect(session.events).toEqual([]);
    expect(session.metadataUpdates).toBe(0);
  });

  it('does not provider-emit duplicate daemon-handled recovery transcript projections', async () => {
    const reportOutboxDir = await mkdtemp(join(tmpdir(), 'gemini-runtime-auth-report-'));
    const session = buildSessionClient();
    const classification = classifyGeminiConnectedServiceRuntimeAuthFailure({
      error: { source: 'gemini_stderr', message: 'RESOURCE_EXHAUSTED' },
      env: GEMINI_GROUP_SELECTION_ENV,
    });
    expect(classification).not.toBeNull();

    const notify = async () => ({
      ok: true,
      result: buildRuntimeAuthRecoveryScheduledResult({
        classification: classification!,
        recovery: { status: 'scheduled', nextRetryAtMs: 1_234_567, attemptCount: 1 },
      }),
    });

    await surfaceGeminiConnectedServiceRuntimeAuthFailure({
      session,
      classification: classification!,
      reportOutboxDir,
      notify,
    });
    await surfaceGeminiConnectedServiceRuntimeAuthFailure({
      session,
      classification: classification!,
      reportOutboxDir,
      notify,
    });

    expect(session.events).toEqual([]);
    expect(session.metadataUpdates).toBe(0);
  });
});
