import { describe, expect, it } from 'vitest';
import { computeActionInputApprovalDigestV1 } from '../actions/decisionAuthority.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from './approvalRequestV1.js';
import { createApprovalRequestArtifact } from './creation.js';

// A trigger-started observer retries one unsettled occurrence with the same
// admission input; each attempt mints a new invocation requestId.
function admission(occurrenceId: string) {
  return { eventRef: { pluginId: 'happier.machine.services', localId: 'health-status' }, occurrenceId,
    occurredAt: 1_700_000_000_000, observationReceivedAt: 1_700_000_000_100,
    payload: { sourceInstanceId: 'source', checkId: 'check', transition: 'failed' },
    definitions: [{ automationId: 'cmautomation00000000000001', triggerId: 'trigger-1', triggerRevision: 1,
      sourceSelectorId: '3f1c2a4e-8b7d-4c3e-9f2a-1b2c3d4e5f60' }] };
}

function attempt(attemptNumber: number, occurrenceId = 'occurrence-a'): ApprovalRequestV2 {
  const actionArgs = admission(occurrenceId);
  return ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: attemptNumber, updatedAtMs: attemptNumber,
    createdBy: { surface: 'system', pluginId: 'happier.machine.services', contributionLocalId: 'health-observer' },
    requestedSurface: 'plugin', actionId: 'automation.event.admit', actionArgs, summary: 'Admit Automation Event occurrence',
    requestInputDigest: computeActionInputApprovalDigestV1('automation.event.admit', actionArgs),
    approval: { flow: 'blocking', result: 'none' },
    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'plugin', serverId: 'profile',
      serverIdentityId: 'home', accountId: 'account', machineId: 'machine', actionId: 'automation.event.admit',
      requestId: `correlation-${attemptNumber}:automation.event.admit:1`,
      caller: { kind: 'plugin', pluginId: 'happier.machine.services', contributionLocalId: 'health-observer', startedBy: 'trigger',
        sourceCustody: { kind: 'development', registeredRootId: `root-${attemptNumber}` } } },
  });
}

function store() {
  const rows = new Map<string, { header: Record<string, unknown>; body: string; access: string }>();
  const create = (request: ApprovalRequestV2) => createApprovalRequestArtifact({ request, accountId: 'account',
    newId: () => { throw new Error('A retained admission has canonical identity'); },
    read: async id => rows.get(id) ?? null,
    create: async (id, header, body) => { rows.set(id, { header, body, access: 'owner' }); },
  });
  return { rows, create };
}

describe('retained plugin event admission approval subject', () => {
  it('files one open Ask for N retries of one occurrence and a new one for a new occurrence', async () => {
    const { rows, create } = store();
    const retries = 12;
    const ids = new Set<string>();
    for (let index = 1; index <= retries; index++) ids.add((await create(attempt(index))).artifactId);
    expect({ asks: rows.size, artifactIds: ids.size }).toEqual({ asks: 1, artifactIds: 1 });
    await create(attempt(retries + 1, 'occurrence-b'));
    expect(rows.size).toBe(2);
  });

  it('asks again when an input that changes the admission changes', async () => {
    const { rows, create } = store();
    await create(attempt(1));
    const changed = attempt(2);
    const actionArgs = { ...admission('occurrence-a'), definitions: [{ ...admission('occurrence-a').definitions[0]!, triggerRevision: 2 }] };
    await create(ApprovalRequestV2Schema.parse({ ...changed, actionArgs,
      requestInputDigest: computeActionInputApprovalDigestV1('automation.event.admit', actionArgs) }));
    expect(rows.size).toBe(2);
  });
});
