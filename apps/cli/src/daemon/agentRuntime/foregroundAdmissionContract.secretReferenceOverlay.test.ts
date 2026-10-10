import { describe, expect, it } from 'vitest';

import { ForegroundAgentRuntimeAdmissionRequestV1Schema } from './foregroundAdmissionContract';

function admissionRequest(extra: Record<string, unknown>) {
  return {
    v: 1,
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    foregroundPid: 4242,
    directory: '/work/repo',
    agentId: 'claude',
    backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
    ...extra,
  };
}

const withProfile = {
  profileId: 'shared-profile',
  accountSettingsScopeKey: 'scope-1',
  accountSettingsVersion: 7,
};

describe('foreground admission secretReferenceOverlay compatibility', () => {
  it('carries the selected destination Profile revision independently of Settings revision', () => {
    const parsed = ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse(admissionRequest({
      ...withProfile,
      profileRecordRevision: 12,
    }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && Reflect.get(parsed.data, 'profileRecordRevision')).toBe(12);
    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse(admissionRequest({
      profileRecordRevision: 12,
    })).success).toBe(false);
  });

  it('accepts an overlay alongside an exact Profile pin', () => {
    const parsed = ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse(admissionRequest({
      ...withProfile,
      secretReferenceOverlay: {
        v: 1,
        bindings: { ANTHROPIC_API_KEY: { ref: 'happier:shared-secret:v1:res-a', revision: 3 } },
      },
    }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.secretReferenceOverlay?.bindings.ANTHROPIC_API_KEY)
      .toEqual({ ref: 'happier:shared-secret:v1:res-a', revision: 3 });
  });

  it('preserves the incumbent request shape when no overlay is sent', () => {
    const parsed = ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse(
      admissionRequest(withProfile),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.secretReferenceOverlay).toBeUndefined();
  });

  it('rejects an overlay with no selected Profile to override', () => {
    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse(admissionRequest({
      secretReferenceOverlay: {
        v: 1,
        bindings: { ANTHROPIC_API_KEY: { ref: 'secret-a' } },
      },
    })).success).toBe(false);
  });

  it('rejects a plaintext secret carrier anywhere in the overlay', () => {
    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse(admissionRequest({
      ...withProfile,
      secretReferenceOverlay: {
        v: 1,
        bindings: { ANTHROPIC_API_KEY: { ref: 'secret-a', value: 'sk-live-123' } },
      },
    })).success).toBe(false);
  });

  it('is strict, so a predecessor daemon rejects an overlay instead of silently dropping it', () => {
    // The released admission request has no `secretReferenceOverlay` key. A
    // strict schema turns "daemon does not understand this field" into a
    // refusal, never a launch with different credentials than the caller chose.
    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse(admissionRequest({
      ...withProfile,
      someFutureLaunchField: { v: 1 },
    })).success).toBe(false);
  });
});
