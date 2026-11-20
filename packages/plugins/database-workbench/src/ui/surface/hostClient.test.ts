import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    DATABASE_CONNECTION_RESOURCE_ID_V1,
    type DatabaseSelectedRowsExportInputV1,
} from '@happier-dev/database-protocol';
import { DatabaseOperationInputV1Schema, type DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { computeSha256HexDigest, PluginError } from '@happier-dev/plugin-sdk';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiSemanticSurfaceAdapter, type PluginUiTestkitHostHandlers } from '@happier-dev/plugin-sdk/testing';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiHostApi, ResourceContent } from '@happier-dev/plugin-sdk/ui';
import type { PluginDynamicResourceInvocationOptionsV1 } from '@happier-dev/plugin-sdk/resources';
import { createHostWorkbenchClient } from './hostClient.js';
import { workbenchTargetKey, createWorkbenchInstance } from '../workbench.js';
import { createDatabaseConnectionResourceRuntime } from '../../resources.js';
import { openManualDatabaseConnection } from '../../connection.js';

const adapter: PluginUiSemanticSurfaceAdapter<null> = { async mount() { return {
  async snapshot() { return { revision: 1, nodes: [] }; }, async update() {}, async invoke() {}, async dispose() {},
}; } };

function createHostFixture(instanceId: string, handlers: PluginUiTestkitHostHandlers = {}) {
  return createPluginUiTestkit({
    identity: { instanceId, mountNonce: 'workbench-test' },
    authorPlugin: { id: 'happier.database', version: '0.0.0' },
    surface: null, surfaceContext: createSurfaceContextFixture(), adapter, handlers,
  });
}

it('saves an export through the host download owner and the export download Action, with the rows and completeness it was given', async () => {
  const downloadFile = vi.fn<NonNullable<PluginUiTestkitHostHandlers['downloadFile']>>(async () => ({
    success: true, status: 'completed', transferId: 't1', destinationId: 'd1', name: 'invoices.csv', sizeBytes: 32, sha256: 'a'.repeat(64),
  }));
  const fixture = await createHostFixture('save-export', { downloadFile });
  try {
    const client = createHostWorkbenchClient(fixture.context.hostApi, { pageLocation: false });
    const result: DatabaseSelectedRowsExportInputV1['result'] = {
      columns: [{ name: 'id', nativeType: 'int8', semanticType: 'integer', nullable: false }],
      rows: [{ cells: [{ type: 'integer', value: '48212' }] }],
      completeness: { complete: false, reason: 'page', continuation: { kind: 'offset',
        binding: { target: createDatabaseDescriptorV1Fixture().target,
          relation: { schema: 'public', name: 'invoices' }, columns: [], order: [] }, offset: 1 } },
    };
    await expect(client.saveExport({ format: 'csv', result })).resolves.toMatchObject({ success: true, status: 'completed' });
    expect(downloadFile).toHaveBeenCalledTimes(1);
    const [{ request }] = downloadFile.mock.calls[0]!;
    // The host fills the destination; the plugin names the Action and hands over exactly what it serializes.
    expect(request.action).toEqual({ pluginId: 'happier.database', localId: 'rows/export-download' });
    expect(request.input).not.toHaveProperty('destination');
    expect(request.input).toMatchObject({ format: 'csv', result: { completeness: { complete: false } } });
  } finally { await fixture.dispose(); }
});

it('preserves demand admission refusal without reconnecting through an ordinary Action', async () => {
  const unavailable = vi.fn(() => { throw new Error('A refused demand never falls back to another read path'); });
  const fixture = await createHostFixture('refused-demand', { readResource: unavailable, executeAction: unavailable });
  const client = createHostWorkbenchClient({
    ...fixture.context.hostApi,
    async watchResource() { throw new PluginError({ code: 'database_read_unavailable' }); },
  }, { pageLocation: false });
  const release = client.subscribeOwnWrites(() => {});
  try {
    await expect(client.operation({ operation: 'describe', target: createDatabaseDescriptorV1Fixture().target }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'database_read_unavailable' });
    expect(unavailable).not.toHaveBeenCalled();
  } finally {
    release();
    await fixture.dispose();
  }
});

it('shares one admitted demand when the same target arrives in a different property order', async () => {
  const descriptor = createDatabaseDescriptorV1Fixture();
  const signal = new AbortController().signal;
  const watchResource = vi.fn<PluginUiHostApi['watchResource']>().mockRejectedValue(new PluginError({ code: 'database_read_unavailable' }));
  const fixture = await createHostFixture('canonical-target');
  const client = createHostWorkbenchClient({ ...fixture.context.hostApi, watchResource }, { pageLocation: false });
  const reordered = Object.fromEntries(Object.entries(descriptor.target).reverse());
  try {
    await expect(client.operation({ operation: 'describe', target: descriptor.target }, signal)).rejects.toMatchObject({ code: 'database_read_unavailable' });
    const target = DatabaseOperationInputV1Schema.parse({ operation: 'describe', target: reordered }).target;
    // Simulate a second source carrying the same already typed target with different insertion order.
    const fromLaunch = Object.assign(reordered, target) as typeof target;
    await expect(client.operation({ operation: 'describe', target: fromLaunch }, signal)).rejects.toMatchObject({ code: 'database_read_unavailable' });
    expect(watchResource).toHaveBeenCalledTimes(1);
  } finally {
    client.dispose();
    await fixture.dispose();
  }
});

it('retains each mounted target demand and refreshes both workbenches from producer revisions only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dbw-host-demand-'));
  const path = join(directory, 'database.sqlite');
  const database = openSqliteDatabaseSync(path);
  database.exec("CREATE TABLE first(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO first VALUES(1, 'before'); CREATE TABLE second(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO second VALUES(1, 'before');");
  database.close();
  const target = { kind: 'manual' as const, accountId: 'account', installationId: 'installation', projectKey: 'project',
    savedSecretId: 'selected', workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } };
  const descriptor: DatabaseDescriptorV1 = { target, label: 'Selected', engine: 'sqlite', origin: { label: 'Manual' },
    capabilities: [], access: { canRead: true, canWrite: true }, placement: {
      serverId: 'home', accountId: 'account', machineId: 'machine', installationId: 'installation',
    } };
  let connections = 0;
  let releases = 0;
  let reads = 0;
  const readInvocations: string[] = [];
  const controllers = [new AbortController(), new AbortController()];
  const runtime = createDatabaseConnectionResourceRuntime({ resolve: async input => {
    connections++;
    return { descriptor, connection: await openManualDatabaseConnection({ target,
      secretValue: await input.secrets.readSavedSecret(target.savedSecretId), access: 'read', signal: input.signal }) };
  } });
  const unavailable = () => { throw new Error('No nested Action or resource call'); };
  const producers = await Promise.all(controllers.map(async controller => {
    const options: PluginDynamicResourceInvocationOptionsV1 = { signal: controller.signal,
      context: { kind: 'surface', mountInstanceKey: String(controllers.indexOf(controller)), launchInput: { operation: 'describe', target } },
      requesterAccount: { accountId: 'account' }, secrets: { readSavedSecret: async () => pathToFileURL(path).toString() },
      resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
      readAction: unavailable, observeAction: unavailable };
    const producer = await runtime.createProducer!(options);
    return { producer, options };
  }));
  const mounts = await Promise.all(producers.map(async ({ producer, options }, index) => {
    let subscriptionId: string | undefined;
    const content = async (): Promise<ResourceContent> => {
      reads++;
      const text = String(await producer.read(options));
      return { contentType: 'application/json', digest: `sha256:${computeSha256HexDigest(text)}`, bytes: new TextEncoder().encode(text) };
    };
    // Only the host transport is substituted. Resource producer, SQLite reads, cache and drafts are real.
    const fixture = await createHostFixture(`mounted-${index}`, {
      readResource: content,
      async watchResource({ signal }) {
        const observation = await producer.observe(async () => {
          const value = await content();
          if (!signal.aborted) fixture.invalidateResource(DATABASE_CONNECTION_RESOURCE_ID_V1, value.digest);
        }, options);
        signal.addEventListener('abort', () => { releases++; void observation.dispose(); }, { once: true });
        return { digest: (await content()).digest };
      },
      async executeAction({ input: operand }) {
        const input = DatabaseOperationInputV1Schema.parse(operand);
        expect(subscriptionId).toBeDefined();
        expect(input.subscriptionId, 'read invokes the already admitted mounted demand').toBe(subscriptionId);
        readInvocations.push(input.operation);
        return projectNativeJsonValueForTransport(await producer.invoke!(input, { signal: options.signal }));
      },
      setUnsavedChanges: async () => {},
    });
    const hostApi = fixture.context.hostApi;
    const host: PluginUiHostApi = {
      ...hostApi,
      async watchResource(...args) {
        const handle = await hostApi.watchResource(...args);
        subscriptionId = handle.subscriptionId;
        return handle;
      },
    };
    const targetKey = workbenchTargetKey(target);
    const instance = createWorkbenchInstance({ client: createHostWorkbenchClient(host, { pageLocation: false }),
      scope: { ...target, kind: 'worktree' }, selectedTarget: descriptor,
      location: { targetKey, relation: { schema: 'main', name: 'first' }, mode: 'data', sort: [], columns: ['id', 'label'], page: { rows: 40, offset: 0 }, fkTrail: [] },
      cataloguePageRows: 40, statementRanges: () => [], consoleStorage: () => ({ read: async () => null, write: async () => {} }) });
    return { fixture, instance };
  }));
  const instances = mounts.map(mount => mount.instance);
  try {
    const pages = instances.flatMap(instance => ['first', 'second'].map(name => instance.page({ ...instance.local.get('location'), relation: { schema: 'main', name } })));
    await Promise.all(pages.map(page => page.demand()));
    const before = [...readInvocations];
    const held = pages.map(page => page.get().data);
    for (const { producer } of producers) await producer.notify!({ target: { ...target, savedSecretId: 'unrelated' } });
    await Promise.all(pages.map(page => page.demand()));
    expect(readInvocations).toEqual(before);
    expect(pages.map(page => page.get().data)).toEqual(held);
    const write = await openManualDatabaseConnection({ target, secretValue: pathToFileURL(path).toString(), access: 'write' });
    try {
      expect(await write.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
        statements: [{ sql: "UPDATE first SET label='after';", parameters: [] }, { sql: "UPDATE second SET label='after';", parameters: [] }] }))
        .toMatchObject({ ok: true });
    } finally { await write.close(); }
    for (const { producer } of producers) {
      await producer.notify!({ target, relation: { schema: 'main', name: 'first' } });
      await producer.notify!({ target, relation: { schema: 'main', name: 'second' } });
    }
    await vi.waitFor(async () => {
      await Promise.all(pages.map(page => page.demand()));
      for (const page of pages) expect(page.get().data?.rows[0]?.cells[1]).toMatchObject({ value: 'after' });
    });
    expect(connections).toBe(2);
    expect(reads).toBeGreaterThan(0);
    instances.forEach(instance => instance.close());
    await vi.waitFor(() => expect(releases).toBe(2));
  } finally {
    instances.forEach(instance => instance.close());
    await Promise.all(mounts.map(mount => mount.fixture.dispose()));
    controllers.forEach(controller => controller.abort());
    await Promise.all(producers.map(({ producer }) => producer.dispose()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000); // Real SQLite worker startup, rather than an in-process database substitute.

it.each([false, true])('protects staged changes through the host unsaved owner with pageLocation=%s', async pageLocation => {
  const unsaved: boolean[] = [];
  // The mounted host is the external boundary; staging and its lifetime stay real.
  const fixture = await createHostFixture('unsaved-changes', { setUnsavedChanges() {} });
  const hostApi = fixture.context.hostApi;
  const host: PluginUiHostApi = {
    ...hostApi,
    async setUnsavedChanges(isDirty) {
      await hostApi.setUnsavedChanges(isDirty);
      unsaved.push(isDirty);
    },
  };
  const descriptor = createDatabaseDescriptorV1Fixture();
  const targetKey = workbenchTargetKey(descriptor.target);
  const relation = { schema: 'public', name: 'items' };
  const instance = createWorkbenchInstance({
    client: createHostWorkbenchClient(host, { pageLocation }),
    scope: { kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
      workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } },
    location: { targetKey, relation, mode: 'data', sort: [], columns: [], page: { rows: 40, offset: 0 }, fkTrail: [] },
    selectedTarget: descriptor, cataloguePageRows: 40, statementRanges: () => [],
    consoleStorage: () => ({ read: async () => null, write: async () => {} }),
  });
  try {
    const change = { targetKey, relation, rowKey: 'row', label: 'Row', change: {
      kind: 'delete' as const, key: [{ column: 'id', value: { type: 'integer' as const, value: '1' } }],
    } };
    instance.drafts.stage(instance.draftKey(change), change);
    await vi.waitFor(() => expect(unsaved).toEqual([true]));
    instance.drafts.discard();
    await vi.waitFor(() => expect(unsaved).toEqual([true, false]));
  } finally {
    instance.close();
    await fixture.dispose();
  }
});
