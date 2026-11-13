import { afterEach, expect, it, onTestFailed, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStoredCredentialsForServerId, removeStoredCredentialsForServerId, writeStoredCredentialsForServerId, type StoredCredentials } from '@/persistence';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { accountSettingsParse, ProviderConnectionIdSchema, type McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { ApiClient } from '@/api/api';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createMutableApiSessionClientFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { runHostSessionRuntime, type HostSessionRuntimeFactoryParams } from './runHostSessionRuntime';
import { bindProcessLogger, Logger, logger } from '@/ui/logger';
import { configuration, reloadConfiguration } from '@/configuration';
import { createRequesterSessionCredentialCustody } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { replacePrivateBearerFile } from '@/daemon/privateBearerFile';
import tweetnacl from 'tweetnacl';
import { prepareAccountSettingsV2Content, parseSettingsFromContent } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { sealMcpServerCatalogContentV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { sealPromptLibraryContentV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { resolveSecretReferenceOverlayEnvironment } from '@/settings/secrets/secretReferenceOverlay';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createSessionRunReportPolicyReader } from '@/api/sessionFollowCreationPreferences';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { SESSION_FOLLOW_HTTP_PATHS_V1, SessionAutoFollowPreferencesResponseSchema } from '@happier-dev/protocol/sessions/follow/api';
import { DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { AgentLaunchMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';
import type { AgentIsolationDaemonObservation } from '@/daemon/agentIsolation/provisioning';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';

const nativeHomes = vi.hoisted(() => new Map<string, Readonly<{
  backingDirectory: string; uid: number; gid: number;
}>>());
const nativeProcess = vi.hoisted(() => ({ uid: undefined as number | undefined,
  observe: undefined as ((phase: string) => void) | undefined,
  spawn: undefined as ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess | undefined) | undefined }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual,
    spawn: (command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
      const observe = nativeProcess.observe;
      const child = nativeProcess.spawn?.(command, args, options) ?? actual.spawn(command, args, options);
      observe?.('child_created');
      child.once('spawn', () => observe?.('child_spawned'));
      child.once('error', () => observe?.('child_error'));
      child.once('exit', () => observe?.('child_exited'));
      child.once('close', () => observe?.('child_closed'));
      child.stdout?.once('data', () => observe?.('child_stdout'));
      child.stderr?.once('data', () => observe?.('child_stderr'));
      return child;
    },
    execFile: (...args: unknown[]) => {
      const [command] = args;
      if (nativeProcess.uid === undefined || command !== 'setfacl')
        return Reflect.apply(actual.execFile, undefined, args);
      const callback = args.at(-1);
      if (typeof callback === 'function') callback(null, '', '');
      return undefined;
    },
  };
});
// Only native filesystem observations are substituted. The member factory,
// private bootstrap, Session birth and ordinary MCP preparation stay real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      const home = nativeHomes.get(String(path));
      return home ? Object.assign(await actual.lstat(home.backingDirectory), {
        uid: home.uid, gid: home.gid, mode: 0o40700,
      }) : actual.lstat(path);
    },
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => nativeHomes.has(String(path))
      ? String(path) : actual.realpath(path),
  };
});

// OS virtual-mount substitute for the sudo process boundary only. The actual
// source launcher consumes frame-selected JSON and opens a real MCP subprocess.
const nativeMcpWorker = String.raw`
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { isAbsolute, join, relative } = require('node:path');
const backingHome = process.env.MCP_SESSION_NATIVE_HOME;
let buffered = Buffer.alloc(0);
let nativeHome;
function mountedPath(path) {
  if (!nativeHome || !backingHome || typeof path !== 'string'
    || path !== nativeHome && !path.startsWith(nativeHome + '/')) return path;
  const suffix = relative(nativeHome, path);
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('../')) return path;
  return join(backingHome, suffix);
}
async function receive(chunk) {
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length < 12) return;
  if (buffered.subarray(0, 8).toString() !== 'HAPAGT1\n') throw new Error('frame_invalid');
  const length = buffered.readUInt32BE(8);
  if (buffered.length < 12 + length) return;
  process.stdin.pause(); process.stdin.off('data', receiveChunk);
  const payload = JSON.parse(buffered.subarray(12, 12 + length).toString('utf8'));
  nativeHome = payload.nativeIdentity?.home;
  // sudo is the substituted OS boundary. Keep canonical Home in all data,
  // while performing its real filesystem effects in a fresh private mount.
  for (const method of ['existsSync', 'mkdirSync', 'chmodSync', 'readFileSync', 'statSync', 'lstatSync', 'realpathSync']) {
    const original = syncFs[method];
    syncFs[method] = Object.assign((path, ...args) => original(mountedPath(path), ...args), original);
    if (typeof original.native === 'function') {
      syncFs[method].native = (path, ...args) => original.native(mountedPath(path), ...args);
    }
  }
  const files = new Map(payload.selectedMaterials.map(file => [join(payload.runtimeHome, file.relativePath), Buffer.from(file.contentBase64, 'base64')]));
  const read = fs.readFile;
  fs.readFile = async (path, options) => {
    const bytes = files.get(String(path));
    return !bytes ? read(mountedPath(path), options) : options === 'utf8' || options?.encoding === 'utf8' ? bytes.toString('utf8') : Buffer.from(bytes);
  };
  syncBuiltinESMExports();
  process.send({ kind: 'frame', uid: payload.nativeIdentity?.agentUid,
    hasSessionContext: files.has(join(payload.runtimeHome, '.happier/session-mcp.json')),
    selectedPaths: [...files.keys()], runtimeHome: payload.runtimeHome });
  const launcher = process.env.MCP_SESSION_LAUNCHER;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, payload.environment);
  const remainder = buffered.subarray(12 + length); buffered = Buffer.alloc(0);
  if (remainder.length) process.stdin.unshift(remainder);
  await import(launcher);
  setImmediate(() => process.stdin.resume());
}
function receiveChunk(chunk) { void receive(chunk).catch(error => {
  process.send({ kind: 'fixture_failure', code: typeof error?.code === 'string' ? error.code : error?.name,
    syscall: error?.syscall,
    pathCategory: typeof error?.path === 'string' && nativeHome
      && (error.path === nativeHome || error.path.startsWith(nativeHome + '/')) ? 'native_home' : 'outside_native_home',
    missingExport: String(error?.message ?? '').match(/does not provide an export named '([A-Za-z_$][A-Za-z0-9_$]*)'/)?.[1] });
  process.stderr.write(String(error?.stack ?? error) + '\n'); process.exit(1);
}); }
process.stdin.on('data', receiveChunk);
`;

afterEach(() => {
  nativeHomes.clear();
  nativeProcess.uid = undefined;
  nativeProcess.observe = undefined;
  nativeProcess.spawn = undefined;
  resetActiveAccountSettingsSnapshotForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  reloadConfiguration();
});

it.each((['fresh', 'resume', 'member', 'member-native', 'member-native-path-a', 'member-native-path-b',
  'member-native-path-absent', 'copied', 'missing-home', 'retired-account',
  'legacy-empty', 'legacy-selected', 'modern-missing-access', 'legacy-partial', 'legacy-unknown',
  'parent-carrier', 'shared-view-session', 'shared-edit-session', 'missing-session', 'member-logging-failure',
  'historical-capsule', 'retained-owner-capsule', 'foreign-home-capsule',
  'malformed-capsule', 'different-bearer-capsule', 'foreign-account-capsule',
  'no-mcp-provider', 'no-mcp-provider-e2ee', 'mcp-provider-overlay', 'no-mcp-provider-restricted',
  'no-mcp-plugin-exec-refusal', 'voice-child-owner', 'voice-child-member-use', 'voice-child-member-manage'] as const).filter(kind => !kind.startsWith('member-native') || process.platform === 'linux'))(
  'qualifies an ordinary native Session from its authenticated physical custodian, not absent requester scope (%s)', async kind => {
  const nativeCase = kind.startsWith('member-native');
  const hostedNativeCase = kind.startsWith('member-native-path-');
  const providerCase = kind.includes('provider');
  const childCase = kind.startsWith('voice-child-');
  let boundaryPhase = 'runtime_fixture';
  const boundaryPhases = new Set<string>();
  if (childCase) {
    nativeProcess.observe = value => { boundaryPhases.add(value); };
    onTestFailed(() => console.error('[MCP Voice fixture boundary]', { phase: boundaryPhase, boundaryPhases: [...boundaryPhases] }));
  }
  const noManagedMcp = kind.startsWith('no-mcp-provider') || kind === 'no-mcp-plugin-exec-refusal' || childCase;
  const mode = kind === 'no-mcp-provider-e2ee' ? 'e2ee' : 'plain';
  const { projectSessionAccessCapabilitiesV1, SessionEffectiveAccessV1Schema } = await import('@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1');
  const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
  const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
  const { loadBundledPluginLocators } = await import('@/plugins/projection/registry/builtIn/locators');
  const { projectBuiltInAgents } = await import('@/plugins/projection/registry/builtIn/agents');
  const { projectLoadedPluginContributes } = await import('@/plugins/projection/registry/fullProjection');
  const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
  const { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS, BUNDLED_FIRST_PARTY_PLUGIN_METADATA } = await import('@/plugins/projection/registry/sources/generatedBundledPluginManifests');
  const { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } = await import('@/plugins/projection/registry/sources/generatedBundledPlugins');
  const { PluginManifestV2Schema } = await import('@happier-dev/protocol/plugins/manifest/v2');
  const { readPluginManifestReferencedPluginIdsV2 } = await import('@happier-dev/protocol/plugins/manifest/ingest');
  // Load the real current Pi declaration through the normal manifest loader.
  // This scoped runtime does not depend on unrelated bundled projections.
  const piLocator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(locator => locator.pluginId === 'happier.agent.pi');
  if (!piLocator) throw new Error('Pi bundled locator unavailable');
  const sourceLocators = [piLocator];
  const sourceDeclarations: Array<Omit<typeof piLocator, 'manifestRelativePath'> & {
    manifest: ReturnType<typeof PluginManifestV2Schema.parse>;
  }> = [];
  for (const locator of sourceLocators) {
    const metadata = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find(candidate => candidate.pluginId === locator.pluginId);
    if (!metadata) throw new Error(`${locator.pluginId} source package metadata unavailable`);
    const sourcePath: string = `../../../../../../../packages/plugins/${metadata.pluginPackageId}/src/manifest`;
    const source: unknown = await import(sourcePath);
    if (!source || typeof source !== 'object' || !('PLUGIN_MANIFEST' in source)) throw new Error(`${metadata.pluginPackageId} source manifest unavailable`);
    const manifest = PluginManifestV2Schema.parse(source.PLUGIN_MANIFEST);
    // Authored source declarations need canonical admission; only generated
    // file declarations have already crossed the publisher's build admission.
    const { manifestRelativePath: _manifestRelativePath, ...inlineLocator } = locator;
    sourceDeclarations.push({ ...inlineLocator, manifest });
    for (const pluginId of readPluginManifestReferencedPluginIdsV2(manifest)) {
      if (sourceLocators.some(candidate => candidate.pluginId === pluginId)) continue;
      const reference = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(candidate => candidate.pluginId === pluginId);
      if (!reference) throw new Error(`${pluginId} referenced bundled locator unavailable`);
      sourceLocators.push(reference);
    }
  }
  // Pi's real Connected Account references must resolve without opening real
  // Account credentials or a native Agent. The legacy-selected case opens only
  // its fixture SDK stdio child. Keep those real peer declarations.
  const loadedPlugins = loadBundledPluginLocators(sourceDeclarations);
  const projected = projectLoadedPluginContributes({
    loadResult: { loadedPlugins, diagnosticsByPluginId: {} },
    provenance: 'first_party',
  });
  const contributes = createResolvedContributionRegistry({ ...projected,
    agents: projectBuiltInAgents({ manifestAgents: projected.agents ?? [],
      registrationBindings: BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS.filter(binding => binding.identity.pluginId === piLocator.pluginId) }),
  });
  const runtimeFixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { contributes, pluginIds: nativeCase ? sourceDeclarations.map(declaration => declaration.pluginId) : [] } });
  const profileId = 'pi-native-owner-regression';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: kind.startsWith('member') || kind.includes('child-member') ? 'pi-member' : 'pi-owner', session: 'pi-terminal' })).toString('base64url')}.fixture`;
  const accountMachineKey = new Uint8Array(32).fill(7);
  const accountPublicKey = tweetnacl.box.keyPair.fromSecretKey(accountMachineKey).publicKey;
  await writeStoredCredentialsForServerId(profileId, { token, encryption: mode === 'e2ee'
    ? { type: 'dataKey', machineKey: accountMachineKey, publicKey: accountPublicKey } : null });
  const storedCredentials = await readStoredCredentialsForServerId(profileId);
  if (!storedCredentials) throw new Error('Stored owner fixture unavailable');
  let credentials: StoredCredentials = kind === 'copied' ? { token: storedCredentials.token, encryption: null } : storedCredentials;
  expect(credentials.requesterSessionCredentialScope).toBeUndefined();
  const installation = readOrCreateInstallationIdentitySync();
  let machineReads = 0;
  let sessionReads = 0;
  let mcpCatalogReads = 0;
  let materialReads = 0;
  let ownerSnapshot: ActiveAccountSettingsSnapshot | undefined;
  const rawSettings = { mcpServersStrictMode: true };
  const settingsContent = prepareAccountSettingsV2Content({ credentials, raw: rawSettings,
    envelopeKind: mode === 'e2ee' ? 'encrypted' : 'plain' });
  const openedSettings = await parseSettingsFromContent({ credentials, content: settingsContent,
    emptyEnvelopeKind: mode === 'e2ee' ? 'encrypted' : 'plain' });
  const resourceId = 'child-launch-token';
  const resourceRef = `happier:shared-secret:v1:${resourceId}`;
  const resourceDataKey = new Uint8Array(32).fill(11);
  const resourceValue = { v: 1 as const, name: 'Child launch token', kind: 'token' as const, value: 'synthetic-child-value' };
  const resourceContent = mode === 'e2ee'
    ? sealSavedSecretResourceStoredContentV1({ resourceId, mode, resourceDataKey,
      randomBytes: length => new Uint8Array(length).fill(12), content: resourceValue })
    : sealSavedSecretResourceStoredContentV1({ resourceId, mode, content: resourceValue });
  const home = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/machines/pi-machine' && request.headers.authorization === `Bearer ${token}`) {
      machineReads++;
      // Exact owner-only GET serialization from released server .17,
      // a2c45c86804b24e60ac0b76146a3ef36dfcaa15b, machineSerialization.ts.
      // Retire this vector when that supported writer and the predecessor seam retire.
      const legacy: Record<string, unknown> = { id: 'pi-machine', metadata: '', metadataVersion: 0,
        daemonState: null, daemonStateVersion: 0, dataEncryptionKey: null,
        installationId: installation.installationId, installationPublicKey: null, contentPublicKeyFingerprint: null,
        replacedByMachineId: null, replacedAt: null, replacementReason: null, replacementSource: null,
        replacementActorUserId: null, seq: 0, active: true, activeAt: 1, revokedAt: null, createdAt: 1, updatedAt: 1 };
      if (kind === 'legacy-partial') delete legacy.activeAt;
      if (kind === 'legacy-unknown') legacy.unrecognizedMachineAuthority = true;
      const modern: Record<string, unknown> = { id: 'pi-machine', installationId: installation.installationId,
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, storageMode: 'plain',
        kind: 'persistent', keyBasis: { dataEncryptionKey: null, metadataVersion: 0, daemonStateVersion: 0 },
        access: { custodian: { accountId: 'pi-owner', displayName: 'Owner' }, role: kind === 'voice-child-member-use' ? 'use' : 'manage',
          resourceMode: 'plain', accessState: 'ready' } };
      if (kind === 'modern-missing-access') delete modern.access;
      response.end(JSON.stringify({ machine: kind.startsWith('legacy-') ? legacy : modern }));
    } else {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path === '/v1/account/saved-secrets/resources/materials') {
        materialReads++;
        response.end(JSON.stringify({ resources: [{ resourceId, encryptionMode: mode,
          entry: { ref: resourceRef, source: 'shared_resource', relationship: 'owner', ownerAccountId: nativeCase ? 'pi-member' : 'pi-owner',
            name: 'Child launch token', kind: 'token', revision: 1, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
          storedContent: resourceContent, recipientEnvelope: mode === 'plain' ? null : {
            encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceDataKey,
              recipientPublicKey: accountPublicKey, randomBytes: length => new Uint8Array(length).fill(13) })).toString('base64'),
            recipientContentPublicKeyFingerprint: 'fixture-content-key' },
        }] })); return;
      }
      if (path === '/v1/account/entity-rows/mcp') mcpCatalogReads++;
      if (path === '/v2/sessions/pi-session') {
        sessionReads++;
        if (kind === 'missing-session') {
          response.statusCode = 404; response.end(JSON.stringify({ error: 'session_unavailable' })); return;
        }
        const accessLevel = kind === 'shared-view-session' ? 'view' : kind === 'shared-edit-session' ? 'edit' : null;
        const session = createSessionRecordFixture({ id: 'pi-session', encryptionMode: 'plain', dataEncryptionKey: null,
          metadata: JSON.stringify({ machineId: 'pi-machine' }), share: accessLevel ? { accessLevel, canApprovePermissions: false } : null });
        response.end(JSON.stringify({ session: kind.startsWith('legacy-') ? session : { ...session,
          effectiveAccess: SessionEffectiveAccessV1Schema.parse({ v: 1, level: accessLevel ?? 'owner',
            sources: accessLevel ? [{ kind: 'direct', shareId: 'foreign-session-grant' }] : [{ kind: 'owner' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: accessLevel === null,
              grants: accessLevel ? [{ accessLevel, canApprovePermissions: false }] : [] }) }) } })); return;
      }
      const body = path === SESSION_FOLLOW_HTTP_PATHS_V1.preferences
        ? SessionAutoFollowPreferencesResponseSchema.parse({ ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1,
          ...DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 })
        : path === '/v2/account/settings' ? { version: 1, content: settingsContent }
        : path === '/v1/account/entity-rows/mcp' ? { status: 'present', revision: 1,
          content: ownerSnapshot?.mcpServerCatalog?.status === 'ready'
            ? sealMcpServerCatalogContentV1({ mode, material: credentials.encryption, catalog: ownerSnapshot.mcpServerCatalog.catalog }) : null }
        : path === '/v1/account/entity-rows/prompt-library' ? { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key,
          revision: 1, content: sealPromptLibraryContentV1({ mode, material: credentials.encryption, record: emptyPromptLibraryRecordV1(key) }) })) }
        : path === '/v1/account/profile' ? { id: kind.includes('child-member') || nativeCase ? 'pi-member' : 'pi-owner' }
        : path === '/v1/artifacts' ? []
        : path === '/v1/account/encryption' ? { mode, updatedAt: 1 }
        : path === '/v1/account/encryption/currentness'
          ? { mode, version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 }
        : path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
          ? ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] }) : null;
      response.statusCode = body === null ? 404 : 200;
      response.end(JSON.stringify(body ?? {}));
    }
  });
  await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
  const address = home.address();
  if (!address || typeof address === 'string') throw new Error('Home fixture unavailable');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  if (childCase || nativeCase) {
    // Match the attached Session's selected exact Home at the persistence and
    // environment boundaries; prompt preparation retains real target checks.
    await seedTestServerProfile({ id: profileId, homeId: 'srv_pi_owner', serverUrl });
    vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', profileId);
    vi.stubEnv('HAPPIER_SERVER_URL', serverUrl);
    reloadConfiguration();
  }
  const workingDirectory = await mkdtemp(join(tmpdir(), 'pi-native-owner-'));
  const sessionPath = kind === 'member-native-path-absent' ? undefined
    : join(workingDirectory, kind === 'member-native-path-a' ? 'session-bin-a' : 'session-bin-b');
  const nativeCleanups: Array<() => void | Promise<void>> = [];
  let nativeRuntimeHome: string | undefined;
  let nativeMaterial: AgentLaunchMaterialization | undefined;
  let nativeBirth: RequesterWorkAttributionV1 | undefined;
  let nativeDaemonObservation: AgentIsolationDaemonObservation | undefined;
  const prepareNativeCase = async () => {
    if (!nativeCase) return;
    const { createAgentIsolationMemberPreparationBoundary } = await import('@/daemon/agentIsolation/agentIsolationEffects.testkit');
    const { prepareDaemonConnectedServices } = await import('@/daemon/spawn/prepareDaemonConnectedServices');
    const { resolveRunnerAgentSessionDescriptorForLease } = await import('@/daemon/spawn/prepareAgentRuntimeSessionBridge');
    const { createRunnerAgentSessionBootstrapAuthorization } = await import('@/daemon/agentRuntime/sessionBridgeAuthorization');
    const { HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY } = await import('@/agent/runtime/session/process/agentRuntimeRunnerProtocol');
    const serverDirectory = join(workingDirectory, 'member-server');
    await mkdir(serverDirectory, { mode: 0o700 });
    await mkdir(join(workingDirectory, 'native-worker-home'), { mode: 0o700 });
    const requester = { serverId: profileId, accountId: 'pi-member', machineId: 'pi-machine', installationId: installation.installationId };
    nativeBirth = requester;
    const requesterIdentity = { kind: 'isolated' as const, requester, separationRequired: true,
      homeServerIdentityId: 'srv_pi_owner' };
    const member = createAgentIsolationMemberPreparationBoundary({ activeServerDir: serverDirectory,
      requesterIdentity,
      uid: 2401, custodianAccountId: 'pi-owner', encryptionMode: 'plain' });
    nativeHomes.set(member.filesystemHome.path, member.filesystemHome);
    const noAccountReads = new Proxy({} as ApiClient, { get() { throw new Error('Native member preparation must precede Account reads'); } });
    const prepared = await prepareDaemonConnectedServices({
      options: { directory: workingDirectory, requesterWorkAttributionV1: requester },
      normalizedExistingSessionId: '', requestedSessionId: 'pi-session', effectiveResume: '', catalogAgentId: 'pi',
      credentials, api: noAccountReads, activeServerDir: serverDirectory,
      connectedServicesMaterializationBaseDir: join(workingDirectory, 'materialized'), connectedServiceRefreshCoordinator: null,
      processEnv: {}, pluginRuntimeRegistry: runtimeFixture.registry,
      prepareAgentIsolationMember: async input => {
        const result = await member.prepare({ signal: input.signal });
        if (result.kind !== 'ready') throw new Error('Real member native preparation refused');
        nativeDaemonObservation = result.daemonObservation;
        return { kind: 'member', requesterIdentity, snapshot: undefined,
          identity: result.identity, daemonObservation: result.daemonObservation };
      },
    });
    if (!prepared.ok || !prepared.agentLaunchMaterials?.memberIdentity) throw new Error('Admitted member material is unavailable');
    nativeRuntimeHome = prepared.agentLaunchMaterials.runtimeHome;
    nativeMaterial = prepared.agentLaunchMaterials;
    // The actual provisioning backend creates this enrolled Workspace too.
    // Represent its native path alongside the already substituted member home.
    nativeHomes.set(prepared.agentLaunchMaterials.memberIdentity.workspaceRoot, {
      backingDirectory: workingDirectory, uid: member.filesystemHome.uid, gid: member.filesystemHome.gid,
    });
    nativeProcess.uid = prepared.agentLaunchMaterials.memberIdentity.agentUid;
    if (prepared.auth?.cleanupOnExit) nativeCleanups.push(prepared.auth.cleanupOnExit);
    const descriptor = await resolveRunnerAgentSessionDescriptorForLease({ target: { kind: 'backend', backendId: 'pi' }, lease: runtimeFixture.lease });
    if (!descriptor) throw new Error('Admitted Pi descriptor is unavailable');
    const bootstrap = await createRunnerAgentSessionBootstrapAuthorization({ happyHomeDir: workingDirectory,
      publicReleaseRing: 'stable', descriptor, launch: {
        runtimeDescriptorV1: { v: 1, agentId: descriptor.agentId, agent: {} },
        agentIsolationMemberIdentity: prepared.agentLaunchMaterials.memberIdentity,
        agentIsolationRuntimeHome: prepared.agentLaunchMaterials.runtimeHome,
      } });
    nativeCleanups.push(bootstrap.cleanupBootstrapFile);
    vi.stubEnv(HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY, bootstrap.authorization.bootstrapFilePath);
    // A native tuple cannot create Session birth. Consume the same protected
    // requester capsule a real admitted member runner receives from its parent.
    const { readRequesterSessionCredentialsForChild, REQUESTER_SESSION_ID_ENV } = await import('@/daemon/sessionEncryption/requesterSessionCredentials');
    const requesterCustody = await createRequesterSessionCredentialCustody({ happyHomeDir: configuration.happyHomeDir,
      sessionId: 'pi-session', attribution: requester, credentials, homeServerIdentityId: 'srv_pi_owner' });
    nativeCleanups.push(requesterCustody.cleanup);
    vi.stubEnv(REQUESTER_SESSION_ID_ENV, 'pi-session');
    const retained = await readRequesterSessionCredentialsForChild(requesterCustody.path);
    if (!retained) throw new Error('Original member Session credential capsule is unavailable');
    credentials = retained;
  };
  const custody = kind.endsWith('-capsule') ? await createRequesterSessionCredentialCustody({
    happyHomeDir: configuration.happyHomeDir, sessionId: 'pi-session',
    credentials: kind === 'different-bearer-capsule' ? { ...credentials, token: `${token}.different` } : credentials,
    attribution: { serverId: profileId, accountId: kind === 'foreign-account-capsule' ? 'pi-member' : 'pi-owner',
      machineId: 'pi-machine', installationId: installation.installationId },
    ...(kind === 'historical-capsule' ? {} : { homeServerIdentityId: kind === 'foreign-home-capsule' ? 'srv_foreign' : 'srv_pi_owner' }),
  }) : undefined;
  if (kind === 'malformed-capsule' && custody) await replacePrivateBearerFile({ path: custody.path, contents: '{}' });
  const restoreLogger = kind === 'no-mcp-plugin-exec-refusal' || kind === 'member'
    ? bindProcessLogger(new Logger({ logFilePath: join(workingDirectory, 'native-refusal.log'),
      allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false })) : undefined;
  try {
  await prepareNativeCase();
  const settings = accountSettingsParse(openedSettings.raw);
  const childCode = nativeCase
    ? String.raw`
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const q=JSON.parse(line); if(q.id===undefined)return;
        const name=process.env.USER_VALUE==='synthetic-child-value'?'member_ready':'wrong_material';
        const result=q.method==='initialize'?{
          protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'member',version:'1'}
        }:q.method==='tools/list'?{tools:[{name,inputSchema:{type:'object'}}]}:{
          content:[{type:'text',text:name}],
          _meta:{environment:{path:process.env.PATH??null,home:process.env.HOME,
            privateAccountPresent:'PRIVATE_ACCOUNT_SECRET' in process.env}}
        };
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
      });`
    : 'require("node:readline").createInterface({input:process.stdin}).on("line",line=>{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==="initialize"?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"legacy-owner",version:"1"}}:{tools:[{name:"fixture",inputSchema:{type:"object"}}]};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:q.id,result})+"\\n")})';
  const servers: McpServerCatalogEntryV1[] = (kind === 'legacy-empty' ? [] : ['selected', 'excluded']).map(id => ({
    id, name: id, transport: 'stdio', stdio: kind === 'legacy-selected' || nativeCase
      ? { command: process.execPath, args: ['-e', childCode] } : { command: 'echo', args: [id] },
    env: { USER_VALUE: nativeCase ? { t: 'savedSecret', secretId: resourceRef } : { t: 'literal', v: 'materialized-value' } }, createdAt: 1, updatedAt: 1,
  }));
  const snapshot: ActiveAccountSettingsSnapshot = {
    source: 'network', settings, rawSettings: openedSettings.raw, settingsVersion: 1, loadedAtMs: 1,
    settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials), scopeKey: (await import('@/api/client/serverHttpBaseUrl')).runWithServerHttpBaseUrl(serverUrl,
      () => resolveAccountSettingsScopeKey(credentials)),
    promptLibraryCatalog: { status: 'ready', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ revision: 1,
      record: emptyPromptLibraryRecordV1(key) })), tombstones: [], diagnostics: [] },
    mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [],
      catalog: { v: 1, servers, bindings: servers.map(server => ({
        id: `binding-${server.id}`, serverId: server.id, enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1,
      })) } },
  };
  setActiveAccountSettingsSnapshot(snapshot);
  ownerSnapshot = snapshot;
  const metadata = createTestMetadata({ path: workingDirectory, permissionMode: nativeCase ? 'yolo' : 'default',
    ...(kind === 'legacy-empty' ? {} : {
      mcpSelectionV1: { v: 1, managedServersEnabled: !noManagedMcp, forceIncludeServerIds: [], forceExcludeServerIds: ['excluded'] },
    }) });
  // The Session transport is the boundary fixture. The host, real Agent catalog,
  // MCP selection, SavedSecret materializer, permission and queue owners stay real.
  const publishedMutations: unknown[] = [];
  let sessionClosed = false;
  const session = createMutableApiSessionClientFixture({ sessionId: 'pi-session', metadata,
    serverBinding: { serverId: profileId, serverUrl },
    overrides: {
      bindSessionAttachmentNativeRuntime: ApiSessionClient.prototype.bindSessionAttachmentNativeRuntime,
      close: async () => { sessionClosed = true; },
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 }),
      getServerIdentityId: () => kind === 'missing-home' ? undefined : 'srv_pi_owner',
      claimCurrentSessionPublisherAuthorityForStartup: async () => ({ status: 'claimed' }),
      refreshSessionSnapshotFromServerRequired: async () => undefined,
      activateDurableMutationDelivery: async () => undefined,
      deactivateDurableMutationDelivery: () => undefined,
      enqueueSessionTurnMutation: async mutation => { publishedMutations.push(mutation); },
      enqueueRegisteredSessionStateFieldMutation: async () => undefined,
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false }),
      onUserMessage: () => undefined,
      hasPendingProviderInput: () => false,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 }),
      subscribeExecutionRunActivitySnapshots: () => () => undefined,
      setOwnerActivityDelivery: () => undefined,
      setSessionRuntimeControls: () => undefined,
      hasOwnerMetadataAuthority: () => true,
      updateMetadataAsCurrentPublisher: async update => { session.updateMetadata(current => current ? update(current) : current); },
      readRolePromptOrganization: async () => ({}),
    },
  });
  // The real Session metadata transport acknowledges publication asynchronously;
  // preserve the canonical fixture's synchronous view update underneath it.
  const updateFixtureMetadata = session.updateMetadata.bind(session);
  session.updateMetadata = async update => { updateFixtureMetadata(update); };
  const { SessionTeamCredentialLaunchUnavailableError } = await import('@/session/services/sessionTeamCredentialLaunchError');
  const opened = nativeCase ? new SessionTeamCredentialLaunchUnavailableError('resource_unavailable')
    : new Error('Agent open boundary observed');
  const nativeExecRefusal = new PluginError({ code: 'project_requester_credentials_unavailable',
    message: 'PRIVATE_PLUGIN_FAILURE', retryable: false,
    details: { cause: { code: 'ingress_missing', stage: 'dispatch' }, private: 'PRIVATE_PLUGIN_DETAILS' } });
  let request: HostSessionRuntimeFactoryParams | undefined;
  let nativeFactoryCalls = 0;
  let privateConfigPath: string | undefined;
  const api = await ApiClient.create(credentials);
  if (childCase) {
    const { startMcpRequesterParent } = await import('./runHostSessionRuntime.mcpRequester.testkit');
    const { createSessionRunSnapshotFixture } = await import('@/rpc/handlers/executionRuns/sessionRunnerSnapshot.fixture');
    const { acquireExecutionRunRuntimeSnapshot } = await import('@/rpc/handlers/executionRuns/acquireExecutionRunRuntimeSnapshot');
    const { ExecutionRunHostBridge } = await import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge');
    const { resolveAgentCliOverrideEnvKey } = await import('@happier-dev/cli-common/agents/resolution');
    const { registerSessionClientRuntimeHandlers } = await import('@/api/session/client/executionRuns/registerSessionClientRuntimeHandlers');
    const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
    let registeredBridge: import('@/agent/runtime/bridges/executionRun/executionRunBridgeContract').ExecutionRunHostBridgeContract | undefined;
    session.setExecutionRunWorkerUpdateSource = source => { registeredBridge = source; };
    boundaryPhase = 'child_fixture_admission';
    const childFixture = await createSessionRunSnapshotFixture(workingDirectory);
    const nativeCliPath = await writeExecutableShim({ dir: workingDirectory,
      fileName: 'snapshot-parent.cjs', contents: 'process.exitCode = 0;\n' });
    vi.stubEnv(resolveAgentCliOverrideEnvKey('acme.snapshot/parent'), nativeCliPath);
    boundaryPhase = 'parent_start';
    const live = await startMcpRequesterParent({ credentials, session, api, machineId: 'pi-machine',
      snapshot, pluginRuntimeRegistryLease: runtimeFixture.lease });
    boundaryPhase = 'parent_started';
    const rpc = new RpcHandlerManager({ scopePrefix: session.sessionId, encryptionMode: 'plain', logger: () => {} });
    const registration = registerSessionClientRuntimeHandlers({ rpcHandlerManager: rpc, token,
      serverId: profileId, serverUrl, metadataPath: workingDirectory, metadata: session.getMetadataSnapshot(),
      localMachineId: 'pi-machine', sessionId: session.sessionId, session,
      readOwnerAccountCredentials: async () => credentials, getSessionMetadata: () => session.getMetadataSnapshot(),
      get sessionRuntimeControls() { return live.readControls(); },
      enqueueSessionUserMessage: async () => {}, enqueueUserTextMessageCommitted: async () => ({ persisted: true, delivered: true }),
      enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: true }),
      enqueueVoiceAgentTranscriptTurnCommitted: async () => ({ persisted: true, delivered: true }),
      sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }), getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    if (!registeredBridge) throw new Error('Missing registered Session child owner');
    // Reuse the actual registrar's tool/permission composer with the real local
    // admitted snapshot. Session RPC ingress has its own tracked-daemon suite.
    const sessionInteractionHost = Reflect.get(registeredBridge, 'sessionInteractionHost') as import('@/agent/runtime/registry/engineRegistryTypes').NativeAgentSessionInteractionHostBinding;
    const bridge = new ExecutionRunHostBridge({ parentProvider: 'pi', cwd: workingDirectory,
      machineId: 'pi-machine', sendAcp: async () => {},
      sessionInteractionHost,
      // Spend the exact live producer output. No identity or resolver is installed
      // by this test between parent initialization and native child admission.
      resolveAccountSettingsSnapshot: live.readControls()?.resolveAccountSettingsSnapshot,
      resolveAccountSettings: () => snapshot.rawSettings,
      resolveRunReportPolicy: createSessionRunReportPolicyReader({ serverId: profileId, serverHttpBaseUrl: serverUrl,
        accountId: readAccountIdFromToken(credentials.token)!, readCredentials: async () => credentials, isCurrent: () => true }),
      // Match the registrar's credentialed exact-Home binding; keep prompt
      // preparation real rather than exercising its uncredentialed fallback.
      resolveVoicePromptPreparation: async ({ sessionId, signal, workingDirectory: directory }) => await resolveCliVoicePromptPreparation({
        credentials, sessionId, signal, serverId: profileId, serverUrl, machineId: 'pi-machine', directory,
      }),
      resolveExecutionRunProfileCatalog: () => acquireExecutionRunRuntimeSnapshot({ sessionId: session.sessionId,
        machineId: 'pi-machine' }, childFixture.controller),
    });
    try {
      expect(live.parent.mcpServers).toEqual({});
      expect(machineReads).toBe(0);
      // A live Session can enable managed MCP after startup. The child's real
      // composer must then demand the original parent's captured requester.
      await session.updateMetadata(current => current ? { ...current,
        mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['excluded'] },
      } : current);
      boundaryPhase = 'child_start';
      const pending = bridge.start({ sessionId: session.sessionId, intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'acme.snapshot/parent' },
        instructions: 'Inherited parent Voice request', permissionMode: 'read_only', connectedServices: null,
        chatModelId: 'snapshot-native-review', commitModelId: 'snapshot-native-review', bootstrapMode: 'none',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', intentInput: {},
      });
      // Start acknowledges the created Run, including initialization failures;
      // its public state, not promise rejection, owns the execution outcome.
      const started = await pending;
      boundaryPhase = 'child_started';
      expect(started).toMatchObject({ runId: expect.any(String) });
      if (kind === 'voice-child-owner') {
        expect(bridge.getPublic(started.runId)).toMatchObject({ intent: 'voice_agent', status: 'running' });
        const opened: unknown[] = readFileSync(join(workingDirectory, 'native-opens.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(opened).toMatchObject([{ agentId: 'parent', modelId: 'snapshot-native-review' }]);
        expect(await live.parent.resolveAccountSettingsSnapshot?.readAgentExecutionContext?.()).toMatchObject({
          requesterIdentity: { kind: 'isolated', separationRequired: false }, isolationEnabled: false,
        });
      } else {
        expect(bridge.getPublic(started.runId)).toMatchObject({ intent: 'voice_agent', status: 'failed', error: { code: 'VOICE_AGENT_START_FAILED' } });
        expect(existsSync(join(workingDirectory, 'native-opens.jsonl'))).toBe(false);
      }
      expect(machineReads).toBe(1);
      expect(materialReads).toBe(0);
    } finally {
      boundaryPhase = 'bridge_disposal';
      await bridge.dispose();
      boundaryPhase = 'registration_disposal';
      await registration.dispose();
      boundaryPhase = 'parent_stop';
      await live.stop();
      boundaryPhase = 'child_fixture_disposal';
      await childFixture.dispose();
      boundaryPhase = 'child_fixture_disposed';
    }
    return;
  }
  if (kind === 'member-logging-failure') {
    const write = logger.warnLocalFile.bind(logger);
    vi.spyOn(logger, 'warnLocalFile').mockImplementation((...args) => {
      if (args[0] === '[MCP] Execution admission refused') throw new Error('File logging boundary unavailable');
      write(...args);
    });
  }
  if (kind === 'parent-carrier') {
    const { startMcpRequesterParent } = await import('./runHostSessionRuntime.mcpRequester.testkit');
    const live = await startMcpRequesterParent({ credentials, session, api, machineId: 'pi-machine',
      snapshot, pluginRuntimeRegistryLease: runtimeFixture.lease });
    const configPath = live.parent.mcpServers.selected?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
    try {
      const resolver = live.readControls()?.resolveAccountSettingsSnapshot;
      expect(resolver).toBe(live.parent.resolveAccountSettingsSnapshot);
      const operation = resolver?.readOperationContext?.();
      expect(operation?.credentials.token === credentials.token).toBe(true);
      expect(await operation?.isCurrent()).toBe(true);
      expect(operation?.readSnapshot()?.scopeKey).toBe(snapshot.scopeKey);
      expect((await resolver?.())?.scopeKey).toBe(snapshot.scopeKey);
      const first = await resolver?.readAgentExecutionContext?.();
      const second = await resolver?.readAgentExecutionContext?.();
      expect(first).toMatchObject({ requesterIdentity: { kind: 'isolated', separationRequired: false }, isolationEnabled: false });
      expect(first?.requesterIdentity).not.toHaveProperty('accountAutomation', true);
      expect(second).toEqual(first);
      expect(machineReads).toBe(1);
      expect(sessionReads).toBe(1);
      resetActiveAccountSettingsSnapshotForTests();
      expect(await resolver?.()).toBeNull();
      await expect(resolver?.readAgentExecutionContext?.()).rejects.toMatchObject({ code: 'context_source_unavailable' });
    } finally { await live.stop(); }
    await expect(live.parent.resolveAccountSettingsSnapshot?.readAgentExecutionContext?.())
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(live.parent.resolveAccountSettingsSnapshot?.()).rejects.toMatchObject({ name: 'AbortError' });
    expect(configPath).toBeTruthy();
    expect(existsSync(configPath!)).toBe(false);
    expect(machineReads).toBe(1);
    expect(sessionReads).toBe(1);
    return;
  }
  const runSession = () => runHostSessionRuntime({ credentials, directory: metadata.path,
    startedBy: kind.endsWith('-capsule') ? 'terminal' : 'daemon',
    ...(kind === 'resume' || kind.endsWith('-capsule') ? { existingSessionId: session.sessionId } : {}),
    accountSettingsContext: { ...snapshot, whenRefreshed: null } }, {
    flavor: 'pi', policyAgentId: 'pi', backendDisplayName: 'Pi', providerName: 'Pi',
    uiLogPrefix: '[Pi test]', waitingForCommandLabel: 'Pi', agentMessageType: 'pi',
    runtimeActivityApplicability: 'not_applicable',
    resolveRunnerMcpServersAccountSettings: () => {
      if (kind === 'retired-account') resetActiveAccountSettingsSnapshotForTests();
      return settings;
    },
    pluginRuntimeRegistryLease: runtimeFixture.lease,
    ...(kind === 'no-mcp-provider-restricted' ? { runtimeAuthority: {
      scope: 'session' as const, sessionCredentials: credentials, accountCredentials: null,
    } } : {}),
    machineMetadata: { host: 'test', platform: process.platform, happyCliVersion: 'test',
      homeDir: '/tmp', happyHomeDir: '/tmp', happyLibDir: '/tmp',
      ...(nativeCase ? { agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } } : {}) },
    loadTerminalDisplay: async () => () => null, shouldRenderTerminalDisplay: () => false,
    formatPromptErrorMessage: String,
    createSessionRuntime: async params => {
      nativeFactoryCalls++;
      request = params;
      // The native plugin factory is the external Agent boundary. Keep startup,
      // refusal projection, file logging and failed-construction cleanup real.
      if (kind === 'no-mcp-plugin-exec-refusal') throw nativeExecRefusal;
      if (nativeCase) {
        expect(params.mcpServersStrictMode).toBe(true);
        expect(Object.keys(params.mcpServers)).toEqual(['selected']);
        const selectedPath = params.mcpServers.selected?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
        expect(selectedPath?.startsWith(`${nativeRuntimeHome}/files/`)).toBe(true);
        expect(JSON.stringify(params.mcpServers).includes('materialized-value')).toBe(false);
        // The native frame publisher, not daemon-private temporary files,
        // owns publication of selected bytes after this preparation boundary.
        expect(existsSync(selectedPath!)).toBe(false);
        if (!nativeMaterial?.memberIdentity || !nativeBirth || !params.sessionMcpContext || !params.bindMcpExecService)
          throw new Error('Actual native Session MCP preparation is unavailable');
        const { createAgentIsolationSessionContext } = await import('@/daemon/agentIsolation/agentIsolationSessionContext');
        const { createStablePluginExecService } = await import('@/plugins/runtime/invocation/services/exec');
        const { connectSessionMcpClient } = await import('@/mcp/runtime/sessionMcpLocalClient');
        const { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } = await import('@/utils/spawnHappyCLI');
        const { projectPath } = await import('@/projectPath');
        const actualProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        const frames: Array<{ uid: unknown; hasSessionContext: unknown; selectedPaths: unknown; runtimeHome: unknown }> = [];
        const failures: Array<{ code: unknown; syscall: unknown; pathCategory: unknown; missingExport: unknown }> = [];
        onTestFailed(() => console.error('[MCP native fixture boundary]', { frames: frames.length, failures }));
        const children: ChildProcess[] = [];
        const hook = resolveTsxImportHookPath();
        if (!hook) throw new Error('Source loader is unavailable');
        const member = nativeMaterial.memberIdentity;
        nativeProcess.spawn = (command, args, options) => {
          if (command !== 'sudo') return undefined;
          expect(args).toEqual(['-n', '-u', member.username, '--', '/opt/happier/cli/current/happier', 'agent-launch']);
          const child = actualProcess.spawn(process.execPath, ['--conditions=happier-source', '--import', hook, '-e', nativeMcpWorker],
            { ...options, cwd: projectPath(), env: { TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
              MCP_SESSION_NATIVE_HOME: join(workingDirectory, 'native-worker-home'),
              MCP_SESSION_LAUNCHER: join(projectPath(), 'src/mcp/launchers/stdioMcpServerLauncher.ts') },
              stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
          children.push(child);
          child.on('message', message => {
            if (message && typeof message === 'object' && 'kind' in message && message.kind === 'fixture_failure') {
              failures.push({ code: Reflect.get(message, 'code'), syscall: Reflect.get(message, 'syscall'),
                pathCategory: Reflect.get(message, 'pathCategory'), missingExport: Reflect.get(message, 'missingExport') });
            }
            if (message && typeof message === 'object' && 'kind' in message && message.kind === 'frame') frames.push({
              uid: Reflect.get(message, 'uid'), hasSessionContext: Reflect.get(message, 'hasSessionContext'),
              selectedPaths: Reflect.get(message, 'selectedPaths'), runtimeHome: Reflect.get(message, 'runtimeHome'),
            });
          });
          return child;
        };
        const isolation = createAgentIsolationSessionContext({ machine: { read: () => ({ enabled: true,
          status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
          workspaceRoots: [workingDirectory], daemonObservation: nativeDaemonObservation }) },
          managedHappierBinaryPath: '/opt/happier/cli/current/happier', sessionRequester: nativeBirth,
          sessionRequesterHomeServerIdentityId: 'srv_pi_owner', sessionCustodianAccountId: 'pi-owner',
          hostHomeServerIdentityId: 'srv_pi_owner', readMaterial: () => nativeMaterial });
        const exec = createStablePluginExecService({
          signal: new AbortController().signal, isOccurrenceCurrent: () => true, agentIsolation: isolation,
          resolveExecutable: async () => { throw new Error('MCP uses its already resolved native launch tuple'); },
          resolvePath: async () => workingDirectory });
        const releaseExec = params.bindMcpExecService(exec);
        const connection = await connectSessionMcpClient(params.sessionMcpContext);
        try {
          const listed = await connection.client.listTools({ _meta: { 'happier/tool-sources': true } });
          const warnings = listed._meta?.['happier/tool-warnings'];
          expect(Array.isArray(warnings) ? warnings.map(warning => {
            const message = warning && typeof warning === 'object' ? Reflect.get(warning, 'error') : undefined;
            return typeof message === 'string' ? message.match(/MCP error -?\d+|ERR_[A-Z_]+|SyntaxError|Connection closed/g) ?? ['unclassified']
              : ['invalid_warning'];
          }) : warnings).toEqual([]);
          expect(listed.tools.filter(tool => tool._meta?.['happier/tool-source'] === 'selected')
            .map(tool => tool.name)).toEqual(['member_ready']);
          const called = await connection.client.callTool({ name: 'member_ready', arguments: {},
            _meta: { 'happier/tool-source': 'selected' } });
          expect(called.structuredContent).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'member_ready' }] } });
          if (hostedNativeCase) expect(called.structuredContent).toMatchObject({ ok: true, result: {
            _meta: { environment: { path: sessionPath ?? null, home: member.home,
              privateAccountPresent: false } },
          } });
          expect(frames).toHaveLength(2);
          for (const frame of frames) {
            expect(frame.uid).toBe(member.agentUid);
            expect(frame.runtimeHome).toBe(nativeRuntimeHome);
            expect(frame.hasSessionContext).toBe(false);
            expect(frame.selectedPaths).not.toContain(selectedPath);
          }
          expect(materialReads).toBeGreaterThan(0);
        } finally {
          await connection.close(); releaseExec(); nativeProcess.spawn = undefined;
          for (const child of children) if (child.exitCode === null && child.signalCode === null) {
            const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
            child.kill('SIGKILL'); await closed;
          }
        }
        throw opened;
      }
      if (providerCase) {
        const { prepareExecutionRunRuntimeProviderLaunch } = await import('@/agent/runtime/bridges/executionRun/runtime/providerPreparation');
        let providerCalls = 0;
        const prepareProvider = () => prepareExecutionRunRuntimeProviderLaunch({ scope: 'session_owned', happyHomeDir: configuration.happyHomeDir,
          runId: 'configured-child', agentId: 'pi', backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
          selection: { agentTargetKey: 'agent:happier.agent.pi/pi', providerConnectionId: ProviderConnectionIdSchema.parse('fixture-connection'), modelId: 'fixture-model' },
          resolveProvidersFeatureEnabled: () => true, resolveAccountSettingsSnapshot: params.resolveAccountSettingsSnapshot,
          // The pinned daemon Provider-launch RPC is the external boundary.
          providerLaunch: { async prepareLaunch(input) {
            providerCalls++;
            expect(input.expectedAccountSettingsScopeKey).toBe(snapshot.scopeKey);
            return { environment: { CONFIGURED_PROVIDER: 'admitted' }, unsetEnvKeys: [], sanitizeDiagnosticText: value => value,
              additionalRedactionValues: [], revalidateBeforeCommit: async () => ({ ok: true }), cleanupOnExit: null };
          } },
        });
        if (kind === 'no-mcp-provider-restricted') {
          await expect(prepareProvider()).rejects.toMatchObject({ code: 'provider_connection_not_found' });
          expect(await params.resolveAccountSettingsSnapshot?.({ secretReferenceOverlay: {
            v: 1, bindings: { CHILD_TOKEN: { ref: resourceRef, revision: 1 } },
          } })).toBeNull();
          expect(providerCalls).toBe(0);
          expect(materialReads).toBe(0);
          throw opened;
        }
        expect(materialReads).toBe(0);
        const prepared = await prepareProvider();
        expect(providerCalls).toBe(1);
        expect(prepared.environment.CONFIGURED_PROVIDER === 'admitted').toBe(true);
        expect(materialReads).toBe(0);
        const overlay = { v: 1 as const, bindings: { CHILD_TOKEN: { ref: resourceRef, revision: 1 } } };
        const admitted = await params.resolveAccountSettingsSnapshot?.({ secretReferenceOverlay: overlay });
        expect(admitted?.scopeKey).toBe(snapshot.scopeKey);
        if (!admitted) throw new Error('Missing admitted launch overlay');
        const env = resolveSecretReferenceOverlayEnvironment({ accountSettings: admitted.settings,
          savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(admitted,
            { isCurrent: () => params.resolveAccountSettingsSnapshot?.readOperationContext?.()?.readSnapshot() === admitted }),
          settingsSecretsReadKeys: admitted.settingsSecretsReadKeys, savedSecretResources: admitted.savedSecretResources,
          secretReferenceOverlay: overlay });
        expect(env.CHILD_TOKEN === 'synthetic-child-value').toBe(true);
        // The existing plain legacy importer can take a census read before
        // fresh authorization. The contract here is demand, not that internal count.
        expect(materialReads).toBeGreaterThan(0);
        if (noManagedMcp) {
          expect(params.mcpServers).toEqual({});
          expect(mcpCatalogReads).toBe(0);
        } else expect(params.mcpServers.selected).toBeDefined();
        resetActiveAccountSettingsSnapshotForTests();
        await expect(prepareProvider()).rejects.toMatchObject({ code: 'provider_connection_not_found' });
        expect(providerCalls).toBe(1);
        throw opened;
      }
      const bridgeEnvironment = Reflect.get(params, 'agentEnvironment') as Readonly<Record<string, string>> | undefined;
      const contextFile = bridgeEnvironment?.HAPPIER_SESSION_MCP_CONTEXT_FILE;
      expect(contextFile).toEqual(expect.any(String));
      expect(bridgeEnvironment).not.toHaveProperty('HAPPIER_HOME_DIR');
      const bridgeContext = JSON.parse(readFileSync(contextFile!, 'utf8'));
      expect(bridgeContext.v).toBe(1);
      expect(typeof bridgeContext.socketPath).toBe('string');
      expect(bridgeContext).not.toHaveProperty('bearerToken');
      expect(params.mcpServersStrictMode).toBe(true);
      expect(Object.keys(params.mcpServers)).toEqual(kind === 'legacy-empty' ? [] : ['selected']);
      if (kind === 'legacy-empty') throw opened;
      expect(JSON.stringify(params.mcpServers).includes('materialized-value')).toBe(false);
      privateConfigPath = params.mcpServers.selected?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
      expect(privateConfigPath).toBeTruthy();
      const privateConfig = JSON.parse(readFileSync(privateConfigPath!, 'utf8'));
      expect(privateConfig.command).toBe(kind === 'legacy-selected' ? process.execPath : 'echo');
      expect(privateConfig.args).toEqual(kind === 'legacy-selected' ? ['-e', childCode] : ['selected']);
      expect(privateConfig.env?.USER_VALUE === 'materialized-value').toBe(true);
      if (process.platform !== 'win32') expect(statSync(privateConfigPath!).mode & 0o777).toBe(0o600);
      if (kind === 'legacy-selected') {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        const { createCustomMcpClientTransport } = await import('@/agent/tools/happierTools/customMcp/createCustomMcpClientTransport');
        const client = new Client({ name: 'legacy-owner-test', version: '1' }, { capabilities: {} });
        const transport = await createCustomMcpClientTransport(params.mcpServers.selected!, process.env);
        const codes = new Set<string>();
        if (transport instanceof StdioClientTransport) transport.stderr?.on('data', chunk => {
          for (const code of ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'plugin_exec_system_tool_denied',
            'SyntaxError', 'ENOENT', 'permission_denied', 'requester_unavailable', 'Unexpected token',
            'Invalid or unexpected token', 'Cannot use import statement', 'does not provide an export named']) {
            if (String(chunk).includes(code)) codes.add(code);
          }
          for (const match of String(chunk).matchAll(/([\w.-]+\.[cm]?[jt]s):\d+/g)) codes.add(match[1]!);
          for (const match of String(chunk).matchAll(/does not provide an export named '([A-Za-z_$][A-Za-z0-9_$]*)'/g)) codes.add(`missing_export:${match[1]}`);
        });
        try {
          try { await client.connect(transport); }
          catch { throw new Error(`Legacy MCP fixture diagnostic codes: ${[...codes].join(',')}`); }
          expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['fixture']);
        } finally { await client.close(); }
      }
      throw opened;
    },
  }, {
    initializeBackendApiContextFn: async () => ({ api, machineId: 'pi-machine' }),
    initializeBackendRunSessionFn: async () => ({ session, reconnectionHandle: null,
      reportedSessionId: session.sessionId, attachedToExistingSession: kind === 'resume' || kind.endsWith('-capsule') }),
  });
  const hostedEnvironment: NodeJS.ProcessEnv = { ...process.env, HOME: join(workingDirectory, 'private-session-home'),
    PRIVATE_ACCOUNT_SECRET: 'must-not-reach-mcp', PATH: sessionPath };
  if (sessionPath === undefined) delete hostedEnvironment.PATH;
  const outcome = hostedNativeCase ? runAddedHostedSession({ environment: hostedEnvironment,
    workingDirectory, end: () => undefined }, runSession) : runSession();
  if (kind === 'no-mcp-plugin-exec-refusal') {
    // The existing host turns a typed preparation refusal into a published
    // dependency failure before construction cleanup; it does not open a runtime.
    await expect(outcome).resolves.toBeUndefined();
    expect(nativeFactoryCalls).toBe(1);
    expect(request).toBeDefined();
    expect(request?.mcpServers).toEqual({});
    expect(mcpCatalogReads).toBe(0);
    expect(materialReads).toBe(0);
    const { SessionTurnMutationV1Schema } = await import('@happier-dev/protocol/sessions/turns/sessionTurnMutationV1');
    const failed = publishedMutations.map(mutation => SessionTurnMutationV1Schema.parse(mutation))
      .find(mutation => mutation.action === 'fail');
    expect(failed).toMatchObject({ action: 'fail', issue: { code: 'preparation_pending', source: 'dependency_failure' } });
    logger.flushSync();
    const lines = readFileSync(logger.getLogPath(), 'utf8').split('\n');
    const entry = lines.find(line => line.includes('[Pi test] Session construction failed'));
    expect(entry !== undefined).toBe(true);
    const diagnostic: unknown = JSON.parse(entry!.slice(entry!.indexOf('{')));
    expect(diagnostic).toMatchObject({ phase: 'agent_runtime_open',
      originalCode: 'project_requester_credentials_unavailable', reason: 'ingress_missing' });
    expect(entry!.includes('PRIVATE_PLUGIN')).toBe(false);
  } else if (nativeCase) {
    const failure = await outcome.then(() => undefined, error => error);
    if (failure !== opened) throw failure ?? new Error('Native MCP fixture did not reach its cleanup sentinel');
    expect(sessionClosed).toBe(true);
    expect(publishedMutations).toContainEqual(expect.objectContaining({ action: 'fail',
      issue: expect.objectContaining({ code: 'resource_unavailable', source: 'team_credential' }) }));
    expect(nativeFactoryCalls).toBe(1);
    expect(machineReads).toBe(1);
    expect(sessionReads).toBe(0);
  } else if (providerCase) {
    await expect(outcome).rejects.toBe(opened);
    expect(request).toBeDefined();
    expect(machineReads).toBe(noManagedMcp ? 0 : 1);
    expect(sessionReads).toBe(noManagedMcp ? 0 : 1);
  } else if (kind === 'legacy-empty') {
    await expect(outcome).rejects.toBe(opened);
    expect(request?.mcpServers).toEqual({});
    expect(privateConfigPath).toBeUndefined();
    expect(machineReads).toBe(1);
  } else if (kind === 'fresh' || kind === 'resume' || kind === 'legacy-selected' || kind === 'retained-owner-capsule') {
    await expect(outcome).rejects.toBe(opened);
    expect(request?.mcpServers.selected?.env).toMatchObject({ HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: privateConfigPath });
    expect(existsSync(privateConfigPath!)).toBe(false);
    // Manual resume also reads the existing Machine resource policy. Custody
    // qualification still performs one Machine read, not one per MCP/Run.
    expect(machineReads).toBe(1 + (kind.endsWith('-capsule') ? 1 : 0));
  } else {
    await expect(outcome).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(request).toBeUndefined();
    expect(privateConfigPath).toBeUndefined();
    expect(machineReads).toBe((kind.endsWith('-capsule') ? 1 : 0) + (['member', 'retired-account', 'modern-missing-access', 'legacy-partial', 'legacy-unknown',
      'shared-view-session', 'shared-edit-session', 'missing-session', 'member-logging-failure',
      'historical-capsule', 'foreign-home-capsule', 'malformed-capsule',
      'different-bearer-capsule', 'foreign-account-capsule'].includes(kind) ? 1 : 0));
    if (kind === 'member') {
      expect(mcpCatalogReads).toBe(0);
      expect(materialReads).toBe(0);
      logger.flushSync();
      const log = readFileSync(logger.getLogPath(), 'utf8');
      expect(log.includes('mcp_execution_admission')).toBe(true);
      expect(log.includes('agent_isolation_unavailable')).toBe(true);
      expect(log.includes('materialized-value')).toBe(false);
    }
  }
  } finally {
    boundaryPhase = 'outer_cleanup';
    restoreLogger?.();
    for (const cleanup of nativeCleanups.reverse()) await cleanup();
    await custody?.cleanup();
    boundaryPhase = 'home_shutdown';
    await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    boundaryPhase = 'filesystem_cleanup';
    await removeStoredCredentialsForServerId(profileId);
    await rm(workingDirectory, { recursive: true, force: true });
    boundaryPhase = 'runtime_fixture_disposal';
    await runtimeFixture.dispose();
    boundaryPhase = 'runtime_fixture_disposed';
  }
});
