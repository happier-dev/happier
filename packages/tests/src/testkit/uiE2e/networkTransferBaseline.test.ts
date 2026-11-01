import { describe, expect, it } from 'vitest';
import { findNetworkTransferBaseline, type NetworkBaselineRun } from './networkTransferBaseline';
import { NETWORK_PHASES, NETWORK_WORKLOAD_REVISION } from '../../../suites/ui-e2e/session.networkTransfer.contract';
import type { NetworkTransferReport } from './networkTransferReport';

// The network/Actions boundary is the only fake. Selection and comparison stay real.
const report = { schemaVersion: 2, workloadRevision: NETWORK_WORKLOAD_REVISION, sourceLine: '0.2', testStatus: 'passed', status: 'incomplete',
  ci: { branch: 'dev', sha: 'base', run: '1', attempt: '1' }, retry: 0, repeatEachIndex: 0,
  runtime: { browser: 'chromium', browserVersion: '145.0', uiMode: 'export', serverMode: 'light-sqlite', viewport: { width: 1440, height: 900 } },
  accounting: { httpDecodedBodyBytes: '', httpEncodedBodyBytes: '', httpEncodedResponseBytes: '', wsApplicationBytes: '', socketIoCoverage: '' },
  fixture: { sessionCount: 101, seededSessionCount: 101, offPagePins: 1, storageMode: 'plain', burstKind: 'metadata-update', burstCount: 5, burstPayloadBytes: 1024, idleMs: 30000, coldCache: 'disabled', warmCache: 'enabled', verifiedBootstraps: 2, openedSessions: 1, reconnects: 1, transcriptMessages: 1, transcriptPayloadBytes: 1024 },
  measurement: { status: 'incomplete', wsEncodedBytes: 'unavailable', lostEvents: 0, phases: NETWORK_PHASES.map((name) => ({ name, durationMs: 1, inFlightAtEnd: 0, socketDisconnects: 0, http: [], webSocket: [] })) },
} satisfies NetworkTransferReport;
const run = (id: number, extra = {}): NetworkBaselineRun => ({ id, head_branch: 'dev', event: 'push', conclusion: 'success', head_sha: 'base', head_repository: { full_name: 'owner/repo' }, ...extra });

describe('successful base-branch network artifact discovery', () => {
  it('skips the current run, forks, failed runs, retried cohorts and mismatched revisions before using the latest comparable artifact', async () => {
    const visited: number[] = [];
    const result = await findNetworkTransferBaseline({ current: report, repository: 'owner/repo', branch: 'dev', currentRun: '8', warn() {}, reader: {
      async runs(page) { return page === 1 ? [run(8), run(7, { head_repository: { full_name: 'fork/repo' } }), run(6, { conclusion: 'failure' }), run(5), run(4)] : page === 2 ? [run(3)] : []; },
      async reports(r) {
        visited.push(r.id);
        const value = structuredClone(report); value.ci.run = String(r.id);
        if (r.id === 5) value.retry = 1;
        if (r.id === 4) value.workloadRevision = 'old';
        return [value];
      },
    } });
    expect(visited).toEqual([5, 4, 3]);
    expect(result?.run.id).toBe(3);
  });

  it('reports invalid artifacts observably and returns missing without inventing a baseline', async () => {
    const warnings: string[] = [];
    const result = await findNetworkTransferBaseline({ current: report, repository: 'owner/repo', branch: 'dev', warn: (m) => warnings.push(m), reader: {
      async runs(page) { return page === 1 ? [run(1)] : []; },
      async reports() { throw new Error('invalid JSON'); },
    } });
    expect(result).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining('artifact invalid or unavailable')]);
  });
});
