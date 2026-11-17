import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { TriageGetResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { exceptionLocalRefV1, getTelemetryException, TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1, TELEMETRY_EXCEPTION_SOURCE_V1 } from './source.js';
import { exceptionDetailDataSchema } from './contracts.js';
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
  async function post(body: unknown, signal: 'traces' | 'logs' = 'traces') {
    const response = await fetch(`${receiver.endpoint}/v1/${signal}`, {
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
  it('retains scope-proven browser origin through mixed groups, Account issues and the native source, never inferring it from app text', async () => {
    const f = await fixture();
    const payload = (scopeName: string, atMs: number) => ({ resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: text('api') }] },
      scopeLogs: [{ scope: { name: scopeName }, logRecords: [{
        timeUnixNano: `${BigInt(atMs) * 1_000_000n}`,
        attributes: [
          { key: 'log.record.uid', value: text(`${scopeName}:${atMs}`) },
          { key: 'exception.type', value: text('BrowserError') },
          { key: 'exception.message', value: text('app.browser.errors in the browser') },
          { key: 'exception.stacktrace', value: text('BrowserError: app.browser.errors\n    at browser (https://app.test/client.js:1:2)') },
        ],
      }] }],
    }] });
    try {
      await f.post(payload('app.backend.errors', clock), 'logs');
      const [backend] = await f.rows();
      expect(backend).toBeDefined();
      expect(backend!.value).not.toHaveProperty('applicationOrigin');
      expect(f.published).toHaveLength(1);
      await f.post(payload('app.browser.errors', clock + 1), 'logs');
      const [browser] = await f.rows();
      expect(browser!.rowId).toBe(backend!.rowId);
      expect(browser!.value).toMatchObject({ applicationOrigin: 'browser' });
      await f.post(payload('app.backend.errors', clock + 2), 'logs');
      const [group] = await f.runtime.store.exceptionGroups({ worktree: environment.partition, limit: 10 });
      expect(group).toMatchObject({ count: 3, applicationOrigin: 'browser' });
      expect(await f.writer.refresh({ environment, rowId: browser!.rowId }))
        .toMatchObject({ value: { count: 3, applicationOrigin: 'browser' } });
      expect(f.published).toHaveLength(1); // A provenance update is not a new issue transition.
      const context = {
        signal: new AbortController().signal,
        services: { storage: { account: { collection: () => f.account.collection } } },
      } as unknown as PluginInvocationContext;
      const got = TriageGetResultV1Schema.parse(await getTelemetryException({
        v: 1,
        instance: { v: 1, instance: { source: TELEMETRY_EXCEPTION_SOURCE_V1,
          sourceInstanceId: '0b0e57a0-3c7e-4c7a-9f39-6a4f1f0a1b2c' },
          binding: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.binding,
          localInstanceKey: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.localInstanceKey,
          configuration: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.configuration },
        localRef: exceptionLocalRefV1(browser!.rowId),
      }, context));
      expect(got).toMatchObject({ kind: 'present', detailData: { applicationOrigin: 'browser' }, investigationDefaults: { permissionMode: 'default' } });
      if (got.kind !== 'present') throw new Error('Expected retained native issue');
      expect(exceptionDetailDataSchema.parse(got.detailData)).toMatchObject({ applicationOrigin: 'browser' });
      const browserSpan = failure('00000000000000f1', 'browser-release', clock + 3);
      const browserScope = browserSpan.resourceSpans[0]!.scopeSpans[0]!;
      await f.post({ resourceSpans: [{ ...browserSpan.resourceSpans[0],
        scopeSpans: [{ ...browserScope, scope: { name: 'app.browser.errors' } }] }] });
      expect((await f.rows()).find(row => row.rowId !== browser!.rowId)?.value)
        .toMatchObject({ applicationOrigin: 'browser' });
    } finally { await f.close(); }
  });

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
