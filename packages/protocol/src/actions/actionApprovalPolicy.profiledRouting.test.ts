import { describe, expect, it } from 'vitest';

import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1, setScopedActionApprovalPreference } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import type { BoundApprovalProfileV1 } from './approvalProfiles.js';

const actionId = 'deployments.deploy';
const spec = getActionSpec(actionId);
const profile: BoundApprovalProfileV1 = {
  profile: { id: 'picked-profile', name: 'Picked profile', approvalWaivedSurfaces: { [actionId]: ['agent'] } },
  resolution: { status: 'available', requestedId: 'picked-profile' },
};
const context = { surface: 'agent' as const, authority: 'account_automation' as const,
  approvalProfileId: 'picked-profile', approvalProfile: profile };

describe('profile and admitted target inputs at the approval router', () => {
  it('accepts a picked profile waiver but keeps the same inherited profile tighten-only', () => {
    const settings = normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } });
    expect(resolveActionApprovalRouting({ actionId, spec, settings, context })).toMatchObject({
      required: false, profile: { status: 'available', requestedId: 'picked-profile' },
    });
    expect(resolveActionApprovalRouting({ actionId, spec, settings,
      context: { ...context, approvalProfileTeamOrGroupDerived: true } })).toMatchObject({ required: true });
    expect(resolveActionApprovalRouting({ actionId, spec, settings,
      context: { ...context, approvalProfile: { profile: null,
        resolution: { status: 'missing', requestedId: 'picked-profile' } } } })).toMatchObject({
      required: true, profile: { status: 'missing', requestedId: 'picked-profile' },
    });
  });

  it('applies an admitted database Ask after a permissive profile', () => {
    const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } });
    expect(resolveActionApprovalRouting({ actionId, spec, settings, context,
      targetApproval: { databaseAgentLevel: 'readWriteAsk' } })).toMatchObject({ required: true });
  });

  it('applies the database Ask floor to every delegated requester the access decider admits as an agent (SEC-1117 M1)', () => {
    // A teammate's API token or Workflow carries account_automation authority on a non-agent surface.
    for (const surface of ['api', 'rpc', 'plugin', 'cli'] as const) {
      const allow = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
      const caller = { surface, authority: 'account_automation' as const };
      expect(resolveActionApprovalRouting({ actionId, spec, settings: allow, context: caller,
        targetApproval: { databaseAgentLevel: 'readWriteAsk' } }), surface).toMatchObject({ required: true });
      // The present person themself is not bound by the agent level.
      expect(resolveActionApprovalRouting({ actionId, spec, settings: allow, context: { surface, authority: 'present_user' },
        targetApproval: { databaseAgentLevel: 'readWriteAsk' } }), `${surface} person`).toMatchObject({ required: false });
    }
  });

  it('reviews accepting the same inherited profile in full even when the child start is waived', () => {
    const spawnId = 'session.spawn_new';
    const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [spawnId]: ['agent'] } });
    const args = { actionId: spawnId, spec: getActionSpec(spawnId), settings,
      input: { approvalProfileId: context.approvalProfileId } } as const;
    expect(resolveActionApprovalRouting({ ...args,
      context: { ...context, approvalProfileTeamOrGroupDerived: true } })).toMatchObject({ required: true });
    expect(resolveActionApprovalRouting({ ...args, context })).toMatchObject({ required: false });
  });

  it('uses the profile control for a project default change through its revisioned Source leaf', () => {
    const sourceId = 'projects.sources.update';
    const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [sourceId]: ['agent'] } });
    const route = (defaults: unknown) => resolveActionApprovalRouting({ actionId: sourceId,
      spec: getActionSpec(sourceId), settings, context: { ...context, approvalProfileTeamOrGroupDerived: true },
      input: { patch: { sessionDefaults: { expectedRevision: 'absent', defaults } } } });
    expect(route({ approvalProfileId: 'different-profile' })).toMatchObject({ required: true });
    expect(route(null)).toMatchObject({ required: true });
    expect(route({ approvalProfileId: context.approvalProfileId })).toMatchObject({ required: false });
    expect(route({})).toMatchObject({ required: false });
  });

  it('allows an admitted no-approval target to waive the default but preserves the person\'s scoped Ask', () => {
    const settings = normalizeActionsSettingsV1({ v: 1 });
    const approvalScope = { kind: 'environment' as const, environmentId: 'preview', inheritedEnvironmentId: 'template' };
    const targetApproval = { databaseAgentLevel: 'readWriteNoApproval' as const };
    expect(resolveActionApprovalRouting({ actionId, spec, settings, approvalScope,
      context: { surface: 'agent' }, targetApproval })).toMatchObject({ required: false });
    const ownAsk = setScopedActionApprovalPreference({ settings, actionId, surface: 'agent', mode: 'required',
      scope: { kind: 'environment', environmentId: 'template' } });
    expect(resolveActionApprovalRouting({ actionId, spec, settings: ownAsk, approvalScope,
      context: { surface: 'agent' }, targetApproval })).toMatchObject({ required: true });
  });
});
