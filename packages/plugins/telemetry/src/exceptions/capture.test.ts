import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { createCaptureRuntime } from '../runtime.js';
import { captureMigrations } from '../store/capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';
import { createTelemetryAssignments } from '../telemetry/assignments.js';

const token = 'fixture-exporter-token';
const traceId = '1234567890abcdef1234567890abcdef';
const leaked = [
  'hunter2',
  'sk-live-abcdefghijklmnopqrstuvwxyz0123',
  'sekret-cookie',
];
const text = (value: string) => ({ stringValue: value });
const resource = (service: string, version: string) => ({
  attributes: [
    { key: 'service.name', value: text(service) },
    { key: 'service.version', value: text(version) },
  ],
});
function exceptionEvent(
  message: string,
  line: number,
  extra: { key: string; value: unknown }[] = [],
) {
  return {
    name: 'exception',
    timeUnixNano: '1700000000000500000',
    attributes: [
      { key: 'exception.type', value: text('TypeError') },
      { key: 'exception.message', value: text(message) },
      {
        key: 'exception.stacktrace',
        value: text(
          `TypeError: ${message}\n    at loadUser (/srv/app/users.js:${line}:17)\n    at handler (/srv/app/routes.js:9:3)`,
        ),
      },
      { key: 'exception.escaped', value: { boolValue: true } },
      ...extra,
    ],
  };
}
function spans(
  service: string,
  version: string,
  items: { spanId: string; events: unknown[] }[],
) {
  return {
    resourceSpans: [
      {
        resource: resource(service, version),
        scopeSpans: [
          {
            spans: items.map((item) => ({
              traceId,
              spanId: item.spanId,
              kind: 2,
              name: 'GET /users/:id',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000000001000000',
              status: { code: 2 },
              events: item.events,
            })),
          },
        ],
      },
    ],
  };
}
const logs = {
  resourceLogs: [
    {
      resource: resource('worker', 'build-7'),
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: '1700000000002000000',
              severityNumber: 17,
              traceId,
              spanId: '00000000000000a1',
              body: text('job failed; cookie: sekret-cookie'),
              attributes: [
                {
                  key: 'log.record.uid',
                  value: text('01J8ZK4Q0000000000000000AB'),
                },
                { key: 'exception.type', value: text('JobError') },
                {
                  key: 'exception.message',
                  value: text(
                    'connect postgres://app:hunter2@db.internal/app failed after 3 tries',
                  ),
                },
                {
                  key: 'exception.stacktrace',
                  value: text(
                    'Traceback (most recent call last):\n  File "/srv/jobs/run.py", line 12, in main\n    run()\n  File "/srv/jobs/db.py", line 40, in connect\n    raise JobError()',
                  ),
                },
              ],
            },
            {
              timeUnixNano: '1700000000003000000',
              severityNumber: 9,
              body: text(
                'plain info line, api_key=sk-live-abcdefghijklmnopqrstuvwxyz0123',
              ),
            },
          ],
        },
      ],
    },
  ],
};

async function fixture(exceptions: boolean) {
  const sqlite = createCaptureSqliteFixture();
  for (const migration of captureMigrations) await migration.up(sqlite.db);
  const runtime = createCaptureRuntime({
    database: sqlite.db,
    normalizeStatement: createPostgresqlObservationNormalizer(),
    publish: () => {},
  });
  const assignments = createTelemetryAssignments();
  assignments.replace([
    {
      environmentId: 'production',
      tokenHash: createHash('sha256').update(token).digest('hex'),
      // The Environment's stored Exceptions opt-in (M1) travels with its token assignment.
      ...(exceptions ? { capabilities: { exceptions: true } } : {}),
    },
  ]);
  const receiver = await runtime.acquireReceiver({
    port: 0,
    context: { partition: '' },
    admit: (request) => assignments.admit(request),
  });
  const post = async (signal: 'traces' | 'logs', body: unknown) => {
    const response = await fetch(`${receiver.endpoint}/v1/${signal}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
  };
  return {
    sqlite,
    runtime,
    receiver,
    post,
    partition: 'environment:production',
    async close() {
      await receiver.release();
      await runtime.ingest.settled();
      sqlite.close();
    },
  };
}

describe('backend exception capture through the authenticated collector receiver and real SQLite', () => {
  it('projects enclosing request facts in one list read and retains only supplied, redacted source context in detail', async () => {
    const f = await fixture(true);
    try {
      const body = spans('api', 'build-41', [
        { spanId: '00000000000000a1', events: [] },
        { spanId: '00000000000000a2', events: [exceptionEvent('failed', 12, [
          { key: 'exception.source_context', value: text('before();\npassword=hunter2\nafter();') },
        ])] },
        { spanId: '00000000000000a3', events: [exceptionEvent('failed', 12)] },
      ]);
      const items = body.resourceSpans[0]!.scopeSpans[0]!.spans;
      Object.assign(items[0]!, { endTimeUnixNano: '1700000000412000000', attributes: [
        { key: 'http.response.status_code', value: { intValue: 500 } },
      ] });
      for (const child of items.slice(1)) Object.assign(child, { kind: 1, parentSpanId: '00000000000000a1' });
      await f.post('traces', body);
      const [group] = await f.runtime.store.exceptionGroups({ worktree: f.partition, limit: 10 });
      f.sqlite.statements.length = 0;
      const rows = await f.runtime.store.exceptionOccurrences({ worktree: f.partition, fingerprint: group!.fingerprint, limit: 10 });
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ httpStatusCode: 500, durationMs: 412 })]));
      expect(rows.every(row => 'httpStatusCode' in row && row.httpStatusCode === 500 && 'durationMs' in row && row.durationMs === 412)).toBe(true);
      expect(f.sqlite.statements).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain('sourceContext');
      const details = await Promise.all(rows.map(row => f.runtime.store.detail(f.partition, row.id, { fingerprint: row.fingerprint })));
      expect(JSON.stringify(details)).toContain('sourceContext');
      expect(JSON.stringify(details)).toContain('before();');
      expect(JSON.stringify(details)).not.toContain('hunter2');
      expect(details.filter(detail => JSON.stringify(detail).includes('sourceContext'))).toHaveLength(1);
      expect(await f.runtime.store.exceptionOccurrences({ worktree: 'other', fingerprint: group!.fingerprint, limit: 10 })).toEqual([]);
    } finally { await f.close(); }
  });

  it('stores each redacted exception occurrence once, groups by type, normalized message and top frame, and keeps stacks out of span detail', async () => {
    const f = await fixture(true);
    try {
      const body = spans('api', 'build-41', [
        {
          spanId: '00000000000000a1',
          events: [
            { name: 'request.start', timeUnixNano: '1700000000000000001' },
            exceptionEvent('user 1842 not found (password=hunter2)', 12),
          ],
        },
        {
          spanId: '00000000000000a2',
          events: [exceptionEvent('user 77 not found (password=hunter2)', 14)],
        },
        {
          spanId: '00000000000000a3',
          events: [
            exceptionEvent('custom grouping', 30, [
              { key: 'exception.fingerprint', value: text('checkout-timeout') },
            ]),
          ],
        },
      ]);
      await f.post('traces', body);
      // An exporter retry carries the same span/event positions and must not fabricate occurrences.
      await f.post('traces', body);
      await f.post(
        'traces',
        spans('billing', 'build-3', [
          {
            spanId: '00000000000000b1',
            events: [exceptionEvent('user 5 not found', 12)],
          },
        ]),
      );
      await f.post('logs', logs);

      const groups = await f.runtime.store.exceptionGroups({
        worktree: f.partition,
        limit: 10,
      });
      const byService = (service: string) =>
        groups.filter((group) => group.serviceName === service);
      expect(
        byService('api')
          .map((group) => group.count)
          .sort(),
      ).toEqual([1, 2]);
      const userGroup = byService('api').find((group) => group.count === 2)!;
      expect(userGroup).toMatchObject({
        type: 'TypeError',
        topFrame: 'loadUser (/srv/app/users.js)',
        lastServiceVersion: 'build-41',
      });
      expect(byService('billing')).toHaveLength(1);
      expect(byService('billing')[0]!.fingerprint).not.toBe(
        userGroup.fingerprint,
      );
      const worker = byService('worker');
      expect(worker).toEqual([
        expect.objectContaining({
          type: 'JobError',
          count: 1,
          topFrame: 'connect (/srv/jobs/db.py)',
        }),
      ]);

      const occurrences = await f.runtime.store.exceptionOccurrences({
        worktree: f.partition,
        fingerprint: userGroup.fingerprint,
        limit: 10,
      });
      expect(occurrences.map((item) => item.spanId).sort()).toEqual([
        '00000000000000a1',
        '00000000000000a2',
      ]);
      expect(occurrences[0]).toMatchObject({
        origin: 'span',
        traceId,
        serviceVersion: 'build-41',
        escaped: true,
      });
      const detail = await f.runtime.store.detail(
        f.partition,
        occurrences[0]!.id,
        { fingerprint: userGroup.fingerprint },
      );
      expect(JSON.stringify(detail)).toContain('at loadUser');
      const spanDetail = await f.runtime.store.detail(
        f.partition,
        `span:${traceId}:00000000000000a1`,
      );
      expect(JSON.stringify(spanDetail)).not.toContain('loadUser');

      const stored = JSON.stringify(
        [
          ...(await f.sqlite.db.query('SELECT * FROM captureExceptions')),
          ...(await f.sqlite.db.query('SELECT body FROM captureDetails')),
        ],
      );
      for (const secret of leaked) expect(stored).not.toContain(secret);
      expect(stored).toContain('[REDACTED]');
    } finally {
      await f.close();
    }
  });

  it('persists no exception enrichment when the Environment did not select Exceptions, while ordinary spans and redacted logs remain', async () => {
    const f = await fixture(false);
    try {
      await f.post(
        'traces',
        spans('api', 'build-41', [
          {
            spanId: '00000000000000a1',
            events: [exceptionEvent('boom password=hunter2', 12)],
          },
        ]),
      );
      await f.post('logs', logs);
      expect(
        await f.runtime.store.exceptionGroups({
          worktree: f.partition,
          limit: 10,
        }),
      ).toEqual([]);
      expect(
        await f.runtime.store.list({
          worktree: f.partition,
          kind: 'span',
          limit: 10,
        }),
      ).toHaveLength(1);
      const stored = JSON.stringify(
        await f.sqlite.db.query('SELECT body FROM captureDetails'),
      );
      expect(stored).not.toContain('hunter2');
      expect(stored).not.toContain('sekret-cookie');
      expect(stored).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz0123');
    } finally {
      await f.close();
    }
  });
});
