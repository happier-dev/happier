import { describe, expect, it } from 'vitest';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { classifyOpenApprovalListFacts, type ApprovalListFactsClassificationStore } from './classifyListFacts';

// The Account Artifact store is the remote persistence boundary; this in-memory
// stand-in keeps its selection (kinds, approval state, header filter) and CAS semantics.
function createStore(rows: Map<string, { header: Record<string, unknown>; body: string; revision: number }>) {
  const counts = { bodiesRead: 0, writes: 0 };
  const store: ApprovalListFactsClassificationStore = {
    list: async options => {
      const items = [...rows].filter(([, row]) => options.kinds.includes(String(row.header.kind))
        && options.approvalStates.some(state => state === row.header.approvalStatus) && options.headerFilter(row.header))
        .map(([artifactId, row]) => { counts.bodiesRead++; return { artifactId, header: row.header, body: row.body }; });
      return { items, coverage: 'complete' as const };
    },
    readForUpdate: async artifactId => {
      const row = rows.get(artifactId);
      if (!row) return null;
      const revision = row.revision;
      return { artifact: { header: row.header, body: row.body }, update: async content => {
        if (rows.get(artifactId)?.revision !== revision) return { ok: false };
        counts.writes++;
        rows.set(artifactId, { header: content.header, body: content.body, revision: revision + 1 });
        return { ok: true };
      } };
    },
  };
  return { store, counts };
}

describe('one-time open approval list-fact classification', () => {
  it('writes the list facts once into open headers written before they existed, from the body', async () => {
    const origin = { v: 1, authority: 'account_automation', surface: 'plugin', serverId: 'home-1', accountId: 'account-1',
      actionId: 'discussion.post', requestId: 'request-1',
      caller: { kind: 'automationRun', runId: 'run-1', automationId: 'automation-1', cause: { kind: 'manual', invokedAt: 1 } }, runId: 'run-1' };
    const discussion = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'system' },
      requestedSurface: 'plugin', executionOriginV1: origin, actionId: 'discussion.post',
      actionArgs: { discussionId: 'discussion-1', localId: 'local-1', content: 'Hello' }, summary: 'Post' });
    const legacy = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 'session-1' }, actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'T' }, summary: 'Title' });
    const unclassified = (request: Parameters<typeof buildApprovalRequestArtifactHeaderV1>[0]) => {
      const { approvalListFacts: _facts, ...header } = buildApprovalRequestArtifactHeaderV1(request);
      return { header, body: JSON.stringify(request), revision: 1 };
    };
    const current = { header: buildApprovalRequestArtifactHeaderV1(discussion), body: JSON.stringify(discussion), revision: 1 };
    const rows = new Map([['discussion-ask', unclassified(discussion)], ['legacy-ask', unclassified(legacy)], ['current-ask', current]]);
    const { store, counts } = createStore(rows);

    expect(await classifyOpenApprovalListFacts({ accountArtifactStore: store })).toEqual({ classified: 2, mismatched: 0, failed: 0, coverage: 'complete' });
    expect(rows.get('discussion-ask')!.header.approvalListFacts).toEqual({ automationId: 'automation-1', discussionId: 'discussion-1' });
    expect(rows.get('legacy-ask')!.header.approvalListFacts).toEqual({});
    expect(approvalArtifactBodyMatchesHeaderV1(rows.get('discussion-ask')!.header, rows.get('discussion-ask')!.body)?.request).toEqual(discussion);
    expect(counts).toEqual({ bodiesRead: 2, writes: 2 });

    // One-time: classified headers leave the selection.
    expect(await classifyOpenApprovalListFacts({ accountArtifactStore: store })).toEqual({ classified: 0, mismatched: 0, failed: 0, coverage: 'complete' });
    expect(counts).toEqual({ bodiesRead: 2, writes: 2 });
  });
  it('separates rows whose stored body disagrees with its header from write failures, and reports both by kind only', async () => {
    const request = (actionId: string, summary: string) => ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 'session-1' }, actionId, actionArgs: { sessionId: 'session-1', title: 'T' }, summary });
    const unclassified = (value: Parameters<typeof buildApprovalRequestArtifactHeaderV1>[0], header?: Record<string, unknown>) => {
      const { approvalListFacts: _facts, ...built } = buildApprovalRequestArtifactHeaderV1(value);
      return { header: { ...built, ...header }, body: JSON.stringify(value), revision: 1 };
    };
    const rows = new Map([
      // Header written by an older writer whose facts contradict the body.
      ['disagree-1', unclassified(request('session.title.set', 'secret-payload one'), { title: 'other' })],
      ['disagree-2', unclassified(request('session.title.set', 'secret-payload two'), { title: 'other' })],
      // Body that no longer parses as a stored approval request.
      ['unreadable', { ...unclassified(request('session.title.set', 'Title')), body: '{"v":9}' }],
      ['refused', unclassified(request('session.title.set', 'Title'))],
      ['thrown', unclassified(request('session.title.set', 'Title'))],
    ]);
    const { store } = createStore(rows);
    const unavailable = Object.assign(new Error('secret-payload'), { code: 'artifact_write_unavailable' });
    const result = await classifyOpenApprovalListFacts({ accountArtifactStore: { ...store,
      readForUpdate: async artifactId => {
        if (artifactId === 'thrown') throw unavailable;
        const current = await store.readForUpdate(artifactId);
        return current && artifactId === 'refused' ? { ...current, update: async () => ({ ok: false }) } : current;
      } } });
    expect(result).toEqual({ classified: 0, mismatched: 3, failed: 2, coverage: 'complete',
      mismatches: [{ reason: 'header_disagrees', actionId: 'session.title.set', count: 2 }, { reason: 'body_unreadable', actionId: 'session.title.set', count: 1 }],
      failures: [{ errorClass: 'ApprovalUpdateRefused', count: 1 }, { errorClass: 'Error', errorCode: 'artifact_write_unavailable', count: 1 }] });
    expect(JSON.stringify(result)).not.toContain('secret-payload');
  });
});
