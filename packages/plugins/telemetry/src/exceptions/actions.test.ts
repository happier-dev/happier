import { describe, expect, it } from 'vitest';
import { PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { createInMemoryAccountCollection } from '@happier-dev/plugin-sdk/collections';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 as limits, type DaemonDatabase, type DaemonDatabaseRow, type DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';
import { resolveDeploymentTelemetryCapabilitiesV1 } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import * as database from '@happier-dev/database-protocol';
import { DATABASE_CAPTURE_PLUGIN } from '../manifest.js';
import { localCaptureBackground } from '../background.js';
import { captureMigrations } from '../store/capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';
import { startCollectorIssueProjection } from './collectorIssues.js';
import { TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1 } from './issueRecord.js';
import type { ExceptionIssueTransition } from './issueWriter.js';

const local = (id: string) =>
  database.databaseActionLocalIdV1(id as database.DatabaseActionIdV1);
const occurrence = (id: string, at: number, version: string) => ({
  kind: 'exception' as const,
  id,
  worktree: 'environment:env',
  at,
  fingerprint: 'fp-1',
  origin: 'span' as const,
  serviceName: 'api',
  serviceVersion: version,
  type: 'TypeError',
  message: 'cart <n> is undefined',
  topFrame: 'total (/srv/app/cart.js)',
  traceId: 't',
  spanId: 's',
  detail: {
    exception: {
      timeUnixNano: '0',
      type: 'TypeError',
      stacktrace: 'TypeError: x\n    at total (/srv/app/cart.js:4:9)',
    },
  },
});

describe('native exception Actions on the collector', () => {
  it.each([0, 137])('returns truthful counts for 100- and 101-bucket authored windows at offset %i across database pages', async (offset) => {
    const fixture = createCaptureSqliteFixture();
    // Preserve real SQLite and enforce the daemon host's per-query row boundary.
    const db: DaemonDatabase = {
      ...fixture.db,
      async query<T extends DaemonDatabaseRow>(statement: string, params: readonly DaemonDatabaseValue[] = []) {
        const rows = await fixture.db.query<T>(statement, params);
        if (rows.length > limits.maximumResultRows) {
          throw Object.assign(new Error('Host result row limit'), { code: 'daemon_database_result_too_large' });
        }
        return rows;
      },
    };
    for (const migration of captureMigrations) await migration.up(db);
    const storage = { daemon: { database: async () => db } } as unknown as PluginServices['storage'];
    const deploymentDatabases = {
      admitTelemetryRead: async () => ({
        environment: { serverId: 'home', environmentId: 'env', revision: 1 },
        collectorMachineId: 'collector',
        capabilities: resolveDeploymentTelemetryCapabilitiesV1({ exceptions: true }),
      }),
    } as unknown as PluginServices['deploymentDatabases'];
    const lease = await localCaptureBackground.acquireRuntime({
      signal: new AbortController().signal, services: { storage },
    });
    try {
      const host = await createPluginTestkit({
        manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
        services: { storage, deploymentDatabases },
      });
      const since = 17;
      const buckets = Array.from({ length: 101 }, (_, index) => ({
        since: since + index * 1000, until: since + (index + 1) * 1000, count: index % 3 + 1,
      }));
      await lease.runtime.store.write(buckets.flatMap((bucket, index) =>
        Array.from({ length: bucket.count }, (_, ordinal) => ({
          ...occurrence(`bucket:${index}:${ordinal}`, bucket.since + offset, 'build-1'),
          fingerprint: 'fp-paging', traceId: `trace-${index}`,
        })),
      ));
      const window = { since, until: since + 101_000, bucketMs: 1000 };
      const read = (until: number) => host.invokeAction(
        local(database.TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1),
        { serverId: 'home', environmentId: 'env', fingerprint: 'fp-paging', page: { limit: 1 }, window: { ...window, until } },
      );
      expect(await read(since + 100_000)).toMatchObject({ status: 'ok', trend: buckets.slice(0, 100), requestsAffected: 100 });
      expect.soft(await lease.runtime.store.exceptionTrend({ worktree: 'environment:env', fingerprint: 'fp-paging', ...window }))
        .toEqual({ buckets, requestsAffected: 101 });
      await expect(read(window.until)).resolves.toMatchObject({ status: 'ok', trend: buckets, requestsAffected: 101 });
    } finally {
      await lease.release();
      fixture.close();
    }
  });

  it('admits each request through R16, reads occurrences on demand, and routes lifecycle edits only to the single writer', async () => {
    const fixture = createCaptureSqliteFixture();
    for (const migration of captureMigrations) await migration.up(fixture.db);
    // Daemon database, host admission and Account storage are SDK process boundaries; the plugin, store and writer are real.
    const storage = {
      daemon: { database: async () => fixture.db },
    } as unknown as PluginServices['storage'];
    let exceptions = true;
    let refuse = false;
    let admissions = 0;
    const deploymentDatabases = {
      admitTelemetryRead: async (input: { environmentId: string }) => {
        admissions += 1;
        if (refuse)
          throw new PluginError({ code: 'deployment_access_denied', message: 'denied' });
        return {
          environment: {
            serverId: 'home',
            environmentId: input.environmentId,
            revision: 1,
          },
          collectorMachineId: 'collector',
          capabilities: resolveDeploymentTelemetryCapabilitiesV1({
            exceptions,
          }),
        };
      },
    } as unknown as PluginServices['deploymentDatabases'];
    const lease = await localCaptureBackground.acquireRuntime({
      signal: new AbortController().signal,
      services: { storage },
    });
    const host = await createPluginTestkit({
      manifest: DATABASE_CAPTURE_PLUGIN.manifest,
      module: DATABASE_CAPTURE_PLUGIN,
      services: { storage, deploymentDatabases },
    });
    let projection:
      | ReturnType<typeof startCollectorIssueProjection>
      | undefined;
    try {
      await lease.runtime.store.write([
        occurrence('exception:a', 1000, 'build-1'),
        occurrence('exception:b', 2000, 'build-1'),
      ]);
      const read = (extra: object = {}) =>
        host.invokeAction(
          local(database.TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1),
          {
            serverId: 'home',
            environmentId: 'env',
            fingerprint: 'fp-1',
            page: { limit: 1 },
            ...extra,
          },
        );
      const page = await read({ occurrenceId: 'exception:b' });
      expect(page).toMatchObject({
        status: 'ok',
        items: [{ id: 'exception:b', serviceVersion: 'build-1' }],
        nextCursor: { at: 2000, id: 'exception:b' },
        stacktrace: expect.stringContaining('at total'),
      });
      // J2 detail: the 7-day trend and Requests affected come from the same retained occurrences.
      expect(await read({ window: { since: 0, until: 3000, bucketMs: 1000 } })).toMatchObject({
        status: 'ok',
        trend: [
          { since: 0, until: 1000, count: 0 },
          { since: 1000, until: 2000, count: 1 },
          { since: 2000, until: 3000, count: 1 },
        ],
        requestsAffected: 1,
      });
      await expect(read({ window: { since: 0, until: 0, bucketMs: 1 } })).rejects.toMatchObject({ code: 'invalid_parameters' });
      exceptions = false;
      expect(await read()).toEqual({ status: 'disabled' });
      exceptions = true;

      const transition = (action: string) =>
        host.invokeAction(
          local(database.TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1),
          {
            serverId: 'home',
            environmentId: 'env',
            issueId: 'missing',
            action,
          },
        );
      await expect(transition('resolve')).rejects.toMatchObject({
        code: 'telemetry_issue_writer_unavailable',
      });

      const account = createInMemoryAccountCollection({
        definition: TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1,
        pluginId: 'happier.telemetry',
      });
      const published: ExceptionIssueTransition[] = [];
      projection = startCollectorIssueProjection({
        account: { collection: () => account.collection } as never,
        runtime: lease.runtime,
        publish: async (transition) => {
          published.push(transition);
        },
        teamOf: () => undefined,
      });
      const refresh = await host.invokeAction(
        local(database.TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1),
        { serverId: 'home', environmentId: 'env' },
      );
      expect(refresh).toEqual({ projection: 'ready' });
      const [row] = (
        await account.collection.query({
          index: 'by-environment',
          order: 'asc',
        })
      ).rows;
      const resolved = await host.invokeAction(
        local(database.TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1),
        {
          serverId: 'home',
          environmentId: 'env',
          issueId: row!.rowId,
          action: 'resolve',
          version: 'build-2',
        },
      );
      expect(resolved).toMatchObject({
        status: 'applied',
        issue: { status: 'resolved', count: 2 },
      });
      expect(published.map((item) => item.phase)).toEqual(['open', 'resolved']);
      // Another Environment's principal cannot address this record through its own admission.
      expect(
        await host.invokeAction(
          local(database.TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1),
          {
            serverId: 'home',
            environmentId: 'other',
            issueId: row!.rowId,
            action: 'reopen',
          },
        ),
      ).toEqual({ status: 'absent' });
      refuse = true;
      await expect(transition('reopen')).rejects.toMatchObject({
        code: 'deployment_access_denied',
      });
      expect(published).toHaveLength(2);
      expect(admissions).toBe(9);
    } finally {
      projection?.stop();
      await lease.release();
      fixture.close();
    }
  });
});
