import { mkdtemp, rm } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as https from 'node:https';
import type { RequestOptions } from 'node:https';
import * as dns from 'node:dns/promises';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import type { RegistryHttpV1, RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createTestNpmTarball, sriSha512 } from '@/plugins/distribution/testkit/npmTarball';
import { npmHttpResponse, npmHttpRequestBoundary } from '@/plugins/distribution/testkit/npmHttp';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent, type MachineRpcAdmissionBoundary } from '@/api/machine/machineRpcAuthorization';
import { reloadConfiguration } from '@/configuration';
import { createCliRegistryHostV1 } from './createCliRegistryHost';
import { createCliBotTemplateActionDeps } from '@/session/actions/cliActionDeps/botTemplates';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../server/sources/storage/db';
import { inTx } from '../../../server/sources/storage/inTx';
import { resolveMachineAdmission, setMachineAccessGrantInTx } from '../../../server/sources/app/machines/machineAccess';
import { resolveExternalActionExecutionMachineAdmissionInTx } from '../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { makeShareEligibleForTest } from '../../../server/sources/testkit/shareEligibility.testkit';
import { auth } from '../../../server/sources/app/auth/auth';
import { enableAuthentication } from '../../../server/sources/app/api/utils/enableAuthentication';
import { registerExternalActionRoutes } from '../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { initializeServerIdentityCache } from '../../../server/sources/app/serverIdentity/serverIdentity';

// Native network boundaries; preserve the production npm client and profile service.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: vi.fn(actual.request) };
});
vi.mock('node:dns/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

const roots: string[] = [];
let database: LightSqliteHarness;
// The fixture is the real HTTP boundary with the server's decorated app type.
const homeApp = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as Parameters<typeof enableAuthentication>[0];
beforeAll(async () => {
  database = await createLightSqliteHarness({ tempDirPrefix: 'happier-template-machine-admission-', initAuth: true, initEncrypt: true });
  homeApp.setValidatorCompiler(validatorCompiler);
  homeApp.setSerializerCompiler(serializerCompiler);
  enableAuthentication(homeApp);
  registerExternalActionRoutes(homeApp, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
  await homeApp.ready();
}, 120_000);
afterAll(async () => { await homeApp.close(); await database?.close(); });
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it.each(['happier-npm', 'happier-catalog'] as const)('admits private %s template acquisition once with Manage and preserves typed refusals', async format => {
  const [{ createPluginCompatibilityProjectionV1 }, { PluginManifestV2Schema }, { createMarketplaceNpmDiscoveryProjectionV1 },
    { BotTemplateReleaseV1Schema }] = await Promise.all([
    import('@happier-dev/protocol/plugins/availability/compatibilityProjectionV1'), import('@happier-dev/protocol/plugins/manifest'),
    import('@happier-dev/protocol/marketplace'), import('@happier-dev/protocol/bots/templates/botTemplateV1'),
  ]);
  const { deriveMarketplaceSourceId } = await import('@happier-dev/protocol/marketplace');
  const release = BotTemplateReleaseV1Schema.parse({ v: 1, version: '2.0.0', releasedAtMs: 1, changelog: 'Garden update',
    content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Use native plants.' },
      memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
  const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({ id: 'acme.garden', version: '1.0.0',
    contributes: { botTemplates: [{ id: 'garden', path: 'templates/garden.json' }, { id: 'future', path: 'templates/future.json' }] } }));
  const bytes = await createTestNpmTarball([
    { name: 'package/package.json', body: JSON.stringify({ name: '@acme/garden', version: '1.0.0', keywords: ['happier-plugin'],
      files: ['.happier-plugin', 'daemon.mjs', 'templates'], happier: { manifest: '.happier-plugin/plugin.json' },
      scripts: { install: 'must-never-execute' }, dependencies: { 'must-never-install': '*' } }) },
    { name: 'package/.happier-plugin/plugin.json', body: JSON.stringify(manifest) },
    { name: 'package/daemon.mjs', body: 'throw new Error("must-never-activate")' },
    { name: 'package/templates/garden.json', body: JSON.stringify(release) },
    { name: 'package/templates/future.json', body: '{"v":999}' },
  ]);
  const compatibility = createPluginCompatibilityProjectionV1({ manifest, uiArtifacts: { version: 2, entries: [] } });
  const discovery = createMarketplaceNpmDiscoveryProjectionV1({ compatibility,
    manifestDigest: `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}` });
  // The catalog boundary supplies real generated metadata; archive staging independently admits its bytes.
  const listing = { pluginId: manifest.id, publisher: { id: 'acme', displayName: 'Acme' }, display: discovery.display,
    distribution: { kind: 'npm', registryOrigin: 'https://registry.example.test', packageName: '@acme/garden', version: '1.0.0', integrity: sriSha512(bytes) },
    manifestDigest: discovery.manifestDigest, compatibility: { platforms: [] }, summary: discovery.summary,
    review: { status: 'unreviewed', reviewedAt: null }, categories: [], media: [], updatePolicy: 'allowed', links: {} };
  const source: RegistrySourceDescriptorV1 = { id: format === 'happier-catalog'
    ? deriveMarketplaceSourceId('https://catalog.example.test/index.json') : 'templates', title: 'Templates', format, kinds: ['plugin'],
    url: format === 'happier-npm' ? 'https://registry.example.test' : 'https://catalog.example.test/index.json',
    enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };
  const http: RegistryHttpV1 = { getJson: async url => ({ ok: true, fetchedAt: 1, value: new URL(url).origin === 'https://registry.example.test'
    ? { name: '@acme/garden', versions: { '1.0.0': { name: '@acme/garden', version: '1.0.0', _npmUser: { name: 'acme' },
      dist: { integrity: sriSha512(bytes), tarball: 'https://registry.example.test/garden.tgz' },
      happier: { compatibilityProjection: compatibility, marketplaceDiscovery: discovery } } } }
    : { source: { id: source.id, sourceUrl: source.url, title: source.title, kind: 'user' },
      freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [listing], diagnostics: [] } }),
    getText: async () => { throw new Error('No text transport expected'); },
    getBytes: async () => ({ ok: true, value: bytes, fetchedAt: 1 }) };
  const itemId = format === 'happier-npm' ? '@acme/garden' : manifest.id;
  const pointer = { sourceId: source.id, itemId, version: '1.0.0' };
  // Owner 2026-10-31 Manage and 2026-11-06 trusted shared Machines: npm
  // profiles are Machine-local; admission already grants Machine administration.
  const home = await mkdtemp(join(tmpdir(), 'happier-template-profile-')); roots.push(home);
  vi.stubEnv('HAPPIER_HOME_DIR', home); reloadConfiguration();
  const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
  const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
  const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
  const keys = tweetnacl.sign.keyPair();
  const machine = await db.machine.create({ data: { id: `template-${custodian.id}`, accountId: custodian.id,
    installationId: 'installation', installationPublicKey: keys.publicKey, active: true,
    metadata: encodePlainMachineStoredContent({ host: 'template-host', platform: 'linux', happyCliVersion: 'test', homeDir: home, happyHomeDir: home }),
    daemonState: encodePlainMachineStoredContent({ status: 'running' }),
    dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
  await makeShareEligibleForTest(custodian.id, manager.id);
  const grant = async (level: 'admin' | 'view') => expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
    actorAccountId: custodian.id, machineId: machine.id, principal: { kind: 'account', accountId: manager.id }, level,
  }))).toMatchObject({ kind: 'saved' });
  await grant('admin');
  const profileId = 'machine-private';
  const profiles = createNpmRegistryProfileService({ happyHomeDir: home });
  expect(await profiles.mutate({ action: 'add', machineId: 'machine', profileId, expectedRevision: 0, mutationId: 'add-profile',
    profile: { displayName: 'Machine registry', origin: 'https://registry.example.test', scopes: ['@acme'],
      useAsDefault: false, allowPrivateNetwork: false } })).toMatchObject({ status: 'success' });
  expect(await profiles.mutate({ action: 'login', machineId: 'machine', profileId, expectedRevision: 1, mutationId: 'login-profile',
    credential: { kind: 'bearer_token', secret: 'machine-registry-fixture' } })).toMatchObject({ status: 'success' });
  // Only third-party HTTP/DNS and Home HTTP are substituted. Profile acquisition,
  // signed daemon admission, integrity verification and archive staging stay real.
  vi.stubGlobal('fetch', async (url: unknown) => {
    if (String(url).endsWith('/garden.tgz')) return new Response(new Uint8Array(bytes));
    const response = await http.getJson(String(url), { source });
    if (!response.ok) throw new Error('Fixture metadata unavailable');
    return Response.json(response.value);
  });
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  const seen: RequestOptions[] = [];
  const responses: IncomingMessage[] = [];
  vi.spyOn(https, 'request').mockImplementation(npmHttpRequestBoundary({ responses, seen }));
  let homeAuthorized = false;
  let legacyPurposeSuccess = false;
  let purposeTransportUnavailable = false;
  const purposeResponses: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    if (String(url).includes('/execution-authorization/')) {
      if (purposeTransportUnavailable) throw new TypeError('Home transport unavailable');
      if (legacyPurposeSuccess) return { status: 200, data: { ok: true }, statusText: 'OK',
        headers: {}, config: { headers: new AxiosHeaders() } };
      // Axios serializes wire headers and leaves internal symbol hints in-process.
      const headers = Object.fromEntries(new Headers(Object.fromEntries(Object.entries(options?.headers ?? {}))));
      const response = await homeApp.inject({ method: 'POST', url: new URL(String(url)).pathname, payload: body, headers });
      const data: unknown = response.json();
      purposeResponses.push(data);
      return { status: response.statusCode, data, statusText: response.statusMessage,
        headers: {}, config: { headers: new AxiosHeaders() } };
    }
    return { status: homeAuthorized ? 200 : 403, data: { v: 1, ok: homeAuthorized },
      statusText: homeAuthorized ? 'OK' : 'Forbidden', headers: {}, config: { headers: new AxiosHeaders() } };
  });
  const boundary: MachineRpcAdmissionBoundary = { machineId: machine.id, resolveInstallationId: () => 'installation',
    resolveCustodianAccountId: async () => custodian.id, resolveHomeServerIdentityId: async () => 'home',
    verifyMachineAdmission: async input => {
      const admitted = await resolveMachineAdmission({ actorAccountId: input.context.actorAccountId,
        machineId: input.context.machineId, rpcMethod: RPC_METHODS.DAEMON_REGISTRIES_FETCH });
      homeAuthorized = admitted.kind === 'admitted' && admitted.role === input.context.role;
      return verifyMachineRpcAdmissionCurrent({ ...input, privateKey: keys.secretKey,
        daemonToken: 'daemon-fixture', serverHttpBaseUrl: 'https://home.invalid' });
    } };
  const machineAdmission = SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: manager.id, custodianAccountId: custodian.id,
    machineId: machine.id, installationId: 'installation', role: 'manage', encryptionMode: 'plain' });
  const request = { method: `${machine.id}:${RPC_METHODS.DAEMON_REGISTRIES_FETCH}`, params: { op: 'list', kind: 'plugin', sourceId: source.id } };
  const queueArtifact = async () => {
    const metadata = await http.getJson('https://registry.example.test/@acme/garden', { source });
    if (!metadata.ok) throw new Error('Fixture metadata unavailable');
    responses.push(npmHttpResponse(metadata.value), Object.assign(Readable.from([bytes]), {
      statusCode: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) },
    }) as unknown as IncomingMessage);
  };
  const privateSource = { ...source, npmRegistryProfileId: profileId };
  const homeId = await initializeServerIdentityCache();
  const actionAuthorization = async (actorAccountId: string) => {
    const envelope = { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: machine.id },
      input: { source: { kind: 'plugin', registryItem: pointer, contributionId: 'garden' } } };
    const token = await auth.createToken(actorAccountId, undefined, { kind: 'account', authority: 'present_user' });
    const response = await homeApp.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('template.preview'),
      headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: machine.id, envelope } });
    if (response.statusCode !== 200) return { status: response.statusCode, authorization: null, refusal: response.json<unknown>() };
    const authorization = await projectExternalActionRequesterHttpAuthorization({
      authorization: ExternalActionExecutionAuthorizationV1Schema.parse(response.json()), rootAdmitted: true,
      serverId: 'home', serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.invalid',
      target: { kind: 'machine', machineId: machine.id }, installationId: 'installation', privateKey: keys.secretKey,
    });
    return { status: response.statusCode, authorization };
  };
  for (const actorAccountId of [custodian.id, manager.id]) {
    const admission = { ...machineAdmission, actorAccountId };
    expect(await authorizeMachineRpcRequest({ ...request, machineAdmission: admission }, boundary)).toMatchObject({ ok: true });
    await queueArtifact();
    const action = await actionAuthorization(actorAccountId);
    expect(action.status).toBe(200);
    if (!action.authorization) throw new Error('Expected a Home-admitted Action carrier');
    const admitted = createCliRegistryHostV1({ actionContext: { externalActionExecutionAuthorization: action.authorization },
      readSources: async () => [privateSource] });
    await expect.soft(admitted.readBotTemplate(pointer, 'garden')).resolves.toMatchObject({ release });
  }
  // Two npm requests (metadata and tarball) spend one acquisition admission each.
  expect(purposeResponses).toEqual([0, 1].map(() => ({ ok: true, nativePurpose: 'machine_npm_profile_acquisition' })));
  expect(await authorizeMachineRpcRequest({ ...request, machineAdmission: { ...machineAdmission, actorAccountId: foreign.id } }, boundary))
    .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
  expect(await authorizeMachineRpcRequest({ ...request, machineAdmission: { ...machineAdmission, installationId: 'foreign-installation' } }, boundary))
    .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
  expect(await actionAuthorization(foreign.id)).toMatchObject({ status: 409, authorization: null,
    refusal: { error: 'invalid_request', code: 'target_unavailable' } });
  await grant('view');
  const useAdmission = { ...machineAdmission, role: 'use' as const };
  // Public registry reads and the Account-only preview carrier both admit Use.
  // Private Machine npm credentials must still respect the approved role boundary.
  expect(await authorizeMachineRpcRequest({ ...request, machineAdmission: useAdmission }, boundary)).toMatchObject({ ok: true });
  expect(await inTx(tx => resolveExternalActionExecutionMachineAdmissionInTx(tx, {
    actorAccountId: manager.id, machineId: machine.id, actionId: 'template.preview',
  }))).toMatchObject({ kind: 'admitted', role: 'use' });
  const privateAcquisition = { actorAccountId: manager.id, machineId: machine.id, actionId: 'template.preview',
    nativePurpose: 'machine_npm_profile_acquisition' as const };
  expect(await inTx(tx => resolveExternalActionExecutionMachineAdmissionInTx(tx, privateAcquisition)))
    .toMatchObject({ kind: 'denied', code: 'access_denied' });
  const useAction = await actionAuthorization(manager.id);
  expect(useAction.status).toBe(200);
  if (!useAction.authorization) throw new Error('Expected a Use-admitted public carrier');
  const purposeCountBeforePublicRead = purposeResponses.length;
  const publicHost = createCliRegistryHostV1({ actionContext: { externalActionExecutionAuthorization: useAction.authorization },
    readSources: async () => [source] });
  await expect(publicHost.readBotTemplate(pointer, 'garden')).resolves.toMatchObject({ release });
  expect(purposeResponses).toHaveLength(purposeCountBeforePublicRead);
  const useHost = createCliRegistryHostV1({ actionContext: { externalActionExecutionAuthorization: useAction.authorization },
    readSources: async () => [privateSource] });
  const nativeRequestsBeforeUse = seen.length;
  const secretRoot = resolvePluginStorePaths({ happyHomeDir: home }).secretsDir;
  const materializationReads = () => vi.mocked(fsPromises.readFile).mock.calls.filter(([path]) =>
    String(path).startsWith(secretRoot) || String(path) === join(home, 'device-local-secret-key.json')).length;
  const materializationReadsBeforeUse = materializationReads();
  expect(materializationReadsBeforeUse).toBeGreaterThan(0);
  // Without an external carrier, ordinary Machine Action admission resolves
  // the declared raw RPC binding and refuses the grantee before artifact work.
  const purposeCountBeforeUnboundAction = purposeResponses.length;
  expect(await resolveMachineAdmission({ actorAccountId: manager.id, machineId: machine.id,
    actionId: 'template.preview', callerAuthority: 'present_user' }))
    .toEqual({ kind: 'denied', code: 'custodian_only' });
  expect(await resolveMachineAdmission({ actorAccountId: custodian.id, machineId: machine.id,
    actionId: 'template.preview', callerAuthority: 'present_user' }))
    .toMatchObject({ kind: 'admitted', actorAccountId: custodian.id, role: 'manage' });
  expect(purposeResponses).toHaveLength(purposeCountBeforeUnboundAction);
  expect(seen).toHaveLength(nativeRequestsBeforeUse);
  expect(materializationReads()).toBe(materializationReadsBeforeUse);
  const useReadOutcome = await useHost.readBotTemplate(pointer, 'garden').then(
    () => ({ kind: 'resolved' as const }),
    (error: unknown) => ({ kind: 'refused' as const, code: error instanceof Error && 'code' in error ? error.code : null,
      status: error instanceof Error && 'status' in error ? error.status : null }),
  );
  const requiredProfileAdmission = { ok: false, nativePurpose: 'machine_npm_profile_acquisition',
    code: 'access_denied', requiredRole: 'manage' };
  expect(useReadOutcome).toEqual({ kind: 'refused', code: 'auth_failed',
    status: { state: 'auth_failed', machineNpmProfileAdmission: requiredProfileAdmission } });
  const unavailableBoundary = async (): Promise<never> => { throw new Error('Unexpected Session or Artifact boundary'); };
  const preview = createCliBotTemplateActionDeps({}, {
    artifactCallerContext: context => context, homeAccountId: manager.id,
    isSameActionHomeId: serverId => serverId === 'home', roleArtifactStore: undefined,
    resolveTransportForSession: unavailableBoundary, readTransportSessionOwnerMetadata: unavailableBoundary,
    resolveServerRequestHeaders: () => null,
    content: { promptDocGet: unavailableBoundary, skillActionExecute: unavailableBoundary },
    // Account catalog persistence is the boundary; registry and Action owners remain real.
    registryPort: { serverId: 'home', matchesServerId: serverId => serverId === 'home', assertCurrent: () => {},
      readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ revision: 1,
        record: { key: 'registry-sources', value: { v: 2, sources: [privateSource], disabledSourceIds: [] } } }],
        tombstones: [], diagnostics: [] } }), writeRecord: unavailableBoundary },
  }).botTemplateAction!;
  expect(await preview({ actionId: 'template.preview', input: { source: { kind: 'plugin', registryItem: pointer, contributionId: 'garden' } },
    context: { surface: 'cli', serverId: 'home', runtimeAccountId: manager.id, authority: 'present_user',
      externalActionExecutionAuthorization: useAction.authorization } }))
    .toMatchObject({ ok: false, errorCode: 'auth_failed', details: { registryStatus: {
      state: 'auth_failed', machineNpmProfileAdmission: requiredProfileAdmission } } });
  expect(seen).toHaveLength(nativeRequestsBeforeUse);
  expect(materializationReads()).toBe(materializationReadsBeforeUse);
  expect(purposeResponses).toContainEqual({ ok: false, nativePurpose: 'machine_npm_profile_acquisition',
    code: 'access_denied', requiredRole: 'manage' });
  const custodianAction = await actionAuthorization(custodian.id);
  if (!custodianAction.authorization) throw new Error('Expected the custodian Action');
  legacyPurposeSuccess = true;
  const legacyHome = createCliRegistryHostV1({ actionContext: { externalActionExecutionAuthorization: custodianAction.authorization },
    readSources: async () => [privateSource] });
  await expect(legacyHome.readBotTemplate(pointer, 'garden')).rejects.toMatchObject({ code: 'auth_failed' });
  expect(seen).toHaveLength(nativeRequestsBeforeUse);
  expect(materializationReads()).toBe(materializationReadsBeforeUse);
  legacyPurposeSuccess = false;
  purposeTransportUnavailable = true;
  await expect(legacyHome.readBotTemplate(pointer, 'garden')).rejects.toMatchObject({ code: 'unreachable', status: { state: 'unreachable' } });
  expect(seen).toHaveLength(nativeRequestsBeforeUse);
  expect(materializationReads()).toBe(materializationReadsBeforeUse);
  purposeTransportUnavailable = false;
  await queueArtifact();
  const ownAgent = createCliRegistryHostV1({ readSources: async () => [privateSource], actionContext: {
    externalActionCredential: { accountId: custodian.id, principalId: 'agent', credentialId: 'agent-credential',
      grant: ApiTokenGrantV1Schema.parse({ v: 1, actions: null, targets: null, approve: false, origins: [], models: null, permissionModes: null, create: null }) },
  } });
  await expect.soft(ownAgent.readBotTemplate(pointer, 'garden')).resolves.toMatchObject({ release });
  expect(seen).toHaveLength(6);
  expect(seen.every(({ headers }) => headers && 'authorization' in headers
    && headers.authorization === 'Bearer machine-registry-fixture')).toBe(true);
});
