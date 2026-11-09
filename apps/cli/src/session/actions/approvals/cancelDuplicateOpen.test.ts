import { describe, expect, it } from 'vitest';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { cancelDuplicateOpenApprovals, type DuplicateOpenApprovalStore } from './cancelDuplicateOpen';

type Row = { header: Record<string, unknown>; body: string };

// The Account Artifact store is the remote persistence boundary. This stand-in keeps its
// selection (kind, approval state, header filter) and commits updates through the real
// Protocol transition owner, as the CLI `approvalsUpdate` adapter does.
function createStore(rows: Map<string, Row>) {
  const counts = { bodiesRead: 0, writes: 0 };
  const store: DuplicateOpenApprovalStore = {
    list: async options => {
      const items = [...rows].filter(([, row]) => options.kinds.includes(String(row.header.kind))
        && options.approvalStates.includes(row.header.approvalStatus as never) && options.headerFilter(row.header))
        .map(([artifactId, row]) => { counts.bodiesRead++; return { artifactId, header: row.header, body: row.body }; });
      return { items, coverage: 'complete' as const };
    },
    approvalsUpdate: async ({ artifactId, request, expectedStatus }) => {
      const row = rows.get(artifactId)!;
      const existing = approvalArtifactBodyMatchesHeaderV1(row.header, row.body);
      if (existing?.family !== 'built_in') return { ok: false, errorCode: 'subject_mismatch', error: 'subject_mismatch' };
      const transition = decideApprovalRequestTransition(existing.request, request, { expectedStatus });
      if (!transition.ok) return transition;
      if (!transition.changed) return { ok: true };
      counts.writes++;
      rows.set(artifactId, { header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) });
      return { ok: true };
    },
  };
  return { store, counts };
}

const origin = (requestId: string, actionId: string) => ({ v: 1, authority: 'account_automation', surface: 'plugin',
  serverId: 'profile', serverIdentityId: 'home', accountId: 'account', machineId: 'machine', actionId, requestId,
  caller: { kind: 'plugin', pluginId: 'happier.machine.services', contributionLocalId: 'health-observer', startedBy: 'trigger',
    sourceCustody: { kind: 'development', registeredRootId: `root-${requestId}` } } });

const admission = (occurrenceId?: string) => ({ eventRef: { pluginId: 'happier.machine.services', localId: 'health-status' },
  ...(occurrenceId ? { occurrenceId } : {}), occurredAt: 1_700_000_000_000, observationReceivedAt: 1_700_000_000_100,
  payload: { sourceInstanceId: 'source', checkId: 'check', transition: 'failed' } });

const post = (content: string, attachments = false) => ({ discussionId: 'discussion-1', localId: 'local-1', content,
  ...(attachments ? { attachmentSources: [{ path: '/tmp/attempt/file.txt' }] } : {}) });

let sequence = 0;
// One attempt of a trigger-started plugin call: every attempt minted a new invocation requestId.
function attempt(actionId: 'automation.event.admit' | 'discussion.post', actionArgs: unknown, options: Readonly<{
  flow?: 'deferred' | 'blocking'; status?: ApprovalRequest['status']; digest?: boolean;
}> = {}) {
  sequence++;
  const status = options.status ?? 'open';
  return ApprovalRequestV2Schema.parse({ v: 2, status, createdAtMs: sequence, updatedAtMs: sequence,
    createdBy: { surface: 'system', pluginId: 'happier.machine.services', contributionLocalId: 'health-observer' },
    requestedSurface: 'plugin', actionId, actionArgs, summary: 'Ask',
    ...(options.digest === false ? {} : { requestInputDigest: computeActionInputApprovalDigestV1(actionId, actionArgs) }),
    ...(status === 'rejected' ? { decision: { kind: 'reject', decidedAtMs: sequence } } : {}),
    approval: { flow: options.flow ?? 'deferred', result: 'none' },
    executionOriginV1: origin(`correlation-${sequence}:${actionId}:1`, actionId) });
}

const row = (request: ApprovalRequest): Row => ({ header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) });
const statusOf = (rows: Map<string, Row>) => [...rows.values()].map(entry => entry.header.approvalStatus);

describe('one-time cancel of older duplicate open approvals', () => {
  it('cancels every open duplicate attempt except the newest of its obligation, and nothing else', async () => {
    const rows = new Map<string, Row>();
    const add = (id: string, request: ApprovalRequest) => { rows.set(id, row(request)); return id; };
    // K = 3 duplicate groups, N = 12 open attempts.
    const groupA = Array.from({ length: 5 }, (_, i) => add(`a-${i}`, attempt('automation.event.admit', admission('occurrence-a'))));
    const groupB = Array.from({ length: 4 }, (_, i) => add(`b-${i}`, attempt('discussion.post', post('Hello'))));
    const groupC = Array.from({ length: 3 }, (_, i) => add(`c-${i}`, attempt('automation.event.admit', admission('occurrence-b'))));
    // Decided rows of the same obligation are never touched.
    add('a-rejected', attempt('automation.event.admit', admission('occurrence-a'), { status: 'rejected' }));
    // Singles: changed input (digest) and the blocking flow are their own obligations.
    add('b-changed', attempt('discussion.post', post('Hello, edited')));
    add('a-blocking', attempt('automation.event.admit', admission('occurrence-a'), { flow: 'blocking' }));
    // Unclassifiable: no occurrence id, no input digest, attempt-owned attachments, a 0.2 (v1) row.
    add('legacy-1', attempt('automation.event.admit', admission()));
    add('legacy-2', attempt('automation.event.admit', admission()));
    add('nodigest-1', attempt('discussion.post', post('Hi'), { digest: false }));
    add('nodigest-2', attempt('discussion.post', post('Hi'), { digest: false }));
    add('attachments-1', attempt('discussion.post', post('File', true)));
    add('attachments-2', attempt('discussion.post', post('File', true)));
    add('v1', ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 'session-1' }, actionId: 'discussion.post', actionArgs: post('Hello'), summary: 'Post' }));
    const openBefore = statusOf(rows).filter(status => status === 'open').length;
    const { store, counts } = createStore(rows);

    expect(await cancelDuplicateOpenApprovals({ accountArtifactStore: store }))
      .toEqual({ groups: 3, canceled: 9, alreadySettled: 0, unclassified: 7, failed: 0, coverage: 'complete' });
    const canceled = [...rows].filter(([, entry]) => entry.header.approvalStatus === 'canceled').map(([id]) => id).sort();
    expect(canceled).toEqual([...groupA.slice(0, 4), ...groupB.slice(0, 3), ...groupC.slice(0, 2)].sort());
    expect({ openBefore, openAfter: statusOf(rows).filter(status => status === 'open').length }).toEqual({ openBefore: 21, openAfter: 12 });
    expect(rows.get('a-rejected')!.header.approvalStatus).toBe('rejected');
    for (const id of canceled) {
      const settled = approvalArtifactBodyMatchesHeaderV1(rows.get(id)!.header, rows.get(id)!.body);
      expect(settled?.request.status).toBe('canceled');
      expect(settled?.request.decision).toBeUndefined();
    }
    expect(counts.writes).toBe(9);

    // Idempotent: canceled attempts leave the open selection; a rerun writes nothing.
    expect(await cancelDuplicateOpenApprovals({ accountArtifactStore: store }))
      .toEqual({ groups: 0, canceled: 0, alreadySettled: 0, unclassified: 7, failed: 0, coverage: 'complete' });
    expect(counts.writes).toBe(9);
  });
  it('counts a row another daemon settled first as already settled, and reports real write errors by class and code', async () => {
    // Several daemons of one Account run the pass over the same rows at once.
    const rows = new Map<string, Row>();
    for (let i = 0; i < 5; i++) rows.set(`a-${i}`, row(attempt('automation.event.admit', admission('occurrence-a'))));
    for (let i = 0; i < 4; i++) rows.set(`b-${i}`, row(attempt('discussion.post', post('Hello'))));
    for (let i = 0; i < 3; i++) rows.set(`c-${i}`, row(attempt('automation.event.admit', admission('occurrence-b'))));
    const { store, counts } = createStore(rows);
    const [first, second] = await Promise.all([
      cancelDuplicateOpenApprovals({ accountArtifactStore: store }),
      cancelDuplicateOpenApprovals({ accountArtifactStore: store }),
    ]);
    expect({ canceled: first.canceled + second.canceled, alreadySettled: first.alreadySettled + second.alreadySettled,
      failed: first.failed + second.failed, writes: counts.writes }).toEqual({ canceled: 9, alreadySettled: 9, failed: 0, writes: 9 });
    expect(statusOf(rows).filter(status => status === 'open')).toHaveLength(3);

    // A real refusal stays a failure, with log-safe facts only.
    const failing = new Map<string, Row>();
    for (let i = 0; i < 3; i++) failing.set(`d-${i}`, row(attempt('discussion.post', post('Again'))));
    const unavailable = Object.assign(new Error('secret-payload'), { code: 'artifact_write_unavailable' });
    const result = await cancelDuplicateOpenApprovals({ accountArtifactStore: { ...createStore(failing).store,
      approvalsUpdate: async () => { throw unavailable; } } });
    expect(result).toEqual({ groups: 1, canceled: 0, alreadySettled: 0, unclassified: 0, failed: 2, coverage: 'complete',
      failures: [{ errorClass: 'Error', errorCode: 'artifact_write_unavailable', count: 2 }] });
  });
});
