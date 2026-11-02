import { describe, expect, it } from 'vitest';

import { buildStableRuntimeAuthFailureReportDedupeKey } from './runtimeAuthFailureReportIdentity';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './sanitizeConnectedServiceRuntimeFailureClassification';

describe('runtimeAuthFailureReportIdentity', () => {
  it('preserves explicitly unknown request identity through report sanitization', () => {
    expect(sanitizeConnectedServiceRuntimeFailureClassification({
      kind: 'usage_limit', source: 'structured_provider_error', serviceId: 'claude-subscription',
      sourceProviderAccountId: null, sourceProviderOrganizationId: null, providerReportedOrganizationId: null,
    })).toMatchObject({ sourceProviderAccountId: null, sourceProviderOrganizationId: null, providerReportedOrganizationId: null });
  });

  const baseClassification = {
    kind: 'auth_expired',
    source: 'structured_provider_error',
    serviceId: 'claude-subscription',
    profileId: 'work',
    groupId: 'pool',
    groupGeneration: 4,
    activeProfileId: 'work',
  } as const;

  function buildKey(failingAccessTokenFingerprint: string | undefined): string | null {
    return buildStableRuntimeAuthFailureReportDedupeKey({
      sessionId: 'sess-1',
      switchesThisTurn: 0,
      resumePromptMode: null,
      classification: {
        ...baseClassification,
        ...(failingAccessTokenFingerprint ? { failingAccessTokenFingerprint } : {}),
      },
    });
  }

  it('distinguishes reports for DIFFERENT failing access tokens (CLOSE-19 ingress dedupe)', () => {
    // A newly rotated token failing with an otherwise identical classification must NOT be
    // suppressed by the 15s report dedupe window: the scheduler's fingerprint-aware recovery can
    // only act on reports that reach it. Same classification + different failing token
    // fingerprint => different dedupe identity.
    const first = buildKey('sha256:aaaa1111');
    const second = buildKey('sha256:bbbb2222');
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('keeps the SAME key for repeated reports of the same failing token', () => {
    const first = buildKey('sha256:aaaa1111');
    const repeat = buildKey('sha256:aaaa1111');
    expect(first).toBeTruthy();
    expect(repeat).toBe(first);
  });

  it('distinguishes otherwise-identical reports from different credential revisions', () => {
    const buildRevisionKey = (credentialRevision: string) => buildStableRuntimeAuthFailureReportDedupeKey({
      sessionId: 'sess-1',
      switchesThisTurn: 0,
      resumePromptMode: null,
      classification: { ...baseClassification, credentialRevision },
    });

    expect(buildRevisionKey('csr_aaaaaaaaaaaaaaaaaaaaaa')).not.toBe(
      buildRevisionKey('csr_bbbbbbbbbbbbbbbbbbbbbb'),
    );
  });
});
