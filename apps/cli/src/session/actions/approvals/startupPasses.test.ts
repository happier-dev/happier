import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { cancelDuplicateOpenApprovals, type DuplicateOpenApprovalStore } from './cancelDuplicateOpen';
import { classifyOpenApprovalListFacts, type ApprovalListFactsClassificationStore } from './classifyListFacts';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { runApprovalStartupPasses } from './startupPasses';

const complete = { groups: 0, canceled: 0, unclassified: 0, failed: 0, coverage: 'complete' as const };

afterEach(() => vi.restoreAllMocks());

describe('daemon startup approval passes', () => {
  it.each(['complete', 'unavailable', 'partial'] as const)('settles completed legacy passes across starts and retries only an incomplete pass (%s)', async selectionState => {
    const directory = await mkdtemp(join(tmpdir(), 'approval-startup-settlement-'));
    try {
      const settlementPath = join(directory, 'account-home.json');
      const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli', sessionId: 'session' }, actionId: 'discussion.post',
        actionArgs: { discussionId: 'discussion', localId: 'post', content: 'Hello' }, summary: 'Post' });
      const { approvalListFacts: _facts, ...header } = buildApprovalRequestArtifactHeaderV1(request);
      const rows = new Map<string, { header: Readonly<Record<string, unknown>>; body: string }>(Array.from({ length: 111 }, (_, index) => [String(index), { header, body: index === 0 ? '{}' : JSON.stringify(request) }]));
      let selections = 0;
      let bodiesRead = 0;
      // The remote Artifact persistence boundary; both approval domain passes run unchanged.
      const boundary: DuplicateOpenApprovalStore & ApprovalListFactsClassificationStore = {
        list: async options => {
          selections++;
          if (selectionState === 'unavailable' && selections === 1) throw Object.assign(new Error('Transport unavailable'), { code: 'ECONNREFUSED' });
          const items = [...rows].filter(([, row]) => options.headerFilter(row.header))
            .map(([artifactId, row]) => { bodiesRead++; return { artifactId, ...row }; });
          return { items, coverage: selectionState === 'partial' && selections === 1 ? 'partial' : 'complete' };
        },
        approvalsUpdate: async () => { throw new Error('Unclassifiable legacy identities must stay open'); },
        readForUpdate: async artifactId => {
          const artifact = rows.get(artifactId);
          if (artifact) bodiesRead++;
          return artifact ? { artifact, update: async content => { rows.set(artifactId, content); return { ok: true }; } } : null;
        },
      };
      const store = {
        approvalsCancelDuplicateOpen: () => cancelDuplicateOpenApprovals({ accountArtifactStore: boundary }),
        approvalsClassifyListFacts: () => classifyOpenApprovalListFacts({ accountArtifactStore: boundary }),
      };
      await runApprovalStartupPasses(store, { settlementPath });
      if (selectionState !== 'complete') await runApprovalStartupPasses(store, { settlementPath });
      const settled = { selections, bodiesRead };
      expect(selections).toBe(selectionState === 'complete' ? 2 : 3);
      expect(bodiesRead).toBe(selectionState === 'partial' ? 444 : 333);
      await runApprovalStartupPasses(store, { settlementPath });
      expect({ selections, bodiesRead }).toEqual(settled);
      expect(JSON.parse(await readFile(settlementPath, 'utf8'))).toEqual({ v: 1, duplicateOpen: true, listFacts: true });
      expect([...rows.values()].every(row => row.header.approvalStatus === 'open')).toBe(true);
      expect(rows.get('0')?.header).not.toHaveProperty('approvalListFacts');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports why a pass was unavailable by error class and code, never its message or payload', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // The Account store refuses a selection while Account material is unavailable; the HTTP
    // boundary refuses with a status and an error code. Messages may carry content.
    const material = Object.assign(new Error('secret-payload approval body'), { code: 'account_encryption_mode_unavailable' });
    const http = new AxiosError('secret-payload url', 'ERR_BAD_RESPONSE', undefined, undefined,
      { status: 503, statusText: 'x', headers: {}, config: { headers: new AxiosHeaders() }, data: { error: 'artifact_read_unavailable' } });

    await runApprovalStartupPasses({
      approvalsCancelDuplicateOpen: () => Promise.reject(material),
      approvalsClassifyListFacts: () => Promise.reject(http),
    });

    expect(warn.mock.calls).toEqual([
      ['[DAEMON RUN] Duplicate open approval cancel unavailable',
        { code: 'approval_duplicate_cancel_unavailable', errorClass: 'Error', errorCode: 'account_encryption_mode_unavailable' }],
      ['[DAEMON RUN] Approval list-fact classification unavailable',
        { code: 'approval_list_facts_unavailable', errorClass: 'AxiosError', errorCode: 'artifact_read_unavailable', status: 503 }],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-payload');
  });

  it('reports the duplicate cancel counts whenever the pass selected rows, including rows it left open', async () => {
    const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    await runApprovalStartupPasses({
      approvalsCancelDuplicateOpen: async () => ({ ...complete, unclassified: 7 }),
      approvalsClassifyListFacts: async () => ({ classified: 0, mismatched: 0, failed: 0, coverage: 'complete' as const }),
    });
    expect(info.mock.calls).toEqual([['[DAEMON RUN] Duplicate open approval cancel', { ...complete, unclassified: 7 }]]);
  });
});
