import { describe, expect, it } from 'vitest';

import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from './buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

const classification: ConnectedServiceRuntimeFailureClassification = {
  kind: 'usage_limit',
  serviceId: 'openai-codex',
  profileId: 'leeroy',
  groupId: 'happier',
  resetsAtMs: null,
  retryAfterMs: 60_000,
  limitCategory: 'usage_limit',
  quotaScope: 'account',
  providerLimitId: 'weekly',
  planType: 'plus',
  rateLimits: null,
  source: 'structured_provider_error',
};

describe('buildConnectedServiceRuntimeAuthSwitchAttemptLogContext', () => {
  it('flattens reactive observed-generation switch attempts into structured telemetry', () => {
    expect(buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
      sessionId: 'sess_1',
      classification,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'observed_generation',
          activeProfileId: 'codex1',
          generation: 57,
        },
      },
      routedThroughFsm: true,
      startedAtMs: 100,
      finishedAtMs: 175,
    })).toMatchObject({
      trigger: 'runtime_auth_failure',
      decision: 'reactive_runtime_auth_switch',
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'happier',
      reportedProfileId: 'leeroy',
      targetProfileId: 'codex1',
      resultStatus: 'observed_generation',
      generation: 57,
      routedThroughFsm: true,
      latencyMs: 75,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      providerLimitId: 'weekly',
    });
  });

  it('summarizes local continuity diagnostics without exposing paths or provider resume ids', () => {
    const context = buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
      sessionId: 'sess_1',
      classification,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: 'codex1',
          generation: 58,
          errorCode: 'provider_session_state_unavailable_for_resume',
          diagnostics: {
            failurePhase: 'continuity',
            continuity: {
              materializationIdentityId: 'csm_pi_shared',
              targetMaterializedRoot: '/tmp/materialized/csm_pi_shared/pi',
              vendorResumeId: 'pi-session-1',
              candidatePersistedSessionFile: '/tmp/native/pi-session-1.jsonl',
              requestedStateMode: 'shared',
              effectiveStateMode: 'shared',
              reachabilityMissReason: 'pi_session_file_not_found',
            },
          },
        },
      },
      routedThroughFsm: true,
      startedAtMs: 100,
      finishedAtMs: 125,
    });
    expect(context).toMatchObject({
      resultStatus: 'generation_apply_failed',
      failurePhase: 'continuity',
      errorCode: 'provider_session_state_unavailable_for_resume',
      materializationIdentityId: 'csm_pi_shared',
      targetMaterializedRoot: 'present',
      vendorResumeId: 'present',
      candidatePersistedSessionFile: 'present',
      requestedStateMode: 'shared',
      effectiveStateMode: 'shared',
      reachabilityMissReason: 'pi_session_file_not_found',
    });
    expect(JSON.stringify(context)).not.toContain('/tmp/materialized');
    expect(JSON.stringify(context)).not.toContain('/tmp/native');
    expect(JSON.stringify(context)).not.toContain('pi-session-1');
  });

  it('surfaces sanitized post-switch verification evidence in structured telemetry', () => {
    expect(buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
      sessionId: 'sess_1',
      classification,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'switched',
          activeProfileId: 'codex1',
          generation: 58,
          verificationByServiceId: {
            'openai-codex': {
              status: 'weakly_verified',
              reason: 'provider_account_email_verified_without_account_id',
            },
          },
        },
      },
      routedThroughFsm: true,
      startedAtMs: 100,
      finishedAtMs: 125,
    })).toMatchObject({
      resultStatus: 'switched',
      targetProfileId: 'codex1',
      generation: 58,
      verificationStatus: 'weakly_verified',
      verificationReason: 'provider_account_email_verified_without_account_id',
    });
  });

  it('surfaces sanitized candidate decision evidence for no-eligible-member switch attempts', () => {
    const context = buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
      sessionId: 'sess_1',
      classification,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'no_eligible_member',
          generation: 58,
          groupExhausted: true,
          retryAtMs: 1_700_000_200_000,
          excluded: [
            {
              profileId: 'backup',
              reason: 'quota_exhausted',
              retryAtMs: 1_700_000_200_000,
              accountLabel: 'backup@example.test',
              accessToken: 'secret-backup-token',
            },
            {
              profileId: 'reauth',
              reason: 'auth_invalid',
              credentialPayload: { refreshToken: 'secret-refresh-token' },
            },
          ],
          diagnostics: {
            decisionTrace: {
              activeProfileId: 'primary',
              reason: 'no_eligible_members',
              accountLabel: 'primary@example.test',
              candidates: [
                {
                  profileId: 'backup',
                  decision: 'excluded',
                  exclusionReason: 'quota_exhausted',
                  retryAtMs: 1_700_000_200_000,
                  quotaEvidence: {
                    status: 'fresh',
                    remainingPercent: 0,
                    capturedAtMs: 1_700_000_100_000,
                    exhausted: true,
                  },
                  accessToken: 'secret-backup-token',
                },
                {
                  profileId: 'reauth',
                  decision: 'excluded',
                  exclusionReason: 'auth_invalid',
                  quotaEvidence: {
                    status: 'stale_or_missing',
                  },
                  sourceAccountLabel: 'reauth@example.test',
                },
              ],
            },
          },
        },
      },
      routedThroughFsm: true,
      startedAtMs: 100,
      finishedAtMs: 140,
    });

    expect(context).toMatchObject({
      resultStatus: 'no_eligible_member',
      failurePhase: 'selection',
      excludedSummary: [
        {
          profileId: 'backup',
          reason: 'quota_exhausted',
          retryAtMs: 1_700_000_200_000,
        },
        {
          profileId: 'reauth',
          reason: 'auth_invalid',
          retryAtMs: null,
        },
      ],
      decisionTraceSummary: {
        activeProfileId: 'primary',
        reason: 'no_eligible_members',
        candidates: [
          {
            profileId: 'backup',
            decision: 'excluded',
            exclusionReason: 'quota_exhausted',
            retryAtMs: 1_700_000_200_000,
            quotaEvidence: {
              status: 'fresh',
              remainingPercent: 0,
              capturedAtMs: 1_700_000_100_000,
              exhausted: true,
            },
          },
          {
            profileId: 'reauth',
            decision: 'excluded',
            exclusionReason: 'auth_invalid',
            retryAtMs: null,
            quotaEvidence: {
              status: 'stale_or_missing',
              remainingPercent: null,
              capturedAtMs: null,
              exhausted: null,
            },
          },
        ],
      },
    });
    const raw = JSON.stringify(context);
    expect(raw).not.toContain('backup@example.test');
    expect(raw).not.toContain('primary@example.test');
    expect(raw).not.toContain('reauth@example.test');
    expect(raw).not.toContain('secret-backup-token');
    expect(raw).not.toContain('secret-refresh-token');
  });

  it.each([
    ['provider_session_state_unavailable_for_resume', 'continuity'],
    ['connected_service_materialization_identity_missing', 'continuity'],
    ['resume_reachability_inputs_missing', 'continuity'],
    ['metadata_update_failed', 'metadata_persist'],
    ['hot_apply_failed', 'apply'],
  ])('maps generation apply error %s to failure phase %s', (errorCode, failurePhase) => {
    expect(buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
      sessionId: 'sess_1',
      classification,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: 'codex1',
          generation: 58,
          errorCode,
        },
      },
      routedThroughFsm: true,
      startedAtMs: 100,
      finishedAtMs: 125,
    })).toMatchObject({
      resultStatus: 'generation_apply_failed',
      failurePhase,
      errorCode,
    });
  });
});
