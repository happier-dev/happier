import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { daemonControlPostJson } from './daemon/controlServerClient';
import { createTestAuth, type TestAuth } from './auth';
import { seedCliDataKeyAuthForServer } from './cliAuth';
import { upsertEncryptedAccountSettingsV2 } from './accountSettings';
import { fetchSessionMetadataV2 } from './sessionHandoffMetadata';

import {
  accountSettingsParse,
  EXTERNAL_AGENT_OBSERVATION_METADATA_KEY,
  EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1,
  ExternalAgentObservationLinkKeyV1Schema,
  ExternalAgentObservationResourceKeyV1Schema,
  ExternalAgentObservationSnapshotV1Schema,
  type ExternalAgentObservationSnapshotV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

type ExternalSessionLiveFixtureTurnStatus = 'waiting' | 'working';

type ExternalSessionLiveLifecycleFollowerReadMarkerEvent = Readonly<{
  kind: 'follower_read';
  generation: string;
  // Optional only so marker files written by the earlier test fixture remain readable.
  daemonPid?: number;
  remoteSessionId?: string;
}>;

type ExternalSessionLiveLifecycleRefreshRequestMarkerEvent = Readonly<{
  kind: 'refresh_requested';
  generation: string;
  // Optional only so marker files written by the earlier test fixture remain readable.
  daemonPid?: number;
  linkKey?: string;
}>;

export type ExternalSessionLiveLifecycleObserverMarkerEvent = Readonly<{
  kind: 'observer_started' | 'observer_disposed';
  generation: string;
  // Optional only so marker files written by the earlier test fixture remain readable.
  daemonPid?: number;
  resourceKey?: string;
  requestedLinkKeys?: readonly string[];
  observerInstanceId?: string;
}>;

type ExternalSessionLiveLifecycleObservationMarkerEvent = Readonly<{
  kind: 'observation_emitted' | 'late_emission_attempted';
  generation: string;
  observedAtMs: number;
  status: ExternalSessionLiveFixtureTurnStatus;
}>;

type ExternalSessionLiveLifecycleReconcileMarkerEvent = Readonly<{
  kind: 'reconcile_requested';
  generation: string;
  purpose: 'observation_evidence' | 'resource_descriptors';
}>;

export type ExternalSessionLiveLifecycleMarkerEvent =
  | ExternalSessionLiveLifecycleFollowerReadMarkerEvent
  | ExternalSessionLiveLifecycleRefreshRequestMarkerEvent
  | ExternalSessionLiveLifecycleObserverMarkerEvent
  | ExternalSessionLiveLifecycleObservationMarkerEvent
  | ExternalSessionLiveLifecycleReconcileMarkerEvent;

export type ExternalSessionLiveLifecycleCounts = Readonly<{
  observersStarted: number;
  observersDisposed: number;
  followerReads: number;
  refreshRequests: number;
}>;

export type ExternalSessionLiveObserverLifecycleCounts = Readonly<{
  observersStarted: number;
  observersDisposed: number;
}>;

export type ExternalSessionLiveExpectedObservationIdentity = Readonly<{
  pluginId: string;
  agentId: string;
  sourceKind: string;
}>;

export type IsolatedExternalSessionLiveAccount = Readonly<{
  auth: TestAuth;
  machineKey: Uint8Array;
}>;

type MachineRpcCall = (
  method: string,
  params: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

type DaemonPluginPostJson = (params: Readonly<{
  port: number;
  path: string;
  body: Readonly<Record<string, unknown>>;
  timeoutMs: number;
  controlToken?: string | null;
}>) => Promise<Readonly<{ status: number; data: unknown }>>;

type RpcEnvelope = Readonly<{
  ok?: unknown;
  result?: unknown;
  error?: unknown;
  errorCode?: unknown;
}>;

type ExternalSessionActionResult = Readonly<{
  ok?: unknown;
  created?: unknown;
  enabled?: unknown;
  sessionId?: unknown;
  error?: unknown;
  errorCode?: unknown;
}>;

export function buildPreAttestedExternalSessionLiveEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
    HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
    ...overrides,
  };
}

export async function createTwoIsolatedExternalSessionLiveAccounts(
  serverBaseUrl: string,
): Promise<Readonly<{
  accountA: IsolatedExternalSessionLiveAccount;
  accountB: IsolatedExternalSessionLiveAccount;
}>> {
  const [authA, authB] = await Promise.all([
    createTestAuth(serverBaseUrl),
    createTestAuth(serverBaseUrl),
  ]);
  return {
    accountA: {
      auth: authA,
      machineKey: Uint8Array.from(randomBytes(32)),
    },
    accountB: {
      auth: authB,
      machineKey: Uint8Array.from(randomBytes(32)),
    },
  };
}

export async function seedExternalSessionLiveAccount(params: Readonly<{
  account: IsolatedExternalSessionLiveAccount;
  cliHome: string;
  serverUrl: string;
}>): Promise<Readonly<{ serverId: string; machineId: string }>> {
  return await seedCliDataKeyAuthForServer({
    cliHome: params.cliHome,
    serverUrl: params.serverUrl,
    token: params.account.auth.token,
    machineKey: params.account.machineKey,
  });
}

export async function enableExternalSessionPassiveRestoreForAccount(params: Readonly<{
  account: IsolatedExternalSessionLiveAccount;
  serverBaseUrl: string;
}>): Promise<number> {
  return await upsertEncryptedAccountSettingsV2({
    baseUrl: params.serverBaseUrl,
    token: params.account.auth.token,
    material: {
      type: 'dataKey',
      machineKey: params.account.machineKey,
    },
    settings: accountSettingsParse({
      externalSessionsSettingsV1: {
        v: 1,
        keepPassivelyFollowingAfterRestart: true,
      },
    }),
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function unwrapMachineRpcResult(
  value: unknown,
  context: string,
): ExternalSessionActionResult {
  const envelope = asRecord(value) as RpcEnvelope | null;
  if (!envelope || envelope.ok !== true) {
    throw new Error(
      `${context} RPC failed (${String(envelope?.errorCode ?? envelope?.error ?? 'unknown')})`,
    );
  }
  const result = asRecord(envelope.result) as ExternalSessionActionResult | null;
  if (!result) {
    throw new Error(`${context} RPC returned no result`);
  }
  return result;
}

export async function ensureLinkedPassiveExternalSession(params: Readonly<{
  machineId: string;
  agentId: string;
  remoteSessionId: string;
  source: Readonly<Record<string, unknown>>;
  titleHint?: string;
  directoryHint?: string;
  call: MachineRpcCall;
}>): Promise<Readonly<{ sessionId: string; created: boolean }>> {
  const route = (method: string): string => `${params.machineId}:${method}`;
  const linked = unwrapMachineRpcResult(
    await params.call(
      route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE),
      {
        machineId: params.machineId,
        agentId: params.agentId,
        providerId: params.agentId,
        remoteSessionId: params.remoteSessionId,
        source: params.source,
        ...(params.titleHint ? { titleHint: params.titleHint } : {}),
        ...(params.directoryHint ? { directoryHint: params.directoryHint } : {}),
      },
    ),
    'External Session link',
  );
  if (linked.ok !== true || typeof linked.sessionId !== 'string' || !linked.sessionId) {
    throw new Error(
      `External Session link failed (${String(linked.errorCode ?? linked.error ?? 'unknown')})`,
    );
  }

  const followed = unwrapMachineRpcResult(
    await params.call(
      route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET),
      {
        machineId: params.machineId,
        sessionId: linked.sessionId,
        agentId: params.agentId,
        providerId: params.agentId,
        remoteSessionId: params.remoteSessionId,
        source: params.source,
        enabled: true,
      },
    ),
    'External Session follow policy',
  );
  if (followed.ok !== true || followed.enabled !== true) {
    throw new Error(
      `External Session follow policy failed (${String(followed.errorCode ?? followed.error ?? 'unknown')})`,
    );
  }

  return {
    sessionId: linked.sessionId,
    created: linked.created === true,
  };
}

export function countExternalSessionLiveLifecycleEvents(params: Readonly<{
  markerEvents: readonly ExternalSessionLiveLifecycleMarkerEvent[];
}>): ExternalSessionLiveLifecycleCounts {
  const countMarker = (
    kind: ExternalSessionLiveLifecycleMarkerEvent['kind'],
  ): number => params.markerEvents.filter((event) => event.kind === kind).length;

  return {
    observersStarted: countMarker('observer_started'),
    observersDisposed: countMarker('observer_disposed'),
    followerReads: countMarker('follower_read'),
    refreshRequests: countMarker('refresh_requested'),
  };
}

export function countExternalSessionLiveObserverLifecycleEvents(
  params: Readonly<{
    markerEvents: readonly ExternalSessionLiveLifecycleMarkerEvent[];
    daemonPid?: number;
    resourceKey?: string;
    observerInstanceId?: string;
  }>,
): ExternalSessionLiveObserverLifecycleCounts {
  const observerEvents = params.markerEvents.filter(
    (event): event is ExternalSessionLiveLifecycleObserverMarkerEvent => (
      (event.kind === 'observer_started' || event.kind === 'observer_disposed')
      && (
        params.daemonPid === undefined
        || event.daemonPid === params.daemonPid
      )
      && (
        params.resourceKey === undefined
        || event.resourceKey === params.resourceKey
      )
      && (
        params.observerInstanceId === undefined
        || event.observerInstanceId === params.observerInstanceId
      )
    ),
  );
  return {
    observersStarted: observerEvents.filter(
      (event) => event.kind === 'observer_started',
    ).length,
    observersDisposed: observerEvents.filter(
      (event) => event.kind === 'observer_disposed',
    ).length,
  };
}

function haveSameExternalSessionLiveRequestedLinkKeys(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((linkKey, index) => linkKey === right[index]);
}

export function findUnmatchedExternalSessionLiveObserverStarts(
  params: Readonly<{
    markerEvents: readonly ExternalSessionLiveLifecycleMarkerEvent[];
    daemonPid: number;
    resourceKey: string;
    requestedLinkKey?: string;
  }>,
): ExternalSessionLiveLifecycleObserverMarkerEvent[] {
  const openStarts = new Map<
    string,
    ExternalSessionLiveLifecycleObserverMarkerEvent
  >();
  for (const event of params.markerEvents) {
    if (
      (event.kind !== 'observer_started' && event.kind !== 'observer_disposed')
      || event.daemonPid !== params.daemonPid
      || event.resourceKey !== params.resourceKey
      || typeof event.observerInstanceId !== 'string'
      || !event.requestedLinkKeys
      || (
        params.requestedLinkKey !== undefined
        && !event.requestedLinkKeys.includes(params.requestedLinkKey)
      )
    ) {
      continue;
    }
    if (event.kind === 'observer_started') {
      openStarts.set(event.observerInstanceId, event);
      continue;
    }
    const started = openStarts.get(event.observerInstanceId);
    if (
      started?.requestedLinkKeys
      && haveSameExternalSessionLiveRequestedLinkKeys(
        started.requestedLinkKeys,
        event.requestedLinkKeys,
      )
    ) {
      openStarts.delete(event.observerInstanceId);
    }
  }
  return [...openStarts.values()];
}

export function hasUnmatchedExternalSessionLiveObserverStarts(
  params: Parameters<
    typeof findUnmatchedExternalSessionLiveObserverStarts
  >[0],
): boolean {
  return findUnmatchedExternalSessionLiveObserverStarts(params).length > 0;
}

export function countExternalSessionLiveFollowerReadEvents(
  params: Readonly<{
    markerEvents: readonly ExternalSessionLiveLifecycleMarkerEvent[];
    daemonPid?: number;
    remoteSessionId?: string;
  }>,
): number {
  return params.markerEvents.filter(
    (event): event is ExternalSessionLiveLifecycleFollowerReadMarkerEvent => (
      event.kind === 'follower_read'
      && (
        params.daemonPid === undefined
        || event.daemonPid === params.daemonPid
      )
      && (
        params.remoteSessionId === undefined
        || event.remoteSessionId === params.remoteSessionId
      )
    ),
  ).length;
}

export function countExternalSessionLiveRefreshRequestEvents(
  params: Readonly<{
    markerEvents: readonly ExternalSessionLiveLifecycleMarkerEvent[];
    daemonPid?: number;
    linkKey?: string;
  }>,
): number {
  return params.markerEvents.filter(
    (event): event is ExternalSessionLiveLifecycleRefreshRequestMarkerEvent => (
      event.kind === 'refresh_requested'
      && (
        params.daemonPid === undefined
        || event.daemonPid === params.daemonPid
      )
      && (
        params.linkKey === undefined
        || event.linkKey === params.linkKey
      )
    ),
  ).length;
}

export function hasExpectedAdvancedExternalSessionLivePulseEvidence(
  params: Readonly<{
    markerEvents: readonly ExternalSessionLiveLifecycleMarkerEvent[];
    generation: string;
    minimumCounts: Readonly<{
      observersStarted: number;
      followerReads: number;
      refreshRequests: number;
    }>;
    expectedIdentity: ExternalSessionLiveExpectedObservationIdentity;
    expectedStatus: ExternalSessionLiveFixtureTurnStatus;
    before: ExternalAgentObservationSnapshotV1;
    after: ExternalAgentObservationSnapshotV1 | null;
  }>,
): boolean {
  const counts = countExternalSessionLiveLifecycleEvents({
    markerEvents: params.markerEvents.filter(
      (event) => event.generation === params.generation,
    ),
  });
  const { before, after, expectedIdentity } = params;
  const exactObservationEmission = params.markerEvents.some(
    (event) => event.kind === 'observation_emitted'
      && event.generation === params.generation
      && event.status === params.expectedStatus
      && event.observedAtMs === after?.observedAtMs,
  );
  return counts.observersStarted >= params.minimumCounts.observersStarted
    && counts.followerReads >= params.minimumCounts.followerReads
    && counts.refreshRequests >= params.minimumCounts.refreshRequests
    && exactObservationEmission
    && after?.status === params.expectedStatus
    && after.qualifiedLinkIdentity.agent.pluginId === expectedIdentity.pluginId
    && after.qualifiedLinkIdentity.agent.localId === expectedIdentity.agentId
    && after.qualifiedLinkIdentity.source.kind === expectedIdentity.sourceKind
    && after.linkGeneration === before.linkGeneration
    && JSON.stringify(after.qualifiedLinkIdentity)
      === JSON.stringify(before.qualifiedLinkIdentity)
    && typeof before.observedAtMs === 'number'
    && typeof after.observedAtMs === 'number'
    && after.observedAtMs > before.observedAtMs;
}

export function readExternalSessionLiveObservationSnapshotFromMetadata(
  metadata: Readonly<Record<string, unknown>>,
): ExternalAgentObservationSnapshotV1 | null {
  const parsed = ExternalAgentObservationSnapshotV1Schema.safeParse(
    metadata[EXTERNAL_AGENT_OBSERVATION_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}

export async function readExternalSessionLiveObservationSnapshot(params: Readonly<{
  serverBaseUrl: string;
  token: string;
  sessionId: string;
  machineKey: Uint8Array;
}>): Promise<ExternalAgentObservationSnapshotV1 | null> {
  const metadata = await fetchSessionMetadataV2({
    baseUrl: params.serverBaseUrl,
    token: params.token,
    sessionId: params.sessionId,
    machineKeys: [params.machineKey],
  });
  return readExternalSessionLiveObservationSnapshotFromMetadata(metadata);
}

function requireCommittedPluginChange(
  response: Readonly<{ status: number; data: unknown }>,
  context: string,
): Readonly<Record<string, unknown>> {
  const data = asRecord(response.data);
  if (response.status !== 200 || data?.kind !== 'committed') {
    throw new Error(
      `${context} did not commit (`
      + `status=${response.status}, `
      + `kind=${String(data?.kind ?? 'unknown')}, `
      + `code=${String(data?.code ?? 'unknown')}, `
      + `message=${String(data?.message ?? 'unknown')}`
      + ')',
    );
  }
  return data;
}

export async function applyTrustedLocalPluginFixture(params: Readonly<{
  daemonPort: number;
  controlToken?: string | null;
  pluginRoot: string;
  pluginId: string;
  interactionId: string;
  postJson?: DaemonPluginPostJson;
}>): Promise<Readonly<Record<string, unknown>>> {
  const postJson = params.postJson ?? daemonControlPostJson;
  const requested = await postJson({
    port: params.daemonPort,
    path: '/plugins/change/request',
    controlToken: params.controlToken,
    timeoutMs: 300_000,
    body: {
      kind: 'installPath',
      locator: params.pluginRoot,
      development: true,
    },
  });
  const requestData = asRecord(requested.data);
  if (requested.status !== 200 || !requestData) {
    throw new Error(`Local plugin installation request failed (status=${requested.status})`);
  }
  if (requestData.kind === 'committed') {
    return requestData;
  }
  if (
    requestData.kind !== 'reviewRequired'
    || typeof requestData.pendingChangeId !== 'string'
    || !requestData.pendingChangeId
  ) {
    throw new Error(
      `Local plugin installation did not reach review (kind=${String(requestData.kind ?? 'unknown')}, code=${String(requestData.code ?? 'unknown')}, message=${String(requestData.message ?? 'unknown')})`,
    );
  }

  return requireCommittedPluginChange(
    await postJson({
      port: params.daemonPort,
      path: '/plugins/change/decide',
      controlToken: params.controlToken,
      timeoutMs: 300_000,
      body: {
        pendingChangeId: requestData.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: params.interactionId,
          occurredAtMs: Date.now(),
        },
        optionalSelections: [],
      },
    }),
    'Local plugin installation decision',
  );
}

export async function reloadTrustedLocalPluginFixture(params: Readonly<{
  daemonPort: number;
  controlToken?: string | null;
  pluginRoot: string;
  pluginId: string;
  changedPaths?: readonly string[];
  postJson?: DaemonPluginPostJson;
}>): Promise<Readonly<Record<string, unknown>>> {
  const postJson = params.postJson ?? daemonControlPostJson;
  return requireCommittedPluginChange(
    await postJson({
      port: params.daemonPort,
      path: '/plugins/change/request',
      controlToken: params.controlToken,
      timeoutMs: 300_000,
      body: {
        kind: 'development',
        pluginId: params.pluginId,
        sourceRootPath: params.pluginRoot,
        ...(params.changedPaths ? { changedPaths: [...params.changedPaths] } : {}),
      },
    }),
    'Local plugin development reload',
  );
}

export async function writeInstrumentedExternalSessionLivePlugin(
  params: Readonly<{
    pluginRoot: string;
    pluginId: string;
    agentId: string;
    generation: string;
    observationStatus: ExternalSessionLiveFixtureTurnStatus;
    markerPath: string;
    transcriptStatePath?: string;
    transcriptText?: string;
  }>,
): Promise<void> {
  await mkdir(join(params.pluginRoot, '.happier-plugin'), { recursive: true });
  const manifest = {
    schemaVersion: 2,
    id: params.pluginId,
    version: '1.0.0',
    displayName: 'External Session live lifecycle fixture',
    description: 'Test-only Agent observation and transcript-follow fixture.',
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './daemon.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    hostAccess: { required: [], optional: [] },
    contributes: {
      actions: [{
        id: 'pulse',
        title: 'Emit External Session lifecycle evidence',
        scopes: ['global'],
        surfaces: ['cli'],
        placement: 'commandPalette',
        dangerLevel: 'safe',
      }],
      agents: [{
        id: params.agentId,
        title: 'External Session live fixture Agent',
        capabilities: { surfaces: ['externalSessions'] },
        surfaces: {
          externalSession: {
            externalLinkedTakeover: { writerSafety: 'unsupported' },
            sources: [{
              sourceKind: 'fixtureLive',
              schema: {
                passthrough: false,
                fields: [{
                  name: 'kind',
                  kind: 'literal',
                  value: 'fixtureLive',
                }],
              },
              key: {
                segments: [{
                  kind: 'literal',
                  value: 'fixtureLive',
                }],
              },
              instances: [{
                kind: 'default',
                constants: {},
              }],
            }],
          },
        },
      }],
    },
  };
  await writeFile(
    join(params.pluginRoot, '.happier-plugin', 'plugin.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(params.pluginRoot, 'package.json'),
    `${JSON.stringify({
      name: params.pluginId,
      version: '1.0.0',
      private: true,
      type: 'module',
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(params.pluginRoot, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '  excludeLinksFromLockfile: false',
      '',
      'importers:',
      '',
      '  .: {}',
      '',
    ].join('\n'),
    'utf8',
  );

  const quoted = (value: string): string => JSON.stringify(value);
  const daemonModule = [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    '',
    `const markerPath = ${quoted(params.markerPath)};`,
    `const generation = ${quoted(params.generation)};`,
    `const observationStatus = ${quoted(params.observationStatus)};`,
    `const transcriptStatePath = ${
      params.transcriptStatePath ? quoted(params.transcriptStatePath) : 'null'
    };`,
    `const transcriptText = ${quoted(
      params.transcriptText ?? 'fixture live transcript delta',
    )};`,
    'const resourceKey = "fixture-live-resource";',
    `const lifecycleKey = Symbol.for(${quoted(
      `happier.tests.external-session-live:${params.pluginId}:${params.agentId}`,
    )});`,
    'const lifecycle = globalThis[lifecycleKey] ??= { retiredEmitters: [] };',
    'lifecycle.nextObserverInstanceOrdinal ??= 0;',
    'const linkKeysByResourceKey = new Map();',
    'let currentObserver = null;',
    'let mostRecentLinkKey = null;',
    'const mark = (kind, details = {}) => appendFileSync(',
    '  markerPath,',
    '  JSON.stringify({ kind, generation, ...details }) + "\\n",',
    '  "utf8",',
    ');',
    'const readTranscriptState = () => {',
    '  if (!transcriptStatePath) return null;',
    '  try {',
    '    const parsed = JSON.parse(readFileSync(transcriptStatePath, "utf8"));',
    '    return Number.isInteger(parsed?.version) && parsed.version >= 0',
    '      ? { version: parsed.version }',
    '      : { version: 0 };',
    '  } catch {',
    '    return { version: 0 };',
    '  }',
    '};',
    'const transcriptTailCursor = (version) => "fixture-live-tail-" + version;',
    'const groupingFor = (request) => {',
    '  const linkKey = "fixture-live-link:" + request.remoteSessionId;',
    '  const linkKeys = linkKeysByResourceKey.get(resourceKey) ?? new Set();',
    '  if (linkKeys.size < 256) linkKeys.add(linkKey);',
    '  linkKeysByResourceKey.set(resourceKey, linkKeys);',
    '  mostRecentLinkKey = linkKey;',
    '  return { resourceKey, linkKey };',
    '};',
    'const descriptorFor = (request) => ({',
    '  ...groupingFor(request),',
    '  changeObservation: "observe_resource",',
    '});',
    'const emitObservation = (request, linkKey, status, markerKind = "observation_emitted", observedAtOffsetMs = 0) => {',
    '  const observedAtMs = Date.now() + observedAtOffsetMs;',
    '  const fact = {',
    '    kind: "turn_phase",',
    '    evidenceClass: "agent_native",',
    '    observedAtMs,',
    '    expiresAtMs: observedAtMs + 30_000,',
    '    value: status,',
    '  };',
    '  mark(markerKind, { observedAtMs, status });',
    '  request.emit({ items: [{ linkKey, facts: [fact] }] });',
    '};',
    'const observationFact = () => {',
    '  const observedAtMs = Date.now();',
    '  return {',
    '    kind: "turn_phase",',
    '    evidenceClass: "agent_native",',
    '    observedAtMs,',
    '    expiresAtMs: observedAtMs + 30_000,',
    '    value: observationStatus,',
    '  };',
    '};',
    '',
    'export function activate(api) {',
    `  api.agents.registerExternalSessions(${quoted(params.agentId)}, {`,
    '    async resolveSource({ source }) {',
    '      return { ok: true, value: { source } };',
    '    },',
    '    async listCandidates() {',
    '      return { ok: true, value: {',
    '        candidates: [{ remoteSessionId: "fixture-live-remote", updatedAtMs: Date.now() }],',
    '        nextCursor: null,',
    '      } };',
    '    },',
    '    async resolveLinkIdentity({ source, remoteSessionId }) {',
    '      return { ok: true, value: { source, remoteSessionId, linkData: {} } };',
    '    },',
    '    async resolveLinkedIdentity({ source, remoteSessionId, linkData }) {',
    '      return { ok: true, value: { source, remoteSessionId, linkData } };',
    '    },',
    '    async pageTranscript() {',
    '      const transcriptState = readTranscriptState();',
    '      return { ok: true, value: {',
    '        items: [],',
    '        nextCursor: null,',
    '        tailCursor: transcriptState',
    '          ? transcriptTailCursor(transcriptState.version)',
    '          : "fixture-live-tail",',
    '        hasMore: false,',
    '      } };',
    '    },',
    '    async readAfterTranscript({ cursor, remoteSessionId }) {',
    '      mark("follower_read", { daemonPid: process.pid, remoteSessionId });',
    '      const transcriptState = readTranscriptState();',
    '      if (!transcriptState) {',
    '        return { ok: true, value: { outcome: "already_current" } };',
    '      }',
    '      const currentCursor = transcriptTailCursor(transcriptState.version);',
    '      if (cursor === currentCursor) {',
    '        return { ok: true, value: { outcome: "already_current" } };',
    '      }',
    '      const cursorMatch = /^fixture-live-tail-(\\d+)$/.exec(cursor);',
    '      const cursorVersion = cursorMatch ? Number(cursorMatch[1]) : -1;',
    '      if (cursorVersion + 1 !== transcriptState.version) {',
    '        return { ok: true, value: { outcome: "gap_or_cursor_expired" } };',
    '      }',
    '      return { ok: true, value: {',
    '        outcome: "advanced",',
    '        items: [{',
    '          id: "fixture-live-message-" + transcriptState.version,',
    '          createdAtMs: 1_700_000_000_000 + transcriptState.version,',
    '          raw: {',
    '            role: "assistant",',
    '            content: { type: "text", text: transcriptText },',
    '          },',
    '        }],',
    '        nextCursor: currentCursor,',
    '        boundary: "fixture-live-boundary-" + transcriptState.version,',
    '      } };',
    '    },',
    '  });',
    `  api.agents.registerExternalSessionObservation(${quoted(params.agentId)}, {`,
    '    describeResource(request) {',
    '      return groupingFor(request);',
    '    },',
    '    observeResource(request) {',
    '      lifecycle.nextObserverInstanceOrdinal += 1;',
    '      const observerInstanceId = process.pid + ":" + lifecycle.nextObserverInstanceOrdinal;',
    '      const observerMarkerDetails = {',
    '        daemonPid: process.pid,',
    '        resourceKey: request.resourceKey,',
    '        requestedLinkKeys: [...(linkKeysByResourceKey.get(request.resourceKey) ?? [])]',
    '          .sort()',
    '          .slice(0, 256),',
    '        observerInstanceId,',
    '      };',
    '      mark("observer_started", observerMarkerDetails);',
    '      let disposed = false;',
    '      currentObserver = request;',
    '      if (mostRecentLinkKey) {',
    '        emitObservation(request, mostRecentLinkKey, observationStatus);',
    '      }',
    '      return {',
    '        dispose() {',
    '          if (disposed) return;',
    '          disposed = true;',
    '          if (currentObserver === request) currentObserver = null;',
    '          const retiredLinkKey = mostRecentLinkKey;',
    '          if (retiredLinkKey) {',
    '            lifecycle.retiredEmitters.push(() => {',
    '              emitObservation(',
    '                request,',
    '                retiredLinkKey,',
    '                observationStatus,',
    '                "late_emission_attempted",',
    '                60_000,',
    '              );',
    '            });',
    '          }',
    '          mark("observer_disposed", observerMarkerDetails);',
    '        },',
    '      };',
    '    },',
    '    async reconcileResource(request) {',
    '      mark("reconcile_requested", { purpose: request.purpose });',
    '      if (request.purpose === "resource_descriptors") {',
    '        return {',
    '          purpose: request.purpose,',
    '          outcomes: request.links.map((link) => ({',
    '            kind: "described",',
    '            descriptor: descriptorFor(link.linkedSource),',
    '          })),',
    '        };',
    '      }',
    '      return {',
    '        purpose: request.purpose,',
    '        outcomes: request.links.map(({ linkKey }) => ({',
    '          linkKey,',
    '          facts: [observationFact()],',
    '        })),',
    '      };',
    '    },',
    '  });',
    "  api.actions.register('pulse', async (input) => {",
    '    if (!currentObserver || !mostRecentLinkKey) {',
    '      return { available: false, generation };',
    '    }',
    '    if (input?.refresh === true) {',
    '      mark("refresh_requested", {',
    '        daemonPid: process.pid,',
    '        linkKey: mostRecentLinkKey,',
    '      });',
    '      currentObserver.requestTranscriptRefresh(mostRecentLinkKey);',
    '    }',
    '    if (input?.emit !== false) {',
    '      emitObservation(currentObserver, mostRecentLinkKey, observationStatus);',
    '    }',
    '    if (input?.emitRetired === true) {',
    '      for (const emitRetired of lifecycle.retiredEmitters.splice(0)) {',
    '        emitRetired();',
    '      }',
    '    }',
    '    return { available: true, generation };',
    '  });',
    '  return () => {',
    '    currentObserver = null;',
    '  };',
    '}',
    '',
  ].join('\n');
  await writeFile(join(params.pluginRoot, 'daemon.mjs'), daemonModule, 'utf8');
}

export async function readExternalSessionLiveLifecycleMarkerEvents(
  markerPath: string,
): Promise<ExternalSessionLiveLifecycleMarkerEvent[]> {
  let contents: string;
  try {
    contents = await readFile(markerPath, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const parsed = asRecord(JSON.parse(line) as unknown);
      if (!parsed || typeof parsed.generation !== 'string') {
        throw new Error(`Invalid External Session lifecycle marker at line ${index + 1}`);
      }
      if (
        parsed.kind === 'observer_started'
        || parsed.kind === 'observer_disposed'
      ) {
        const hasLegacyCorrelationShape =
          parsed.daemonPid === undefined
          && parsed.resourceKey === undefined
          && parsed.requestedLinkKeys === undefined
          && parsed.observerInstanceId === undefined;
        const parsedResourceKey =
          ExternalAgentObservationResourceKeyV1Schema.safeParse(parsed.resourceKey);
        const parsedRequestedLinkKeys = Array.isArray(parsed.requestedLinkKeys)
          && parsed.requestedLinkKeys.length
            <= EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1
          ? parsed.requestedLinkKeys.map(
              (linkKey) => ExternalAgentObservationLinkKeyV1Schema.safeParse(linkKey),
            )
          : null;
        const hasValidRequestedLinkKeys =
          parsedRequestedLinkKeys !== null
          && parsedRequestedLinkKeys.every((linkKey) => linkKey.success)
          && new Set(
            parsedRequestedLinkKeys.map((linkKey) => (
              linkKey.success ? linkKey.data : ''
            )),
          ).size === parsedRequestedLinkKeys.length;
        const hasValidObserverInstanceId =
          typeof parsed.observerInstanceId === 'string'
          && parsed.observerInstanceId === parsed.observerInstanceId.trim()
          && parsed.observerInstanceId.length > 0
          && parsed.observerInstanceId.length <= 128;
        const hasCurrentCorrelationShape =
          Number.isSafeInteger(parsed.daemonPid)
          && Number(parsed.daemonPid) > 0
          && parsedResourceKey.success
          && hasValidRequestedLinkKeys
          && hasValidObserverInstanceId;
        if (!hasLegacyCorrelationShape && !hasCurrentCorrelationShape) {
          throw new Error(
            `Invalid External Session lifecycle marker at line ${index + 1}`,
          );
        }
        return {
          kind: parsed.kind,
          generation: parsed.generation,
          ...(hasCurrentCorrelationShape
            ? {
                daemonPid: Number(parsed.daemonPid),
                resourceKey: parsedResourceKey.data,
                requestedLinkKeys: parsedRequestedLinkKeys?.map(
                  (linkKey) => linkKey.success ? linkKey.data : '',
                ),
                observerInstanceId: String(parsed.observerInstanceId),
              }
            : {}),
        };
      }
      if (parsed.kind === 'follower_read') {
        const hasLegacyCorrelationShape =
          parsed.daemonPid === undefined
          && parsed.remoteSessionId === undefined;
        const hasCurrentCorrelationShape =
          Number.isSafeInteger(parsed.daemonPid)
          && Number(parsed.daemonPid) > 0
          && typeof parsed.remoteSessionId === 'string'
          && parsed.remoteSessionId === parsed.remoteSessionId.trim()
          && parsed.remoteSessionId.length > 0
          && parsed.remoteSessionId.length <= 2_000;
        if (!hasLegacyCorrelationShape && !hasCurrentCorrelationShape) {
          throw new Error(
            `Invalid External Session lifecycle marker at line ${index + 1}`,
          );
        }
        return {
          kind: parsed.kind,
          generation: parsed.generation,
          ...(hasCurrentCorrelationShape
            ? {
                daemonPid: Number(parsed.daemonPid),
                remoteSessionId: String(parsed.remoteSessionId),
              }
            : {}),
        };
      }
      if (parsed.kind === 'refresh_requested') {
        const hasLegacyCorrelationShape =
          parsed.daemonPid === undefined && parsed.linkKey === undefined;
        const parsedLinkKey =
          ExternalAgentObservationLinkKeyV1Schema.safeParse(parsed.linkKey);
        const hasCurrentCorrelationShape =
          Number.isSafeInteger(parsed.daemonPid)
          && Number(parsed.daemonPid) > 0
          && parsedLinkKey.success;
        if (!hasLegacyCorrelationShape && !hasCurrentCorrelationShape) {
          throw new Error(
            `Invalid External Session lifecycle marker at line ${index + 1}`,
          );
        }
        return {
          kind: parsed.kind,
          generation: parsed.generation,
          ...(hasCurrentCorrelationShape
            ? {
                daemonPid: Number(parsed.daemonPid),
                linkKey: parsedLinkKey.data,
              }
            : {}),
        };
      }
      if (
        ['observation_emitted', 'late_emission_attempted'].includes(String(parsed.kind))
        && typeof parsed.observedAtMs === 'number'
        && (parsed.status === 'waiting' || parsed.status === 'working')
      ) {
        return {
          kind: parsed.kind,
          generation: parsed.generation,
          observedAtMs: parsed.observedAtMs,
          status: parsed.status,
        } as ExternalSessionLiveLifecycleObservationMarkerEvent;
      }
      if (
        parsed.kind === 'reconcile_requested'
        && (
          parsed.purpose === 'observation_evidence'
          || parsed.purpose === 'resource_descriptors'
        )
      ) {
        return {
          kind: parsed.kind,
          generation: parsed.generation,
          purpose: parsed.purpose,
        };
      }
      throw new Error(`Invalid External Session lifecycle marker at line ${index + 1}`);
    });
}
