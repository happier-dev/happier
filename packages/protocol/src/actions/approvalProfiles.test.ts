import { describe, expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import {
  applyApprovalProfileOverlayV1,
  readApprovalProfileV1,
  resolveSessionApprovalProfileReferenceV1,
} from './approvalProfiles.js';

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
    approvalProfiles: [
      {
        id: 'careful',
        name: 'Careful agent',
        actions: {
          'deployments.deploy': { approvalRequiredSurfaces: [] },
          'session.stop': { approvalRequiredSurfaces: ['agent'] },
          'review.start': { disabledSurfaces: ['agent'] },
        },
        approvalWaivedSurfaces: { 'deployments.deploy': ['agent'] },
      },
    ],
  });
  const careful = account.approvalProfiles![0]!;

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
    expect(merged.approvalProfiles).toBe(account.approvalProfiles);
  });

  it('stores only policy fields on a profile row', () => {
    const settings = normalizeActionsSettingsV1({
      v: 1,
      approvalProfiles: [
        {
          id: 'p',
          name: 'P',
          actions: {
            'session.list': {
              enabled: false,
              enabledPlacements: ['agent_input_chips'],
              toolExposureModes: { agent: 'direct' },
            },
          },
        },
      ],
    });
    expect(settings.approvalProfiles?.[0]?.actions?.['session.list']).toEqual({
      enabled: false,
    });
  });

  it('settles a deleted or legacy built-in reference as missing, never a stricter or looser built-in', () => {
    for (const id of [
      'deleted',
      'builtin:full-trust',
      'builtin:read-propose',
    ]) {
      expect(readApprovalProfileV1(account, id)).toEqual({
        profile: null,
        resolution: { status: 'missing', requestedId: id },
      });
    }
    expect(readApprovalProfileV1(account, 'careful')).toEqual({
      profile: careful,
      resolution: { status: 'available', requestedId: 'careful' },
    });
  });

  it('resolves Session explicit > Machine default > Account settings', () => {
    const settings = normalizeActionsSettingsV1({
      ...account,
      machineApprovalProfiles: { 'machine-a': 'careful' },
    });
    expect(
      resolveSessionApprovalProfileReferenceV1(
        { approvalProfileId: 'other', machineId: 'machine-a' },
        settings,
      ),
    ).toBe('other');
    expect(
      resolveSessionApprovalProfileReferenceV1(
        { approvalProfileId: null, machineId: 'machine-a' },
        settings,
      ),
    ).toBe('careful');
    expect(
      resolveSessionApprovalProfileReferenceV1(
        { machineId: 'machine-a' },
        settings,
      ),
    ).toBe('careful');
    expect(
      resolveSessionApprovalProfileReferenceV1(
        { machineId: 'machine-b' },
        settings,
      ),
    ).toBeNull();
    expect(resolveSessionApprovalProfileReferenceV1({}, settings)).toBeNull();
    expect(
      resolveSessionApprovalProfileReferenceV1(
        { machineId: 'machine-a' },
        null,
      ),
    ).toBeNull();
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
