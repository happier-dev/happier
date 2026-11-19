import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { computePluginUiArtifactFileSetSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';

import {
  resolveQaStackRuntimeJsonPath,
  resolveQaRunningExpoState,
  resolveQaUiRuntimeIdentity,
  resolveQaUiUrl,
} from '../../../../../scripts/qa/resolveQaUiUrl.mjs';
import { readCliAccessKeyForServerId, type CliAccessKey } from '../cliAccessKey';
import { daemonControlPostJson } from '../daemon/controlServerClient';
import { buildCredentialsAuthBootstrapStorageSnapshot } from '../uiE2e/buildAuthBootstrapStorageSnapshot';
import { fetchJson } from '../http';
import { resolveCliTestLaunchSpec } from '../process/cliLaunchSpec';
import type { AuthBootstrapStorageSnapshot } from '../uiE2e/readLegacyAuthSecretFromLocalStorage';
import {
  applyTrustedLocalPluginFixture,
  reloadTrustedLocalPluginFixture,
  uninstallTrustedLocalPluginFixture,
} from '../externalSessionLiveLifecycleFixture';
import {
  decideAuthenticatedPluginInstallReview,
  readPluginInstallReviewRequiredEnvelope,
} from './authenticatedInstallReview';

const INSPECTOR_PLUGIN_ID = 'happier.inspector';
const INSPECTOR_PACKAGE_NAME = '@happier-dev/plugins-inspector';
const INSPECTOR_ARTIFACT_ID = 'inspector-app-native';
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const CURRENT_SOURCE_SESSION_AGENT_EXAMPLE_ROOT = join(
  REPOSITORY_ROOT,
  'packages/plugin-sdk/examples/session-agent',
);
const MANAGED_DAEMON_RESTART_SETTLE_TIMEOUT_MS = 300_000;

/**
 * Exact external Session Agent identity of the canonical deterministic public
 * example. Every loaded client corridor asserts this same qualified identity;
 * there is no per-client variant of it.
 */
export const CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID = 'examples.session-agent';
export const CURRENT_SOURCE_SESSION_AGENT_LOCAL_ID = 'session-agent';
export const CURRENT_SOURCE_SESSION_AGENT_QUALIFIED_TARGET_ID = `agent:${CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID}/${CURRENT_SOURCE_SESSION_AGENT_LOCAL_ID}`;
export const CURRENT_SOURCE_SESSION_AGENT_DISPLAY_TITLE = 'Deterministic Session Agent';
export const CURRENT_SOURCE_SESSION_AGENT_ASSISTANT_TEXT = 'Deterministic check approved.';
export const CURRENT_SOURCE_SESSION_AGENT_REASONING_TEXT = 'Preparing the deterministic check.';
export const CURRENT_SOURCE_SESSION_AGENT_UPDATED_REASONING_TEXT = 'Preparing the updated deterministic check.';
export const CURRENT_SOURCE_SESSION_AGENT_PACKED_REASONING_TEXT = 'Preparing the packed deterministic check.';
export const CURRENT_SOURCE_SESSION_AGENT_CONFIRMATION_TITLE = 'Run deterministic check?';
const CURRENT_SOURCE_SESSION_AGENT_PACKED_VERSION = '0.2.0';
/**
 * The reasoning-delta channel is a closed union in the public runtime-event
 * contract, so replacing it with an unknown member is a deterministic
 * compile-time refusal that survives the version and reasoning-text rewrites
 * above. Anchoring on real example bytes keeps a drifted example loud.
 */
const CURRENT_SOURCE_SESSION_AGENT_FAILING_UPDATE_ANCHOR = "channel: 'reasoning',";
const CURRENT_SOURCE_SESSION_AGENT_FAILING_UPDATE_REPLACEMENT = "channel: 'deterministic-failing-update',";
const CURRENT_SOURCE_NATIVE_PUBLIC_FIXTURE_ROOT = join(
  REPOSITORY_ROOT,
  'packages/tests/fixtures/plugin-platform/current-source-native-public',
);
const execFileAsync = promisify(execFile);

type JsonRecord = Record<string, unknown>;

type DaemonPluginPostJson = (params: Readonly<{
  port: number;
  path: string;
  body: Readonly<Record<string, unknown>>;
  timeoutMs: number;
  controlToken?: string | null;
}>) => Promise<Readonly<{ status: number; data: unknown }>>;

export type CurrentManagedStackPluginUiContext = Readonly<{
  runtimeJsonPath: string;
  stackDir: string;
  stackName: string;
  cliHome: string;
  uiUrl: string;
  serverUrl: string;
  account: Readonly<{
    accountId: string;
    serverId: string;
    serverIdentityId: string | null;
    uiServerId: string;
  }>;
  daemon: Readonly<{
    pid: number;
    port: number;
    controlToken: string;
    statePath: string;
    runtimeId: string;
    machineId: string;
    runtimeEntrypoint: string;
    distClosureFingerprint: string | null;
  }>;
  runtime: Readonly<{
    updatedAt: string | null;
    runtimeSnapshotId: string | null;
    selectedSnapshotId: string;
    pendingManualRestart: false;
    publicationComponents: Readonly<Record<string, 'current'>>;
  }>;
  uiProducer: Readonly<{
    mode: 'snapshot' | 'expo' | 'borrowedExpo';
    stackName: string;
    runtimeJsonPath: string;
    projectDir: string | null;
    pid: number | null;
    processInstanceFingerprint: string | null;
  }>;
  authStorage: AuthBootstrapStorageSnapshot;
}>;

export type CurrentManagedStackPluginUiAttestation = Readonly<{
  stackName: string;
  runtimeJsonPath: string;
  runtimeUpdatedAt: string | null;
  runtimeSnapshotId: string | null;
  selectedSnapshotId: string;
  pendingManualRestart: false;
  uiProducer: CurrentManagedStackPluginUiContext['uiProducer'];
  daemonPid: number;
  daemonRuntimeId: string;
  daemonMachineId: string;
  daemonRuntimeEntrypoint: string;
  daemonDistClosureFingerprint: string | null;
  daemonPingVerified: true;
  accountId: string;
  serverId: string;
  serverIdentityId: string | null;
  pluginId: typeof INSPECTOR_PLUGIN_ID;
  desiredGeneration: string;
  appliedGeneration: string;
  contributionProjectionGeneration: string;
  artifact: Readonly<{
    platform: 'web' | 'ios' | 'android';
    digest: string;
    entry: string;
    byteSize: number;
  }>;
}>;

export type CurrentManagedStackSourcePluginGeneration = Readonly<{
  pluginId: string;
  desiredGeneration: string;
  appliedGeneration: string;
  contributionProjectionGeneration: string;
}>;

export type CurrentManagedStackDeclarativeLifecycleFixture = Readonly<{
  pluginId: string;
  pluginRoot: string;
  panelTabTestId: string;
  v1Text: string;
  v2Text: string;
  composer: Readonly<{
    actionTestId: string;
    actionLabel: string;
    controlTestId: string;
    choiceLabel: string;
    attachmentLabel: string;
    referenceLabel: string;
    regionText: string;
  }>;
  installed: CurrentManagedStackSourcePluginGeneration;
  applyV2: () => Promise<CurrentManagedStackSourcePluginGeneration>;
  disable: () => Promise<CurrentManagedStackSourcePluginGeneration>;
  enable: () => Promise<CurrentManagedStackSourcePluginGeneration>;
  uninstall: () => Promise<void>;
  reinstallV1: () => Promise<CurrentManagedStackSourcePluginGeneration>;
  cleanup: () => Promise<void>;
}>;

export type CurrentManagedStackNativePublicFixture = Readonly<{
  pluginId: string;
  pluginRoot: string;
  rnSurfaceUrlPath: string;
  hostedSurfaceUrlPath: string;
  declarativeSurfaceUrlPath: string;
  sentinels: Readonly<{
    rnV1: string;
    rnV2: string;
    hostedV1: string;
    hostedV2: string;
    hostedHistoryAction: string;
    hostedHistoryV1: string;
    hostedHistoryV2: string;
    declarativeV1: string;
    declarativeV2: string;
    actionTestId: string;
    actionLabel: string;
    targetedV1: string;
    targetedV2: string;
    composerControl: string;
    composerSecondaryControl: string;
    composerChoiceLabel: string;
    composerAttachmentV1: string;
    composerAttachmentV2: string;
    composerReferenceV1: string;
    composerReferenceV2: string;
    composerRegion: string;
    agentTitle: string;
    transcriptSentinel: string;
    resourceV1: string;
    resourceV2: string;
    actionRun: string;
    actionBusy: string;
    actionSettled: string;
    actionResultV1: string;
    actionResultV2: string;
  }>;
  installed: CurrentManagedStackSourcePluginGeneration;
  artifact(platform: 'web' | 'ios' | 'android'): Promise<Readonly<{ digest: string; entry: string; byteSize: number }>>;
  hostedArtifact(): Promise<Readonly<{ digest: string; entry: string; byteSize: number }>>;
  applyV2(): Promise<CurrentManagedStackSourcePluginGeneration>;
  disable(): Promise<CurrentManagedStackSourcePluginGeneration>;
  enable(): Promise<CurrentManagedStackSourcePluginGeneration>;
  uninstall(): Promise<void>;
  reinstallV1(): Promise<CurrentManagedStackSourcePluginGeneration>;
  cleanup(): Promise<void>;
}>;

export type CurrentManagedStackSessionAgentAgentActivationState =
  | 'notRequired'
  | 'dormant'
  | 'active'
  | 'unavailable';

export type CurrentManagedStackSessionAgentCatalogIdentity = Readonly<{
  pluginId: string;
  enabled: boolean;
  desiredGeneration: string | null;
  appliedGeneration: string | null;
  agentContribution: Readonly<{
    family: 'agents';
    localId: string;
    activationState: CurrentManagedStackSessionAgentAgentActivationState;
    activationGeneration: string | null;
    registrationRequirement: string | null;
    registrationState: string | null;
    registrationGeneration: string | null;
  }> | null;
}>;

/**
 * One canonical current-source Session Agent lifecycle fixture shared by the
 * browser RNW, Tauri desktop, and iOS/Android loaded corridors. The source is
 * the deterministic public SDK example; the daemon-owned change owner performs
 * every catalog mutation. `reattach` re-points the fixture at the context of a
 * restarted daemon without rebuilding or reinstalling anything.
 */
export type CurrentManagedStackSessionAgentFixture = Readonly<{
  pluginId: typeof CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID;
  agentLocalId: typeof CURRENT_SOURCE_SESSION_AGENT_LOCAL_ID;
  qualifiedAgentId: string;
  displayTitle: string;
  assistantText: string;
  reasoningText: string;
  updatedReasoningText: string;
  packedReasoningText: string;
  confirmationTitle: string;
  sourceRoot: string;
  /** Caller-owned example roots are never deleted; disposable copies are. */
  ownsSourceRoot: boolean;
  installed: CurrentManagedStackSourcePluginGeneration;
  selectors: Readonly<{
    wizardOption: string;
    agentChip: string;
    chipPickerOption: string;
    newSessionComposerInput: string;
    newSessionComposerSend: string;
    sessionComposerInput: string;
    sessionComposerSend: string;
    permissionAllow: string;
    abort: string;
    forgetTrustAction: string;
  }>;
  reattach(context: CurrentManagedStackPluginUiContext): void;
  generation(): Promise<CurrentManagedStackSourcePluginGeneration>;
  applySourceUpdate(): Promise<CurrentManagedStackSourcePluginGeneration>;
  /**
   * Leaves the disposable source broken after proving the canonical author
   * typecheck and build both refuse it. Returns the generation still applied by
   * the daemon, which the caller asserts is the untouched incumbent.
   */
  applyFailingSourceUpdate(): Promise<CurrentManagedStackSourcePluginGeneration>;
  /** Restores the last good source, rebuilds, and reloads onto a fresh generation. */
  recoverFailingSourceUpdate(): Promise<CurrentManagedStackSourcePluginGeneration>;
  installPackedDiscriminator(): Promise<CurrentManagedStackSourcePluginGeneration>;
  disable(): Promise<CurrentManagedStackSourcePluginGeneration>;
  enable(): Promise<CurrentManagedStackSourcePluginGeneration>;
  reinstall(): Promise<CurrentManagedStackSourcePluginGeneration>;
  uninstall(): Promise<void>;
  cleanup(): Promise<void>;
}>;

function currentManagedStackAccessToken(context: CurrentManagedStackPluginUiContext): string {
  const credentials = asRecord(JSON.parse(context.authStorage.localStorage.auth_credentials));
  return requireString(credentials?.token, 'plugin_ui_current_stack_account_access_token_missing');
}

export async function deleteCurrentManagedStackSession(
  context: CurrentManagedStackPluginUiContext,
  sessionId: string,
): Promise<void> {
  const response = await fetchJson<{ success?: unknown }>(
    `${context.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${currentManagedStackAccessToken(context)}` },
      timeoutMs: 30_000,
    },
  );
  if (response.status !== 200 || response.data?.success !== true) {
    throw new Error(`plugin_ui_current_stack_disposable_session_delete_failed:${sessionId}:${response.status}`);
  }
}

/**
 * Revision-fenced cleanup for a QA-owned New Session draft. Missing/already
 * deleted drafts are successful cleanup; a concurrent revision change fails
 * closed instead of deleting another writer's bytes.
 */
export async function deleteCurrentManagedStackNewSessionDraft(
  context: CurrentManagedStackPluginUiContext,
  draftId: string,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${currentManagedStackAccessToken(context)}`,
    'Content-Type': 'application/json',
  };
  const address = { kind: 'newSession', draftId } as const;
  const read = await fetchJson<{ status?: unknown; record?: { revision?: unknown } }>(
    `${context.serverUrl}/v1/account/session-drafts/read`,
    { method: 'POST', headers, body: JSON.stringify({ address }), timeoutMs: 30_000 },
  );
  if (read.status !== 200) {
    throw new Error(`plugin_ui_current_stack_new_session_draft_read_failed:${read.status}`);
  }
  if (read.data?.status === 'absent' || read.data?.status === 'deleted') return;
  const revision = read.data?.record?.revision;
  if (!Number.isInteger(revision) || Number(revision) < 0) {
    throw new Error('plugin_ui_current_stack_new_session_draft_revision_missing');
  }
  const deleted = await fetchJson<{ status?: unknown }>(
    `${context.serverUrl}/v1/account/session-drafts/mutate`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ address, expectedRevision: revision, content: null }),
      timeoutMs: 30_000,
    },
  );
  if (deleted.status !== 200 || deleted.data?.status !== 'updated') {
    throw new Error(`plugin_ui_current_stack_new_session_draft_delete_failed:${deleted.status}`);
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function requireString(value: unknown, code: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(code);
  return normalized;
}

function optionalString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function requirePositiveInteger(value: unknown, code: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) throw new Error(code);
  return normalized;
}

async function readJsonRecord(path: string, code: string): Promise<JsonRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${code}:${error instanceof Error ? error.message : String(error)}`);
  }
  const record = asRecord(parsed);
  if (!record) throw new Error(code);
  return record;
}

async function listDaemonStatePaths(cliHome: string): Promise<readonly string[]> {
  const serversDir = join(cliHome, 'servers');
  let entries;
  try {
    entries = await readdir(serversDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(serversDir, entry.name, 'daemon.state.json'));
}

async function resolveCurrentDaemonState(params: Readonly<{
  cliHome: string;
  expectedPid: number;
}>): Promise<Readonly<{ path: string; value: JsonRecord }>> {
  const candidates: Array<Readonly<{ path: string; value: JsonRecord }>> = [];
  for (const path of await listDaemonStatePaths(params.cliHome)) {
    try {
      candidates.push({ path, value: await readJsonRecord(path, 'plugin_ui_current_stack_daemon_state_invalid') });
    } catch {
      // Ignore unrelated or partially written server profiles. The selected
      // Stack daemon PID below remains the authority.
    }
  }
  const selected = candidates.find(({ value }) => Number(value.pid) === params.expectedPid);
  if (!selected) {
    throw new Error(`plugin_ui_current_stack_daemon_state_missing_for_pid:${params.expectedPid}`);
  }
  return selected;
}

function credentialsFromAccessKey(accessKey: CliAccessKey): CliAccessKey {
  return 'secret' in accessKey
    ? { token: accessKey.token, secret: accessKey.secret }
    : { token: accessKey.token, encryption: { ...accessKey.encryption } };
}

function accountIdFromAccessToken(token: string): string {
  try {
    const payload = token.split('.')[1];
    if (!payload) throw new Error('missing_payload');
    const parsed = asRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return requireString(parsed?.sub, 'plugin_ui_current_stack_access_token_account_missing');
  } catch (error) {
    if (error instanceof Error && error.message === 'plugin_ui_current_stack_access_token_account_missing') throw error;
    throw new Error('plugin_ui_current_stack_access_token_invalid');
  }
}

async function readSelectedServerProfile(params: Readonly<{
  cliHome: string;
  serverId: string;
}>): Promise<Readonly<{ serverUrl: string; serverIdentityId: string | null }>> {
  const settings = await readJsonRecord(join(params.cliHome, 'settings.json'), 'plugin_ui_current_stack_settings_invalid');
  const profile = asRecord(asRecord(settings.servers)?.[params.serverId]);
  if (!profile) throw new Error(`plugin_ui_current_stack_server_profile_missing:${params.serverId}`);
  return Object.freeze({
    serverUrl: requireString(profile.serverUrl, 'plugin_ui_current_stack_server_profile_url_missing'),
    serverIdentityId: optionalString(profile.serverIdentityId),
  });
}

function comparableServerOrigin(value: string): string {
  const parsed = new URL(value);
  const hostname = parsed.hostname === '127.0.0.1'
    || parsed.hostname === '::1'
    || parsed.hostname === 'happier-server.localhost'
    || parsed.hostname.endsWith('.localhost')
    ? 'localhost'
    : parsed.hostname;
  return `${parsed.protocol}//${hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
}

export async function resolveCurrentManagedStackPluginUiContext(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  requiredPublicationComponents?: readonly string[];
  resolveRunningExpoState?: typeof resolveQaRunningExpoState;
}> = {}): Promise<CurrentManagedStackPluginUiContext> {
  const env = params.env ?? process.env;
  const runtimeJsonPath = resolveQaStackRuntimeJsonPath(env);
  if (!runtimeJsonPath) throw new Error('plugin_ui_current_stack_runtime_path_missing');
  const runtime = await readJsonRecord(runtimeJsonPath, 'plugin_ui_current_stack_runtime_invalid');
  const uiRuntimeIdentity = resolveQaUiRuntimeIdentity(env);
  const stackDir = dirname(runtimeJsonPath);
  const stackName = requireString(runtime.stackName ?? env.HAPPIER_QA_STACK_NAME, 'plugin_ui_current_stack_name_missing');
  const cliHome = join(stackDir, 'cli');
  const processes = asRecord(runtime.processes);
  const expectedDaemonPid = requirePositiveInteger(processes?.daemonPid, 'plugin_ui_current_stack_daemon_pid_missing');
  const daemonState = await resolveCurrentDaemonState({ cliHome, expectedPid: expectedDaemonPid });
  const serverId = basename(dirname(daemonState.path));
  const runtimeEntrypoint = requireString(
    daemonState.value.startedWithRuntimeEntrypoint,
    'plugin_ui_current_stack_daemon_runtime_entrypoint_missing',
  );
  try {
    const entrypointStat = await stat(runtimeEntrypoint);
    if (!entrypointStat.isFile()) throw new Error('not_file');
  } catch {
    throw new Error(`plugin_ui_current_stack_daemon_runtime_entrypoint_unavailable:${runtimeEntrypoint}`);
  }

  const accessKey = await readCliAccessKeyForServerId(cliHome, serverId);
  if (!accessKey) throw new Error('plugin_ui_current_stack_access_key_missing');
  const uiUrl = resolveQaUiUrl(env);
  const parsedUiUrl = new URL(uiUrl);
  const serverUrl = parsedUiUrl.searchParams.get('server')?.trim() || parsedUiUrl.origin;
  const serverProfile = await readSelectedServerProfile({ cliHome, serverId });
  if (comparableServerOrigin(serverProfile.serverUrl) !== comparableServerOrigin(serverUrl)) {
    throw new Error(`plugin_ui_current_stack_server_profile_url_mismatch:${serverProfile.serverUrl}:${serverUrl}`);
  }
  const accountId = accountIdFromAccessToken(accessKey.token);
  const runtimeSnapshot = asRecord(runtime.runtimeSnapshot);
  const runtimeSnapshotId = optionalString(runtime.runtimeSnapshotId)
    ?? optionalString(runtimeSnapshot?.id);
  if (!runtimeSnapshotId) {
    throw new Error('plugin_ui_current_stack_runtime_snapshot_identity_missing');
  }
  const runtimePublication = asRecord(runtime.runtimePublication);
  if (!runtimePublication) {
    throw new Error('plugin_ui_current_stack_runtime_publication_missing');
  }
  if (uiRuntimeIdentity.mode === 'snapshot' && runtimePublication?.phase !== 'current') {
    throw new Error(`plugin_ui_current_stack_runtime_publication_not_current:${String(runtimePublication?.phase ?? 'missing')}`);
  }
  const publicationSnapshotId = requireString(
    runtimePublication.currentSnapshotId,
    'plugin_ui_current_stack_runtime_publication_snapshot_missing',
  );
  if (publicationSnapshotId !== runtimeSnapshotId) {
    throw new Error(`plugin_ui_current_stack_runtime_publication_snapshot_mismatch:${runtimeSnapshotId}:${publicationSnapshotId}`);
  }
  const selectedRuntimePointer = await readJsonRecord(
    join(stackDir, 'runtime', 'current.json'),
    'plugin_ui_current_stack_selected_runtime_pointer_invalid',
  );
  const selectedSnapshotId = requireString(
    selectedRuntimePointer.snapshotId,
    'plugin_ui_current_stack_selected_runtime_snapshot_missing',
  );
  if (selectedSnapshotId !== runtimeSnapshotId) {
    throw new Error(`plugin_ui_current_stack_pending_manual_restart:${selectedSnapshotId}:${runtimeSnapshotId}`);
  }
  const publicationComponents = asRecord(runtimePublication.components);
  const requiredPublicationComponents = params.requiredPublicationComponents
    ?? (uiRuntimeIdentity.mode === 'snapshot' ? ['server', 'daemon', 'web'] : ['server', 'daemon']);
  const currentPublicationComponents: Record<string, 'current'> = {};
  for (const component of requiredPublicationComponents) {
    const componentState = asRecord(publicationComponents?.[component]);
    if (componentState?.phase !== 'current') {
      throw new Error(`plugin_ui_current_stack_runtime_component_not_current:${component}:${String(componentState?.phase ?? 'missing')}`);
    }
    currentPublicationComponents[component] = 'current';
  }
  const distClosureFingerprint = optionalString(daemonState.value.distClosureFingerprint)
    ?? optionalString(asRecord(runtime.daemon)?.distClosureFingerprint);
  if (!distClosureFingerprint) {
    throw new Error('plugin_ui_current_stack_daemon_dist_closure_fingerprint_missing');
  }

  const authStorage = buildCredentialsAuthBootstrapStorageSnapshot({
    serverUrl,
    credentials: credentialsFromAccessKey(accessKey),
    storageScope: `managed-stack-plugin-ui-${stackName}`,
    serverIdentityId: serverProfile.serverIdentityId,
  });
  let uiProducer: CurrentManagedStackPluginUiContext['uiProducer'];
  if (uiRuntimeIdentity.mode === 'snapshot') {
    uiProducer = Object.freeze({
      mode: 'snapshot',
      stackName: stackName,
      runtimeJsonPath: runtimeJsonPath,
      projectDir: null,
      pid: null,
      processInstanceFingerprint: null,
    });
  } else {
    const producerRuntime = await readJsonRecord(
      uiRuntimeIdentity.producerRuntimePath,
      'plugin_ui_current_stack_expo_producer_runtime_invalid',
    );
    const runningExpo = await (params.resolveRunningExpoState ?? resolveQaRunningExpoState)(uiRuntimeIdentity.producerRuntimePath);
    const producerExpo = asRecord(producerRuntime.expo);
    if (!runningExpo) throw new Error('plugin_ui_current_stack_expo_producer_not_running');
    const producerWebPort = requirePositiveInteger(producerExpo?.webPort, 'plugin_ui_current_stack_expo_producer_port_missing');
    if (Number(runningExpo.state?.port) !== producerWebPort) {
      throw new Error('plugin_ui_current_stack_expo_producer_port_mismatch');
    }
    const projectDir = requireString(runningExpo.state?.projectDir ?? runningExpo.state?.uiDir, 'plugin_ui_current_stack_expo_project_missing');
    if (resolve(projectDir) !== resolve(REPOSITORY_ROOT, 'apps/ui')) {
      throw new Error(`plugin_ui_current_stack_expo_project_mismatch:${projectDir}`);
    }
    uiProducer = Object.freeze({
      mode: uiRuntimeIdentity.mode,
      stackName: uiRuntimeIdentity.producerStackName,
      runtimeJsonPath: uiRuntimeIdentity.producerRuntimePath,
      projectDir,
      pid: requirePositiveInteger(runningExpo.state?.pid, 'plugin_ui_current_stack_expo_pid_missing'),
      processInstanceFingerprint: optionalString(runningExpo.state?.processInstanceFingerprint),
    });
  }
  return {
    runtimeJsonPath,
    stackDir,
    stackName,
    cliHome,
    uiUrl,
    serverUrl,
    account: {
      accountId,
      serverId,
      serverIdentityId: serverProfile.serverIdentityId,
      uiServerId: requireString(authStorage.sessionStorage.activeServerId, 'plugin_ui_current_stack_ui_server_id_missing'),
    },
    daemon: {
      pid: expectedDaemonPid,
      port: requirePositiveInteger(daemonState.value.httpPort, 'plugin_ui_current_stack_daemon_port_missing'),
      controlToken: requireString(daemonState.value.controlToken, 'plugin_ui_current_stack_daemon_token_missing'),
      statePath: daemonState.path,
      runtimeId: requireString(daemonState.value.runtimeId, 'plugin_ui_current_stack_daemon_runtime_id_missing'),
      machineId: requireString(daemonState.value.machineId, 'plugin_ui_current_stack_daemon_machine_id_missing'),
      runtimeEntrypoint,
      distClosureFingerprint,
    },
    runtime: {
      updatedAt: optionalString(runtime.updatedAt),
      runtimeSnapshotId,
      selectedSnapshotId,
      pendingManualRestart: false,
      publicationComponents: Object.freeze(currentPublicationComponents),
    },
    uiProducer,
    authStorage,
  };
}

function readCatalogProjectionGeneration(entry: JsonRecord): string {
  const projection = asRecord(entry.contributions) ?? asRecord(entry.contributionIntrospection);
  const value = projection?.generation;
  if ((typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && value.trim())) {
    return String(value);
  }
  throw new Error('plugin_ui_current_stack_inspector_projection_generation_missing');
}

async function attestInspectorArtifact(
  runtimeEntrypoint: string,
  platform: 'web' | 'ios' | 'android',
): Promise<Readonly<{
  digest: string;
  entry: string;
  byteSize: number;
}>> {
  const pluginRoot = join(dirname(runtimeEntrypoint), 'node_modules', INSPECTOR_PACKAGE_NAME);
  const pluginManifest = await readJsonRecord(
    join(pluginRoot, '.happier-plugin', 'plugin.json'),
    'plugin_ui_current_stack_inspector_manifest_invalid',
  );
  if (pluginManifest.id !== INSPECTOR_PLUGIN_ID) {
    throw new Error(`plugin_ui_current_stack_inspector_manifest_identity_mismatch:${String(pluginManifest.id)}`);
  }
  const artifactsRoot = join(pluginRoot, 'dist', 'happier-plugin-ui');
  const artifacts = await readJsonRecord(
    join(artifactsRoot, 'ui-artifacts.json'),
    'plugin_ui_current_stack_inspector_artifacts_invalid',
  );
  const entries = Array.isArray(artifacts.entries) ? artifacts.entries : [];
  const web = entries.map(asRecord).find((entry) => entry?.contributionId === INSPECTOR_ARTIFACT_ID
    && entry.tier === 'reactNative'
    && entry.platform === platform);
  if (!web) throw new Error('plugin_ui_current_stack_inspector_web_artifact_missing');
  const files = Array.isArray(web.files) ? web.files.map(asRecord) : [];
  const verifiedFiles: Array<Readonly<{ relativePath: string; bytes: Uint8Array }>> = [];
  let totalBytes = 0;
  for (const file of files) {
    if (!file) throw new Error('plugin_ui_current_stack_inspector_artifact_file_invalid');
    const relativePath = requireString(file.relativePath, 'plugin_ui_current_stack_inspector_artifact_path_missing');
    const absolutePath = resolve(artifactsRoot, relativePath);
    if (!absolutePath.startsWith(`${resolve(artifactsRoot)}/`)) {
      throw new Error('plugin_ui_current_stack_inspector_artifact_path_escape');
    }
    const bytes = await readFile(absolutePath);
    const expectedByteSize = requirePositiveInteger(file.byteSize, 'plugin_ui_current_stack_inspector_artifact_size_missing');
    if (bytes.byteLength !== expectedByteSize) throw new Error('plugin_ui_current_stack_inspector_artifact_size_mismatch');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== requireString(file.digest, 'plugin_ui_current_stack_inspector_artifact_digest_missing')) {
      throw new Error('plugin_ui_current_stack_inspector_artifact_file_digest_mismatch');
    }
    totalBytes += bytes.byteLength;
    verifiedFiles.push({ relativePath, bytes });
  }
  const aggregateDigest = computePluginUiArtifactFileSetSha256DigestV1(verifiedFiles);
  if (aggregateDigest !== requireString(web.digest, 'plugin_ui_current_stack_inspector_artifact_aggregate_digest_missing')) {
    throw new Error('plugin_ui_current_stack_inspector_artifact_aggregate_digest_mismatch');
  }
  return {
    digest: aggregateDigest,
    entry: requireString(web.entry, 'plugin_ui_current_stack_inspector_artifact_entry_missing'),
    byteSize: totalBytes,
  };
}

export async function attestCurrentManagedStackPluginUi(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  postJson?: DaemonPluginPostJson;
  artifactPlatform?: 'web' | 'ios' | 'android';
}>): Promise<CurrentManagedStackPluginUiAttestation> {
  const currentContext = await resolveCurrentManagedStackPluginUiContext({
    env: {
      ...process.env,
      HAPPIER_QA_STACK_RUNTIME_JSON_PATH: params.context.runtimeJsonPath,
      ...(params.context.uiProducer.mode === 'snapshot' ? { HAPPIER_QA_UI_MODE: 'snapshot' } : {}),
      ...(params.context.uiProducer.mode === 'borrowedExpo'
        ? { HAPPIER_QA_EXPO_SOURCE_STACK: params.context.uiProducer.stackName }
        : {}),
    },
    requiredPublicationComponents: Object.keys(params.context.runtime.publicationComponents),
  });
  if (
    currentContext.runtime.runtimeSnapshotId !== params.context.runtime.runtimeSnapshotId
    || currentContext.daemon.runtimeId !== params.context.daemon.runtimeId
    || currentContext.daemon.pid !== params.context.daemon.pid
    || currentContext.daemon.machineId !== params.context.daemon.machineId
    || currentContext.daemon.runtimeEntrypoint !== params.context.daemon.runtimeEntrypoint
    || currentContext.daemon.distClosureFingerprint !== params.context.daemon.distClosureFingerprint
    || currentContext.account.accountId !== params.context.account.accountId
    || currentContext.account.serverId !== params.context.account.serverId
    || JSON.stringify(currentContext.uiProducer) !== JSON.stringify(params.context.uiProducer)
  ) {
    throw new Error('plugin_ui_current_stack_runtime_changed_during_journey');
  }
  const postJson = params.postJson ?? daemonControlPostJson;
  const ping = await postJson({
    port: currentContext.daemon.port,
    path: '/ping',
    controlToken: currentContext.daemon.controlToken,
    body: {},
    timeoutMs: 30_000,
  });
  const pingBody = asRecord(ping.data);
  if (
    ping.status !== 200
    || pingBody?.status !== 'ok'
    || pingBody.runtimeId !== currentContext.daemon.runtimeId
    || pingBody.distClosureFingerprint !== currentContext.daemon.distClosureFingerprint
  ) {
    throw new Error('plugin_ui_current_stack_daemon_ping_identity_mismatch');
  }
  const response = await postJson({
    port: currentContext.daemon.port,
    path: '/plugins/catalog/read',
    controlToken: currentContext.daemon.controlToken,
    body: {},
    timeoutMs: 30_000,
  });
  const body = asRecord(response.data);
  if (response.status !== 200 || body?.kind !== 'available' || !Array.isArray(body.plugins)) {
    throw new Error(`plugin_ui_current_stack_catalog_unavailable:${response.status}`);
  }
  const inspector = body.plugins.map(asRecord).find((entry) => entry?.pluginId === INSPECTOR_PLUGIN_ID);
  if (!inspector) throw new Error('plugin_ui_current_stack_inspector_catalog_entry_missing');
  const desiredGeneration = requireString(
    inspector.desiredGeneration,
    'plugin_ui_current_stack_inspector_desired_generation_missing',
  );
  const appliedGeneration = requireString(
    inspector.appliedGeneration,
    'plugin_ui_current_stack_inspector_applied_generation_missing',
  );
  if (desiredGeneration !== appliedGeneration) {
    throw new Error(`plugin_ui_current_stack_inspector_generation_not_current:${desiredGeneration}:${appliedGeneration}`);
  }
  const artifactPlatform = params.artifactPlatform ?? 'web';
  const artifact = await attestInspectorArtifact(
    currentContext.daemon.runtimeEntrypoint,
    artifactPlatform,
  );
  return {
    stackName: currentContext.stackName,
    runtimeJsonPath: currentContext.runtimeJsonPath,
    runtimeUpdatedAt: currentContext.runtime.updatedAt,
    runtimeSnapshotId: currentContext.runtime.runtimeSnapshotId,
    selectedSnapshotId: currentContext.runtime.selectedSnapshotId,
    pendingManualRestart: currentContext.runtime.pendingManualRestart,
    uiProducer: currentContext.uiProducer,
    daemonPid: currentContext.daemon.pid,
    daemonRuntimeId: currentContext.daemon.runtimeId,
    daemonMachineId: currentContext.daemon.machineId,
    daemonRuntimeEntrypoint: currentContext.daemon.runtimeEntrypoint,
    daemonDistClosureFingerprint: currentContext.daemon.distClosureFingerprint,
    daemonPingVerified: true,
    accountId: currentContext.account.accountId,
    serverId: currentContext.account.serverId,
    serverIdentityId: currentContext.account.serverIdentityId,
    pluginId: INSPECTOR_PLUGIN_ID,
    desiredGeneration,
    appliedGeneration,
    contributionProjectionGeneration: readCatalogProjectionGeneration(inspector),
    artifact: Object.freeze({
      platform: artifactPlatform,
      digest: artifact.digest,
      entry: artifact.entry,
      byteSize: artifact.byteSize,
    }),
  };
}

export async function attestCurrentManagedStackSourcePluginGeneration(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  pluginId: string;
  postJson?: DaemonPluginPostJson;
}>): Promise<CurrentManagedStackSourcePluginGeneration> {
  const response = await (params.postJson ?? daemonControlPostJson)({
    port: params.context.daemon.port,
    path: '/plugins/catalog/read',
    controlToken: params.context.daemon.controlToken,
    body: {},
    timeoutMs: 30_000,
  });
  const body = asRecord(response.data);
  const entry = response.status === 200 && body?.kind === 'available' && Array.isArray(body.plugins)
    ? body.plugins.map(asRecord).find((candidate) => candidate?.pluginId === params.pluginId)
    : null;
  if (!entry) throw new Error(`plugin_ui_current_stack_source_catalog_entry_missing:${params.pluginId}`);
  const desiredGeneration = requireString(
    entry.desiredGeneration,
    'plugin_ui_current_stack_source_desired_generation_missing',
  );
  const appliedGeneration = requireString(
    entry.appliedGeneration,
    'plugin_ui_current_stack_source_applied_generation_missing',
  );
  if (desiredGeneration !== appliedGeneration) {
    throw new Error(
      `plugin_ui_current_stack_source_generation_not_current:${params.pluginId}:${desiredGeneration}:${appliedGeneration}`,
    );
  }
  return Object.freeze({
    pluginId: params.pluginId,
    desiredGeneration,
    appliedGeneration,
    contributionProjectionGeneration: readCatalogProjectionGeneration(entry),
  });
}

async function assertCurrentManagedStackSourcePluginAbsent(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  pluginId: string;
  postJson?: DaemonPluginPostJson;
}>): Promise<void> {
  const response = await (params.postJson ?? daemonControlPostJson)({
    port: params.context.daemon.port,
    path: '/plugins/catalog/read',
    controlToken: params.context.daemon.controlToken,
    body: {},
    timeoutMs: 30_000,
  });
  const body = asRecord(response.data);
  if (response.status !== 200 || body?.kind !== 'available' || !Array.isArray(body.plugins)) {
    throw new Error(`plugin_ui_current_stack_source_catalog_unavailable:${response.status}`);
  }
  if (body.plugins.map(asRecord).some((entry) => entry?.pluginId === params.pluginId)) {
    throw new Error(`plugin_ui_current_stack_source_catalog_entry_not_retired:${params.pluginId}`);
  }
  const pending = await (params.postJson ?? daemonControlPostJson)({
    port: params.context.daemon.port,
    path: '/plugins/change/list',
    controlToken: params.context.daemon.controlToken,
    body: {},
    timeoutMs: 30_000,
  });
  const pendingBody = asRecord(pending.data);
  if (pending.status !== 200 || !Array.isArray(pendingBody?.changes)) {
    throw new Error(`plugin_ui_current_stack_source_pending_changes_unavailable:${pending.status}`);
  }
  if (pendingBody.changes.map(asRecord).some((entry) => entry?.pluginId === params.pluginId)) {
    throw new Error(`plugin_ui_current_stack_source_pending_change_not_retired:${params.pluginId}`);
  }
}

async function writeCurrentManagedStackDeclarativeFixture(params: Readonly<{
  root: string;
  pluginId: string;
  text: string;
}>): Promise<void> {
  await mkdir(join(params.root, '.happier-plugin'), { recursive: true });
  await writeFile(
    join(params.root, '.happier-plugin', 'daemon.mjs'),
    `export async function activate(api) {
  api.actions.register('qa-self-check', async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { ok: true };
  });
  api.composerReferences.register('qa-references', {
    async search(query) {
      return query.toLowerCase().includes('qa')
        ? [{ id: 'qa-42', label: 'QA reference 42', description: 'Current Stack external reference' }]
        : [];
    },
    async resolve(candidateId) {
      return {
        id: candidateId,
        label: 'QA reference 42',
        description: 'Current Stack external reference',
        context: 'Current Stack external reference context',
      };
    },
  });
  api.composerAttachments.register('qa-item', {
    async prepareForSend({ attachments }) {
      return { attachments: attachments.map(({ instanceId, value, content }) => ({
        instanceId,
        status: 'ready',
        value,
        ...(content === undefined ? {} : { content }),
      })) };
    },
    async resolveForDispatch({ attachments }) {
      return { attachments: attachments.map(({ instanceId, value }) => ({
        instanceId,
        status: 'ready',
        context: 'Current Stack external attachment context',
        data: value,
      })) };
    },
    async afterMessageAccepted() {},
  });
}
`,
    'utf8',
  );
  await writeFile(join(params.root, '.happier-plugin', 'plugin.json'), `${JSON.stringify({
    schemaVersion: 2,
    id: params.pluginId,
    version: '0.0.0',
    displayName: 'Current Stack mobile lifecycle fixture',
    description: 'Reversible moving-source lifecycle fixture for current managed Stack native QA.',
    engines: { happier: '^0.0.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './.happier-plugin/daemon.mjs' },
    hostAccess: { required: [], optional: [] },
    secrets: [],
    contributes: {
      ui: {
        views: [{
          id: 'current-stack-panel',
          container: 'rightSidebarTab',
          target: { kind: 'app' },
          renderer: 'current-stack-declarative',
          title: 'Current Stack mobile QA',
        }],
        renderers: [{
          id: 'current-stack-declarative',
          kind: 'declarative',
          root: {
            kind: 'group',
            title: 'Current Stack mobile lifecycle',
            children: [{ kind: 'text', text: params.text }, {
              kind: 'actionPanel',
              title: 'Current Stack external actions',
              children: [{
                kind: 'action',
                action: 'qa-self-check',
                label: 'Run Current Stack external self-check',
                variant: 'primary',
              }],
            }],
          },
        }, {
          id: 'current-stack-composer-region',
          kind: 'declarative',
          root: {
            kind: 'status',
            label: 'Current Stack external Composer',
            value: 'Current Stack external Composer region mounted',
            tone: 'default',
          },
        }],
      },
      actions: [{
        id: 'qa-self-check',
        title: 'Run Current Stack external self-check',
        description: 'Exercises a daemon Action from the public external fixture.',
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: ['toolbar'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        inputSchema: { type: 'object', additionalProperties: false },
        resultSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      }],
      composerReferences: [{
        id: 'qa-references',
        title: 'Current Stack QA references',
        description: 'Disposable references from the current-source external fixture.',
        icon: 'external',
        triggers: ['@'],
      }],
      composerAttachments: [{
        id: 'qa-item',
        title: 'Current Stack QA item',
        description: 'Disposable attachment from the current-source external fixture.',
        icon: 'action',
        cardinality: 'many',
        valueSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { qaId: { type: 'string' } },
          required: ['qaId'],
          additionalProperties: false,
        },
        display: { kind: 'badge' },
        runtime: {
          prepareForSend: true,
          resolveForDispatch: true,
          afterMessageAccepted: true,
        },
      }],
      composerControls: [{
        id: 'qa-control',
        label: 'Current Stack QA',
        icon: 'action',
        scopes: ['session', 'newSession', 'pendingMessage'],
        interaction: {
          kind: 'choices',
          selection: 'single',
          options: [{
            id: 'attach-qa-42',
            label: 'Attach Current Stack QA item',
            description: 'Adds one disposable public-plugin attachment.',
            effect: {
              kind: 'composerApply',
              operations: [{
                kind: 'attachment.add',
                attachmentLocalId: 'qa-item',
                value: {
                  key: 'qa-42',
                  value: { qaId: 'qa-42' },
                  presentation: {
                    label: 'Current Stack QA item 42',
                    description: 'Disposable public-plugin attachment.',
                    icon: 'action',
                    tone: 'info',
                  },
                },
              }],
            },
          }],
        },
      }],
      composerRegions: [{
        id: 'qa-region',
        placement: 'beforeComposer',
        renderer: { renderer: 'current-stack-composer-region' },
        scopes: ['session', 'newSession', 'pendingMessage'],
      }],
    },
  }, null, 2)}\n`, 'utf8');
}

async function requestCurrentManagedStackPluginState(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  pluginId: string;
  kind: 'enable' | 'disable';
  postJson?: DaemonPluginPostJson;
}>): Promise<void> {
  const response = await (params.postJson ?? daemonControlPostJson)({
    port: params.context.daemon.port,
    path: '/plugins/change/request',
    controlToken: params.context.daemon.controlToken,
    body: { kind: params.kind, pluginId: params.pluginId },
    timeoutMs: 300_000,
  });
  const body = asRecord(response.data);
  if (response.status !== 200 || body?.kind !== 'committed' || body.pluginId !== params.pluginId) {
    throw new Error(`plugin_ui_current_stack_source_${params.kind}_failed:${response.status}:${String(body?.kind ?? 'unknown')}`);
  }
}

/**
 * Owns one reversible current-source row. Every row starts from v1 and cleanup
 * retires the fixture even after a failed device flow, so iOS, Android, and
 * repeated local runs never inherit each other's catalog state.
 */
export async function prepareCurrentManagedStackDeclarativeLifecycleFixture(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  rowId: string;
  postJson?: DaemonPluginPostJson;
}>): Promise<CurrentManagedStackDeclarativeLifecycleFixture> {
  const safeRowId = params.rowId.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'row';
  const pluginId = `qa.current-stack.mobile.${safeRowId}.${randomUUID()}`;
  const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-current-stack-mobile-'));
  const v1Text = `current-managed-stack-${safeRowId}-v1`;
  const v2Text = `current-managed-stack-${safeRowId}-v2`;
  let installed = false;
  let selectedText = v1Text;
  const generation = async (): Promise<CurrentManagedStackSourcePluginGeneration> => (
    await attestCurrentManagedStackSourcePluginGeneration({
      context: params.context,
      pluginId,
      postJson: params.postJson,
    })
  );
  const install = async (): Promise<CurrentManagedStackSourcePluginGeneration> => {
    await applyTrustedLocalPluginFixture({
      daemonPort: params.context.daemon.port,
      controlToken: params.context.daemon.controlToken,
      pluginRoot,
      pluginId,
      interactionId: `mobile-current-stack-${safeRowId}-${Date.now()}`,
      postJson: params.postJson,
    });
    installed = true;
    return await generation();
  };

  try {
    await writeCurrentManagedStackDeclarativeFixture({ root: pluginRoot, pluginId, text: v1Text });
    const initial = await install();
    return Object.freeze({
      pluginId,
      pluginRoot,
      panelTabTestId: `app-scope-right-sidebar-tab:plugin:${pluginId}:current-stack-panel`,
      v1Text,
      v2Text,
      composer: Object.freeze({
        actionTestId: `plugin-declarative-action:${pluginId}/qa-self-check`,
        actionLabel: 'Run Current Stack external self-check',
        controlTestId: `plugin-composer-control:${pluginId}/qa-control`,
        choiceLabel: 'Attach Current Stack QA item',
        attachmentLabel: 'Current Stack QA item 42',
        referenceLabel: 'QA reference 42',
        regionText: 'Current Stack external Composer region mounted',
      }),
      installed: initial,
      applyV2: async () => {
        await writeCurrentManagedStackDeclarativeFixture({ root: pluginRoot, pluginId, text: v2Text });
        await reloadTrustedLocalPluginFixture({
          daemonPort: params.context.daemon.port,
          controlToken: params.context.daemon.controlToken,
          pluginRoot,
          pluginId,
          changedPaths: ['.happier-plugin/plugin.json'],
          postJson: params.postJson,
        });
        selectedText = v2Text;
        return await generation();
      },
      disable: async () => {
        await requestCurrentManagedStackPluginState({ ...params, pluginId, kind: 'disable' });
        return await generation();
      },
      enable: async () => {
        await requestCurrentManagedStackPluginState({ ...params, pluginId, kind: 'enable' });
        return await generation();
      },
      uninstall: async () => {
        if (installed) {
          await uninstallTrustedLocalPluginFixture({
            daemonPort: params.context.daemon.port,
            controlToken: params.context.daemon.controlToken,
            pluginId,
            postJson: params.postJson,
          });
        }
        installed = false;
        await assertCurrentManagedStackSourcePluginAbsent({ context: params.context, pluginId, postJson: params.postJson });
      },
      reinstallV1: async () => {
        if (installed) {
          await uninstallTrustedLocalPluginFixture({
            daemonPort: params.context.daemon.port,
            controlToken: params.context.daemon.controlToken,
            pluginId,
            postJson: params.postJson,
          });
          installed = false;
        }
        selectedText = v1Text;
        await writeCurrentManagedStackDeclarativeFixture({ root: pluginRoot, pluginId, text: selectedText });
        return await install();
      },
      cleanup: async () => {
        try {
          await uninstallTrustedLocalPluginFixture({
            daemonPort: params.context.daemon.port,
            controlToken: params.context.daemon.controlToken,
            pluginId,
            postJson: params.postJson,
          });
        } catch (error) {
          // Only the canonical absence read below may prove that response loss
          // or an already-retired fixture needs no second mutation.
          await assertCurrentManagedStackSourcePluginAbsent({ context: params.context, pluginId, postJson: params.postJson })
            .catch(() => { throw error; });
        }
        installed = false;
        await assertCurrentManagedStackSourcePluginAbsent({
          context: params.context,
          pluginId,
          postJson: params.postJson,
        });
        await rm(pluginRoot, { recursive: true, force: true });
      },
    });
  } catch (error) {
    let retirementError: unknown = null;
    try {
      await uninstallTrustedLocalPluginFixture({
        daemonPort: params.context.daemon.port,
        controlToken: params.context.daemon.controlToken,
        pluginId,
        postJson: params.postJson,
      }).catch(async (cleanupFailure) => {
        await assertCurrentManagedStackSourcePluginAbsent({
          context: params.context,
          pluginId,
          postJson: params.postJson,
        }).catch(() => { throw cleanupFailure; });
      });
      installed = false;
      await assertCurrentManagedStackSourcePluginAbsent({
        context: params.context,
        pluginId,
        postJson: params.postJson,
      });
    } catch (cleanupFailure) {
      retirementError = cleanupFailure;
    }
    if (!retirementError) {
      await rm(pluginRoot, { recursive: true, force: true });
    }
    if (retirementError) {
      throw new AggregateError(
        [error, retirementError],
        `Current managed Stack fixture preparation and retirement both failed; source retained at ${pluginRoot}`,
      );
    }
    throw error;
  }
}

/**
 * The one staging path for generated current-source public fixture revisions:
 * it copies the single checked-in fixture and qualifies only the plugin id and
 * the generation constant, exactly like the loaded-QA harness's build step.
 * Focused tests stage revisions through this same helper and import the staged
 * source, so a regression can never prove dispatch facts the loaded plugin
 * would not produce. There is no second fixture source and no second rewrite
 * rule.
 */
export function shouldStageCurrentSourceNativePublicFixturePath(source: string): boolean {
  return !source.includes('/dist/')
    && !source.includes('/.happier-plugin/')
    && !source.includes('/.happier-plugin-ui-staging/')
    && !source.endsWith('/.happier-plugin-ui-staging')
    && !source.endsWith('/node_modules');
}

export async function stageCurrentSourceNativePublicFixtureSource(params: Readonly<{
  root: string;
  pluginId: string;
  revision: 'v1' | 'v2';
}>): Promise<void> {
  await cp(CURRENT_SOURCE_NATIVE_PUBLIC_FIXTURE_ROOT, params.root, {
    recursive: true,
    filter: shouldStageCurrentSourceNativePublicFixturePath,
  });
  const indexPath = join(params.root, 'index.ts');
  const revisionPath = join(params.root, 'revision.ts');
  await writeFile(
    indexPath,
    (await readFile(indexPath, 'utf8')).replace(
      "const pluginId = 'qa.current-source.native-public';",
      `const pluginId = ${JSON.stringify(params.pluginId)};`,
    ),
    'utf8',
  );
  await writeFile(revisionPath, `export const QA_REVISION = ${JSON.stringify(params.revision)} as const;\n`, 'utf8');
}

async function buildCurrentManagedStackNativePublicSource(params: Readonly<{
  root: string;
  pluginId: string;
  revision: 'v1' | 'v2';
}>): Promise<void> {
  await stageCurrentSourceNativePublicFixtureSource(params);
  await buildCurrentSourcePublicPluginFixture(params.root);
}

/** Ordinary public source-author build, shared by composed plugin fixtures. */
export async function buildCurrentSourcePublicPluginFixture(root: string): Promise<void> {
  // The same current-source CLI producer ordinary external authors invoke owns
  // dependency preparation, declaration/manifest emission, daemon bundling,
  // and UI artifacts. The QA harness intentionally does not reproduce any of
  // those responsibilities or manufacture an archive-shaped candidate.
  const launch = await resolveCliTestLaunchSpec(
    { testDir: dirname(root), env: process.env },
    { repoRoot: REPOSITORY_ROOT, snapshotDir: join(dirname(root), 'cli-public-plugin-build') },
  );
  try {
    await execFileAsync(launch.command, [...launch.args, 'plugins', 'dev', 'build', root], {
      cwd: launch.cwd ?? REPOSITORY_ROOT,
      env: { ...process.env, ...launch.env },
      maxBuffer: 32 * 1024 * 1024,
    });
  } finally {
    await launch.cleanup?.();
  }
}

async function attestCurrentManagedStackFixtureArtifact(params: Readonly<{
  pluginRoot: string;
  platform: 'web' | 'ios' | 'android';
  contributionId: 'qa-native' | 'qa-hosted';
  tier: 'reactNative' | 'hostedWeb';
}>): Promise<Readonly<{ digest: string; entry: string; byteSize: number }>> {
  const artifactsRoot = join(params.pluginRoot, 'dist', 'happier-plugin-ui');
  const inventory = await readJsonRecord(
    join(artifactsRoot, 'ui-artifacts.json'),
    'plugin_ui_current_stack_source_artifacts_invalid',
  );
  const entry = (Array.isArray(inventory.entries) ? inventory.entries : [])
    .map(asRecord)
    .find((candidate) => candidate?.contributionId === params.contributionId
      && candidate.tier === params.tier
      && candidate.platform === params.platform);
  if (!entry) throw new Error(`plugin_ui_current_stack_source_native_artifact_missing:${params.platform}`);
  const files = Array.isArray(entry.files) ? entry.files.map(asRecord) : [];
  const verified: Array<Readonly<{ relativePath: string; bytes: Uint8Array }>> = [];
  let byteSize = 0;
  for (const file of files) {
    if (!file) throw new Error('plugin_ui_current_stack_source_artifact_file_invalid');
    const relativePath = requireString(file.relativePath, 'plugin_ui_current_stack_source_artifact_path_missing');
    const absolutePath = resolve(artifactsRoot, relativePath);
    if (!absolutePath.startsWith(`${resolve(artifactsRoot)}/`)) {
      throw new Error('plugin_ui_current_stack_source_artifact_path_escape');
    }
    const bytes = await readFile(absolutePath);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== requireString(file.digest, 'plugin_ui_current_stack_source_artifact_digest_missing')) {
      throw new Error('plugin_ui_current_stack_source_artifact_file_digest_mismatch');
    }
    if (bytes.byteLength !== requirePositiveInteger(file.byteSize, 'plugin_ui_current_stack_source_artifact_size_missing')) {
      throw new Error('plugin_ui_current_stack_source_artifact_size_mismatch');
    }
    byteSize += bytes.byteLength;
    verified.push({ relativePath, bytes });
  }
  const digest = computePluginUiArtifactFileSetSha256DigestV1(verified);
  if (digest !== requireString(entry.digest, 'plugin_ui_current_stack_source_artifact_aggregate_digest_missing')) {
    throw new Error('plugin_ui_current_stack_source_artifact_aggregate_digest_mismatch');
  }
  return Object.freeze({
    digest,
    entry: requireString(entry.entry, 'plugin_ui_current_stack_source_artifact_entry_missing'),
    byteSize,
  });
}

/**
 * Builds and owns one real public-source RN/hosted/targeted/Composer plugin.
 * The temporary source is installed through the incumbent development-path
 * owner; there is no archive, release candidate, or parallel plugin registry.
 */
export async function prepareCurrentManagedStackNativePublicFixture(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  rowId: string;
  postJson?: DaemonPluginPostJson;
  buildSource?: typeof buildCurrentManagedStackNativePublicSource;
}>): Promise<CurrentManagedStackNativePublicFixture> {
  const safeRowId = params.rowId.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'row';
  const pluginId = `qa.current-source.native.${safeRowId}.${randomUUID()}`;
  const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-current-source-native-'));
  const buildSource = params.buildSource ?? buildCurrentManagedStackNativePublicSource;
  let catalogMutationAttempted = false;
  const generation = async () => await attestCurrentManagedStackSourcePluginGeneration({
    context: params.context,
    pluginId,
    postJson: params.postJson,
  });
  const build = async (next: 'v1' | 'v2') => {
    await rm(join(pluginRoot, 'dist'), { recursive: true, force: true });
    await rm(join(pluginRoot, '.happier-plugin'), { recursive: true, force: true });
    await buildSource({ root: pluginRoot, pluginId, revision: next });
    // No catalog mutation may select a source build whose platform artifact
    // graphs have not passed the same digest/size admission used by loaded QA.
    await Promise.all([
      ...(['web', 'ios', 'android'] as const).map(async (platform) => {
        await attestCurrentManagedStackFixtureArtifact({
          pluginRoot,
          platform,
          contributionId: 'qa-native',
          tier: 'reactNative',
        });
      }),
      attestCurrentManagedStackFixtureArtifact({
        pluginRoot,
        platform: 'web',
        contributionId: 'qa-hosted',
        tier: 'hostedWeb',
      }),
    ]);
  };
  const install = async () => {
    // Once a catalog request can escape, cleanup must retire the exact plugin
    // even if the response is lost. Pure source/artifact preflight failures do
    // not issue a speculative uninstall against an untouched catalog.
    catalogMutationAttempted = true;
    await applyTrustedLocalPluginFixture({
      daemonPort: params.context.daemon.port,
      controlToken: params.context.daemon.controlToken,
      pluginRoot,
      pluginId,
      interactionId: `mobile-current-source-native-${safeRowId}-${Date.now()}`,
      postJson: params.postJson,
    });
    return await generation();
  };
  const uninstall = async () => {
    try {
      await uninstallTrustedLocalPluginFixture({
        daemonPort: params.context.daemon.port,
        controlToken: params.context.daemon.controlToken,
        pluginId,
        postJson: params.postJson,
      });
    } catch (error) {
      await assertCurrentManagedStackSourcePluginAbsent({
        context: params.context,
        pluginId,
        postJson: params.postJson,
      }).catch(() => { throw error; });
    }
    await assertCurrentManagedStackSourcePluginAbsent({ context: params.context, pluginId, postJson: params.postJson });
  };

  try {
    await build('v1');
    const initial = await install();
    return Object.freeze({
      pluginId,
      pluginRoot,
      rnSurfaceUrlPath: `/plugins/${encodeURIComponent(pluginId)}/native`,
      hostedSurfaceUrlPath: `/plugins/${encodeURIComponent(pluginId)}/hosted`,
      declarativeSurfaceUrlPath: `/plugins/${encodeURIComponent(pluginId)}/declarative`,
      sentinels: Object.freeze({
        rnV1: 'qa-current-source-rn-v1', rnV2: 'qa-current-source-rn-v2',
        hostedV1: 'qa-current-source-hosted-v1', hostedV2: 'qa-current-source-hosted-v2',
        hostedHistoryAction: 'qa-current-source-hosted-history-action',
        hostedHistoryV1: 'qa-current-source-hosted-history-v1',
        hostedHistoryV2: 'qa-current-source-hosted-history-v2',
        declarativeV1: 'qa-current-source-declarative-v1',
        declarativeV2: 'qa-current-source-declarative-v2',
        actionTestId: `plugin-declarative-action:${pluginId}/qa-self-check`,
        actionLabel: 'Run current source self-check',
        targetedV1: 'qa-current-source-targeted-v1', targetedV2: 'qa-current-source-targeted-v2',
        composerControl: `plugin-composer-control:${pluginId}/qa-control`,
        composerSecondaryControl: `plugin-composer-control:${pluginId}/qa-secondary-control`,
        composerChoiceLabel: 'Attach Current source QA facts',
        composerAttachmentV1: 'Current source QA attachment v1',
        composerAttachmentV2: 'Current source QA attachment v2',
        composerReferenceV1: 'Current source QA reference v1',
        composerReferenceV2: 'Current source QA reference v2',
        composerRegion: 'qa-current-source-composer-region',
        agentTitle: `${pluginId} deterministic QA`,
        transcriptSentinel: 'PLUGIN_UI_CURRENT_SOURCE_NATIVE_ACCEPTED',
        resourceV1: 'qa-current-source-resource-v1',
        resourceV2: 'qa-current-source-resource-v2',
        actionRun: 'qa-current-source-action-run',
        actionBusy: 'qa-current-source-action-busy',
        actionSettled: 'qa-current-source-action-settled',
        actionResultV1: 'qa-current-source-action-result-v1',
        actionResultV2: 'qa-current-source-action-result-v2',
      }),
      installed: initial,
      artifact: async (platform) => await attestCurrentManagedStackFixtureArtifact({
        pluginRoot,
        platform,
        contributionId: 'qa-native',
        tier: 'reactNative',
      }),
      hostedArtifact: async () => await attestCurrentManagedStackFixtureArtifact({
        pluginRoot,
        platform: 'web',
        contributionId: 'qa-hosted',
        tier: 'hostedWeb',
      }),
      applyV2: async () => {
        await build('v2');
        await reloadTrustedLocalPluginFixture({
          daemonPort: params.context.daemon.port,
          controlToken: params.context.daemon.controlToken,
          pluginRoot,
          pluginId,
          changedPaths: ['index.ts', 'revision.ts', 'dist/happier-plugin-ui'],
          postJson: params.postJson,
        });
        return await generation();
      },
      disable: async () => {
        await requestCurrentManagedStackPluginState({ ...params, pluginId, kind: 'disable' });
        return await generation();
      },
      enable: async () => {
        await requestCurrentManagedStackPluginState({ ...params, pluginId, kind: 'enable' });
        return await generation();
      },
      uninstall,
      reinstallV1: async () => {
        await uninstall();
        await build('v1');
        return await install();
      },
      cleanup: async () => {
        await uninstall();
        await rm(pluginRoot, { recursive: true, force: true });
      },
    });
  } catch (error) {
    let cleanupError: unknown = null;
    if (catalogMutationAttempted) {
      try { await uninstall(); } catch (candidate) { cleanupError = candidate; }
    }
    if (!cleanupError) await rm(pluginRoot, { recursive: true, force: true });
    if (cleanupError) throw new AggregateError([error, cleanupError], `Native public fixture preparation and cleanup failed at ${pluginRoot}`);
    throw error;
  }
}

function readSessionAgentActivationState(value: unknown): CurrentManagedStackSessionAgentAgentActivationState {
  const record = asRecord(value);
  const state = record?.state;
  if (state === 'notRequired' || state === 'dormant' || state === 'active' || state === 'unavailable') {
    return state;
  }
  throw new Error('plugin_ui_current_stack_session_agent_activation_state_invalid');
}

/**
 * Reads the daemon catalog — the projection every loaded client consumes —
 * and projects the exact external Agent identity of one plugin. Returns null
 * when the plugin is retired; a missing Agent contribution inside a present
 * plugin is an invalid identity, not a null.
 */
export async function readCurrentManagedStackSessionAgentCatalogIdentity(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  pluginId?: string;
  agentLocalId?: string;
  postJson?: DaemonPluginPostJson;
}>): Promise<CurrentManagedStackSessionAgentCatalogIdentity | null> {
  const pluginId = params.pluginId ?? CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID;
  const agentLocalId = params.agentLocalId ?? CURRENT_SOURCE_SESSION_AGENT_LOCAL_ID;
  const response = await (params.postJson ?? daemonControlPostJson)({
    port: params.context.daemon.port,
    path: '/plugins/catalog/read',
    controlToken: params.context.daemon.controlToken,
    body: {},
    timeoutMs: 30_000,
  });
  const body = asRecord(response.data);
  if (response.status !== 200 || body?.kind !== 'available' || !Array.isArray(body.plugins)) {
    throw new Error(`plugin_ui_current_stack_session_agent_catalog_unavailable:${response.status}`);
  }
  const entry = body.plugins.map(asRecord).find((candidate) => candidate?.pluginId === pluginId);
  if (!entry) return null;
  const introspection = asRecord(entry.contributionIntrospection) ?? asRecord(entry.contributions);
  const contributions = Array.isArray(introspection?.contributions) ? introspection.contributions : [];
  const agentRecords = contributions
    .map(asRecord)
    .filter((record) => {
      const identity = asRecord(record?.contribution);
      return identity?.family === 'agents'
        && identity.kind === 'localId'
        && identity.localId === agentLocalId;
    });
  if (agentRecords.length !== 1) {
    throw new Error(`plugin_ui_current_stack_session_agent_contribution_identity_ambiguous:${pluginId}:${agentRecords.length}`);
  }
  const agentRecord = asRecord(agentRecords[0]);
  if (!agentRecord) throw new Error('plugin_ui_current_stack_session_agent_contribution_record_invalid');
  const activation = asRecord(agentRecord.activation);
  const registration = asRecord(agentRecord.registration);
  const activationState = readSessionAgentActivationState(activation);
  const activationGeneration = activationState === 'active' && typeof activation?.generation === 'string' && activation.generation.trim()
    ? activation.generation
    : null;
  return Object.freeze({
    pluginId,
    enabled: entry.enabled === true,
    desiredGeneration: typeof entry.desiredGeneration === 'string' ? entry.desiredGeneration : null,
    appliedGeneration: typeof entry.appliedGeneration === 'string' ? entry.appliedGeneration : null,
    agentContribution: Object.freeze({
      family: 'agents' as const,
      localId: agentLocalId,
      activationState,
      activationGeneration,
      registrationRequirement: optionalString(registration?.requirement),
      registrationState: optionalString(registration?.state),
      registrationGeneration: optionalString(registration?.generation),
    }),
  });
}

/**
 * Asserts the client-visible Agent identity at the canonical daemon catalog
 * seam. `active` additionally requires an enabled, generation-current plugin
 * whose Agent contribution is bound and active.
 */
export async function assertCurrentManagedStackSessionAgentIdentity(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  phase: 'active' | 'present' | 'absent';
  postJson?: DaemonPluginPostJson;
}>): Promise<CurrentManagedStackSessionAgentCatalogIdentity | null> {
  if (params.phase === 'absent') {
    await assertCurrentManagedStackSourcePluginAbsent({
      context: params.context,
      pluginId: CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID,
      postJson: params.postJson,
    });
    return null;
  }
  const identity = await readCurrentManagedStackSessionAgentCatalogIdentity({
    context: params.context,
    postJson: params.postJson,
  });
  if (!identity) {
    throw new Error(`plugin_ui_current_stack_session_agent_identity_absent:${params.phase}`);
  }
  if (params.phase === 'active') {
    if (!identity.enabled) {
      throw new Error('plugin_ui_current_stack_session_agent_identity_disabled');
    }
    if (
      !identity.desiredGeneration
      || identity.desiredGeneration !== identity.appliedGeneration
    ) {
      throw new Error(
        `plugin_ui_current_stack_session_agent_generation_not_current:${String(identity.desiredGeneration)}:${String(identity.appliedGeneration)}`,
      );
    }
    if (identity.agentContribution?.activationState !== 'active') {
      throw new Error(
        `plugin_ui_current_stack_session_agent_contribution_not_active:${String(identity.agentContribution?.activationState ?? 'missing')}`,
      );
    }
    if (
      identity.agentContribution.registrationRequirement !== 'required'
      || identity.agentContribution.registrationState !== 'bound'
      || identity.agentContribution.registrationGeneration !== identity.appliedGeneration
    ) {
      throw new Error(
        `plugin_ui_current_stack_session_agent_registration_not_current:${String(identity.agentContribution.registrationRequirement)}:${String(identity.agentContribution.registrationState)}:${String(identity.agentContribution.registrationGeneration)}`,
      );
    }
    if (identity.agentContribution.activationGeneration !== identity.appliedGeneration) {
      throw new Error(
        `plugin_ui_current_stack_session_agent_activation_not_current:${String(identity.agentContribution.activationGeneration)}:${String(identity.appliedGeneration)}`,
      );
    }
  }
  return identity;
}

async function prepareCurrentManagedStackSessionAgentSource(params: Readonly<{
  sourceRoot: string;
  exampleRoot: string;
}>): Promise<void> {
  await cp(params.exampleRoot, params.sourceRoot, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/u).some((segment) => (
      segment === 'node_modules'
      || segment === 'dist'
      || segment === '.happier-plugin'
    )),
  });
}

async function applyCurrentManagedStackSessionAgentExampleToScaffold(params: Readonly<{
  sourceRoot: string;
  exampleRoot: string;
}>): Promise<void> {
  await mkdir(join(params.sourceRoot, 'src', 'agent'), { recursive: true });
  await Promise.all([
    cp(join(params.exampleRoot, 'index.ts'), join(params.sourceRoot, 'src', 'index.ts')),
    cp(
      join(params.exampleRoot, 'agent', 'deterministicSessionAgent.ts'),
      join(params.sourceRoot, 'src', 'agent', 'deterministicSessionAgent.ts'),
    ),
    cp(join(params.exampleRoot, 'test', 'index.test.mjs'), join(params.sourceRoot, 'test', 'index.test.mjs')),
  ]);
}

async function resolveCurrentManagedStackSessionAgentSourceDirectory(sourceRoot: string): Promise<string> {
  try {
    const scaffoldEntry = await stat(join(sourceRoot, 'src', 'index.ts'));
    if (scaffoldEntry.isFile()) return join(sourceRoot, 'src');
  } catch {
    // The maintained package-root example is also accepted by caller-owned
    // fixture roots; it keeps index.ts and agent/ at the package root.
  }
  return sourceRoot;
}

/**
 * Builds the same managed author command arguments an ordinary external
 * author invokes. Keeping this derivation public to the testkit lets the
 * owner-level test prevent the loaded journey from drifting onto private
 * compiler, test-runner, or pack implementations.
 */
export function buildCurrentManagedStackSessionAgentAuthorArgs(params: Readonly<
  | { command: 'create'; sourceRoot: string; pluginId: string }
  | { command: 'typecheck' | 'test' | 'build'; sourceRoot: string }
  | { command: 'pack'; sourceRoot: string; archivePath: string }
>): readonly string[] {
  if (params.command === 'create') {
    return Object.freeze([
      'plugins',
      'create',
      params.sourceRoot,
      '--id',
      params.pluginId,
      '--json',
    ]);
  }
  if (params.command === 'test') {
    return Object.freeze(['plugins', 'test', params.sourceRoot]);
  }
  if (params.command === 'pack') {
    return Object.freeze([
      'plugins',
      'pack',
      params.sourceRoot,
      '--out',
      params.archivePath,
    ]);
  }
  return Object.freeze(['plugins', 'dev', params.command, params.sourceRoot, '--json']);
}

/**
 * Runs the canonical managed author command. Dependency preparation is
 * automatic inside these commands; the harness never reproduces their
 * typecheck, test, build, or pack responsibilities itself.
 */
async function runCurrentManagedStackSessionAgentAuthorCommand(params: Readonly<{
  command: 'create' | 'typecheck' | 'test' | 'build' | 'pack';
  sourceRoot: string;
  archivePath?: string;
  pluginId?: string;
}>): Promise<void> {
  const args = params.command === 'create'
    ? buildCurrentManagedStackSessionAgentAuthorArgs({
        command: 'create',
        sourceRoot: params.sourceRoot,
        pluginId: requireString(
          params.pluginId,
          'plugin_ui_current_stack_session_agent_create_plugin_id_missing',
        ),
      })
    : params.command === 'pack'
    ? buildCurrentManagedStackSessionAgentAuthorArgs({
        command: 'pack',
        sourceRoot: params.sourceRoot,
        archivePath: requireString(
          params.archivePath,
          'plugin_ui_current_stack_session_agent_pack_path_missing',
        ),
      })
    : buildCurrentManagedStackSessionAgentAuthorArgs({
        command: params.command,
        sourceRoot: params.sourceRoot,
      });
  await execFileAsync(
    process.execPath,
    [join(REPOSITORY_ROOT, 'apps/cli/bin/happier.mjs'), ...args],
    { cwd: REPOSITORY_ROOT, maxBuffer: 32 * 1024 * 1024 },
  );
}

/** The public, headless local-development install command an external author uses. */
export function buildCurrentManagedStackSessionAgentInstallArgs(sourceRoot: string): readonly string[] {
  return Object.freeze([
    'plugins',
    'install',
    sourceRoot,
    '--dev',
    '--json',
  ]);
}

/** The ordinary archive install command; present-user review remains separate. */
export function buildCurrentManagedStackSessionAgentArchiveInstallArgs(archivePath: string): readonly string[] {
  return Object.freeze([
    'plugins',
    'install',
    archivePath,
    '--kind',
    'archive',
    '--json',
  ]);
}

/** The documented development reload command an external author runs after an edit. */
export function buildCurrentManagedStackSessionAgentReloadArgs(pluginId: string): readonly string[] {
  return Object.freeze(['plugins', 'reload', pluginId, '--json']);
}

/** The canonical plugin enable/disable commands — the Settings toggle's CLI twin. */
export function buildCurrentManagedStackSessionAgentPluginStateArgs(
  kind: 'enable' | 'disable',
  pluginId: string,
): readonly string[] {
  return Object.freeze(['plugins', kind, pluginId, '--json']);
}

/** The canonical uninstall command; plugin data is intentionally preserved. */
export function buildCurrentManagedStackSessionAgentUninstallArgs(pluginId: string): readonly string[] {
  return Object.freeze(['plugins', 'uninstall', pluginId, '--json']);
}

async function installCurrentManagedStackSessionAgentThroughCli(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  sourceRoot: string;
}>): Promise<void> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(REPOSITORY_ROOT, 'apps/cli/bin/happier.mjs'),
      ...buildCurrentManagedStackSessionAgentInstallArgs(params.sourceRoot),
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, HAPPIER_HOME_DIR: params.context.cliHome },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000,
    },
  );
  const response = asRecord(JSON.parse(stdout.trim()));
  const data = asRecord(response?.data);
  if (
    response?.ok !== true
    || response.kind !== 'plugins_install'
    || data?.pluginId !== CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID
  ) {
    throw new Error('plugin_ui_current_stack_session_agent_cli_install_not_committed');
  }
}

async function installCurrentManagedStackSessionAgentArchiveThroughCli(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  archivePath: string;
}>): Promise<void> {
  let stdout: string;
  try {
    stdout = (await execFileAsync(
      process.execPath,
      [
        join(REPOSITORY_ROOT, 'apps/cli/bin/happier.mjs'),
        ...buildCurrentManagedStackSessionAgentArchiveInstallArgs(params.archivePath),
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, HAPPIER_HOME_DIR: params.context.cliHome },
        maxBuffer: 32 * 1024 * 1024,
        timeout: 300_000,
      },
    )).stdout;
  } catch (error) {
    const processError = error as Error & { stdout?: string | Buffer };
    stdout = typeof processError.stdout === 'string'
      ? processError.stdout
      : Buffer.isBuffer(processError.stdout)
        ? processError.stdout.toString('utf8')
        : '';
    if (!stdout.trim()) throw error;
  }
  const requested = readPluginInstallReviewRequiredEnvelope(JSON.parse(stdout.trim()));
  if (
    requested.review.source.kind !== 'archive'
    || requested.review.pluginId !== CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID
    || requested.review.version !== CURRENT_SOURCE_SESSION_AGENT_PACKED_VERSION
  ) {
    throw new Error('plugin_ui_current_stack_session_agent_archive_review_identity_mismatch');
  }
  const outcome = await decideAuthenticatedPluginInstallReview({
    cliHomeDir: params.context.cliHome,
    serverUrl: params.context.serverUrl,
    pendingChangeId: requested.pendingChangeId,
    optionalSelections: requested.review.optionalHostAccess.map((access) => ({
      accessId: access.id,
      selected: false,
    })),
    confirmPresentUser: async () => true,
  });
  if (outcome.kind !== 'committed' || outcome.pluginId !== CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID) {
    throw new Error(`plugin_ui_current_stack_session_agent_archive_install_not_committed:${outcome.kind}`);
  }
}

/**
 * Runs one canonical plugins CLI lifecycle command against the selected
 * Stack's daemon home. The loaded journey must prove the documented public
 * author contract, so reload/enable/disable/uninstall ride exactly the
 * command an external author types — never a private daemon-control shortcut.
 * A non-committed JSON envelope (review required, refused, expired) fails the
 * row through its typed error code instead of being retried out-of-band.
 */
async function runCurrentManagedStackSessionAgentCliLifecycleCommand(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  args: readonly string[];
  expectedKind: string;
  expectedPluginId?: string;
}>): Promise<void> {
  let stdout: string;
  try {
    stdout = (await execFileAsync(
      process.execPath,
      [join(REPOSITORY_ROOT, 'apps/cli/bin/happier.mjs'), ...params.args],
      {
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, HAPPIER_HOME_DIR: params.context.cliHome },
        maxBuffer: 32 * 1024 * 1024,
        timeout: 300_000,
      },
    )).stdout;
  } catch (error) {
    const processError = error as Error & { stdout?: string | Buffer };
    stdout = typeof processError.stdout === 'string'
      ? processError.stdout
      : Buffer.isBuffer(processError.stdout)
        ? processError.stdout.toString('utf8')
        : '';
    if (!stdout.trim()) throw error;
  }
  const response = asRecord(JSON.parse(stdout.trim()));
  const data = asRecord(response?.data);
  const errorCode = asRecord(response?.error)?.code;
  if (response?.ok !== true || response.kind !== params.expectedKind) {
    throw new Error(
      `plugin_ui_current_stack_session_agent_cli_change_refused:${params.expectedKind}:${String(errorCode ?? response?.kind ?? 'no_envelope')}`,
    );
  }
  if (params.expectedPluginId && data?.pluginId !== params.expectedPluginId) {
    throw new Error(`plugin_ui_current_stack_session_agent_cli_change_identity_mismatch:${params.expectedKind}`);
  }
}

function nextSessionAgentSourceVersion(previousIndex: number): string {
  return `0.1.${10 + previousIndex}`;
}

async function rewriteSessionAgentSourceVersion(params: Readonly<{
  sourceRoot: string;
  version: string;
}>): Promise<void> {
  const sourceDirectory = await resolveCurrentManagedStackSessionAgentSourceDirectory(params.sourceRoot);
  const indexPath = join(sourceDirectory, 'index.ts');
  const original = await readFile(indexPath, 'utf8');
  const updated = original.replace(
    /version: '[^']*',/u,
    `version: '${params.version}',`,
  );
  if (updated === original) {
    throw new Error('plugin_ui_current_stack_session_agent_source_version_anchor_missing');
  }
  await writeFile(indexPath, updated, 'utf8');
  const agentPath = join(sourceDirectory, 'agent', 'deterministicSessionAgent.ts');
  const agentOriginal = await readFile(agentPath, 'utf8');
  const agentUpdated = agentOriginal.replace(
    CURRENT_SOURCE_SESSION_AGENT_REASONING_TEXT,
    CURRENT_SOURCE_SESSION_AGENT_UPDATED_REASONING_TEXT,
  );
  if (agentUpdated === agentOriginal) {
    throw new Error('plugin_ui_current_stack_session_agent_behavior_update_anchor_missing');
  }
  await writeFile(agentPath, agentUpdated, 'utf8');
}

/**
 * Derives the deterministic failing external-author edit from real example
 * bytes. Exported so the owner-level test can prove the edit stays anchored to
 * the maintained example instead of silently degrading into a source rewrite
 * that still compiles.
 */
export function buildCurrentManagedStackSessionAgentFailingSourceUpdate(source: string): string {
  const updated = source.replace(
    CURRENT_SOURCE_SESSION_AGENT_FAILING_UPDATE_ANCHOR,
    CURRENT_SOURCE_SESSION_AGENT_FAILING_UPDATE_REPLACEMENT,
  );
  if (updated === source) {
    throw new Error('plugin_ui_current_stack_session_agent_failing_update_anchor_missing');
  }
  return updated;
}

/**
 * Runs a managed author command that must refuse the current source. A command
 * that succeeds is a coverage failure, not a passing journey: it would mean the
 * failing edit never reached the author toolchain.
 */
export async function requireCurrentManagedStackSessionAgentAuthorCommandRefusal(params: Readonly<{
  command: 'typecheck' | 'build';
  sourceRoot: string;
  runAuthorCommand?: typeof runCurrentManagedStackSessionAgentAuthorCommand;
}>): Promise<void> {
  try {
    await (params.runAuthorCommand ?? runCurrentManagedStackSessionAgentAuthorCommand)(params);
  } catch (error) {
    const processError = error as Error & { stdout?: string | Buffer };
    const stdout = typeof processError.stdout === 'string'
      ? processError.stdout
      : Buffer.isBuffer(processError.stdout)
        ? processError.stdout.toString('utf8')
        : '';
    try {
      const response = asRecord(JSON.parse(stdout.trim()));
      const failure = asRecord(response?.error);
      const diagnostics = Array.isArray(failure?.diagnostics)
        ? failure.diagnostics.map(asRecord)
        : [];
      const expectedSourceFailure = diagnostics.some((diagnostic) => {
        const source = asRecord(diagnostic?.source);
        return diagnostic?.code === 'plugin_author_tool_failed'
          && typeof source?.file === 'string'
          && source.file.replaceAll('\\', '/') === 'src/agent/deterministicSessionAgent.ts';
      });
      if (
        response?.ok === false
        && response.kind === `plugins_dev_${params.command}`
        && failure?.code === 'plugin_author_failed'
        && expectedSourceFailure
      ) {
        return;
      }
    } catch {
      // Missing or malformed JSON means the managed author command itself did
      // not establish the expected source-level refusal. Preserve that failure.
    }
    throw error;
  }
  throw new Error(
    `plugin_ui_current_stack_session_agent_failing_update_${params.command}_unexpectedly_passed`,
  );
}

async function rewriteSessionAgentPackedDiscriminator(params: Readonly<{
  sourceRoot: string;
}>): Promise<void> {
  const sourceDirectory = await resolveCurrentManagedStackSessionAgentSourceDirectory(params.sourceRoot);
  const indexPath = join(sourceDirectory, 'index.ts');
  const indexSource = await readFile(indexPath, 'utf8');
  const versioned = indexSource.replace(
    /version: '[^']*',/u,
    `version: '${CURRENT_SOURCE_SESSION_AGENT_PACKED_VERSION}',`,
  );
  if (versioned === indexSource) {
    throw new Error('plugin_ui_current_stack_session_agent_packed_version_anchor_missing');
  }
  await writeFile(indexPath, versioned, 'utf8');

  const agentPath = join(sourceDirectory, 'agent', 'deterministicSessionAgent.ts');
  const agentSource = await readFile(agentPath, 'utf8');
  const discriminated = agentSource.replace(
    CURRENT_SOURCE_SESSION_AGENT_REASONING_TEXT,
    CURRENT_SOURCE_SESSION_AGENT_PACKED_REASONING_TEXT,
  );
  if (discriminated === agentSource) {
    throw new Error('plugin_ui_current_stack_session_agent_packed_behavior_anchor_missing');
  }
  await writeFile(agentPath, discriminated, 'utf8');
}

/**
 * Restarts the managed Stack daemon through the canonical CLI owner and
 * resolves the successor daemon identity from the daemon-owned state file.
 * The successor must serve the same runtime bytes (identical dist-closure
 * fingerprint) or the journey evidence basis would silently change underneath
 * the loaded clients. The stack runtime publication is revalidated only after
 * the successor settles; the daemon state file, not the stack runtime pointer,
 * owns the live daemon identity.
 */
export async function restartCurrentManagedStackDaemon(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  restartSessionRunners?: boolean;
  settleTimeoutMs?: number;
}>): Promise<CurrentManagedStackPluginUiContext> {
  const previous = params.context.daemon;
  const args = ['daemon', 'restart', '--json'];
  if (params.restartSessionRunners) args.push('--restart-session-runners');
  await execFileAsync(
    process.execPath,
    [join(REPOSITORY_ROOT, 'apps/cli/bin/happier.mjs'), ...args],
    {
      cwd: REPOSITORY_ROOT,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, HAPPIER_HOME_DIR: params.context.cliHome },
      timeout: MANAGED_DAEMON_RESTART_SETTLE_TIMEOUT_MS,
    },
  );
  const settleTimeoutMs = params.settleTimeoutMs ?? MANAGED_DAEMON_RESTART_SETTLE_TIMEOUT_MS;
  const deadline = Date.now() + settleTimeoutMs;
  let successorState: JsonRecord | null = null;
  for (;;) {
    try {
      const candidate = await readJsonRecord(previous.statePath, 'plugin_ui_current_stack_daemon_state_invalid');
      const candidatePid = requirePositiveInteger(candidate.pid, 'plugin_ui_current_stack_daemon_pid_missing');
      const candidateRuntimeId = requireString(candidate.runtimeId, 'plugin_ui_current_stack_daemon_runtime_id_missing');
      if (
        candidatePid !== previous.pid
        && candidateRuntimeId !== previous.runtimeId
        && optionalString(candidate.distClosureFingerprint) === previous.distClosureFingerprint
      ) {
        const ping = await daemonControlPostJson({
          port: requirePositiveInteger(candidate.httpPort, 'plugin_ui_current_stack_daemon_port_missing'),
          path: '/ping',
          controlToken: requireString(candidate.controlToken, 'plugin_ui_current_stack_daemon_token_missing'),
          body: {},
          timeoutMs: 30_000,
        });
        const pingBody = asRecord(ping.data);
        if (
          ping.status === 200
          && pingBody?.status === 'ok'
          && pingBody.runtimeId === candidateRuntimeId
          && pingBody.distClosureFingerprint === previous.distClosureFingerprint
        ) {
          successorState = candidate;
        }
      }
    } catch {
      // The state file is absent or mid-rewrite while the successor boots;
      // the poll deadline below owns failure, not this transient read.
    }
    if (successorState) break;
    if (Date.now() >= deadline) {
      throw new Error('plugin_ui_current_stack_daemon_restart_settle_timeout');
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  if (!successorState) {
    throw new Error('plugin_ui_current_stack_daemon_restart_settle_timeout');
  }
  const successorDaemon = {
    pid: requirePositiveInteger(successorState.pid, 'plugin_ui_current_stack_daemon_pid_missing'),
    port: requirePositiveInteger(successorState.httpPort, 'plugin_ui_current_stack_daemon_port_missing'),
    controlToken: requireString(successorState.controlToken, 'plugin_ui_current_stack_daemon_token_missing'),
    statePath: previous.statePath,
    runtimeId: requireString(successorState.runtimeId, 'plugin_ui_current_stack_daemon_runtime_id_missing'),
    machineId: requireString(successorState.machineId, 'plugin_ui_current_stack_daemon_machine_id_missing'),
    runtimeEntrypoint: requireString(
      successorState.startedWithRuntimeEntrypoint,
      'plugin_ui_current_stack_daemon_runtime_entrypoint_missing',
    ),
    distClosureFingerprint: requireString(
      successorState.distClosureFingerprint,
      'plugin_ui_current_stack_daemon_dist_closure_fingerprint_missing',
    ),
  };
  if (successorDaemon.machineId !== previous.machineId) {
    throw new Error(`plugin_ui_current_stack_daemon_restart_machine_changed:${previous.machineId}:${successorDaemon.machineId}`);
  }
  return {
    ...params.context,
    daemon: successorDaemon,
  };
}

/**
 * Exact stable selectors every loaded client corridor asserts for the
 * canonical external Session Agent identity. One derivation owner: no client
 * corridor hardcodes a second copy of these strings.
 */
export function buildCurrentManagedStackSessionAgentSelectors(): CurrentManagedStackSessionAgentFixture['selectors'] {
  return Object.freeze({
    wizardOption: `new-session-agent:${CURRENT_SOURCE_SESSION_AGENT_QUALIFIED_TARGET_ID}`,
    agentChip: 'agent-input-agent-chip',
    chipPickerOption: `agent-input-chip-picker.option:${CURRENT_SOURCE_SESSION_AGENT_QUALIFIED_TARGET_ID}`,
    newSessionComposerInput: 'new-session-composer-input',
    newSessionComposerSend: 'new-session-composer-send',
    sessionComposerInput: 'session-composer-input',
    sessionComposerSend: 'session-composer-send',
    permissionAllow: 'permission-footer.allow',
    abort: 'agent-input-abort',
    forgetTrustAction: `settings.plugins.detail.${CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID}.action.forgetTrust`,
  });
}

/**
 * Owns one reversible current-source Session Agent row built from the
 * canonical deterministic public example. The example's own managed author
 * commands prepare dependencies and run typecheck/test/build/pack;
 * installation and every later lifecycle mutation — reload, disable, enable,
 * uninstall — ride the documented public plugins CLI commands an external
 * author runs, verified afterward through the daemon catalog seam. Every row
 * starts from the pristine example source and cleanup retires the fixture even
 * after a failed client flow. One archive-only reasoning sentinel lets the
 * browser row prove a deterministic Session turn actually used packed bytes.
 */
export async function prepareCurrentManagedStackSessionAgentFixture(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
  rowId: string;
  postJson?: DaemonPluginPostJson;
  /** Existing checked-out example root; it is used in place and never deleted. */
  exampleRoot?: string;
}>): Promise<CurrentManagedStackSessionAgentFixture> {
  const exampleRoot = params.exampleRoot
    ? resolve(params.exampleRoot)
    : CURRENT_SOURCE_SESSION_AGENT_EXAMPLE_ROOT;
  const ownsSourceRoot = !params.exampleRoot;
  const sourceOutputRoot = ownsSourceRoot
    ? await mkdtemp(join(tmpdir(), 'happier-current-source-session-agent-'))
    : null;
  const sourceRoot = sourceOutputRoot ? join(sourceOutputRoot, 'session-agent') : exampleRoot;
  const pluginId = CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID;
  let context = params.context;
  let installed = false;
  let sourceUpdateOrdinal = 0;
  /** Retained bytes of the last building source while a failing edit is staged. */
  let lastGoodAgentSource: string | null = null;
  const packOutputRoot = await mkdtemp(join(tmpdir(), 'happier-current-source-session-agent-pack-'));
  const packSourceRoot = join(packOutputRoot, 'source');
  const packArchivePath = join(packOutputRoot, 'session-agent.tgz');
  const generation = async (): Promise<CurrentManagedStackSourcePluginGeneration> => (
    await attestCurrentManagedStackSourcePluginGeneration({
      context,
      pluginId,
      postJson: params.postJson,
    })
  );
  const install = async (): Promise<CurrentManagedStackSourcePluginGeneration> => {
    await installCurrentManagedStackSessionAgentThroughCli({
      context,
      sourceRoot,
    });
    installed = true;
    return await generation();
  };
  const uninstallOnce = async (): Promise<void> => {
    try {
      await runCurrentManagedStackSessionAgentCliLifecycleCommand({
        context,
        args: buildCurrentManagedStackSessionAgentUninstallArgs(pluginId),
        expectedKind: 'plugins_uninstall',
        expectedPluginId: pluginId,
      });
    } catch (error) {
      await assertCurrentManagedStackSourcePluginAbsent({
        context,
        pluginId,
        postJson: params.postJson,
      }).catch(() => { throw error; });
    }
    installed = false;
    await assertCurrentManagedStackSourcePluginAbsent({
      context,
      pluginId,
      postJson: params.postJson,
    });
  };

  try {
    if (ownsSourceRoot) {
      await runCurrentManagedStackSessionAgentAuthorCommand({
        command: 'create',
        sourceRoot,
        pluginId,
      });
      await applyCurrentManagedStackSessionAgentExampleToScaffold({ sourceRoot, exampleRoot });
    }
    await runCurrentManagedStackSessionAgentAuthorCommand({ command: 'typecheck', sourceRoot });
    await runCurrentManagedStackSessionAgentAuthorCommand({ command: 'test', sourceRoot });
    await runCurrentManagedStackSessionAgentAuthorCommand({ command: 'build', sourceRoot });
    await prepareCurrentManagedStackSessionAgentSource({ sourceRoot: packSourceRoot, exampleRoot: sourceRoot });
    await rewriteSessionAgentPackedDiscriminator({ sourceRoot: packSourceRoot });
    await runCurrentManagedStackSessionAgentAuthorCommand({
      command: 'pack',
      sourceRoot: packSourceRoot,
      archivePath: packArchivePath,
    });
    const packed = await stat(packArchivePath);
    if (!packed.isFile() || packed.size === 0) {
      throw new Error('plugin_ui_current_stack_session_agent_pack_output_invalid');
    }
    const initial = await install();
    return Object.freeze({
      pluginId,
      agentLocalId: CURRENT_SOURCE_SESSION_AGENT_LOCAL_ID,
      qualifiedAgentId: CURRENT_SOURCE_SESSION_AGENT_QUALIFIED_TARGET_ID,
      displayTitle: CURRENT_SOURCE_SESSION_AGENT_DISPLAY_TITLE,
      assistantText: CURRENT_SOURCE_SESSION_AGENT_ASSISTANT_TEXT,
      reasoningText: CURRENT_SOURCE_SESSION_AGENT_REASONING_TEXT,
      updatedReasoningText: CURRENT_SOURCE_SESSION_AGENT_UPDATED_REASONING_TEXT,
      packedReasoningText: CURRENT_SOURCE_SESSION_AGENT_PACKED_REASONING_TEXT,
      confirmationTitle: CURRENT_SOURCE_SESSION_AGENT_CONFIRMATION_TITLE,
      sourceRoot,
      ownsSourceRoot,
      installed: initial,
      selectors: buildCurrentManagedStackSessionAgentSelectors(),
      reattach(nextContext: CurrentManagedStackPluginUiContext): void {
        context = nextContext;
      },
      generation,
      applySourceUpdate: async () => {
        if (!ownsSourceRoot) {
          throw new Error('plugin_ui_current_stack_session_agent_source_update_rejected_for_caller_root');
        }
        if (!installed) {
          throw new Error('plugin_ui_current_stack_session_agent_source_update_requires_install');
        }
        sourceUpdateOrdinal += 1;
        await rewriteSessionAgentSourceVersion({
          sourceRoot,
          version: nextSessionAgentSourceVersion(sourceUpdateOrdinal),
        });
        await runCurrentManagedStackSessionAgentAuthorCommand({ command: 'build', sourceRoot });
        // The documented author reload: the CLI re-inspects the source root
        // and submits the development change through the canonical owner, so
        // the loaded row proves `happier plugins reload --json` end to end.
        await runCurrentManagedStackSessionAgentCliLifecycleCommand({
          context,
          args: buildCurrentManagedStackSessionAgentReloadArgs(pluginId),
          expectedKind: 'plugins_reload',
          expectedPluginId: pluginId,
        });
        return await generation();
      },
      applyFailingSourceUpdate: async () => {
        if (!ownsSourceRoot) {
          throw new Error('plugin_ui_current_stack_session_agent_source_update_rejected_for_caller_root');
        }
        if (!installed) {
          throw new Error('plugin_ui_current_stack_session_agent_source_update_requires_install');
        }
        const sourceDirectory = await resolveCurrentManagedStackSessionAgentSourceDirectory(sourceRoot);
        const agentPath = join(sourceDirectory, 'agent', 'deterministicSessionAgent.ts');
        lastGoodAgentSource = await readFile(agentPath, 'utf8');
        await writeFile(
          agentPath,
          buildCurrentManagedStackSessionAgentFailingSourceUpdate(lastGoodAgentSource),
          'utf8',
        );
        // The canonical author toolchain, not the harness, must refuse the
        // broken edit. No daemon change is requested, so the installed
        // generation below is the untouched incumbent.
        await requireCurrentManagedStackSessionAgentAuthorCommandRefusal({ command: 'typecheck', sourceRoot });
        await requireCurrentManagedStackSessionAgentAuthorCommandRefusal({ command: 'build', sourceRoot });
        return await generation();
      },
      recoverFailingSourceUpdate: async () => {
        if (lastGoodAgentSource === null) {
          throw new Error('plugin_ui_current_stack_session_agent_failing_update_not_applied');
        }
        const sourceDirectory = await resolveCurrentManagedStackSessionAgentSourceDirectory(sourceRoot);
        await writeFile(
          join(sourceDirectory, 'agent', 'deterministicSessionAgent.ts'),
          lastGoodAgentSource,
          'utf8',
        );
        lastGoodAgentSource = null;
        await runCurrentManagedStackSessionAgentAuthorCommand({ command: 'build', sourceRoot });
        await runCurrentManagedStackSessionAgentCliLifecycleCommand({
          context,
          args: buildCurrentManagedStackSessionAgentReloadArgs(pluginId),
          expectedKind: 'plugins_reload',
          expectedPluginId: pluginId,
        });
        return await generation();
      },
      installPackedDiscriminator: async () => {
        if (installed) {
          throw new Error('plugin_ui_current_stack_session_agent_archive_install_requires_absent_plugin');
        }
        await installCurrentManagedStackSessionAgentArchiveThroughCli({ context, archivePath: packArchivePath });
        installed = true;
        return await generation();
      },
      disable: async () => {
        await runCurrentManagedStackSessionAgentCliLifecycleCommand({
          context,
          args: buildCurrentManagedStackSessionAgentPluginStateArgs('disable', pluginId),
          expectedKind: 'plugins_disable',
          expectedPluginId: pluginId,
        });
        return await generation();
      },
      enable: async () => {
        await runCurrentManagedStackSessionAgentCliLifecycleCommand({
          context,
          args: buildCurrentManagedStackSessionAgentPluginStateArgs('enable', pluginId),
          expectedKind: 'plugins_enable',
          expectedPluginId: pluginId,
        });
        return await generation();
      },
      reinstall: async () => {
        if (installed) await uninstallOnce();
        return await install();
      },
      uninstall: async () => {
        if (!installed) return;
        await uninstallOnce();
      },
      cleanup: async () => {
        if (installed) await uninstallOnce();
        else {
          await assertCurrentManagedStackSourcePluginAbsent({
            context,
            pluginId,
            postJson: params.postJson,
          });
        }
        if (sourceOutputRoot) {
          await rm(sourceOutputRoot, { recursive: true, force: true });
        }
        await rm(packOutputRoot, { recursive: true, force: true });
      },
    });
  } catch (error) {
    let cleanupError: unknown = null;
    if (installed) {
      try { await uninstallOnce(); } catch (candidate) { cleanupError = candidate; }
    }
    if (!cleanupError && sourceOutputRoot) {
      await rm(sourceOutputRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (!cleanupError) {
      await rm(packOutputRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Session Agent fixture preparation and retirement both failed; source retained at ${sourceRoot}`,
      );
    }
    throw error;
  }
}
