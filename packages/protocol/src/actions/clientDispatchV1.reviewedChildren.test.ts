import { describe, expect, it } from 'vitest';
import { buildUiActionDispatchRequestV1, UiActionDispatchRequestV1Schema } from './clientDispatchV1.js';
import { computeActionInputApprovalDigestV1 } from './decisionAuthority.js';
import { createHostReviewedChildPortV1 } from './executor/deploymentRoleChild.js';

const input = { draftArtifactId: '7e23f798-230a-42f3-931f-e38b20736333', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
  version: '1.0.0', changelog: '', share: { recipients: [], signedInLink: true as const } };
const child = { action: 'artifact.public_link.create' as const, role: 'signed_in_link',
  input: { artifactId: 'released', audience: 'signed_in', preserveExisting: true } };
const facts = { parentActionId: 'template.release' as const,
  parentInputDigest: computeActionInputApprovalDigestV1('template.release', input),
  plan: { children: [child] }, policies: [{ action: child.action, role: child.role, surface: 'agent' as const }],
  reviewAdmitted: true as const };

describe('admitted client reviewed-child continuation', () => {
  it('does not promote caller context into sending-host admission', () => {
    const request = buildUiActionDispatchRequestV1({ actionId: 'template.release', input,
      context: { surface: 'agent', authority: 'account_automation', admittedHostReviewedChildren: facts } });
    expect(request.context.admittedHostReviewedChildren).toBeUndefined();
  });

  it('carries the closed parent admission through JSON and keeps the issuer bound to the selected child', async () => {
    const request = buildUiActionDispatchRequestV1({ actionId: 'template.release', input,
      context: { surface: 'agent', authority: 'account_automation' }, admittedHostReviewedChildren: facts });
    const received = UiActionDispatchRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
    expect(received.context.admittedHostReviewedChildren).toEqual(facts);
    const admitted = received.context.admittedHostReviewedChildren;
    if (!admitted) throw new Error('Missing admitted child facts');
    // The real issuer stays in process. This callback is the final host effect boundary.
    const effects: unknown[] = [];
    const port = createHostReviewedChildPortV1({ actionId: received.actionId, input: received.input,
      context: received.context, plan: admitted.plan, policies: admitted.policies,
      ...(admitted.reviewAdmitted ? { reviewAdmitted: true } : {}),
      execute: async effect => { effects.push(effect); return { ok: true, result: {} }; } });
    expect(await port.invoke({ ...child, input: { ...child.input, artifactId: 'substituted' } }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await port.invoke({ ...child, action: 'artifact.public_link.revoke' }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(effects).toEqual([]);
    expect(await port.invoke(child)).toMatchObject({ ok: true });
    expect(effects).toEqual([child.input]);
  });

  it.each(['parent', 'operand', 'policy'] as const)('refuses a substituted %s before receiver execution', substitution => {
    const context = { surface: 'agent', authority: 'account_automation', admittedHostReviewedChildren: {
      ...facts,
      ...(substitution === 'parent' ? { parentActionId: 'template.preview' } : {}),
      ...(substitution === 'policy' ? { policies: [{ ...facts.policies[0], action: 'artifact.public_link.revoke' }] } : {}),
    } };
    expect(UiActionDispatchRequestV1Schema.safeParse({ v: 1, actionId: 'template.release',
      input: substitution === 'operand' ? { ...input, version: '2.0.0' } : input, context }).success).toBe(false);
  });
});
