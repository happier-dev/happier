import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { describe, expect, it } from 'vitest';
import { createCanonicalJsonSigningInput, PluginError, type JsonValue, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestkitInvokeActionOptions } from '@happier-dev/plugin-sdk/testing';
import type { PluginAccountStorageScope, StorageScopeService } from '@happier-dev/plugin-sdk/storage';
import { DATABASE_PLUGIN_ID_V1 } from '@happier-dev/plugin-sdk/database';
import * as database from '@happier-dev/database-protocol';
import { localCaptureBackground } from './background.js';
import { captureSourcePartition } from './partition.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';
import { captureMigrations } from './store/capture.js';
import { DATABASE_CAPTURE_PLUGIN } from './manifest.js';
import { PLUGIN_MANIFEST as workbenchManifest, plugin as workbenchPlugin } from '../../database-workbench/src/manifest.js';
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

const databaseTarget = {
  kind: 'worktree', accountId: 'alice', installationId: 'install', projectKey: 'project',
  workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/workspace' },
  source: { kind: 'service', serviceId: 'web', variable: 'DATABASE_URL' },
} as const;

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
  it('admits Worktree app telemetry for agents while enforcing the exact target for database evidence', async () => {
    const entries = new Map<string, JsonValue>();
    const storage: StorageScopeService = {
      async get<T extends JsonValue = JsonValue>(key: string) { return (entries.get(key) ?? null) as T | null; },
      async set(key, value) { entries.set(key, value); },
      async delete(key) { entries.delete(key); },
      async list() { return { items: [...entries.keys()].map(key => ({ key })) }; },
      consistency() { return { kind: 'authoritativeSerializable' }; },
      async transaction(run) { return run(storage); },
    };
    const workbench = await createPluginTestkit({ manifest: workbenchManifest, module: workbenchPlugin,
      services: { storage: {
        daemon: { ...storage, async database() { throw new Error('No Workbench database requested'); } },
        daemonSession: storage, ephemeral: storage,
      } } });
    const launch = workbench.registration('serviceLaunchEnvironments', 'database-discovery');
    if (!launch) throw new Error('Missing database discovery contribution');
    const retained = await launch.prepare({
      workspace: { ...databaseTarget.workspace, id: source.workspaceId, projectKey: source.projectId },
      project: { serverId: source.serverId, projectId: source.projectId },
      requester: { accountId: databaseTarget.accountId, installationId: databaseTarget.installationId },
      serviceId: databaseTarget.source.serviceId, physicalRootIdentity: databaseTarget.workspace.rootPath,
      executionPlacement: { mode: 'spawn', machineId: source.machineId }, assignedPorts: {},
      async readEnvironment() {
        return { projectedEnvironment: {
          DATABASE_URL: 'postgresql://localhost/selected', OTHER_DATABASE_URL: 'postgresql://localhost/neighbor',
        }, provenance: {} };
      },
    });
    const f = await setup();
    try {
      const worktree = captureSourcePartition(source, 'alice');
      const traceId = 'trace';
      const selected = retained.worktreeDatabaseMembers?.find(member => member.source.variable === 'DATABASE_URL');
      const neighbor = retained.worktreeDatabaseMembers?.find(member => member.source.variable === 'OTHER_DATABASE_URL');
      expect(selected).toEqual(databaseTarget);
      if (!selected || !neighbor) throw new Error('Expected attributed database members');
      const selectedKey = createCanonicalJsonSigningInput(selected);
      const neighborKey = createCanonicalJsonSigningInput(neighbor);
      await f.lease.runtime.store.write([
        { id: 'request', worktree, traceId, kind: 'span', source: 'otlp', at: 1, spanId: 'request', spanKind: 2 },
        ...[1, 2, 3].flatMap(n => [
          { id: `selected-${n}`, worktree, traceId, kind: 'query' as const, source: 'wire' as const, at: 2,
            spanId: `db-${n}`, executionIdentity: `exec-${n}`, databaseMemberKey: selectedKey,
            shape: 'SELECT name FROM items WHERE id = ?', statementKind: 'select' as const, parameterIdentity: String(n),
            detail: { sql: 'selected' } },
          { id: `otlp-${n}`, worktree, traceId, kind: 'query' as const, source: 'otlp' as const, at: 2,
            spanId: `db-${n}`, spanKind: 3, parentSpanId: 'request', executionIdentity: `exec-${n}` },
        ]),
        { id: 'unassigned', worktree, traceId, kind: 'query', source: 'wire', at: 3, parentSpanId: 'request',
          shape: 'SELECT unassigned', detail: { sql: 'unassigned' } },
        { id: 'neighbor', worktree, traceId, kind: 'query', source: 'wire', at: 3, parentSpanId: 'request',
          databaseMemberKey: neighborKey, shape: 'SELECT neighbor', detail: { sql: 'neighbor' } },
      ]);
      const scoped = { source, databaseTarget };
      const selectedIds = ['selected-3', 'selected-2', 'selected-1'];
      const list = local(database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1);
      const detail = local(database.DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1);
      const trace = local(database.DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1);
      const person = { ...owner, agentCaller: false, authority: 'present_user' as const };
      const agent = { ...person, agentCaller: true };
      function invoke(localId: string, input: JsonValue, caller: PluginTestkitInvokeActionOptions) {
        // The testkit does not stamp a Machine admission on cross-plugin calls. Supply the
        // original caller at that transport boundary and run the real Workbench Action.
        const actions = { async execute(ref: unknown, operands: JsonValue) {
          const admission = local(database.DATABASE_ACCESS_READ_ACTION_ID_V1);
          expect(ref).toEqual({ pluginId: DATABASE_PLUGIN_ID_V1, localId: admission });
          return workbench.invokeAction(admission, operands, { ...caller, surface: 'plugin' });
        } } as PluginServices['actions'];
        return f.host.invokeAction(localId, input, { ...caller, services: { actions } });
      }
      const listResult = database.DatabaseCaptureQueriesListResultV1Schema.parse(
        await invoke(list, { ...scoped, page }, person));
      expect(listResult.ok && listResult.items.map(row => row.id)).toEqual(selectedIds);
      const worktreeResult = database.DatabaseCaptureQueriesListResultV1Schema.parse(
        await invoke(list, { source, page }, person));
      expect(worktreeResult.ok && worktreeResult.items.map(row => row.id))
        .toEqual(expect.arrayContaining([...selectedIds, 'unassigned', 'neighbor']));
      expect(await invoke(detail, { ...scoped, id: 'selected-1' }, person))
        .toMatchObject({ ok: true, detail: { sql: 'selected' } });
      for (const id of ['neighbor', 'unassigned']) {
        expect(await invoke(detail, { ...scoped, id }, person)).toMatchObject({ ok: true, detail: null });
      }
      await workbench.invokeAction(local(database.DATABASE_ACCESS_SET_ACTION_ID_V1), { target: databaseTarget, agentAccess: 'read' }, person);
      const traceResult = database.DatabaseCaptureTraceGetResultV1Schema.parse(
        await invoke(trace, { ...scoped, traceId, page: { limit: 2 } }, agent));
      expect(traceResult.ok && traceResult.summaries.map(row => row.id)).toEqual(selectedIds);
      expect(traceResult).toMatchObject({ ok: true, repeatedQueries: [
        { kind: 'suspected_n_plus_one', repetitionCount: 3, observationIds: expect.arrayContaining(selectedIds) },
      ] });
      await expect(invoke(list, { ...scoped, page }, { ...person, ...other }))
        .rejects.toMatchObject({ code: 'database_target_unavailable' });
      await expect(invoke(list, { ...scoped, source: { ...source, workspaceId: 'different' }, page }, person))
        .rejects.toMatchObject({ code: 'capture_source_unavailable' });
      await workbench.invokeAction(local(database.DATABASE_ACCESS_SET_ACTION_ID_V1), { target: databaseTarget, agentAccess: 'none' }, person);
      await expect(invoke(list, { ...scoped, page }, agent)).rejects.toMatchObject({ code: 'database_agent_access_none' });
      await expect(invoke(list, { source, page }, agent)).rejects.toMatchObject({ code: 'database_target_required' });
      await expect(invoke(detail, { source, id: 'selected-1' }, agent))
        .rejects.toMatchObject({ code: 'database_target_required' });
      await expect(invoke(trace, { source, traceId, page }, agent))
        .rejects.toMatchObject({ code: 'database_target_required' });

      const appReads = [
        [database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1, { source }],
        [database.DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, { source, page }],
        [database.DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1, { source, page }],
        [database.DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1, { source, page }],
        [database.TELEMETRY_COSTS_READ_ACTION_ID_V1, { source, since: 0, until: 10, granularity: 'hour' }],
      ] as const;
      for (const [action, input] of appReads) {
        const personResult = await invoke(local(action), input, person);
        expect(personResult).toMatchObject({ ok: true, source });
        await expect(invoke(local(action), input, agent)).resolves.toEqual(personResult);
      }
    } finally {
      await f.close();
      if (retained.kind === 'unchanged') await retained.release?.();
      await workbench.dispose();
    }
  });

  it('configures production findings with the admitted collector and no requester Machine', async () => {
    const f = await setup();
    try {
      const prepared = await f.host.invokeAction(TELEMETRY_PRODUCTION_FINDING_SETUP_ACTION_LOCAL_ID_V1,
        { v: 1, source: environment }, { requesterAccount: { accountId: 'alice' } });
      expect(prepared).toMatchObject({ sourceConfig: { v: 1, subject: environment } });
      expect(f.telemetryReads()).toBe(1);
    } finally { await f.close(); }
  });

  it('reports unavailable when the exact production trace in a finding is no longer retained', async () => {
    const f = await setup(true);
    const traceId = 'checkout-trace';
    const read = (scope: typeof environment) => f.host.invokeAction(
      local(database.DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1), { source: scope, traceId, page }, owner,
    );
    try {
      const neighbor = { ...environment, environmentId: 'neighbor' };
      for (const scope of [environment, neighbor]) {
        await f.lease.runtime.ingest.write([{
          id: 'failed-request', worktree: captureSourcePartition(scope, undefined), traceId,
          at: 1_000, kind: 'span', source: 'otlp', spanId: 'request', spanKind: 2,
          endpointMethod: 'GET', endpointRoute: '/checkout', httpStatusCode: 503,
        }]);
      }
      const retained = database.DatabaseCaptureTraceGetResultV1Schema.parse(await read(environment));
      expect(retained).toMatchObject({ ok: true, findings: [{ kind: 'failing_endpoint' }] });
      if (!retained.ok || !retained.findings?.[0]) throw new Error('Missing retained finding');
      const verification = retained.findings[0].verification.readBefore.input;
      expect(verification).toEqual({ source: environment, traceId, page });
      await f.host.invokeAction(local(database.DATABASE_CAPTURE_CLEAR_ACTION_ID_V1), { source: environment }, owner);
      await expect(f.host.invokeAction(local(database.DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1), verification, owner))
        .resolves.toEqual({ ok: false, status: 'unavailable', code: 'capture_read_expired', reason: 'trace_expired' });
      await expect(read(neighbor)).resolves.toMatchObject({ ok: true, source: neighbor, traceId });
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
