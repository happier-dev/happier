import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { runApprovalStartupPasses } from './startupPasses';

const complete = { groups: 0, canceled: 0, unclassified: 0, failed: 0, coverage: 'complete' as const };

afterEach(() => vi.restoreAllMocks());

describe('daemon startup approval passes', () => {
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
