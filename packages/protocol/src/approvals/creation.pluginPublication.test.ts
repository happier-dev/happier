import { describe, expect, it } from 'vitest';
import { computeActionInputApprovalDigestV1 } from '../actions/decisionAuthority.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from './approvalRequestV1.js';
import { createApprovalRequestArtifact, deriveApprovalRequestArtifactId } from './creation.js';

function proposal(generation: number): ApprovalRequestV2 {
  const actionArgs = { discussionId: 'discussion', localId: 'obligation', content: { v: 1, parts: [{ t: 'text', text: 'Original message' }] } };
  return ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: generation, updatedAtMs: generation,
    createdBy: { surface: 'system', pluginId: 'happier.channels', contributionLocalId: 'router' },
    requestedSurface: 'plugin', actionId: 'discussion.post', actionArgs, summary: 'Publish inbound message',
    requestInputDigest: computeActionInputApprovalDigestV1('discussion.post', actionArgs),
    approval: { flow: 'blocking', result: 'required' },
    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'plugin', serverId: 'profile',
      serverIdentityId: 'home', accountId: 'account', machineId: 'machine', actionId: 'discussion.post', requestId: `correlation-${generation}`,
      caller: { kind: 'plugin', pluginId: 'happier.channels', contributionLocalId: 'router',
        sourceCustody: { kind: 'managed', immutableGenerationId: `generation-${generation}`, installSource: 'localPath' } } },
  });
}

describe('plugin publication canonical approval subject', () => {
  it('rejoins the exact original consent despite new correlation and executable custody', async () => {
    const rows = new Map<string, { header: Record<string, unknown>; body: string; access: string }>();
    let writes = 0;
    const create = (request: ApprovalRequestV2) => createApprovalRequestArtifact({ request, accountId: 'account',
      newId: () => { throw new Error('A publication has canonical identity'); },
      read: async id => rows.get(id) ?? null,
      create: async (id, header, body) => { writes++; rows.set(id, { header, body, access: 'owner' }); },
    });
    const original = await create(proposal(1));
    const successor = proposal(2);
    successor.executionOriginV1.serverId = 'another-profile-for-the-same-home';
    expect(await create(successor)).toEqual(original);
    expect(writes).toBe(1);
    expect(rows.size).toBe(1);
  });

  it.each(['accountId', 'machineId', 'serverIdentityId'] as const)('isolates another %s', field => {
    const original = proposal(1);
    const other = { ...proposal(1), executionOriginV1: { ...proposal(1).executionOriginV1, [field]: 'other' } };
    expect(deriveApprovalRequestArtifactId(other)).not.toBe(deriveApprovalRequestArtifactId(original));
  });

  it.each(['pluginId', 'contributionLocalId'] as const)('isolates another %s', field => {
    const original = proposal(1);
    const next = proposal(1);
    const value = field === 'pluginId' ? 'other.plugin' : 'other';
    const other = ApprovalRequestV2Schema.parse({ ...next, createdBy: { ...next.createdBy, [field]: value }, executionOriginV1: { ...next.executionOriginV1,
      caller: { ...next.executionOriginV1.caller, [field]: value } } });
    expect(deriveApprovalRequestArtifactId(other)).not.toBe(deriveApprovalRequestArtifactId(original));
  });

  it('asks again for changed canonical input under the same localId', async () => {
    const request = proposal(1);
    const rows = new Map<string, { header: Record<string, unknown>; body: string; access: string }>();
    const ports = { accountId: 'account', newId: () => 'unused', read: async (id: string) => rows.get(id) ?? null,
      create: async (id: string, header: Record<string, unknown>, body: string) => { rows.set(id, { header, body, access: 'owner' }); } };
    const original = await createApprovalRequestArtifact({ ...ports, request });
    const next = proposal(2);
    const actionArgs = { ...request.actionArgs as Record<string, unknown>, content: { v: 1, parts: [{ t: 'text', text: 'Changed message' }] } };
    const successor = await createApprovalRequestArtifact({ ...ports, request: { ...next, actionArgs,
      requestInputDigest: computeActionInputApprovalDigestV1('discussion.post', actionArgs) } });
    expect(successor.artifactId).not.toBe(original.artifactId);
    expect(successor.request.status).toBe('open');
    expect(rows.size).toBe(2);
  });
});
