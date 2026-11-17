import { describe, expect, it } from 'vitest';

import { ProjectSetupReviewV1Schema } from '@happier-dev/protocol/actions/projectSetupConsentFailure';

import { ForegroundAgentRuntimeAdmissionRequestV1Schema, ForegroundAgentRuntimeAdmissionResponseV1Schema } from './foregroundAdmissionContract';

describe('foreground Project launch refusals', () => {
  it('admits the exact typed Team model source into foreground launch', () => {
    const selection = { v: 2, updatedAt: 42, ref: { source: 'team_resource',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'selected-model', resourceId: 'resource-1',
      teamId: 'team-1', expectedResourceRevision: 4, deliveryMode: 'brokered' } };
    const request = { v: 1, attemptId: 'attempt-1', sessionId: 'session-1', foregroundPid: 123,
      directory: '/workspace', agentId: 'codex', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      selection };
    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.parse(request).selection).toEqual(selection);
  });
  it('retains typed native refusal and canonical setup review without admitting private launch fields', () => {
    const setupReview = ProjectSetupReviewV1Schema.parse({
      reviewedEffectDigest: 'reviewed-setup-effect',
      reviewedEffect: { purpose: 'setup', commands: [], bindings: [] },
    });
    const refused = { ok: false, error: { code: 'project_agent_launch_refused', reason: 'child_required' } };
    expect(ForegroundAgentRuntimeAdmissionResponseV1Schema.parse(refused)).toEqual(refused);
    // readProjectManifest preserves OS boundary codes, including inaccessible files.
    const inaccessible = { ok: false, error: { code: 'project_agent_launch_refused', reason: 'EACCES' } };
    expect(ForegroundAgentRuntimeAdmissionResponseV1Schema.parse(inaccessible)).toEqual(inaccessible);
    const held = { ok: false, error: { code: 'project_agent_launch_refused',
      reason: 'project_setup_consent_required', setupReview } };
    expect(ForegroundAgentRuntimeAdmissionResponseV1Schema.parse(held)).toEqual(held);
    expect(ForegroundAgentRuntimeAdmissionResponseV1Schema.safeParse({ ...held,
      error: { ...held.error, environment: { PRIVATE_BINDING: 'not-a-wire-field' } },
    }).success).toBe(false);
  });
});
