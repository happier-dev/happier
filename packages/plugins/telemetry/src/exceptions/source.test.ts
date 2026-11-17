import { describe, expect, it } from 'vitest';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createInMemoryAccountCollection } from '@happier-dev/plugin-sdk/collections';
import {
  TriageGetResultV1Schema,
  TriageScanResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import {
  TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1,
  type ExceptionIssueRecord,
} from './issueRecord.js';
import {
  exceptionLocalRefV1,
  getTelemetryException,
  scanTelemetryExceptions,
  TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1,
  TELEMETRY_EXCEPTION_SOURCE_V1,
} from './source.js';

const instance = {
  v: 1 as const,
  instance: {
    source: TELEMETRY_EXCEPTION_SOURCE_V1,
    sourceInstanceId: '0b0e57a0-3c7e-4c7a-9f39-6a4f1f0a1b2c',
  },
  binding: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.binding,
  localInstanceKey: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.localInstanceKey,
  configuration: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.configuration,
};
const record = (
  id: string,
  status: ExceptionIssueRecord['status'],
  updatedAtMs: number,
): ExceptionIssueRecord => ({
  id,
  environmentId: 'production',
  fingerprint: `fp-${id}`,
  title: 'TypeError: cart 12 is undefined',
  serviceName: 'api',
  topFrame: 'total (/srv/app/cart.js)',
  status,
  ...(status === 'open' && id === 'b' ? { regressed: true as const } : {}),
  count: 3,
  firstSeenAtMs: 1,
  lastSeenAtMs: updatedAtMs,
  asOfMs: updatedAtMs,
  lastServiceVersion: 'build-2',
  ...(status === 'resolved'
    ? { resolution: { atMs: updatedAtMs, priorVersions: ['build-1'] } }
    : {}),
  createdAtMs: 1,
  updatedAtMs,
});

function context(sharing?: unknown) {
  const account = createInMemoryAccountCollection({
    definition: TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1,
    pluginId: 'happier.telemetry',
  });
  for (const [id, status, at] of [
    ['a', 'resolved', 10],
    ['b', 'open', 30],
    ['c', 'ignored', 20],
  ] as const)
    account.control.seed(record(id, status, at));
  const collection =
    sharing === undefined
      ? account.collection
      : { ...account.collection, sharing };
  // Account storage is the persistent-store boundary; everything above it is the real source code.
  return {
    signal: new AbortController().signal,
    services: { storage: { account: { collection: () => collection } } },
  } as unknown as PluginInvocationContext;
}

describe('built-in Happier exceptions Triage source', () => {
  it('hands the detail surface what its occurrence and stack reads need, on the exact read only', async () => {
    const got = TriageGetResultV1Schema.parse(
      await getTelemetryException(
        { v: 1, instance, localRef: exceptionLocalRefV1('a') },
        context(),
      ),
    );
    expect(got).toMatchObject({
      kind: 'present',
      detailData: { v: 1, environmentId: 'production', fingerprint: 'fp-a', status: 'resolved', count: 3,
        firstSeenAtMs: 1, lastSeenAtMs: 10, lastServiceVersion: 'build-2', resolution: { atMs: 10, priorVersions: ['build-1'] } },
    });
    expect(got).not.toHaveProperty('investigationDefaults');
    const scan = TriageScanResultV1Schema.parse(
      await scanTelemetryExceptions({ v: 1, instance, page: { kind: 'initial', limit: 5 } }, context()),
    );
    // Scan rows feed the retained corpus; source-owned presentation stays on the exact read.
    expect(JSON.stringify(scan)).not.toContain('detailData');
  });

  it('reads own Account records newest first with lifecycle states, and keeps them when Team-shared reads are unavailable', async () => {
    const result = TriageScanResultV1Schema.parse(
      await scanTelemetryExceptions(
        { v: 1, instance, page: { kind: 'initial', limit: 10 } },
        context(),
      ),
    );
    expect(result).toMatchObject({
      kind: 'complete',
      evidence: { kind: 'partial', reason: 'sharedIssuesUnavailable' },
    });
    const rows = result.kind === 'complete' ? result.observations : [];
    expect(
      rows.map(
        (row) =>
          row.kind === 'present' && [
            row.localRef.entryId,
            row.snapshot.state.presentation,
            row.snapshot.state.nativeLabel,
          ],
      ),
    ).toEqual([
      ['b', 'active', 'Regressed'],
      ['c', 'closed', 'Ignored'],
      ['a', 'resolved', 'Resolved'],
    ]);
  });

  it('adds Team-shared records with their owner-relative refs and reads one exactly; a revoked grant reads as absent', async () => {
    const shared = { ...record('s', 'open', 40), id: 's' };
    const sharing = {
      async sharedWithMe() {
        return {
          rows: [
            {
              rowId: 's',
              revision: 2,
              value: shared,
              ownerAccountId: 'owner-1',
              access: 'view',
            },
          ],
        };
      },
      async get(address: { ownerAccountId: string; rowId: string }) {
        if (address.rowId !== 's')
          throw new PluginError({ code: 'collection_access_forbidden', message: 'Grant revoked' });
        return {
          rowId: 's',
          revision: 2,
          value: shared,
          ownerAccountId: 'owner-1',
          access: 'view',
        };
      },
    };
    const scan = TriageScanResultV1Schema.parse(
      await scanTelemetryExceptions(
        { v: 1, instance, page: { kind: 'initial', limit: 2 } },
        context(sharing),
      ),
    );
    expect(scan.kind).toBe('page');
    const all = [...(scan.kind === 'page' ? scan.observations : [])];
    if (scan.kind === 'page') {
      const rest = TriageScanResultV1Schema.parse(
        await scanTelemetryExceptions(
          {
            v: 1,
            instance,
            page: { kind: 'continuation', continuation: scan.continuation },
          },
          context(sharing),
        ),
      );
      expect(rest).toMatchObject({
        kind: 'complete',
        evidence: { kind: 'walkFinished' },
      });
      all.push(...(rest.kind === 'complete' ? rest.observations : []));
    }
    expect(
      all.map((row) => row.kind === 'present' && row.localRef.collisionScope),
    ).toEqual(['personal', 'personal', 'personal', 'account:owner-1']);

    const exact = TriageGetResultV1Schema.parse(
      await getTelemetryException(
        { v: 1, instance, localRef: exceptionLocalRefV1('s', 'owner-1') },
        context(sharing),
      ),
    );
    expect(exact).toMatchObject({
      kind: 'present',
      snapshot: { scopeUnitId: 'production' },
    });
    expect(JSON.stringify(exact)).not.toContain('fp-s');
    const revoked = TriageGetResultV1Schema.parse(
      await getTelemetryException(
        { v: 1, instance, localRef: exceptionLocalRefV1('x', 'owner-1') },
        context(sharing),
      ),
    );
    expect(revoked).toMatchObject({ kind: 'absent' });
  });
});
