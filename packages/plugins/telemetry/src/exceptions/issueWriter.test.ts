import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createInMemoryAccountCollection } from '@happier-dev/plugin-sdk/collections';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { createCaptureRuntime } from '../runtime.js';
import { captureMigrations } from '../store/capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';
import { createTelemetryAssignments } from '../telemetry/assignments.js';
import { TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1 } from './issueRecord.js';
import {
  createExceptionIssueWriter,
  type ExceptionIssueCollection,
  type ExceptionIssueTransition,
} from './issueWriter.js';

const token = 'fixture-exporter-token';
const environment = {
  partition: 'environment:production',
  environmentId: 'production',
};
let clock = 1_700_000_100_000;
const text = (value: string) => ({ stringValue: value });

/** One OTLP span with one exception event, at a controlled time and release. */
function failure(spanId: string, version: string, atMs: number) {
  const nanos = `${BigInt(atMs) * 1_000_000n}`;
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: text('api') },
            { key: 'service.version', value: text(version) },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: '1234567890abcdef1234567890abcdef',
                spanId,
                kind: 2,
                name: 'GET /checkout',
                startTimeUnixNano: nanos,
                endTimeUnixNano: nanos,
                events: [
                  {
                    name: 'exception',
                    timeUnixNano: nanos,
                    attributes: [
                      { key: 'exception.type', value: text('TypeError') },
                      {
                        key: 'exception.message',
                        value: text('cart 12 is undefined'),
                      },
                      {
                        key: 'exception.stacktrace',
                        value: text(
                          'TypeError: cart 12 is undefined\n    at total (/srv/app/cart.js:4:9)',
                        ),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function fixture(share?: (row: { rowId: string; revision: number }) => Promise<void>) {
  const sqlite = createCaptureSqliteFixture();
  for (const migration of captureMigrations) await migration.up(sqlite.db);
  const runtime = createCaptureRuntime({
    database: sqlite.db,
    normalizeStatement: createPostgresqlObservationNormalizer(),
    publish: () => {},
  });
  // The Account Collection is the persistent-store boundary; the SDK's schema-backed adapter keeps CAS revisions.
  const account = createInMemoryAccountCollection({
    definition: TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1,
    pluginId: 'happier.telemetry',
  });
  let refuse: string | null = null;
  const issues = new Proxy(account.collection, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== 'put' || typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        refuse
          ? Promise.reject(
              new PluginError({
                code: refuse,
                message: 'Account storage unavailable',
              }),
            )
          : (value as (...a: unknown[]) => unknown).apply(target, args);
    },
  }) as unknown as ExceptionIssueCollection;
  const published: ExceptionIssueTransition[] = [];
  const writer = createExceptionIssueWriter({
    issues,
    store: runtime.store,
    now: () => clock,
    publish: async (transition) => {
      published.push(transition);
    },
    ...(share ? { share } : {}),
  });
  const assignments = createTelemetryAssignments();
  assignments.replace([
    {
      environmentId: 'production',
      tokenHash: createHash('sha256').update(token).digest('hex'),
      capabilities: { exceptions: true },
    },
  ]);
  const pending: Promise<void>[] = [];
  const receiver = await runtime.acquireReceiver({
    port: 0,
    context: { partition: '' },
    admit: (request) => assignments.admit(request),
    onExceptionsCommitted: (context, fingerprints) => {
      pending.push(writer.observe(environment, fingerprints).catch(() => {}));
    },
  });
  async function post(body: unknown) {
    const response = await fetch(`${receiver.endpoint}/v1/traces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    await Promise.all(pending.splice(0));
  }
  const rows = async () =>
    (
      await issues.query({
        index: 'by-environment',
        prefixes: [['production']],
        order: 'asc',
        limit: 10,
      })
    ).rows;
  return {
    runtime,
    writer,
    published,
    post,
    rows,
    account,
    setRefusal(code: string | null) {
      refuse = code;
    },
    async close() {
      await receiver.release();
      await runtime.ingest.settled();
      sqlite.close();
    },
  };
}

describe('native exception issue writer on the collector', () => {
  it('creates one Account issue per group, publishes only lifecycle transitions, and regresses only on a qualifying recurrence', async () => {
    const f = await fixture();
    try {
      await f.post(failure('00000000000000a1', 'build-1', clock - 5_000));
      const [created] = await f.rows();
      expect(created!.value).toMatchObject({
        status: 'open',
        count: 1,
        title: 'TypeError: cart <n> is undefined'.replace('<n>', '12'),
        topFrame: 'total (/srv/app/cart.js)',
        lastServiceVersion: 'build-1',
        environmentId: 'production',
      });
      expect(f.published.map((item) => [item.phase, item.regressed])).toEqual([
        ['open', false],
      ]);

      // A count-only arrival: no Account write, no transition.
      await f.post(failure('00000000000000a2', 'build-1', clock - 4_000));
      expect((await f.rows())[0]!.revision).toBe(created!.revision);
      expect(f.published).toHaveLength(1);

      clock += 1_000;
      const resolved = await f.writer.transition({
        environment,
        rowId: created!.rowId,
        action: 'resolve',
        version: 'build-2',
      });
      expect(resolved).toMatchObject({
        kind: 'applied',
        row: {
          value: {
            status: 'resolved',
            resolution: { version: 'build-2', priorVersions: ['build-1'] },
          },
        },
      });
      expect(f.published.at(-1)).toMatchObject({ phase: 'resolved' });

      // Late traffic from the release already seen before the fix does not reopen.
      clock += 1_000;
      await f.post(failure('00000000000000a3', 'build-1', clock));
      expect((await f.rows())[0]!.value.status).toBe('resolved');
      expect(f.published).toHaveLength(2);

      // The fixed release recurring reopens the same issue as regressed (phase open).
      clock += 1_000;
      await f.post(failure('00000000000000a4', 'build-2', clock));
      const [regressed] = await f.rows();
      expect(regressed!.rowId).toBe(created!.rowId);
      expect(regressed!.value).toMatchObject({
        status: 'open',
        regressed: true,
        count: 4,
        lastServiceVersion: 'build-2',
      });
      expect(f.published.at(-1)).toMatchObject({
        phase: 'open',
        regressed: true,
      });
      expect(await f.rows()).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('keeps raw occurrences when Account storage refuses, reports the typed state, and replays idempotently after recovery', async () => {
    const f = await fixture();
    try {
      f.setRefusal('plugin_account_data_unavailable');
      await f.post(failure('00000000000000b1', 'build-1', clock));
      expect(await f.rows()).toEqual([]);
      expect(f.writer.status()).toEqual({
        state: 'unavailable',
        code: 'plugin_account_data_unavailable',
      });
      expect(
        await f.runtime.store.exceptionGroups({
          worktree: environment.partition,
          limit: 10,
        }),
      ).toHaveLength(1);

      f.setRefusal(null);
      await f.writer.replay(environment, 10);
      await f.writer.replay(environment, 10);
      expect(await f.rows()).toHaveLength(1);
      expect(f.writer.status()).toEqual({ state: 'ready' });
      expect(f.published.map((item) => item.phase)).toEqual(['open']);
    } finally {
      await f.close();
    }
  });

  it('arms the Team grant once per created issue, and a refused grant keeps the issue and its transition while reporting the typed state', async () => {
    const shared: string[] = [];
    let refuse = false;
    const f = await fixture(async (row) => {
      if (refuse) throw new PluginError({ code: 'collection_invalid_recipient_envelope', message: 'refused' });
      shared.push(row.rowId);
    });
    try {
      await f.post(failure('00000000000000c1', 'build-1', clock));
      await f.post(failure('00000000000000c2', 'build-1', clock));
      expect(shared).toHaveLength(1);
      expect(f.writer.status()).toEqual({ state: 'ready' });
      refuse = true;
      const other = failure('00000000000000c3', 'build-1', clock);
      other.resourceSpans[0]!.resource.attributes[0]!.value = text('billing');
      await f.post(other);
      expect(await f.rows()).toHaveLength(2);
      expect(f.published.map((item) => item.phase)).toEqual(['open', 'open']);
      expect(f.writer.status()).toEqual({ state: 'unavailable', code: 'telemetry_issue_share_unavailable' });
    } finally {
      await f.close();
    }
  });
});
