import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { describe, expect, it } from 'vitest';
import { PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import * as database from '@happier-dev/database-protocol';
import { localCaptureBackground } from './background.js';
import { captureSourcePartition } from './partition.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';
import { captureMigrations } from './store/capture.js';
import { DATABASE_CAPTURE_PLUGIN } from './manifest.js';
import { TELEMETRY_PRODUCTION_FINDING_SETUP_ACTION_LOCAL_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';

const source = {
  kind: 'worktree' as const,
  serverId: 'home',
  machineId: 'machine',
  projectId: 'project',
  workspaceId: 'workspace',
};
const environment = {
  kind: 'environment' as const,
  serverId: 'home',
  environmentId: 'app',
};
const owner = {
  requesterAccount: { accountId: 'alice' },
  chosenMachine: { machineId: 'machine', installationId: 'install' },
};
const other = { ...owner, requesterAccount: { accountId: 'bob' } };
const local = (actionId: database.DatabaseActionIdV1) =>
  databaseActionLocalIdV1(actionId);
const page = { limit: 10 };

function memoryAccountStorage(): Readonly<{
  storage: PluginAccountStorageScope;
  values: Map<string, unknown>;
}> {
  const values = new Map<string, unknown>();
  const versions = new Map<string, number>();
  const tx = {
    async get(key: string) {
      return values.has(key)
        ? { version: versions.get(key)!, value: values.get(key) as never }
        : null;
    },
    async set(key: string, value: unknown) {
      const version = (versions.get(key) ?? 0) + 1;
      values.set(key, value);
      versions.set(key, version);
      return { version };
    },
    async delete() {
      throw new Error('Unused persistence operation');
    },
  };
  // Account KV is the persistence boundary owned by the SDK host.
  const storage = {
    kv: {
      ...tx,
      async list() {
        return { items: [] };
      },
      async transaction(run: (t: typeof tx) => unknown) {
        return await run(tx);
      },
    },
    collection() {
      throw new Error('Unused persistence operation');
    },
  } as unknown as PluginAccountStorageScope;
  return { storage, values };
}

async function setup(canClear = false) {
  const fixture = createCaptureSqliteFixture(),
    lifetime = new AbortController();
  for (const migration of captureMigrations) await migration.up(fixture.db);
  const account = memoryAccountStorage();
  const storage = {
    daemon: { database: async () => fixture.db },
    account: account.storage,
  } as unknown as PluginServices['storage'];
  let telemetryReads = 0;
  let assignmentStamped: boolean | undefined;
  const deploymentDatabases = {
    async admitTelemetryClear() {
      if (!canClear) throw new PluginError({ code: 'source_access_denied' });
    },
    async admitTelemetryRead() {
      telemetryReads++;
      return {
        environment: { serverId: 'home', environmentId: 'app', revision: 1 },
        collectorMachineId: 'machine',
        capabilities: { queries: true, traces: true, appLlmCost: true },
        assignmentStamped,
      };
    },
  } as unknown as PluginServices['deploymentDatabases'];
  const lease = await localCaptureBackground.acquireRuntime({
    signal: lifetime.signal,
    services: { storage },
  });
  const host = await createPluginTestkit({
    manifest: DATABASE_CAPTURE_PLUGIN.manifest,
    module: DATABASE_CAPTURE_PLUGIN,
    services: { storage, deploymentDatabases },
  });
  return {
    fixture,
    lease,
    host,
    account,
    telemetryReads: () => telemetryReads,
    setAssignmentStamped(value: boolean) { assignmentStamped = value; },
    async close() {
      lifetime.abort();
      await host.dispose();
      await lease.release();
      fixture.close();
    },
  };
}

describe('R2-A3 local capture Source/project admission through the real manifest', () => {
  it('configures production findings with the admitted collector and no requester Machine', async () => {
    const f = await setup();
    try {
      const prepared = await f.host.invokeAction(TELEMETRY_PRODUCTION_FINDING_SETUP_ACTION_LOCAL_ID_V1,
        { v: 1, source: environment }, { requesterAccount: { accountId: 'alice' } });
      expect(prepared).toMatchObject({ sourceConfig: { v: 1, subject: environment } });
      expect(f.telemetryReads()).toBe(1);
    } finally { await f.close(); }
  });

  it("admits a worktree source for the Account that recorded it, and nobody else reads that Account's rows", async () => {
    const f = await setup();
    try {
      const partition = captureSourcePartition(source, 'alice');
      await f.lease.runtime.store.write([
        {
          id: 'q1',
          worktree: partition,
          kind: 'query',
          source: 'wire',
          at: 1,
          shape: 'select ?',
        },
      ]);
      const list = (options: typeof owner) =>
        f.host.invokeAction(
          local(database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1),
          { source, page },
          options,
        );
      expect(await list(owner)).toMatchObject({
        ok: true,
        source,
        items: [{ id: 'q1' }],
      });
      // Another person names the same source and reads only their own (empty) partition.
      expect(await list(other)).toMatchObject({ ok: true, items: [] });
      await expect(
        f.host.invokeAction(
          local(database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1),
          { source, page },
          {
            ...owner,
            chosenMachine: {
              machineId: 'elsewhere',
              installationId: 'install',
            },
          },
        ),
      ).rejects.toMatchObject({ code: 'capture_source_unavailable' });
      await expect(
        f.host.invokeAction(
          local(database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1),
          { source, page },
          { chosenMachine: owner.chosenMachine },
        ),
      ).rejects.toMatchObject({ code: 'capture_source_unavailable' });
      expect(f.telemetryReads()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it.each([true, false])("clears only the selected partitions with Environment write admission (%s)", async canClear => {
    const f = await setup(canClear);
    try {
      const mine = captureSourcePartition(source, 'alice'),
        theirs = captureSourcePartition(source, 'bob');
      const shared = captureSourcePartition(environment, undefined);
      await f.lease.runtime.store.write([
        { id: 'a', worktree: mine, kind: 'query', source: 'wire', at: 1 },
        { id: 'b', worktree: theirs, kind: 'query', source: 'wire', at: 1 },
        { id: 'e', worktree: shared, kind: 'query', source: 'otlp', at: 1 },
      ]);
      const clear = local(database.DATABASE_CAPTURE_CLEAR_ACTION_ID_V1);
      expect(await f.host.invokeAction(clear, { source }, owner)).toEqual({
        ok: true,
      });
      expect(
        await f.lease.runtime.store.list({
          worktree: mine,
          kind: 'query',
          limit: 10,
        }),
      ).toHaveLength(0);
      expect(
        await f.lease.runtime.store.list({
          worktree: theirs,
          kind: 'query',
          limit: 10,
        }),
      ).toHaveLength(1);
      if (canClear) {
        expect(await f.host.invokeAction(clear, { source: environment }, owner)).toEqual({ ok: true });
      } else {
        await expect(f.host.invokeAction(clear, { source: environment }, owner))
          .rejects.toMatchObject({ code: 'source_access_denied' });
      }
      expect(f.telemetryReads()).toBe(0);
      expect(
        await f.lease.runtime.store.list({
          worktree: shared,
          kind: 'query',
          limit: 10,
        }),
      ).toHaveLength(canClear ? 0 : 1);
    } finally {
      await f.close();
    }
  });

  it('reports Environment readiness from the serving assignment and retained selected samples', async () => {
    const f = await setup();
    const action = local(database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1);
    const status = () => f.host.invokeAction(action, { source: environment }, owner);
    const partition = captureSourcePartition(environment, undefined);
    try {
      f.setAssignmentStamped(false);
      await expect(status()).resolves.toMatchObject({ environmentReadiness: 'redeploy_required', lastReceivedAt: null });
      f.setAssignmentStamped(true);
      await f.lease.runtime.ingest.write([
        { id: 'neighbor', at: 2_000, worktree: 'environment:other', kind: 'span', source: 'otlp' },
      ]);
      await expect(status()).resolves.toMatchObject({ environmentReadiness: 'waiting_for_first_data', lastReceivedAt: null });
      await f.lease.runtime.ingest.write([
        { id: 'selected', at: 1_000, worktree: partition, kind: 'span', source: 'otlp' },
      ]);
      await expect(status()).resolves.toMatchObject({ environmentReadiness: 'receiving', lastReceivedAt: 1_000 });
      f.setAssignmentStamped(false);
      await expect(status()).resolves.toMatchObject({ environmentReadiness: 'redeploy_required', lastReceivedAt: 1_000 });
      f.setAssignmentStamped(true);
      await expect(status()).resolves.toMatchObject({ environmentReadiness: 'receiving', lastReceivedAt: 1_000 });
    } finally {
      await f.close();
    }
  });

  it("reaches Configure for a project on the executing Machine and refuses another Machine's project", async () => {
    const f = await setup();
    try {
      const configure = local(database.DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1);
      const project = {
        serverId: 'home',
        machineId: 'machine',
        projectId: 'project',
      };
      const status = local(database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1);
      await expect(f.host.invokeAction(status, { source }, owner)).resolves.toMatchObject({ enabled: false });
      expect(
        await f.host.invokeAction(configure, { project, enabled: true }, owner),
      ).toEqual({ ok: true, enabled: true });
      expect([...f.account.values.values()]).toEqual([true]);
      await expect(f.host.invokeAction(status, { source }, owner)).resolves.toMatchObject({ enabled: true });
      await expect(f.host.invokeAction(status, { source: environment }, owner)).resolves.not.toHaveProperty('enabled');
      await expect(
        f.host.invokeAction(
          configure,
          { project: { ...project, machineId: 'elsewhere' }, enabled: true },
          owner,
        ),
      ).rejects.toMatchObject({ code: 'capture_source_unavailable' });
    } finally {
      await f.close();
    }
  });
});
