// Keep the real UI Account owners under their canonical native boundaries.
import '../../../../ui/sources/dev/vitestSetup';
import axios, { AxiosHeaders } from 'axios';
import { randomBytes } from 'node:crypto';
import { AccountSettingsSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginAccountCollectionContractV1, PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1, PluginCollectionSharingPutRequestV1Schema,
  PluginCollectionSharingGetRequestV1Schema,
  type PluginCollectionSharingResourceV1 } from '@happier-dev/protocol/plugins/data/collectionSharingV1';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 as ids } from '@happier-dev/protocol/plugins/data/collectionSharingActionIdsV1';
import { encodePluginCollectionLogicalValueV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, createAccountTokenForTests } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '../../../../ui/sources/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '../../../../ui/sources/dev/testkit/cleanup/standardCleanup';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';

vi.mock('socket.io-client', async importOriginal =>
  (await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('../../../../ui/sources/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('../../../../ui/sources/sync/ops/actions/defaultActionExecutor');
const { setActiveServerId } = await import('../../../../ui/sources/sync/domains/server/serverProfiles');
const { storage } = await import('../../../../ui/sources/sync/domains/state/storage');
const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
  approvalWaivedSurfaces: Object.fromEntries(Object.values(ids).map(id => [id, ['agent']])) } });
const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'example.documents', contribution: {
  id: 'documents', schemaVersion: 1, rowIdField: 'id', identityFields: [],
  schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } },
    required: ['id', 'note'], additionalProperties: false },
  serverReadable: ['id'], indexes: [], uiQueries: [], relations: [], migrations: [],
} });
const collectionRef = { pluginId: contract.pluginId, collectionId: contract.collectionId,
  schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
const accountId = 'collection-peer';
const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }), encryption: null } as const;
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => {
  await homes.reset();
  await loadSyncSingletonForTests();
  serverId = await homes.addHome({ name: 'Collection parity', serverUrl: 'https://collection-parity.test', accountId, currentAccount: true });
  connection = await restoreServerAccountForTest({ serverUrl: 'https://collection-parity.test', accountId, request: homes.request });
  installHomeGovernanceBoundaries(homes);
  storage.setState({ settings });
  homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
  // Axios and fetch are the two realm HTTP leaves; all Action, codec and scope logic stays real.
  const headers = (value: Parameters<typeof AxiosHeaders.from>[0]) => new Headers(Object.fromEntries(
    Object.entries(AxiosHeaders.from(value).toJSON()).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const response = await homes.request(String(url), { method: 'GET', headers: headers(config?.headers) });
    return { status: response.status, data: await response.json() };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    const response = await homes.request(String(url), { method: 'POST', headers: headers(config?.headers), body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  });
  homes.answer(serverId, PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, { body: { access: 'readOnly', contract } });
});
afterEach(async () => {
  standardCleanup();
  await connection?.dispose(); connection = undefined;
  vi.restoreAllMocks();
});

describe('logical Collection sharing Actions through UI and CLI HTTP adapters', () => {
  it.each(['ui', 'cli', 'ui-inactive'] as const)('reads, edits, manages grants and preserves refusal outcomes on %s', async host => {
    const encoded = encodePluginCollectionLogicalValueV1({ contract, value: { id: 'document', note: 'Private note' },
      isValidLogicalValue: (value): value is { id: string; note: string } => typeof value.id === 'string' && typeof value.note === 'string',
      encryptionMode: 'plain', material: null, randomBytes });
    if (encoded.status !== 'encoded') throw new Error(encoded.reason);
    let resource: PluginCollectionSharingResourceV1 = { ownerAccountId: 'owner', pluginId: contract.pluginId,
      collectionId: contract.collectionId, rowId: 'document', access: 'edit', encryptionMode: 'plain', encryptedDataKey: null,
      row: { rowId: 'document', revision: 1, content: encoded.content, projection: encoded.projection } };
    let denied = false;
    let granted = false;
    const ownedEncoded = encodePluginCollectionLogicalValueV1({ contract, value: { id: 'owned', note: 'Owned note' },
      isValidLogicalValue: (value): value is { id: string; note: string } => typeof value.id === 'string' && typeof value.note === 'string',
      encryptionMode: 'plain', material: null, randomBytes });
    if (ownedEncoded.status !== 'encoded') throw new Error(ownedEncoded.reason);
    homes.answer(serverId, PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1.get, { select: raw => {
      const request = PluginCollectionSharingGetRequestV1Schema.parse(raw);
      if (request.ownerAccountId === accountId) return { body: { ...resource, ownerAccountId: accountId, rowId: 'owned', access: 'owner',
        row: { rowId: 'owned', revision: 1, content: ownedEncoded.content, projection: ownedEncoded.projection } } };
      return denied ? { status: 404, body: { error: 'collection_unavailable' } } : { body: resource };
    } });
    homes.answer(serverId, PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1.sharedWithMe, { select: () => ({ body: { resources: [resource], nextCursor: null } }) });
    homes.answer(serverId, PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1.put, { select: raw => {
      const input = PluginCollectionSharingPutRequestV1Schema.parse(raw);
      if (input.expectedRevision !== resource.row.revision) return { status: 409, body: { error: 'collection_revision_conflict' } };
      resource = { ...resource, row: { ...resource.row, revision: resource.row.revision + 1, content: input.content, projection: input.projection } };
      return { body: resource };
    } });
    homes.answer(serverId, PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1.census, { body: { ownerAccountId: accountId,
      pluginId: contract.pluginId, collectionId: contract.collectionId, rowId: 'owned', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] } });
    homes.answer(serverId, PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1.setGrant, { select: () => { granted = true; return { body: { changed: true } }; } });
    homes.answer(serverId, PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1.grants, { select: () => ({ body: {
      ownerAccountId: accountId, pluginId: contract.pluginId, collectionId: contract.collectionId,
      rowId: 'owned', access: 'owner', grants: [],
    } }) });
    homes.answer(serverId, PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1.revokeGrant, { select: () => { granted = false; return { body: { changed: true } }; } });
    if (host === 'ui-inactive') {
      const other = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-collection.test', accountId: 'other', currentAccount: true });
      await setActiveServerId(other);
    }
    const executor = host !== 'cli' ? createDefaultActionExecutor() : createCliActionExecutorFromCredentials({ credentials,
      serverId, serverApiUrl: 'https://collection-parity.test', pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings }) });
    const context = { serverId, expectedAccountId: accountId, surface: 'agent' as const, authority: 'account_automation' as const,
      actionCaller: { kind: 'host' as const } };
    const address = { collectionRef, ownerAccountId: 'owner', rowId: 'document' };
    const read = { ownerAccountId: 'owner', access: 'edit', rowId: 'document', revision: 1, value: { id: 'document', note: 'Private note' } };
    expect(await executor.execute(ids.get, address, context)).toEqual({ ok: true, result: read });
    expect(await executor.execute(ids.list, { collectionRef, sharedWithTeamId: 'selected-team' }, context))
      .toEqual({ ok: true, result: { rows: [read] } });
    const put = { collectionRef, ownerAccountId: 'owner', expectedRevision: 1, value: { id: 'document', note: 'Edited note' } };
    expect(await executor.execute(ids.put, put, context)).toMatchObject({ ok: true, result: { ...read, revision: 2, value: put.value } });
    expect(await executor.execute(ids.put, put, context)).toMatchObject({ ok: false, errorCode: 'collection_revision_conflict' });
    const principal = { kind: 'account' as const, accountId: 'recipient' };
    expect(await executor.execute(ids.setGrant, { collectionRef, rowId: 'owned', principal, accessLevel: 'view', expectedRevision: 1 }, context))
      .toMatchObject({ ok: true, result: { changed: true } });
    expect(granted).toBe(true);
    expect(await executor.execute(ids.listGrants, { collectionRef, rowId: 'owned' }, context))
      .toEqual({ ok: true, result: { ownerAccountId: accountId, access: 'owner', grants: [] } });
    expect(await executor.execute(ids.revokeGrant, { collectionRef, rowId: 'owned', principal }, context))
      .toMatchObject({ ok: true, result: { changed: true } });
    expect(granted).toBe(false);
    denied = true;
    expect(await executor.execute(ids.get, address, context)).toMatchObject({ ok: false, errorCode: 'collection_unavailable' });
    denied = false;
    homes.answer(serverId, PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, { body: {
      access: 'readOnly', contract: { ...contract,
        contractDigest: `${contract.contractDigest[0] === 'A' ? 'B' : 'A'}${contract.contractDigest.slice(1)}` },
    } });
    const readsBeforeStaleContract = homes.requestsFor(PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1.get).length;
    expect(await executor.execute(ids.get, address, context)).toMatchObject({ ok: false });
    expect(homes.requestsFor(PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1.get)).toHaveLength(readsBeforeStaleContract);
    if (host !== 'cli') {
      homes.answer(serverId, PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, { body: { access: 'readOnly', contract } });
      homes.answer(serverId, PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1.get, { select: async () => {
        // Credential retirement is a real system boundary, including for an off-active Home.
        await homes.switchAccount(serverId, 'replacement-account', { currentAccount: true });
        return { body: resource };
      } });
      expect(await executor.execute(ids.get, address, context)).toMatchObject({ ok: false });
    }
  });
});
