import { describe, expect, it } from 'vitest';

import { normalizeActionsSettingsV1, setScopedActionApprovalPreference } from './actionSettings.js';
import { readActionAudiencePolicy, setActionAudiencePolicy } from './actionAudiencePolicy.js';
import { applyApprovalProfileOverlayV1, resolveProfiledActionsSettingsV1, type ApprovalProfileV1 } from './approvalProfiles.js';
import { readExplicitActionApprovalPreferenceV1 } from './actionApprovalPolicy.js';

const actionId = 'session.stop';
const modes = ['off', 'ask_first', 'allowed'] as const;

describe('approval profile application mode', () => {
  it('uses the host-bound profile and reports a revoked catalog row as missing', () => {
    const account = setActionAudiencePolicy(normalizeActionsSettingsV1({ v: 1 }), actionId, 'agent', 'ask_first');
    const profile: ApprovalProfileV1 = { id: 'bound-profile', name: 'Picked profile',
      approvalWaivedSurfaces: { [actionId]: ['agent'] } };
    const available = resolveProfiledActionsSettingsV1(account, profile.id, { boundProfile: {
      profile, resolution: { status: 'available', requestedId: profile.id },
    } });
    expect(readActionAudiencePolicy(available.settings, actionId, 'agent').mode).toBe('allowed');
    const missing = resolveProfiledActionsSettingsV1(account, profile.id, { boundProfile: {
      profile: null, resolution: { status: 'missing', requestedId: profile.id },
    } });
    expect(readActionAudiencePolicy(missing.settings, actionId, 'agent').mode).toBe('ask_first');
    expect(missing.profile).toEqual({ status: 'missing', requestedId: profile.id });
  });
  for (const mergeMode of ['full', 'tighten-only'] as const) {
    for (const own of modes) {
      for (const shared of modes) {
        it(`${mergeMode}: Account ${own}, profile ${shared}`, () => {
          const account = setActionAudiencePolicy(normalizeActionsSettingsV1({ v: 1 }), actionId, 'agent', own);
          const profile: ApprovalProfileV1 = {
            id: 'profile', name: 'Shared profile',
            actions: { [actionId]: {
              disabledSurfaces: shared === 'off' ? ['agent'] : [],
              approvalRequiredSurfaces: shared === 'ask_first' ? ['agent'] : [],
            } },
            ...(shared === 'allowed' ? { approvalWaivedSurfaces: { [actionId]: ['agent'] } } : {}),
          };
          const applied = applyApprovalProfileOverlayV1(account, profile, mergeMode);
          const expected = mergeMode === 'full' ? shared : modes[Math.min(modes.indexOf(own), modes.indexOf(shared))];
          expect(readActionAudiencePolicy(applied, actionId, 'agent').mode).toBe(expected);
        });
      }
    }
  }

  it('retains Account disablement, neighbouring surfaces and placements when defaults only tighten', () => {
    const account = normalizeActionsSettingsV1({ v: 1, actions: {
      [actionId]: { enabled: false, disabledSurfaces: ['mcp'], approvalRequiredSurfaces: ['ui'],
        disabledPlacements: ['session_header'] },
    } });
    const applied = applyApprovalProfileOverlayV1(account, { id: 'profile', name: 'Shared',
      actions: { [actionId]: { enabled: true } }, approvalWaivedSurfaces: { [actionId]: ['ui', 'mcp'] },
    }, 'tighten-only');
    expect(applied.actions[actionId]).toMatchObject({ enabled: false, disabledSurfaces: ['mcp'],
      approvalRequiredSurfaces: ['ui'], disabledPlacements: ['session_header'] });
    expect(applied.approvalWaivedSurfaces?.[actionId]).toBeUndefined();
  });

  for (const mergeMode of ['full', 'tighten-only'] as const) {
    for (const own of modes) {
      for (const shared of modes) {
        for (const databaseAgentLevel of ['readWriteAsk', 'readWriteNoApproval'] as const) {
          it(`${mergeMode}: Account ${own}, profile ${shared}, target ${databaseAgentLevel}`, () => {
            const account = setActionAudiencePolicy(normalizeActionsSettingsV1({ v: 1 }), actionId, 'agent', own);
            const profile: ApprovalProfileV1 = { id: 'target-profile', name: 'Target profile',
              actions: { [actionId]: { disabledSurfaces: shared === 'off' ? ['agent'] : [],
                approvalRequiredSurfaces: shared === 'ask_first' ? ['agent'] : [] } },
              ...(shared === 'allowed' ? { approvalWaivedSurfaces: { [actionId]: ['agent'] } } : {}) };
            const applied = resolveProfiledActionsSettingsV1(account, profile.id, {
              boundProfile: { profile, resolution: { status: 'available', requestedId: profile.id } },
              approvalProfileTeamOrGroupDerived: mergeMode === 'tighten-only', context: { surface: 'agent' },
              targetApproval: { actionId, databaseAgentLevel },
            }).settings;
            const expected = own === 'off' || shared === 'off' ? 'off'
              : databaseAgentLevel === 'readWriteAsk' || own === 'ask_first' || shared === 'ask_first' ? 'ask_first' : 'allowed';
            expect(readActionAudiencePolicy(applied, actionId, 'agent').mode).toBe(expected);
          });
        }
      }
    }
  }

  it('uses the admitted target scope and preserves an inherited explicit Ask', () => {
    const scope = { kind: 'environment' as const, environmentId: 'preview', inheritedEnvironmentId: 'template' };
    const account = setScopedActionApprovalPreference({ settings: normalizeActionsSettingsV1({ v: 1 }), actionId,
      scope: { kind: 'environment', environmentId: 'template' }, surface: 'mcp', mode: 'required' });
    const applied = resolveProfiledActionsSettingsV1(account, null, { context: { surface: 'mcp' },
      targetApproval: { actionId, databaseAgentLevel: 'readWriteNoApproval', approvalScope: scope } }).settings;
    expect(readExplicitActionApprovalPreferenceV1(actionId, applied, { surface: 'mcp' }, scope)).toBe(true);
    expect(readExplicitActionApprovalPreferenceV1(actionId, applied, { surface: 'mcp' },
      { kind: 'environment', environmentId: 'other' })).toBeUndefined();
  });

  for (const databaseAgentLevel of ['none', 'read'] as const) {
    it(`does not turn database ${databaseAgentLevel} access into a write approval waiver`, () => {
      const account = setActionAudiencePolicy(normalizeActionsSettingsV1({ v: 1 }), actionId, 'agent', 'ask_first');
      const applied = resolveProfiledActionsSettingsV1(account, null, { context: { surface: 'agent' },
        targetApproval: { actionId, databaseAgentLevel } }).settings;
      expect(applied).toBe(account);
    });
  }

  it('does not apply an agent target preference to a person or another Action', () => {
    const account = setActionAudiencePolicy(normalizeActionsSettingsV1({ v: 1 }), actionId, 'ui', 'ask_first');
    const applied = resolveProfiledActionsSettingsV1(account, null, { context: { surface: 'ui' },
      targetApproval: { actionId, databaseAgentLevel: 'readWriteNoApproval' } }).settings;
    expect(applied).toBe(account);
  });
});
