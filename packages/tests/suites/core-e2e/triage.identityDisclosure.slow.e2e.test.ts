/* QB-09/QB-10: real Account Actions, Collection transport, and PostgreSQL storage. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1, projectSessionSharedMetadataV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { derivePluginCollectionIdentityTagV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { preparePluginAccountCollectionContractV1, PluginCollectionContentEnvelopeV1Schema,
  PluginCollectionProjectionV1Schema,
  PluginCollectionGetResultV1Schema, PluginCollectionMutationRequestV1Schema,
  PluginCollectionMutationErrorV1Schema, PluginCollectionMutationResultV1Schema,
  PLUGIN_COLLECTION_GET_HTTP_PATH_V1, PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
  encodePluginCollectionIndexSortKeyV1, getPluginCollectionScalarKindV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PluginAvailabilityActionHttpPathsV1,
  PluginAvailabilityCollectionWritersClaimActionOutputV1Schema,
  PluginAvailabilityIntentsListActionOutputV1Schema,
  PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PLUGIN_MANIFEST } from '../../../plugins/triage/src/manifest';
import { configuredSourceInstanceTagComponents } from '../../../plugins/triage/src/corpus/identity/components';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../../../plugins/triage/src/corpus/collections/ids';
import { TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
  TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, TriageListPinnedEntriesResultV1Schema,
  TriageSetEntryPinnedResultV1Schema } from '../../../plugins/triage/src/actions/userMarksProtocol';
import { createTestAuth, type TestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { createServerLightDatabaseClient } from '../../src/testkit/process/serverLightDatabase';
import { startHttpRequestRecordingProxy, type HttpRequestRecordingProxy,
  type RecordedHttpProxyRequest } from '../../src/testkit/httpRequestRecordingProxy';
import { createSession } from '../../src/testkit/sessions';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-identity-disclosure' });
const sourceRuntime = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
  'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
const collectionDeclarations = PLUGIN_MANIFEST.contributes.accountCollections;
if (!collectionDeclarations?.length) throw new Error('Triage did not declare its Account collections');
const contracts = collectionDeclarations.map(contribution =>
  preparePluginAccountCollectionContractV1({ pluginId: PLUGIN_MANIFEST.id, contribution }).normalized);
const entryRef = { source: { pluginId: 'happier.scm.forge.github', localId: 'github-forge' },
  kindId: 'issue', collisionScope: 'private-owner/repository|scope', entryId: 'private-item|4242' } as const;
const components = [`${entryRef.source.pluginId}/${entryRef.source.localId}`, entryRef.kindId,
  entryRef.collisionScope, entryRef.entryId];
const displayAtMark = { title: 'Private issue title', scopeLabel: 'Private repository label' };
const privateValues = [entryRef.collisionScope, entryRef.entryId, displayAtMark.title, displayAtMark.scopeLabel,
  'private-provider-account', 'private-route', 'private-configuration'];
const snapshotSchema = z.object({
  rows: z.array(z.object({ collectionId: z.string(), rowId: z.string(), revision: z.number(),
    contentEnvelope: PluginCollectionContentEnvelopeV1Schema })),
  projections: z.array(z.object({ collectionId: z.string(), rowId: z.string(), fieldId: z.string(), typedEncodedValue: z.string() })),
  indexes: z.array(z.object({ collectionId: z.string(), indexId: z.string(), rowId: z.string(), keyHex: z.string() })),
  relations: z.array(z.object({ sourceCollectionId: z.string(), sourceRowId: z.string(), relationId: z.string(),
    targetKind: z.string(), targetRowId: z.string().nullable() })),
});
let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
let database: Awaited<ReturnType<typeof createServerLightDatabaseClient>> | undefined;

beforeAll(async () => {
  server = await startServerLight({ testDir: run.testDir('server'), dbProvider: 'postgres', extraEnv: {
    NODE_OPTIONS: sourceRuntime,
    HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
  } });
  if (!server.databaseUrl) throw new Error('Identity fixture omitted its isolated PostgreSQL URL');
  database = await createServerLightDatabaseClient('postgres', server.databaseUrl);
}, 0);
afterAll(async () => { try { await database?.$disconnect(); } finally { await server?.stop(); } }, 0);

async function snapshot(auth: TestAuth) {
  if (!database) throw new Error('Identity fixture PostgreSQL is unavailable');
  const accountId = readAccountIdFromToken(auth.token);
  if (!accountId) throw new Error('Fixture token omitted its Account identity');
  // SQL stays inside this fixture's isolated database. Logical values use the product codec.
  const where = `"accountId" = $1 AND "pluginId" = 'happier.triage'`;
  const result = await database.$queryRawUnsafe(`
    SELECT json_build_object(
      'rows', COALESCE((SELECT json_agg(r ORDER BY r."collectionId", r."rowId") FROM
        (SELECT "collectionId", "rowId", revision, "contentEnvelope" FROM "PluginCollectionRow"
          WHERE ${where} AND "deletedAt" IS NULL) r), '[]'::json),
      'projections', COALESCE((SELECT json_agg(p ORDER BY p."collectionId", p."fieldId") FROM
        (SELECT "collectionId", "rowId", "fieldId", "typedEncodedValue" FROM "PluginCollectionProjection" WHERE ${where}) p), '[]'::json),
      'indexes', COALESCE((SELECT json_agg(i ORDER BY i."collectionId", i."indexId") FROM
        (SELECT s."collectionId", s."indexId", e."rowId", encode(e."encodedSortKey", 'hex') AS "keyHex"
          FROM "PluginCollectionIndexEntry" e JOIN "PluginCollectionIndexState" s ON s.id = e."indexStateId"
          WHERE s."accountId" = $1 AND s."pluginId" = 'happier.triage') i), '[]'::json),
      'relations', COALESCE((SELECT json_agg(l) FROM
        (SELECT "sourceCollectionId", "sourceRowId", "relationId", "targetKind", "targetRowId"
          FROM "PluginCollectionRelation" WHERE "accountId" = $1
          AND "sourcePluginId" = 'happier.triage' AND "deletedAt" IS NULL) l), '[]'::json)) AS snapshot;
  `, accountId);
  return z.array(z.object({ snapshot: snapshotSchema })).parse(result)[0]!.snapshot;
}

async function withAccount<T>(mode: 'plain' | 'e2ee', body: (fixture: Readonly<{
  auth: TestAuth;
  client: Awaited<ReturnType<typeof connectUiTriageActionClient>>;
  data: Awaited<ReturnType<Awaited<ReturnType<typeof connectUiTriageActionClient>>['collectionClients']>>;
  proxy: HttpRequestRecordingProxy;
}>) => Promise<T>, onRequestStart?: (request: RecordedHttpProxyRequest) => Promise<void>): Promise<T> {
  if (!server) throw new Error('Identity fixture server is unavailable');
  const auth = await createTestAuth(server.baseUrl);
  if (mode === 'plain') {
    const response = await fetch(`${server.baseUrl}/v1/account/encryption`, { method: 'PATCH', headers: {
      Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ mode: 'plain' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'plain' });
  }
  const testDir = run.testDir(`${mode}-${randomUUID()}`);
  const homeDir = join(testDir, 'daemon-home');
  await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth,
    mode: mode === 'plain' ? 'tokenOnly' : 'dataKey' });
  const daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
    ...process.env, NODE_OPTIONS: sourceRuntime, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
    HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
  } });
  let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
  let proxy: HttpRequestRecordingProxy | undefined;
  try {
    proxy = await startHttpRequestRecordingProxy({ targetBaseUrl: server.baseUrl, onRequestStart,
      captureRequestBody: request => request.path === PLUGIN_COLLECTION_GET_HTTP_PATH_V1
        || request.path === PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
      captureResponseBody: true });
    try {
      client = await connectUiTriageActionClient({ serverUrl: proxy.baseUrl, addressAnchorUrl: server.baseUrl,
        accountSecret: auth.accountSigningSeed, accountEncryptionMode: mode });
    } catch (error) {
      // Retain only public transport/admission facts; omit credentials and request/declaration bodies.
      const availabilityPaths = new Set<string>(Object.values(PluginAvailabilityActionHttpPathsV1));
      console.error(JSON.stringify({ boundary: 'identity-Home-admission', mode,
        requests: proxy.entries().filter(entry => availabilityPaths.has(entry.path)).map(entry => {
          let responseFacts: object = {};
          let responseError: unknown;
          try {
            const response: unknown = JSON.parse(entry.responseBody?.text ?? 'null');
            if (response && typeof response === 'object' && 'error' in response
              && typeof response.error === 'string') responseError = response.error;
            if (entry.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
              const parsed = PluginAvailabilityIntentsListActionOutputV1Schema.safeParse(response);
              const triage = parsed.success ? parsed.data.intentReads.find(row => row.pluginId === PLUGIN_MANIFEST.id) : undefined;
              responseFacts = parsed.success ? { intentListed: parsed.data.pluginIds.includes(PLUGIN_MANIFEST.id),
                intentFailed: parsed.data.failedPluginIds.includes(PLUGIN_MANIFEST.id),
                writerCount: triage?.response.intent?.writableCollections.length ?? null,
                cursor: parsed.data.availabilityCursor } : { invalidIntentPage: true };
            } else if (entry.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim']) {
              const parsed = PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.safeParse(response);
              responseFacts = parsed.success ? { writerCount: parsed.data.intent.writableCollections.length } : { invalidClaim: true };
            } else if (entry.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
              const parsed = PluginAvailabilityMaterializationsReadActionOutputV1Schema.safeParse(response);
              responseFacts = parsed.success ? { inventoryComplete: parsed.data.inventoryComplete,
                cursor: parsed.data.availabilityCursor } : { invalidMaterializations: true };
            }
          } catch { /* An absent or incomplete response remains visible in transport facts. */ }
          return { path: entry.path, statusCode: entry.statusCode, error: entry.error, responseError, ...responseFacts,
            responseComplete: entry.responseBody?.complete, startedAtMs: entry.startedAtMs, endedAtMs: entry.endedAtMs };
        }) }));
      throw error;
    }
    await waitFor(() => client!.isAccountReady(), { context: 'identity fixture Account readiness' });
    const data = await client.collectionClients(contracts);
    return await body({ auth, client, data, proxy });
  } finally {
    try { await client?.close(); } finally {
      try { await proxy?.stop(); } finally { await daemon.stop(); }
    }
  }
}

it.each(['plain', 'e2ee'] as const)('%s: keeps durable identity opaque and rejects undeclared disclosure before persistence', async mode => {
  expect(contracts.map(contract => contract.collectionId).sort()).toEqual(['session-links', 'source-instances', 'user-marks']);
  expect(contracts.flatMap(contract => contract.indexes.map(index => `${contract.collectionId}/${index.id}`)).sort())
    .toEqual(['session-links/by-entry', 'session-links/by-session', 'source-instances/by-lifecycle', 'user-marks/by-pinned']);
  let holdPinWrites = false;
  let releaseWrites!: () => void;
  const writesHeld = new Promise<void>(resolve => { releaseWrites = resolve; });
  const heldWriteIds: number[] = [];
  const firstTag = await withAccount(mode, async ({ auth, client, data, proxy }) => {
    const indexOf = (id: string) => {
      const index = contracts.findIndex(contract => contract.collectionId === id);
      if (index < 0) throw new Error(`Missing declared Collection ${id}`);
      return index;
    };
    const markIndex = indexOf('user-marks');
    const marks = data[markIndex]!;
    const markContract = contracts[markIndex]!;
    const tag = async (index: number, field: string, parts: readonly string[]) => {
      const result = await data[index]!.identityTag({ field, components: parts });
      expect(result.status).toBe('ready');
      if (result.status !== 'ready') throw new Error(`Identity derivation failed: ${JSON.stringify(result)}`);
      expect(result.tag).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      return result.tag;
    };
    const markTag = await tag(markIndex, 'markTag', components);
    const expectedTag = derivePluginCollectionIdentityTagV1({ accountEncryptionMode: mode,
      material: mode === 'plain' ? null : { type: 'dataKey', machineKey: auth.accountMachineKey },
      pluginId: PLUGIN_MANIFEST.id, collectionId: 'user-marks', field: 'markTag', components });
    expect(markTag).toBe(expectedTag);
    const unkeyedTag = derivePluginCollectionIdentityTagV1({ accountEncryptionMode: 'plain', material: null,
      pluginId: PLUGIN_MANIFEST.id, collectionId: 'user-marks', field: 'markTag', components });
    if (mode === 'e2ee') expect(markTag).not.toBe(unkeyedTag);
    expect(await tag(markIndex, 'markTag', [...components.slice(0, 2), 'a|b', 'c']))
      .not.toBe(await tag(markIndex, 'markTag', [...components.slice(0, 2), 'a', 'b|c']));
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const }, serverId: client.serverId };
    const pin = async (reference: typeof entryRef) => {
      const result = await client.execute('action.invoke', { action: { pluginId: PLUGIN_MANIFEST.id,
        localId: TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1 }, input: { v: 1, pinned: true, entryRef: reference, displayAtMark } }, context);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(`Pin refused: ${result.errorCode}`);
      return TriageSetEntryPinnedResultV1Schema.parse(result.result);
    };
    // Hold genuine HTTP writes, after each Action has acquired its fresh absence
    // witness. Neither writer can reach the server before both have read absence.
    holdPinWrites = true;
    const pinning = Promise.all([pin(entryRef), pin({ entryId: entryRef.entryId,
      collisionScope: entryRef.collisionScope, kindId: entryRef.kindId,
      source: { localId: entryRef.source.localId, pluginId: entryRef.source.pluginId } })]);
    let pinned: Awaited<typeof pinning>;
    try {
      await Promise.race([
        waitFor(() => heldWriteIds.length === 2, { context: 'both concurrent pin writes held at HTTP ingress' }),
        pinning.then(() => { throw new Error('Pins settled before both HTTP writes arrived'); }),
      ]);
      expect(heldWriteIds).toHaveLength(2);
      expect((await snapshot(auth)).rows).toEqual([]);
      const absentReads = proxy.entries().filter(request => request.path === PLUGIN_COLLECTION_GET_HTTP_PATH_V1
        && request.body?.text && JSON.parse(request.body.text).rowId === markTag && request.responseBody?.complete);
      expect(absentReads.length).toBeGreaterThanOrEqual(2);
      for (const request of absentReads) {
        expect(PluginCollectionGetResultV1Schema.parse(JSON.parse(request.responseBody!.text)).row).toBeNull();
      }
      releaseWrites();
      pinned = await pinning;
      const writes = proxy.entries().filter(request => heldWriteIds.includes(request.id));
      expect(writes).toHaveLength(2);
      for (const request of writes) {
        const sent = PluginCollectionMutationRequestV1Schema.parse(JSON.parse(request.body!.text));
        expect(sent).toMatchObject({ collectionId: 'user-marks',
          operations: [{ kind: 'put', rowId: markTag, expectedRevision: 'absent' }] });
      }
    } finally { holdPinWrites = false; releaseWrites(); await pinning.catch(() => {}); }
    expect(pinned.some(result => result.status === 'pinned')).toBe(true);
    expect(pinned.every(result => result.status === 'pinned' || result.status === 'conflict')).toBe(true);
    const sourceIndex = indexOf('source-instances');
    const sourceComponents = [entryRef.source.pluginId, entryRef.source.localId, 'triage-source',
      'happier.scm.forge.github', 'accounts', 'private-provider-account', 'private-route'];
    const configured = { v: 1, instance: { source: entryRef.source, sourceInstanceId: randomUUID() },
      binding: { purpose: 'triage-source', account: { service: { pluginId: 'happier.scm.forge.github', localId: 'accounts' },
        accountId: 'private-provider-account' } }, localInstanceKey: 'private-route',
      configuration: { v: 1, token: 'private-configuration' }, locator: { v: 1, displayLabel: 'Private repository label' } } as const;
    const instanceInput = { source: entryRef.source, binding: configured.binding, localInstanceKey: configured.localInstanceKey };
    const instanceTag = await tag(sourceIndex, 'instanceTag', configuredSourceInstanceTagComponents(instanceInput));
    expect(instanceTag).toBe(derivePluginCollectionIdentityTagV1({ accountEncryptionMode: mode,
      material: mode === 'plain' ? null : { type: 'dataKey', machineKey: auth.accountMachineKey },
      pluginId: PLUGIN_MANIFEST.id, collectionId: 'source-instances', field: 'instanceTag', components: sourceComponents }));
    expect(await tag(sourceIndex, 'instanceTag', configuredSourceInstanceTagComponents({
      localInstanceKey: configured.localInstanceKey,
      binding: { account: { accountId: 'private-provider-account', service: {
        localId: 'accounts', pluginId: 'happier.scm.forge.github' } }, purpose: 'triage-source' },
      source: { localId: entryRef.source.localId, pluginId: entryRef.source.pluginId },
    }))).toBe(instanceTag);
    expect(await data[sourceIndex]!.mutate([{ kind: 'put', expectedRevision: 'absent', value: {
      instanceTag, sourceQualifiedId: `${entryRef.source.pluginId}/${entryRef.source.localId}`,
      lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1_760_000_900_000, configured,
    } }])).toMatchObject({ status: 'updated' });
    const linkIndex = indexOf('session-links');
    let sessionId: string;
    if (mode === 'plain') {
      // Plain Accounts require the current owner-metadata envelope, without
      // Account or Session data-encryption material.
      const metadata = { name: 'Identity disclosure fixture' };
      const owner = createSessionOwnerMetadataV1({ metadata });
      if (!owner.ok) throw new Error('Invalid identity fixture Session owner metadata');
      const response = await fetch(`${server!.baseUrl}/v1/sessions`, { method: 'POST', headers: {
        Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json',
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
      }, body: JSON.stringify({ tag: randomUUID(), encryptionMode: 'plain', metadataLayoutVersion: 1,
        sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })) },
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
        agentState: null, dataEncryptionKey: null }) });
      expect(response.status).toBe(200);
      sessionId = z.object({ session: z.object({ id: z.string().min(1) }) }).parse(await response.json()).session.id;
    } else {
      ({ sessionId } = await createSession(server!.baseUrl, auth.token));
    }
    const entryTag = await tag(linkIndex, 'entryTag', components);
    const linkTag = await tag(linkIndex, 'linkTag', [...components, sessionId]);
    expect(entryTag).not.toBe(markTag);
    expect(await data[linkIndex]!.mutate([{ kind: 'put', expectedRevision: 'absent', value: {
      linkTag, entryTag, sessionId, linkedAtMs: 1_760_000_900_000, entryRef, identityEntryRef: entryRef,
      displayPathAtLink: 'Private repository label',
    } }])).toMatchObject({ status: 'updated' });

    const stored = await snapshot(auth);
    expect(stored.rows).toHaveLength(3);
    expect(stored.rows.filter(row => row.collectionId === 'user-marks').map(row => row.rowId)).toEqual([markTag]);
    expect(stored.indexes).toHaveLength(4);
    for (const row of stored.rows) {
      const contract = contracts.find(candidate => candidate.collectionId === row.collectionId)!;
      const projections = stored.projections.filter(value => value.collectionId === row.collectionId);
      expect(projections.map(value => value.fieldId).sort()).toEqual([...contract.serverReadable].sort());
      expect(row.contentEnvelope.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
      expect(row.rowId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const projection = PluginCollectionProjectionV1Schema.parse(Object.fromEntries(
        projections.map(value => [value.fieldId, JSON.parse(value.typedEncodedValue)])));
      for (const index of contract.indexes) {
        const encoded = encodePluginCollectionIndexSortKeyV1({ rowId: row.rowId, fields: index.fields.map(field => ({
          kind: getPluginCollectionScalarKindV1({ schema: contract.schema, field: field.field }),
          value: projection[field.field], direction: field.direction,
        })) });
        expect(stored.indexes.find(value => value.collectionId === row.collectionId && value.indexId === index.id))
          .toMatchObject({ rowId: row.rowId, keyHex: Buffer.from(encoded).toString('hex') });
      }
    }
    expect(stored.relations).toEqual([{ sourceCollectionId: 'session-links', sourceRowId: linkTag,
      relationId: 'session', targetKind: 'host:session', targetRowId: sessionId }]);
    const disclosed = JSON.stringify({ ids: stored.rows.map(row => row.rowId), projections: stored.projections,
      indexes: stored.indexes, relations: stored.relations });
    for (const secret of privateValues) {
      expect(disclosed).not.toContain(secret);
      for (const index of stored.indexes) expect(index.keyHex).not.toContain(Buffer.from(secret).toString('hex'));
      if (mode === 'e2ee') expect(JSON.stringify(stored.rows)).not.toContain(secret);
    }
    if (mode === 'e2ee') expect(disclosed).not.toContain(unkeyedTag);

    const mark = stored.rows.find(row => row.collectionId === 'user-marks')!;
    const projection = PluginCollectionProjectionV1Schema.parse(Object.fromEntries(
      stored.projections.filter(value => value.collectionId === 'user-marks')
        .map(value => [value.fieldId, JSON.parse(value.typedEncodedValue)])));
    const mutateWire = (content: unknown, submittedProjection: unknown) =>
      fetch(`${server!.baseUrl}${PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1}`, {
        method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json',
          ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
        body: JSON.stringify({ pluginId: PLUGIN_MANIFEST.id, collectionId: 'user-marks',
          writerContext: { schemaVersion: markContract.schemaVersion, contractDigest: markContract.contractDigest },
          operations: [{ kind: 'put', rowId: mark.rowId, expectedRevision: mark.revision, content, projection: submittedProjection }] }),
      });
    const reject = async (content: unknown, submittedProjection: unknown, code: string) => {
      const response = await mutateWire(content, submittedProjection);
      expect(response.ok).toBe(false);
      expect(PluginCollectionMutationErrorV1Schema.parse(await response.json())).toMatchObject({ error: code });
      expect(await snapshot(auth)).toEqual(stored);
    };
    // Both envelopes are structurally valid. Only the persisted Account mode
    // decides whether either content shape can reach persistence.
    const encrypted = stored.rows.find(row => row.contentEnvelope.t === 'encrypted')?.contentEnvelope;
    await reject(mode === 'e2ee' ? { t: 'plain', v: {} } : encrypted ?? { t: 'encrypted', c: 'fixture-ciphertext' },
      projection, 'collection_content_mode_mismatch');
    await reject(mark.contentEnvelope, { ...projection, title: displayAtMark.title }, 'collection_mutation_invalid');
    expect(await marks.get(markTag)).toMatchObject({ status: 'ready', row: { rowId: markTag,
      value: { entryRef, displayAtMark, pinned: true } } });

    // Model inconsistent retained bytes at the real persistence boundary, on
    // this fixture's isolated Account row only. No production codec is replaced.
    const accountId = readAccountIdFromToken(auth.token);
    if (!accountId || !database) throw new Error('Corrupted-read fixture lost its isolated Account database');
    const wrongModeContent = mode === 'e2ee'
      ? { t: 'plain', v: { entryRef, displayAtMark } }
      : { t: 'encrypted', c: 'fixture-ciphertext' };
    const corrupted = await database.$queryRawUnsafe(`UPDATE "PluginCollectionRow"
      SET "contentEnvelope" = $1::jsonb WHERE "accountId" = $2 AND "pluginId" = 'happier.triage'
      AND "collectionId" = 'user-marks' AND "rowId" = $3 AND revision = $4 RETURNING "rowId"`,
    JSON.stringify(wrongModeContent), accountId, mark.rowId, mark.revision);
    expect(z.array(z.object({ rowId: z.string() })).parse(corrupted)).toEqual([{ rowId: markTag }]);
    try {
      expect(await marks.get(markTag)).toEqual({ status: 'rejected', code: 'collection_content_mode_mismatch' });
      const refused = await client.execute('action.invoke', { action: { pluginId: PLUGIN_MANIFEST.id,
        localId: TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1 }, input: { v: 1, limit: 20 } }, context);
      expect(refused).toMatchObject({ ok: false, errorCode: 'collection_content_mode_mismatch' });
      expect(refused).not.toHaveProperty('result');
      for (const secret of privateValues) expect(JSON.stringify(refused)).not.toContain(secret);
    } finally {
      // Restoration goes through the actual Collection writer, retaining CAS,
      // projection/index maintenance, encryption-mode admission, and publication.
      const restored = await mutateWire(mark.contentEnvelope, projection);
      expect(restored.ok).toBe(true);
      expect(PluginCollectionMutationResultV1Schema.parse(await restored.json())).toMatchObject({ status: 'updated' });
    }
    const reopened = await client.execute('action.invoke', { action: { pluginId: PLUGIN_MANIFEST.id,
      localId: TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1 }, input: { v: 1, limit: 20 } }, context);
    expect(reopened).toMatchObject({ ok: true });
    if (!reopened.ok) throw new Error(`Restored mark Action refused: ${reopened.errorCode}`);
    expect(TriageListPinnedEntriesResultV1Schema.parse(reopened.result).pins)
      .toEqual([expect.objectContaining({ entryRef, displayAtMark })]);
    return markTag;
  }, async request => {
    if (!holdPinWrites || request.path !== PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1) return;
    heldWriteIds.push(request.id);
    await writesHeld;
  });
  if (mode === 'e2ee') {
    await withAccount(mode, async ({ data }) => {
      const index = contracts.findIndex(contract => contract.collectionId === 'user-marks');
      const result = await data[index]!.identityTag({ field: 'markTag', components });
      expect(result.status).toBe('ready');
      if (result.status !== 'ready') throw new Error('Second Account identity derivation failed');
      expect(result.tag).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(result.tag).not.toBe(firstTag);
    });
  }
}, 0);
