import { describe, expect, it } from 'vitest';
import { NETWORK_PHASES, NETWORK_WORKLOAD_REVISION } from '../../../suites/ui-e2e/session.networkTransfer.contract';
import { compareNetworkTransfer, MAX_NETWORK_REPORT_BYTES, parseNetworkTransferReport, type NetworkTransferReport } from './networkTransferReport';

function fixture(): NetworkTransferReport {
  return {
    schemaVersion: 2, workloadRevision: NETWORK_WORKLOAD_REVISION, sourceLine: '0.2', testStatus: 'passed', status: 'incomplete',
    ci: { branch: 'dev', sha: null, run: '123', attempt: '1' }, retry: 0, repeatEachIndex: 0,
    runtime: { browser: 'chromium', browserVersion: '145.0.7632.0', uiMode: 'export', serverMode: 'light-sqlite', viewport: { width: 1440, height: 900 } },
    accounting: { httpDecodedBodyBytes: 'decoded', httpEncodedBodyBytes: 'encoded', httpEncodedResponseBytes: 'response', wsApplicationBytes: 'application', socketIoCoverage: 'websocket' },
    fixture: { sessionCount: 101, seededSessionCount: 101, offPagePins: 1, storageMode: 'plain', burstKind: 'metadata-update', burstCount: 5, burstPayloadBytes: 1024, idleMs: 30000, coldCache: 'disabled', warmCache: 'enabled', verifiedBootstraps: 2, openedSessions: 1, reconnects: 1, transcriptMessages: 1, transcriptPayloadBytes: 1024 },
    measurement: { status: 'incomplete', wsEncodedBytes: 'unavailable', lostEvents: 0, phases: NETWORK_PHASES.map((name) => ({
      name, durationMs: 1, inFlightAtEnd: 0, socketDisconnects: 0, http: name.endsWith('-home') ? [{
        method: 'GET', route: 'session-list-targeted', requests: 1, failed: 0, inFlight: 0, lateResponses: 0,
        decodedBodyBytes: 111106, encodedBodyBytes: 'unavailable', encodedResponseBytes: 2400, requestBodyBytes: 0,
        unavailableBodies: 1, statuses: { '200': 1 }, encodings: { br: 1 }, cached: 0, serviceWorker: 0,
      }] : [], webSocket: [],
    })) },
  };
}

describe('network transfer comparison', () => {
  it('compares a disappeared traffic class as zero only when that phase completed without lost events', () => {
    const base = fixture();
    base.measurement.phases[2].http = [{ ...base.measurement.phases[0].http[0], route: 'other-api' }];
    const current = fixture();
    expect(compareNetworkTransfer(current, base).markdown).toContain('home-idle-30s | GET other-api requests | 1 | 0 | -1');
    current.measurement.phases.splice(2, 1);
    expect(compareNetworkTransfer(current, base).markdown).toContain('home-idle-30s | GET other-api requests | not comparable | unavailable | not comparable');
  });

  it('compares available metrics on passing workloads even when unrelated byte evidence is incomplete', () => {
    const base = parseNetworkTransferReport(JSON.stringify(fixture()));
    const current = structuredClone(base);
    current.measurement.phases[0].http[0].decodedBodyBytes = 111107;
    const result = compareNetworkTransfer(current, base);
    expect(result.comparable).toBe(true);
    expect(result.markdown).toContain('111106 | 111107 | +1 | 111106');
    expect(result.violations).toContain('cold-home: GET session-list* decodedBodyBytes');
    expect(result.markdown).toContain('unavailable | not comparable');
  });

  it('enforces absolute ceilings without a base and rejects failed, skewed, missing-phase and lost-event comparisons', () => {
    const current = fixture();
    current.measurement.phases[0].http[0].requests = 2;
    expect(compareNetworkTransfer(current).violations).toContain('cold-home: GET session-list* requests');
    expect(compareNetworkTransfer(current).markdown).toContain('missing');
    for (const mutate of [
      (r: NetworkTransferReport) => { r.testStatus = 'failed'; },
      (r: NetworkTransferReport) => { r.runtime.browserVersion = '146.0'; },
      (r: NetworkTransferReport) => { r.fixture.sessionCount = 102; },
      (r: NetworkTransferReport) => { r.measurement.phases.pop(); },
    ]) {
      const base = fixture(); mutate(base);
      expect(compareNetworkTransfer(current, base).comparable).toBe(false);
    }
    current.measurement.lostEvents = 1;
    expect(compareNetworkTransfer(current).violations).toContain('cold-home: GET session-list* decodedBodyBytes');
  });

  it('does not turn an unobserved required list into a zero-byte passing ceiling', () => {
    const current = fixture();
    current.measurement.phases[0].http = [];
    expect(compareNetworkTransfer(current).violations).toContain('cold-home: GET session-list* decodedBodyBytes');
  });

  it('strictly rejects unknown keys, fractional/negative/unsafe counters, duplicate buckets and untrusted labels', () => {
    const good = fixture();
    expect(parseNetworkTransferReport(JSON.stringify(good))).toEqual(good);
    for (const invalid of [
      { ...good, extra: true }, { ...good, retry: -1 }, { ...good, retry: 0.5 }, { ...good, retry: Number.MAX_SAFE_INTEGER + 1 },
      { ...good, measurement: { ...good.measurement, phases: [...good.measurement.phases, good.measurement.phases[0]] } },
      { ...good, measurement: { ...good.measurement, phases: [{ ...good.measurement.phases[0], name: '| injected |' }] } },
    ]) expect(() => parseNetworkTransferReport(JSON.stringify(invalid))).toThrow();
    const duplicate = fixture(); duplicate.measurement.phases[0].http.push(duplicate.measurement.phases[0].http[0]);
    expect(() => parseNetworkTransferReport(JSON.stringify(duplicate))).toThrow();
    expect(() => parseNetworkTransferReport(JSON.stringify(good).padEnd(MAX_NETWORK_REPORT_BYTES + 1, ' '))).toThrow('schema size bound');
  });
});
