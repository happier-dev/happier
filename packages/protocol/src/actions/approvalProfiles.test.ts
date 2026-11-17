import { describe, expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import {
  applyApprovalProfileOverlayV1,
  ApprovalProfileV1Schema,
  resolveProfiledActionsSettingsV1,
  resolveSessionApprovalProfileReferenceV1,
} from './approvalProfiles.js';
import { bindApprovalProfileV1 } from './approvalProfileArtifactV1.js';

describe('approval profile overlay', () => {
  const account = normalizeActionsSettingsV1({
    v: 1,
    actions: {
      'deployments.deploy': {
        approvalRequiredSurfaces: ['agent'],
        disabledPlacements: ['session_header'],
      },
      'session.list': { disabledSurfaces: ['mcp'] },
    },
    approvalWaivedSurfaces: { 'session.stop': ['agent'] },
  });
  const careful = ApprovalProfileV1Schema.parse({
        id: 'careful',
        name: 'Careful agent',
        actions: {
          'deployments.deploy': { approvalRequiredSurfaces: [] },
          'session.stop': { approvalRequiredSurfaces: ['agent'] },
          'review.start': { disabledSurfaces: ['agent'] },
        },
        approvalWaivedSurfaces: { 'deployments.deploy': ['agent'] },
  });
  const rows = [{ id: careful.id, profile: careful, access: 'owner' as const,
    revision: { headerVersion: 1, bodyVersion: 1 } }];

  it("replaces only the profile Actions' policy rows and keeps Account placements", () => {
    const merged = applyApprovalProfileOverlayV1(account, careful);
    expect(merged.actions['deployments.deploy']).toMatchObject({
      approvalRequiredSurfaces: [],
      disabledSurfaces: [],
      disabledPlacements: ['session_header'],
    });
    expect(merged.approvalWaivedSurfaces?.['deployments.deploy']).toEqual([
      'agent',
    ]);
    // A profile row without a waiver list drops the Account waiver for that Action.
    expect(merged.actions['session.stop']?.approvalRequiredSurfaces).toEqual([
      'agent',
    ]);
    expect(merged.approvalWaivedSurfaces?.['session.stop']).toBeUndefined();
    expect(merged.actions['review.start']?.disabledSurfaces).toEqual(['agent']);
    // Actions the profile does not name keep the Account row untouched.
    expect(merged.actions['session.list']).toBe(
      account.actions['session.list'],
    );
  });

  it('stores only policy fields on a profile row', () => {
    expect(ApprovalProfileV1Schema.safeParse({
          id: 'p',
          name: 'P',
          actions: {
            'session.list': {
              enabled: false,
              enabledPlacements: ['agent_input_chips'],
              toolExposureModes: { agent: 'direct' },
            },
          },
    }).success).toBe(false);
  });

  it('settles a deleted or legacy built-in reference as missing, never a stricter or looser built-in', () => {
    for (const id of [
      'deleted',
      'builtin:full-trust',
      'builtin:read-propose',
    ]) {
      expect(bindApprovalProfileV1(rows, id)).toEqual({
        profile: null,
        resolution: { status: 'missing', requestedId: id },
      });
    }
    expect(bindApprovalProfileV1(rows, 'careful')).toEqual({
      profile: careful,
      resolution: { status: 'available', requestedId: 'careful' },
    });
  });

  it('settles a stored pre-overlay profile as missing instead of an available empty overlay', () => {
    expect(ApprovalProfileV1Schema.safeParse({ id: 'strict', name: 'Strict', defaultMode: 'require',
      categories: { danger: 'require' } }).success).toBe(false);
    expect(bindApprovalProfileV1(rows, 'strict')).toEqual({
      profile: null,
      resolution: { status: 'missing', requestedId: 'strict' },
    });
    expect(resolveProfiledActionsSettingsV1(account, 'strict')).toEqual({
      settings: account,
      profile: { status: 'missing', requestedId: 'strict' },
    });
  });

  it('uses only the stored Session choice, including an explicit null or a missing choice', () => {
    const stored = { approvalProfileId: 'other', machineId: 'machine-a' };
    const cleared = { approvalProfileId: null, machineId: 'machine-a' };
    const missing = { approvalProfileId: undefined, machineId: 'machine-a' };
    expect(resolveSessionApprovalProfileReferenceV1(stored)).toBe('other');
    expect(resolveSessionApprovalProfileReferenceV1(cleared)).toBeNull();
    expect(resolveSessionApprovalProfileReferenceV1(missing)).toBeNull();
    expect(resolveSessionApprovalProfileReferenceV1({})).toBeNull();
  });

  it('round-trips the per-Account Machine defaults and drops malformed rows', () => {
    expect(
      normalizeActionsSettingsV1({
        v: 1,
        machineApprovalProfiles: { m: 'careful' },
      }).machineApprovalProfiles,
    ).toEqual({ m: 'careful' });
    expect(
      normalizeActionsSettingsV1({ v: 1, machineApprovalProfiles: { m: 4 } })
        .machineApprovalProfiles,
    ).toBeUndefined();
  });
});
