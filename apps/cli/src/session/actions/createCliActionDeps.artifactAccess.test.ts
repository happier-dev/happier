import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createCliActionDeps } from './createCliActionDeps';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, buildWidgetDefinitionArtifactHeaderV1,
  WidgetAreaLayoutV1Schema, WidgetDefinitionV1Schema, readBuiltinWidgetDescriptorV1, flattenWidgetLayoutWidgetsV1 } from '@happier-dev/protocol/widgets';
import { ArtifactAccessRecipientCensusResponseV1Schema, ArtifactAccessGrantRowV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactPrivateRevisionMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { decodeBase64, decryptWithDataKey, encodeBase64, encryptWithDataKey, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';

afterEach(() => vi.restoreAllMocks());

// Signed variants prove captured HTTP authorization and codecs at the CLI boundary;
// they do not assert Home admission for a direct signed grant-set root.
it.each([{ mode: 'plain', signed: false }, { mode: 'plain', signed: true }, { mode: 'e2ee', signed: true }] as const)(
  'shares only widget titles through the real CLI composition ($mode, signed=$signed)', async ({ mode, signed }) => {
  const accountId = `dashboard-maker-${mode}-${signed ? 'signed' : 'bearer'}`;
  const serverHttpBaseUrl = 'https://dashboard-sharing.test';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const machineKey = new Uint8Array(32).fill(13);
  const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
    : { type: 'dataKey', machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey) } };
  const key = await createResourceDataKey({ credentials, mode });
  const encode = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
    : encodeBase64(encryptWithDataKey(value, key.dataKey));
  const decode = (value: string): unknown => key.mode === 'plain' ? decodePlainArtifactStoredContent(value)
    : decryptWithDataKey(decodeBase64(value), key.dataKey);
  const surface = { serverId: 'home', accountId, owner: { kind: 'project' as const, projectId: 'project', layoutId: 'dashboard' } };
  const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'private-definition', name: 'Private burn down',
    body: { kind: 'builtin', id: 'project_about' }, inputs: { fields: [] }, inputSchema: { type: 'object', properties: {} },
    sizeDeclaration: readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'project_about' })!.sizeDeclaration, provenance: { source: { kind: 'authored' } } });
  const instance = (id: string) => ({ v: 1, id, definition: { kind: 'artifact', artifactId: definition.id }, bindings: {} });
  const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, items: [
    { kind: 'widget', instance: instance('first') },
    { kind: 'widget', instance: { ...instance('custom'), definition: { kind: 'artifact', artifactId: 'private-unrelated' }, displayName: 'My name' } },
    { kind: 'group', id: 'group', children: [{ kind: 'widget', instance: instance('second') }] },
    { kind: 'widget', instance: { ...instance('builtin'), definition: { kind: 'builtin', id: 'project_about' } } },
    ...(signed ? ([['models', ['model']], ['agents', ['agent']], ['multiple', ['model', 'agent']]] as const).map(([id, dimensions]) => ({ kind: 'widget', instance: {
      ...instance(id), definition: { kind: 'builtin', id: 'usage_breakdowns' }, bindings: { breakdown: { kind: 'value', value: [...dimensions] } },
    } })) : []),
    { kind: 'widget', instance: { ...instance('unavailable'), definition: { kind: 'artifact', artifactId: 'unavailable-definition' } } },
    { kind: 'widget', instance: { ...instance('missing-plugin'), definition: { kind: 'installed', surface: { pluginId: 'missing.plugin', localId: 'widget' } } } },
  ] });
  const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
  const row = (id: string, header: Readonly<Record<string, unknown>>, body: string) => ({ id, ownerAccountId: accountId,
    access: 'owner', encryptionMode: mode, publicAudience: 'none', dataEncryptionKey: key.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER,
    header: encode(header), body: encode({ body }),
    provenance: encode(ArtifactPrivateRevisionMetadataV1Schema.parse({ v: 1, artifactId: id, bodyVersion: 1,
      provenance: { savedBy: { kind: 'person', accountId } } })),
    ...(key.mode === 'e2ee' ? { provenanceDataEncryptionKey: key.dataEncryptionKey } : {}),
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
  const rows = new Map([
    [artifactId, row(artifactId, buildWidgetSurfaceArtifactHeaderV1(layout), JSON.stringify(layout))],
    [definition.id, row(definition.id, buildWidgetDefinitionArtifactHeaderV1(definition), JSON.stringify(definition))],
  ]);
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const keyPair = nacl.sign.keyPair();
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'sharing-proof', binding: {
    accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'home',
    machineId: target.machineId, installationId: 'installation', actionId: 'artifact.access.grants.set', requestId: 'sharing-request',
    target, accountEncryptionMode: mode, requestEnvelopeDigest: 'd'.repeat(43),
  } });
  const authorize = (options: Readonly<{ headers?: unknown }> | undefined, request: Readonly<{ method: string; path: string; body?: unknown }>) => {
    const headers = options?.headers;
    expect(headers).toBeTruthy();
    if (signed) {
      expect(headers).toHaveProperty(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, authorization.token);
      expect(headers).not.toHaveProperty('Authorization');
      if (!headers || typeof headers !== 'object') throw new Error('Missing signed headers');
      const signature: unknown = Reflect.get(headers, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER);
      if (typeof signature !== 'string') throw new Error('Missing Machine signature');
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: 'artifact.access.grants.set',
        target, installationId: 'installation', requestId: 'sharing-request', ...request, publicKey: keyPair.publicKey, signature })).toBe(true);
    } else expect(headers).toHaveProperty('Authorization', `Bearer ${token}`);
  };
  const reads: string[] = [];
  let shared = false;
  let abortTitleRead: AbortController | undefined;
  let rejectTitleAuthorization = false;
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    authorize(options, { method: 'GET', path });
    reads.push(path);
    if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/machines') return { status: 200, data: [] };
    const grantsPath = /^\/v1\/artifacts\/([^/]+)\/access\/grants$/u.exec(path);
    if (grantsPath && rows.has(grantsPath[1]!)) return { status: 200, data: { artifactId: grantsPath[1]!, ownerAccountId: accountId, access: 'owner',
      grants: grantsPath[1] === artifactId && shared ? [ArtifactAccessGrantRowV1Schema.parse({ principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view',
        createdByAccountId: accountId, createdAt: 1, display: { name: 'Recipient' } })] : [] } };
    const censusPath = /^\/v1\/artifacts\/([^/]+)\/access\/recipients$/u.exec(path);
    if (censusPath) {
      const selected = rows.get(censusPath[1]!)!;
      return { status: 200, data: ArtifactAccessRecipientCensusResponseV1Schema.parse({ artifactId: selected.id,
        ownerAccountId: accountId, access: 'owner', encryptionMode: mode, dataEncryptionKey: key.dataEncryptionKey,
        callerDataEncryptionKey: key.dataEncryptionKey, provenanceDataEncryptionKey: key.dataEncryptionKey,
        callerProvenanceDataEncryptionKey: key.dataEncryptionKey, recipients: [] }) };
    }
    const selected = rows.get(path.slice('/v1/artifacts/'.length));
    if (selected) return { status: 200, data: selected };
    if (path === '/v1/artifacts/unavailable-definition') {
      if (abortTitleRead) { abortTitleRead.abort(); throw new DOMException('Cancelled', 'AbortError'); }
      return rejectTitleAuthorization
        ? { status: 403, data: { error: 'artifact_access_forbidden' } }
        : { status: 503, data: { error: 'artifact_read_unavailable' } };
    }
    throw new Error(`Unexpected read: ${path}`);
  });
  const writes: string[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown, options) => {
    authorize(options, { method: 'POST', path: new URL(String(url)).pathname, body });
    if (new URL(String(url)).pathname === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
      return { status: 200, data: PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1, snapshots: [], inventoryComplete: true }) };
    }
    expect(new URL(String(url)).pathname).toBe(`/v1/artifacts/${artifactId}`);
    const previous = rows.get(artifactId)!;
    expect(body).toMatchObject({ expectedHeaderVersion: previous.headerVersion, expectedBodyVersion: previous.bodyVersion });
    if (!body || typeof body !== 'object' || typeof Reflect.get(body, 'body') !== 'string' || typeof Reflect.get(body, 'header') !== 'string') throw new Error('Invalid update');
    rows.set(artifactId, { ...previous, header: Reflect.get(body, 'header'), body: Reflect.get(body, 'body'), provenance: Reflect.get(body, 'provenance'),
      headerVersion: previous.headerVersion + 1, bodyVersion: previous.bodyVersion + 1 });
    writes.push('layout');
    return { status: 200, data: { success: true, headerVersion: previous.headerVersion + 1, bodyVersion: previous.bodyVersion + 1 } };
  });
  const granted = { artifactId, ownerAccountId: accountId, access: 'owner', changed: true, grants: [] };
  vi.spyOn(axios, 'put').mockImplementation(async (url, body: unknown, options) => {
    authorize(options, { method: 'PUT', path: new URL(String(url)).pathname, body });
    const stored = decode(rows.get(artifactId)!.body);
    if (!stored || typeof stored !== 'object') throw new Error('Invalid body envelope');
    const sharedLayout = WidgetAreaLayoutV1Schema.parse(JSON.parse(Reflect.get(stored, 'body')));
    expect(flattenWidgetLayoutWidgetsV1(sharedLayout.items).map(item => item.instance.displayName))
      .toEqual(['Private burn down', 'My name', 'Private burn down', readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'project_about' })!.title,
        ...(signed ? ['Models', 'Agents', 'Breakdowns'] : []), undefined, undefined]);
    expect(JSON.stringify(sharedLayout)).not.toContain('provenance');
    if (mode === 'e2ee') {
      expect(rows.get(artifactId)!.body).not.toContain(definition.name);
      expect(rows.get(artifactId)!.header).not.toContain(definition.name);
    }
    writes.push('grant');
    shared = true;
    return { status: 200, data: granted };
  });
  const host = createCliActionDeps({ token, credentials, sessionId: '', mode: 'plain', ctx: null, serverId: 'home',
    serverIdentityId: 'home', serverHttpBaseUrl, externalActionMachineRequestPrivateKey: keyPair.secretKey,
    externalActionMachineInstallationId: 'installation' });
  const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home',
    ...(signed ? { externalActionExecutionAuthorization: authorization, externalActionTarget: target } : {}) };
  await expect(host.artifactAccessAction!({ actionId: 'artifact.access.grants.set',
    input: { artifactId, principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view' }, context })).resolves.toEqual(granted);
  expect(writes).toEqual(['layout', 'grant']);
  expect(reads.filter(path => path === `/v1/artifacts/${definition.id}`)).toHaveLength(1);
  expect(reads).not.toContain('/v1/artifacts');
  if (signed) {
    const acknowledgedWrites = [...writes];
    rejectTitleAuthorization = true;
    await expect(host.artifactAccessAction!({ actionId: 'artifact.access.grants.set',
      input: { artifactId, principal: { kind: 'account', accountId: 'denied-recipient' }, accessLevel: 'view' }, context }))
      .rejects.toMatchObject({ code: 'action_forbidden' });
    expect(writes).toEqual(acknowledgedWrites);
  }
  if (!signed) {
    const first = layout.items[0]!;
    if (first.kind !== 'widget') throw new Error('Missing fixture widget');
    const added = { ...first.instance, id: 'added' };
    // This assertion exercises the acknowledged shared write after the person's exact add confirmation.
    const acknowledgement = await createActionExecutor(host).execute('widgets.item.add', { surface, instance: added },
      { ...context, presentUserConfirmation: { actionId: 'widgets.item.add' } });
    expect(acknowledgement, JSON.stringify(acknowledgement))
      .toMatchObject({ ok: true, result: { instance: { displayName: definition.name } } });
    const stored = decode(rows.get(artifactId)!.body);
    if (!stored || typeof stored !== 'object') throw new Error('Invalid body envelope');
    const current = WidgetAreaLayoutV1Schema.parse(JSON.parse(Reflect.get(stored, 'body')));
    expect(flattenWidgetLayoutWidgetsV1(current.items).find(item => item.instance.id === 'added')?.instance.displayName).toBe(definition.name);
    const acknowledgedWrites = [...writes];
    abortTitleRead = new AbortController();
    await expect(host.artifactAccessAction!({ actionId: 'artifact.access.grants.set',
      input: { artifactId, principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view' }, context, signal: abortTitleRead.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(writes).toEqual(acknowledgedWrites);
  }
});

it('lists an owned Artifact through signed Session Action read admission without preparing keys', async () => {
  const artifactId = 'owned-workflow';
  const serverHttpBaseUrl = 'https://artifact-grants.test';
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-root-proof', binding: {
    accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
    serverIdentityId: 'home', machineId: target.machineId, installationId: 'installation',
    actionId: 'artifact.access.grants.list', requestId: 'grants-request', target, accountEncryptionMode: 'plain',
    requestEnvelopeDigest: 'd'.repeat(43),
  } });
  let allowed = true;
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    reads.push(path);
    expect(options?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
    expect(options?.headers?.Authorization).toBeUndefined();
    if (path === `/v1/artifacts/${artifactId}`) return { status: 200, data: {
      id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ title: 'Owned Artifact' }),
      body: encodePlainArtifactStoredContent({ body: 'Private content' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (path === `/v1/artifacts/${artifactId}/access/grants`) return allowed
      ? { status: 200, data: { artifactId, ownerAccountId: 'owner', access: 'owner', grants: [] } }
      : { status: 403, data: { error: 'artifact_access_forbidden' } };
    throw new Error(`Unexpected read: ${path}`);
  });
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
  const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
    sessionId: 'source-session', mode: 'plain', ctx: null, serverId: 'profile', serverIdentityId: 'home', serverHttpBaseUrl,
    rawSession: { metadata: JSON.stringify(createTestMetadata()) },
    externalActionMachineRequestPrivateKey: nacl.sign.keyPair().secretKey, externalActionMachineInstallationId: 'installation',
  }));
  const context = { surface: 'mcp' as const, authority: 'account_automation' as const, defaultSessionId: 'source-session',
    actionCaller: { kind: 'session' as const, sessionId: 'source-session', starterDepth: 0, turnDepth: 0 },
    externalActionExecutionAuthorization: authorization, externalActionTarget: target };
  await expect(executor.execute('artifact.access.grants.list', { artifactId }, context)).resolves.toEqual({
    ok: true, result: { artifactId, ownerAccountId: 'owner', access: 'owner', grants: [] },
  });
  allowed = false;
  await expect(executor.execute('artifact.access.grants.list', { artifactId }, context))
    .resolves.toMatchObject({ ok: false, error: 'artifact_access_forbidden' });
  expect(reads).toEqual([
    `/v1/artifacts/${artifactId}/access/grants`, `/v1/artifacts/${artifactId}/access/grants`,
  ]);
  expect(reads.some(path => path.includes('/access/recipients'))).toBe(false);
});
