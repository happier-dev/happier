import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseOperationInputV1Schema, type DatabaseDescriptorV1 } from '@happier-dev/database-protocol';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { computeSha256HexDigest, PluginError } from '@happier-dev/plugin-sdk';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import type { PluginUiHostApi, ResourceContent, ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import type { PluginDynamicResourceInvocationOptionsV1 } from '@happier-dev/plugin-sdk/resources';
import { createHostWorkbenchClient } from './hostClient.js';
import { createWorkbenchInstance } from '../workbench.js';
import { createDatabaseConnectionResourceRuntime } from '../../resources.js';
import { openManualDatabaseConnection } from '../../connection.js';

it('saves an export through the host download owner and the export download Action, with the rows and completeness it was given', async () => {
  const downloadFile = vi.fn(async () => ({ success: true as const, status: 'completed' as const, transferId: 't1',
    destinationId: 'd1', name: 'invoices.csv', sizeBytes: 32, sha256: 'a'.repeat(64) }));
  const client = createHostWorkbenchClient({ downloadFile } as unknown as PluginUiHostApi, { pageLocation: false });
  const result = { columns: [{ name: 'id', nativeType: 'int8', semanticType: 'integer' as const, nullable: false }],
    rows: [{ cells: [{ type: 'integer' as const, value: '48212' }] }], completeness: { complete: false as const,
      continuation: { kind: 'offset' as const, binding: { target: createDatabaseDescriptorV1Fixture().target,
        relation: { schema: 'public', name: 'invoices' }, columns: [], order: [] }, offset: 1 } } };
  await expect(client.saveExport({ format: 'csv', result })).resolves.toMatchObject({ success: true, status: 'completed' });
  expect(downloadFile).toHaveBeenCalledTimes(1);
  const [request] = downloadFile.mock.calls[0] as unknown as [{ action: unknown; input: { format: string; result: { completeness: { complete: boolean } } } }];
  // The host fills the destination; the plugin names the Action and hands over exactly what it serializes.
  expect(request.action).toEqual({ pluginId: 'happier.database', localId: 'rows/export-download' });
  expect(request.input).not.toHaveProperty('destination');
  expect(request.input.format).toBe('csv');
  expect(request.input.result.completeness.complete).toBe(false);
});

it('preserves demand admission refusal without reconnecting through an ordinary Action', async () => {
  const unavailable = () => { throw new Error('A refused demand never falls back to another read path'); };
  const host = { readResource: unavailable, executeAction: unavailable,
    watchResource: async () => { throw new PluginError({ code: 'database_read_unavailable' }); } };
  const client = createHostWorkbenchClient(host as PluginUiHostApi, { pageLocation: false });
  const release = client.subscribeOwnWrites(() => {});
  try {
    await expect(client.operation({ operation: 'describe', target: createDatabaseDescriptorV1Fixture().target }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'database_read_unavailable' });
  } finally { release(); }
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
  const instances = producers.map(({ producer, options }, index) => {
    const subscriptionId = `mounted-${index}`;
    const content = async (): Promise<ResourceContent> => {
      reads++;
      const text = String(await producer.read(options));
      return { contentType: 'application/json', digest: `sha256:${computeSha256HexDigest(text)}`, bytes: new TextEncoder().encode(text) };
    };
    // Only the host transport is substituted. Resource producer, SQLite reads, cache and drafts are real.
    const host = {
      readResource: async () => await content(),
      watchResource: async (_resource: unknown, listener: (event: ResourceSubscriptionEvent) => void) => {
        const observation = await producer.observe(async () => {
          const value = await content();
          listener({ version: 1, kind: 'invalidated', subscriptionId, digest: value.digest });
        }, options);
        return { subscriptionId, dispose() { releases++; return observation.dispose(); } };
      },
      executeAction: async (_action: unknown, operand: unknown) => {
        const input = DatabaseOperationInputV1Schema.parse(operand);
        expect(input.subscriptionId, 'read invokes the already admitted mounted demand').toBe(subscriptionId);
        readInvocations.push(input.operation);
        return await producer.invoke!(input, { signal: controllers[index]!.signal });
      },
      setUnsavedChanges: async () => {},
      notify: async () => {},
    } satisfies Pick<PluginUiHostApi, 'readResource' | 'watchResource' | 'setUnsavedChanges' | 'notify'> & {
      executeAction(action: unknown, operand: unknown): Promise<unknown>;
    };
    const targetKey = JSON.stringify(target);
    return createWorkbenchInstance({ client: createHostWorkbenchClient(host as PluginUiHostApi, { pageLocation: false }),
      scope: { ...target, kind: 'worktree' }, selectedTarget: descriptor,
      location: { targetKey, relation: { schema: 'main', name: 'first' }, mode: 'data', sort: [], columns: ['id', 'label'], page: { rows: 40, offset: 0 }, fkTrail: [] },
      cataloguePageRows: 40, statementRanges: () => [], consoleStorage: () => ({ read: async () => null, write: async () => {} }) });
  });
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
    controllers.forEach(controller => controller.abort());
    await Promise.all(producers.map(({ producer }) => producer.dispose()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000); // Real SQLite worker startup, rather than an in-process database substitute.

it.each([false, true])('protects staged changes through the host unsaved owner with pageLocation=%s', async pageLocation => {
  const unsaved: boolean[] = [];
  // The mounted host is the external boundary; staging and its lifetime stay real.
  const host = { setUnsavedChanges: async (value: boolean) => { unsaved.push(value); } } as Pick<PluginUiHostApi, 'setUnsavedChanges'>;
  const descriptor = createDatabaseDescriptorV1Fixture();
  const targetKey = JSON.stringify(descriptor.target);
  const relation = { schema: 'public', name: 'items' };
  const instance = createWorkbenchInstance({
    client: createHostWorkbenchClient(host as PluginUiHostApi, { pageLocation }),
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
  } finally { instance.close(); }
});
