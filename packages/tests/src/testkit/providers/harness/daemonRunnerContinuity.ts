import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { daemonControlPostJson } from '../../daemon/controlServerClient';
import {
  replaceTestDaemonWithoutStoppingSessions,
  type DaemonState,
  type StartedDaemon,
} from '../../daemon/daemon';
import { decryptLegacyBase64 } from '../../messageCrypto';
import { isProcessAlive } from '../../process/processTree';
import type { CliTestLaunchSpec } from '../../process/cliLaunchSpec';
import { fetchAllMessages, fetchSessionV2 } from '../../sessions';
import { waitFor } from '../../timing';
import {
  sanitizeDaemonRunnerContinuityManifestEvidence,
  sanitizeRetainedPluginLifecycleManifestEvidence,
  type DaemonRunnerLaunchEntrypointKind,
  type DaemonRunnerContinuityManifestEvidence,
  type DaemonRunnerRuntimeIdentityKind,
  type RetainedPluginLifecycleManifestEvidence,
} from '../../manifest';
import type { RetainedPluginLifecycleObservations } from '../types';
import {
  enqueueSessionPromptForScenario,
  extractAssistantCandidateTextsFromDecryptedRecord,
  waitForAssistantMessageContaining,
} from '../scenarios/sessionRuntime';
import { normalizeDecodedTranscriptValue } from '../normalizeDecodedTranscriptValue';
import { readCompletedTurnId } from './harnessSignals';

type RetainedAgentFactoryBinding = Readonly<{
  v: 1;
  pluginId: string;
  pluginVersion: string;
  agentId: string;
  localAgentId: string;
  immutableGenerationId: string;
  locator: Readonly<{
    module: string;
    export: string;
    runtimeApiVersion: 1;
    externalSessionsExport?: string;
  }>;
  normalizedModulePath: string;
  loadMode: 'immutable-js' | 'source-ts';
}>;

type RetainedDeclarativeAcpAgentBinding = Readonly<{
  kind: 'host_declarative_acp_v1';
  v: 1;
  pluginId: string;
  pluginVersion: string;
  agentId: string;
  qualifiedAgentId: string;
  localAgentId: string;
  immutableGenerationId: string;
}>;

type RetainedAgentBinding =
  | RetainedAgentFactoryBinding
  | RetainedDeclarativeAcpAgentBinding;

export type RunnerDaemonServiceAuthority = Readonly<{
  path: string;
  sessionId: string;
  runner: Readonly<{
    pid: number;
    processStartTimeMs: number;
    processCommandHash: string;
    snapshotIdentity: string;
  }>;
  pluginHardRevocationRevision: number;
  retainedAgent: RetainedAgentBinding;
  httpPort: number;
  capability: string;
}>;

export type DaemonServiceProbe = Readonly<{
  status: number | 'connection_failed';
  ok: boolean | null;
  errorCode: string | null;
  resultKind: string | null;
  resultStatus: string | null;
}>;

type ContinuityPhase = Readonly<{
  id: 'b' | 'c';
  prompt: string;
  requiredAssistantSubstring: string;
  effect: Readonly<{
    path: string;
    marker: string;
  }>;
}>;

type UnderlyingAgentIdentityObservation = Readonly<{
  childProcessIdentity: unknown | null;
  vendorSessionId: string | null;
}>;

type ContinuityDeps = Readonly<{
  readTrackedRunnerPid: (params: Readonly<{ daemon: DaemonState; sessionId: string }>) => Promise<number>;
  waitForAuthority: (params: Readonly<{
    daemon: DaemonState;
    happyHomeDir: string;
    sessionId: string;
  }>) => Promise<RunnerDaemonServiceAuthority>;
  probeAuthority: (authority: RunnerDaemonServiceAuthority) => Promise<DaemonServiceProbe>;
  replaceDaemon: (params: Readonly<{
    previousDaemon: DaemonState;
    originalDaemon?: StartedDaemon;
    testDir: string;
    happyHomeDir: string;
    env: NodeJS.ProcessEnv;
    phase: 'b' | 'c';
    cliLaunchSpec?: CliTestLaunchSpec;
  }>) => Promise<StartedDaemon>;
  isProcessAlive: (pid: number) => boolean;
  enqueuePrompt: (params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    secret: Uint8Array;
    text: string;
  }>) => Promise<void>;
  waitForActiveTurn: (params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    previousTurnId: string;
    timeoutMs: number;
  }>) => Promise<string>;
  waitForMatchingEffect: (params: Readonly<{
    path: string;
    marker: string;
    timeoutMs: number;
  }>) => Promise<void>;
  waitForMatchingAssistantTranscriptOutput: (params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    secret: Uint8Array;
    requiredSubstring: string;
    timeoutMs: number;
  }>) => Promise<void>;
  countMatchingAssistantTranscriptOutputs: (params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    secret: Uint8Array;
    requiredSubstring: string;
  }>) => Promise<number>;
  countMatchingEffects: (params: Readonly<{
    path: string;
    marker: string;
  }>) => Promise<number>;
  countTerminalEvents: (params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    secret: Uint8Array;
    turnId: string;
  }>) => Promise<number>;
  observeUnderlyingAgentIdentity: (params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    secret: Uint8Array;
    runnerPid: number;
    vendorSessionMetadataKey?: string;
    observeAgentChildProcess?: (params: Readonly<{ runnerPid: number }>) => Promise<Readonly<{
      pid: number;
      processStartTimeMs?: number;
      processCommandHash?: string;
    }> | null>;
  }>) => Promise<UnderlyingAgentIdentityObservation>;
  waitForNextCompletedTurn: (params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    previousTurnId: string | null;
    timeoutMs: number;
  }>) => Promise<string>;
}>;

export type DaemonRunnerContinuityEvidence = DaemonRunnerContinuityManifestEvidence;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function capabilityFingerprint(capability: string): string {
  return fingerprintValue({ kind: 'daemon_service_capability', value: capability });
}

function fingerprintValue(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

export function classifyRunnerRuntimeIdentity(
  snapshotIdentity: string,
): DaemonRunnerRuntimeIdentityKind {
  if (snapshotIdentity.startsWith('path:')) return 'mutable_runtime';
  if (snapshotIdentity.startsWith('snapshot:')) return 'immutable_snapshot';
  if (snapshotIdentity.startsWith('version:')) return 'versioned_runtime';
  return 'unclassified';
}

function requireExactObservationKeys(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid retained plugin lifecycle observations: ${field}`);
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`Invalid retained plugin lifecycle observations: ${field}`);
  }
}

function requireGenerationObservation(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`Invalid retained plugin lifecycle observations: ${field}`);
  }
  return value;
}

export function projectRetainedPluginLifecycleEvidence(
  observations: RetainedPluginLifecycleObservations,
): RetainedPluginLifecycleManifestEvidence {
  requireExactObservationKeys(observations, ['agent', 'provider'], 'root');
  requireExactObservationKeys(
    observations.agent,
    ['generations', 'retainedLaterTurn', 'newSessionFirstTurn'],
    'agent',
  );
  requireExactObservationKeys(observations.agent.generations, [
    'retainedSessionBeforeUpdate',
    'retainedSessionAfterUpdate',
    'newSessionAfterUpdate',
  ], 'agent.generations');
  requireExactObservationKeys(
    observations.provider,
    ['generations', 'retainedHandleUse', 'newClaim'],
    'provider',
  );
  requireExactObservationKeys(observations.provider.generations, [
    'retainedHandleBeforeUpdate',
    'retainedHandleAfterUpdate',
    'newClaimAfterUpdate',
  ], 'provider.generations');

  const agentGenerations = {
    retainedSessionBeforeUpdate: requireGenerationObservation(
      observations.agent.generations.retainedSessionBeforeUpdate,
      'agent.generations.retainedSessionBeforeUpdate',
    ),
    retainedSessionAfterUpdate: requireGenerationObservation(
      observations.agent.generations.retainedSessionAfterUpdate,
      'agent.generations.retainedSessionAfterUpdate',
    ),
    newSessionAfterUpdate: requireGenerationObservation(
      observations.agent.generations.newSessionAfterUpdate,
      'agent.generations.newSessionAfterUpdate',
    ),
  };
  const providerGenerations = {
    retainedHandleBeforeUpdate: requireGenerationObservation(
      observations.provider.generations.retainedHandleBeforeUpdate,
      'provider.generations.retainedHandleBeforeUpdate',
    ),
    retainedHandleAfterUpdate: requireGenerationObservation(
      observations.provider.generations.retainedHandleAfterUpdate,
      'provider.generations.retainedHandleAfterUpdate',
    ),
    newClaimAfterUpdate: requireGenerationObservation(
      observations.provider.generations.newClaimAfterUpdate,
      'provider.generations.newClaimAfterUpdate',
    ),
  };
  if (
    observations.agent.retainedLaterTurn !== 'completed'
    || observations.agent.newSessionFirstTurn !== 'completed'
    || agentGenerations.retainedSessionBeforeUpdate !== agentGenerations.retainedSessionAfterUpdate
    || agentGenerations.retainedSessionBeforeUpdate === agentGenerations.newSessionAfterUpdate
    || observations.provider.retainedHandleUse !== 'continued'
    || observations.provider.newClaim !== 'admitted'
    || providerGenerations.retainedHandleBeforeUpdate !== providerGenerations.retainedHandleAfterUpdate
    || providerGenerations.retainedHandleBeforeUpdate === providerGenerations.newClaimAfterUpdate
  ) {
    throw new Error('Invalid distinct retained plugin lifecycle generation evidence');
  }

  return sanitizeRetainedPluginLifecycleManifestEvidence({
    agent: {
      generations: {
        retainedSessionBeforeUpdate: agentGenerations.retainedSessionBeforeUpdate,
        retainedSessionAfterUpdate: agentGenerations.retainedSessionAfterUpdate,
        newSessionAfterUpdate: agentGenerations.newSessionAfterUpdate,
      },
      distinctGenerationCount: 2,
      retainedLaterTurn: 'completed',
      newSessionFirstTurn: 'completed',
    },
    provider: {
      generations: {
        retainedHandleBeforeUpdate: providerGenerations.retainedHandleBeforeUpdate,
        retainedHandleAfterUpdate: providerGenerations.retainedHandleAfterUpdate,
        newClaimAfterUpdate: providerGenerations.newClaimAfterUpdate,
      },
      distinctGenerationCount: 2,
      retainedHandleUse: 'continued',
      newClaim: 'admitted',
    },
  });
}

function fingerprintSessionScopedValue(
  kind:
    | 'daemon'
    | 'runtime_entrypoint'
    | 'runner_identity'
    | 'runner_process_command_hash'
    | 'logical_session'
    | 'retained_agent_binding'
    | 'agent_child_process'
    | 'vendor_session'
    | 'completed_turn',
  sessionId: string,
  value: unknown,
): string {
  return fingerprintValue({ kind, sessionId, value });
}

function distinctValueCount(values: Readonly<Record<'a' | 'b' | 'c', string>>): number {
  return new Set(Object.values(values)).size;
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value);
}

function parseRetainedAgentBinding(value: unknown): RetainedAgentBinding | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'host_declarative_acp_v1') {
    if (
      !hasExactKeys(value, [
        'kind',
        'v',
        'pluginId',
        'pluginVersion',
        'agentId',
        'qualifiedAgentId',
        'localAgentId',
        'immutableGenerationId',
      ])
      || value.v !== 1
      || !isBoundedNonEmptyString(value.pluginId, 256)
      || !isBoundedNonEmptyString(value.pluginVersion, 256)
      || !isBoundedNonEmptyString(value.agentId, 512)
      || !isBoundedNonEmptyString(value.qualifiedAgentId, 1_024)
      || !isBoundedNonEmptyString(value.localAgentId, 256)
      || !isBoundedNonEmptyString(value.immutableGenerationId, 512)
    ) {
      return null;
    }
    return {
      kind: 'host_declarative_acp_v1',
      v: 1,
      pluginId: value.pluginId,
      pluginVersion: value.pluginVersion,
      agentId: value.agentId,
      qualifiedAgentId: value.qualifiedAgentId,
      localAgentId: value.localAgentId,
      immutableGenerationId: value.immutableGenerationId,
    };
  }
  if (
    !hasExactKeys(value, [
      'v',
      'pluginId',
      'pluginVersion',
      'agentId',
      'localAgentId',
      'immutableGenerationId',
      'locator',
      'normalizedModulePath',
      'loadMode',
    ])
    || value.v !== 1
    || !isBoundedNonEmptyString(value.pluginId, 256)
    || !isBoundedNonEmptyString(value.pluginVersion, 256)
    || !isBoundedNonEmptyString(value.agentId, 512)
    || !isBoundedNonEmptyString(value.localAgentId, 256)
    || !isBoundedNonEmptyString(value.immutableGenerationId, 512)
    || !isRecord(value.locator)
    || !hasExactKeys(
      value.locator,
      Object.prototype.hasOwnProperty.call(value.locator, 'externalSessionsExport')
        ? ['module', 'export', 'runtimeApiVersion', 'externalSessionsExport']
        : ['module', 'export', 'runtimeApiVersion'],
    )
    || typeof value.locator.module !== 'string'
    || !/^\.[/][A-Za-z0-9._/-]+$/u.test(value.locator.module)
    || !isIdentifier(value.locator.export)
    || value.locator.runtimeApiVersion !== 1
    || (
      value.locator.externalSessionsExport !== undefined
      && !isIdentifier(value.locator.externalSessionsExport)
    )
    || !isBoundedNonEmptyString(value.normalizedModulePath, 16_384)
    || (value.loadMode !== 'immutable-js' && value.loadMode !== 'source-ts')
  ) {
    return null;
  }
  return {
    v: 1,
    pluginId: value.pluginId,
    pluginVersion: value.pluginVersion,
    agentId: value.agentId,
    localAgentId: value.localAgentId,
    immutableGenerationId: value.immutableGenerationId,
    locator: {
      module: value.locator.module,
      export: value.locator.export,
      runtimeApiVersion: 1,
      ...(value.locator.externalSessionsExport === undefined
        ? {}
        : { externalSessionsExport: value.locator.externalSessionsExport }),
    },
    normalizedModulePath: value.normalizedModulePath,
    loadMode: value.loadMode,
  };
}

export function parseRunnerDaemonServiceAuthority(
  path: string,
  value: unknown,
): RunnerDaemonServiceAuthority | null {
  if (
    !isRecord(value)
    || value.v !== 2
    || !hasExactKeys(value, [
      'v',
      'sessionId',
      'runner',
      'pluginHardRevocationRevision',
      'retainedAgent',
      'httpPort',
      'capability',
    ])
    || !isRecord(value.runner)
  ) {
    return null;
  }
  const runner = value.runner;
  const retainedAgent = parseRetainedAgentBinding(value.retainedAgent);
  if (
    typeof value.sessionId !== 'string'
    || typeof runner.pid !== 'number'
    || !Number.isInteger(runner.pid)
    || runner.pid <= 0
    || typeof runner.processStartTimeMs !== 'number'
    || !Number.isInteger(runner.processStartTimeMs)
    || runner.processStartTimeMs < 0
    || typeof runner.processCommandHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(runner.processCommandHash)
    || typeof runner.snapshotIdentity !== 'string'
    || runner.snapshotIdentity.length === 0
    || typeof value.pluginHardRevocationRevision !== 'number'
    || !Number.isInteger(value.pluginHardRevocationRevision)
    || value.pluginHardRevocationRevision < 0
    || value.pluginHardRevocationRevision > Number.MAX_SAFE_INTEGER
    || retainedAgent === null
    || typeof value.httpPort !== 'number'
    || !Number.isInteger(value.httpPort)
    || value.httpPort < 1
    || value.httpPort > 65_535
    || typeof value.capability !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.capability)
  ) {
    return null;
  }
  return {
    path,
    sessionId: value.sessionId,
    runner: {
      pid: runner.pid,
      processStartTimeMs: runner.processStartTimeMs,
      processCommandHash: runner.processCommandHash,
      snapshotIdentity: runner.snapshotIdentity,
    },
    pluginHardRevocationRevision: value.pluginHardRevocationRevision,
    retainedAgent,
    httpPort: value.httpPort,
    capability: value.capability,
  };
}

export async function probeTurnContributionsAuthority(
  authority: RunnerDaemonServiceAuthority,
): Promise<DaemonServiceProbe> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${authority.httpPort}/agent-runtime/session/services/v1`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-daemon-token': authority.capability,
        },
        body: JSON.stringify({
          v: 1,
          context: {
            token: authority.capability,
            sessionId: authority.sessionId,
          },
          operation: {
            kind: 'turn_contributions.resolve',
            requestId: `continuity-probe-${randomUUID()}`,
            request: { kind: 'prompt' },
          },
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    const raw = await response.text();
    let body: unknown = null;
    try {
      body = raw.trim() ? JSON.parse(raw) as unknown : null;
    } catch {
      body = null;
    }
    const record = isRecord(body) ? body : null;
    const error = record && isRecord(record.error) ? record.error : null;
    const result = record && isRecord(record.result) ? record.result : null;
    return {
      status: response.status,
      ok: typeof record?.ok === 'boolean' ? record.ok : null,
      errorCode: typeof error?.code === 'string' ? error.code : null,
      resultKind: typeof result?.kind === 'string' ? result.kind : null,
      resultStatus: typeof result?.status === 'string' ? result.status : null,
    };
  } catch {
    return {
      status: 'connection_failed',
      ok: null,
      errorCode: null,
      resultKind: null,
      resultStatus: null,
    };
  }
}

export async function waitForRunnerDaemonServiceAuthority(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
}>): Promise<RunnerDaemonServiceAuthority> {
  let authority: RunnerDaemonServiceAuthority | null = null;
  await waitFor(async () => {
    const authorityPaths = new Set<string>();
    for (const basename of ['daemon-sessions', 'daemon-sessions.dev', 'daemon-sessions.preview']) {
      const markerDir = join(params.happyHomeDir, 'tmp', basename);
      for (const name of await readdir(markerDir).catch(() => [])) {
        if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;
        try {
          const marker = JSON.parse(await readFile(join(markerDir, name), 'utf8')) as unknown;
          if (
            isRecord(marker)
            && marker.happySessionId === params.sessionId
            && typeof marker.agentRuntimeDaemonServiceAuthorityFilePath === 'string'
          ) {
            authorityPaths.add(marker.agentRuntimeDaemonServiceAuthorityFilePath);
          }
        } catch {
          // Publication can replace a marker while this observation is in flight.
        }
      }
    }
    if (authorityPaths.size !== 1) return false;
    const [authorityPath] = [...authorityPaths];
    try {
      authority = parseRunnerDaemonServiceAuthority(
        authorityPath,
        JSON.parse(await readFile(authorityPath, 'utf8')) as unknown,
      );
    } catch {
      authority = null;
    }
    return authority?.sessionId === params.sessionId;
  }, {
    timeoutMs: 30_000,
    intervalMs: 50,
    context: `runner daemon-service authority for ${params.sessionId}`,
  });
  if (!authority) {
    throw new Error(`Missing runner daemon-service authority for ${params.sessionId}`);
  }
  return authority;
}

export async function readTrackedRunnerPid(params: Readonly<{
  daemon: DaemonState;
  sessionId: string;
}>): Promise<number> {
  let runnerPid: number | null = null;
  await waitFor(async () => {
    const listed = await daemonControlPostJson<{
      children?: readonly Readonly<{
        happySessionId?: unknown;
        startedBy?: unknown;
        pid?: unknown;
      }>[];
    }>({
      port: params.daemon.httpPort,
      path: '/list',
      controlToken: params.daemon.controlToken,
    });
    if (listed.status !== 200 || !Array.isArray(listed.data?.children)) return false;
    const matching = listed.data.children.filter((child) => child.happySessionId === params.sessionId);
    if (
      matching.length !== 1
      || matching[0]?.startedBy !== 'daemon'
      || typeof matching[0]?.pid !== 'number'
      || !Number.isInteger(matching[0].pid)
      || matching[0].pid <= 0
    ) {
      return false;
    }
    runnerPid = matching[0].pid;
    return true;
  }, {
    timeoutMs: 30_000,
    intervalMs: 100,
    context: `exact tracked runner for ${params.sessionId}`,
  });
  if (!runnerPid) throw new Error(`Missing tracked runner PID for ${params.sessionId}`);
  return runnerPid;
}

async function countMatchingAssistantTranscriptOutputs(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  requiredSubstring: string;
}>): Promise<number> {
  const logicalOutputs = new Set<string>();
  for (const row of await fetchAllMessages(params.baseUrl, params.token, params.sessionId)) {
    try {
      const decrypted = decryptLegacyBase64(row.content.c, params.secret) as Record<string, unknown> | null;
      if (!decrypted || typeof decrypted !== 'object') continue;
      const texts = extractAssistantCandidateTextsFromDecryptedRecord(decrypted);
      if (!texts.some((text) => text.includes(params.requiredSubstring))) continue;
      const meta = isRecord(decrypted.meta) ? decrypted.meta : null;
      const segment = isRecord(meta?.happierStreamSegmentV1) ? meta.happierStreamSegmentV1 : null;
      const logicalId = (
        typeof segment?.segmentLocalId === 'string' && segment.segmentLocalId
      ) || (
        typeof meta?.happierStreamKey === 'string' && meta.happierStreamKey
      ) || row.localId || `seq:${row.seq}`;
      logicalOutputs.add(logicalId);
    } catch {
      // Ignore malformed rows; the positive transcript-output waiter owns the required observation.
    }
  }
  return logicalOutputs.size;
}

async function countMatchingEffects(params: Readonly<{
  path: string;
  marker: string;
}>): Promise<number> {
  const contents = await readFile(params.path, 'utf8').catch(() => '');
  return contents
    .split(/\r?\n/u)
    .filter((line) => line === params.marker)
    .length;
}

async function countTerminalEvents(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  turnId: string;
}>): Promise<number> {
  const terminalRows = new Set<string>();
  for (const row of await fetchAllMessages(params.baseUrl, params.token, params.sessionId)) {
    try {
      const decrypted = decryptLegacyBase64(row.content.c, params.secret);
      const normalized = normalizeDecodedTranscriptValue(decrypted);
      const record = isRecord(normalized) ? normalized : null;
      if (record?.type !== 'task_complete' || record.id !== params.turnId) continue;
      terminalRows.add(row.localId || `seq:${row.seq}`);
    } catch {
      // Malformed rows cannot supply positive exactly-once terminal evidence.
    }
  }
  return terminalRows.size;
}

async function observeUnderlyingAgentIdentity(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  runnerPid: number;
  vendorSessionMetadataKey?: string;
  observeAgentChildProcess?: (params: Readonly<{ runnerPid: number }>) => Promise<Readonly<{
    pid: number;
    processStartTimeMs?: number;
    processCommandHash?: string;
  }> | null>;
}>): Promise<UnderlyingAgentIdentityObservation> {
  const childProcessIdentity = params.observeAgentChildProcess
    ? await params.observeAgentChildProcess({ runnerPid: params.runnerPid })
    : null;
  const metadataKey = params.vendorSessionMetadataKey?.trim();
  if (!metadataKey) {
    return { childProcessIdentity, vendorSessionId: null };
  }
  const snapshot = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
  const metadata = decryptLegacyBase64(snapshot.metadata, params.secret);
  const record = isRecord(metadata) ? metadata : null;
  const value = record?.[metadataKey];
  const vendorSessionId = typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
  return { childProcessIdentity, vendorSessionId };
}

function summarizeOptionalIdentity(
  kind: 'agent_child_process' | 'vendor_session',
  sessionId: string,
  values: Readonly<Record<'a' | 'b' | 'c', unknown | null>>,
): Readonly<{
  availability: 'observed' | 'unknown';
  identityFingerprints: Readonly<Record<'a' | 'b' | 'c', string | null>>;
  distinctIdentityCount: 1 | null;
  stableAcrossAllPhases: true | null;
}> {
  const presentValues = Object.values(values).filter((value) => value !== null);
  if (presentValues.length === 0) {
    return {
      availability: 'unknown',
      identityFingerprints: { a: null, b: null, c: null },
      distinctIdentityCount: null,
      stableAcrossAllPhases: null,
    };
  }
  if (presentValues.length !== 3) {
    throw new Error(`Underlying Agent ${kind} identity was only observable for part of daemon A to B to C`);
  }
  const fingerprints = {
    a: fingerprintSessionScopedValue(kind, sessionId, values.a),
    b: fingerprintSessionScopedValue(kind, sessionId, values.b),
    c: fingerprintSessionScopedValue(kind, sessionId, values.c),
  };
  if (distinctValueCount(fingerprints) !== 1) {
    throw new Error(`Underlying Agent ${kind} identity changed across daemon A to B to C`);
  }
  return {
    availability: 'observed',
    identityFingerprints: fingerprints,
    distinctIdentityCount: 1,
    stableAcrossAllPhases: true,
  };
}

const defaultDeps: ContinuityDeps = {
  readTrackedRunnerPid,
  waitForAuthority: async ({ happyHomeDir, sessionId }) => (
    await waitForRunnerDaemonServiceAuthority({ happyHomeDir, sessionId })
  ),
  probeAuthority: probeTurnContributionsAuthority,
  replaceDaemon: async ({ originalDaemon, testDir, happyHomeDir, env, phase, cliLaunchSpec }) => (
    await replaceTestDaemonWithoutStoppingSessions({
      testDir,
      happyHomeDir,
      env,
      ...(originalDaemon ? { originalDaemon } : {}),
      stdoutPath: resolve(testDir, `daemon-${phase}.stdout.log`),
      stderrPath: resolve(testDir, `daemon-${phase}.stderr.log`),
      ...(cliLaunchSpec ? { cliLaunchSpec } : {}),
    })
  ),
  isProcessAlive,
  enqueuePrompt: enqueueSessionPromptForScenario,
  waitForActiveTurn: async ({ baseUrl, token, sessionId, previousTurnId, timeoutMs }) => {
    let activeTurnId: string | null = null;
    await waitFor(async () => {
      const snapshot = await fetchSessionV2(baseUrl, token, sessionId).catch(() => null);
      if (!snapshot || snapshot.latestTurnStatus !== 'in_progress') return false;
      const candidate = typeof snapshot.latestTurnId === 'string' ? snapshot.latestTurnId.trim() : '';
      if (!candidate || candidate === previousTurnId) return false;
      activeTurnId = candidate;
      return true;
    }, {
      timeoutMs,
      intervalMs: 50,
      context: `active continuity turn for ${sessionId}`,
    });
    if (!activeTurnId) throw new Error(`Missing active continuity turn for ${sessionId}`);
    return activeTurnId;
  },
  waitForMatchingEffect: async ({ path, marker, timeoutMs }) => {
    await waitFor(async () => (await countMatchingEffects({ path, marker })) >= 1, {
      timeoutMs,
      intervalMs: 50,
      context: 'daemon runner continuity effect',
    });
  },
  waitForMatchingAssistantTranscriptOutput: async (params) => {
    await waitForAssistantMessageContaining({
      ...params,
      requiredSubstring: params.requiredSubstring,
    });
  },
  countMatchingAssistantTranscriptOutputs,
  countMatchingEffects,
  countTerminalEvents,
  observeUnderlyingAgentIdentity,
  waitForNextCompletedTurn: async ({ baseUrl, token, sessionId, previousTurnId, timeoutMs }) => {
    let completedTurnId: string | null = null;
    await waitFor(async () => {
      const snapshot = await fetchSessionV2(baseUrl, token, sessionId).catch(() => null);
      completedTurnId = readCompletedTurnId(snapshot);
      return completedTurnId !== null && completedTurnId !== previousTurnId;
    }, {
      timeoutMs,
      intervalMs: 100,
      context: `next completed turn for ${sessionId}`,
    });
    if (!completedTurnId) throw new Error(`Missing next completed turn for ${sessionId}`);
    return completedTurnId;
  },
};

function assertCurrentAuthorityProbe(probe: DaemonServiceProbe, phase: string): void {
  if (
    probe.status !== 200
    || probe.ok !== true
    || probe.resultKind !== 'turn_contributions'
    || probe.resultStatus !== 'resolved'
  ) {
    throw new Error(`Daemon ${phase} did not accept its current runner authority: ${JSON.stringify(probe)}`);
  }
}

function assertStaleAuthorityRejected(probe: DaemonServiceProbe, phase: string): void {
  if (
    probe.status !== 403
    || probe.ok !== false
    || probe.errorCode !== 'agent_runtime_daemon_service_forbidden'
  ) {
    throw new Error(`Daemon ${phase} did not reject predecessor runner authority: ${JSON.stringify(probe)}`);
  }
}

function assertSameRunnerAuthority(
  initial: RunnerDaemonServiceAuthority,
  current: RunnerDaemonServiceAuthority,
  phase: string,
): void {
  const stableInitial = {
    path: initial.path,
    sessionId: initial.sessionId,
    runner: initial.runner,
    pluginHardRevocationRevision: initial.pluginHardRevocationRevision,
    retainedAgent: initial.retainedAgent,
  };
  const stableCurrent = {
    path: current.path,
    sessionId: current.sessionId,
    runner: current.runner,
    pluginHardRevocationRevision: current.pluginHardRevocationRevision,
    retainedAgent: current.retainedAgent,
  };
  if (JSON.stringify(stableCurrent) !== JSON.stringify(stableInitial)) {
    throw new Error(`Daemon ${phase} changed runner execution authority`);
  }
  if (capabilityFingerprint(current.capability) === capabilityFingerprint(initial.capability)) {
    throw new Error(`Daemon ${phase} reused predecessor runner authority capability`);
  }
}

export async function runDaemonRunnerContinuityAToBToC(params: Readonly<{
  daemonA: StartedDaemon;
  testDir: string;
  happyHomeDir: string;
  daemonEnv: NodeJS.ProcessEnv;
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  phases: readonly [ContinuityPhase, ContinuityPhase];
  launchEntrypointKind: DaemonRunnerLaunchEntrypointKind;
  cliLaunchSpec?: CliTestLaunchSpec;
  identityEvidence?: Readonly<{
    vendorSessionMetadataKey?: string;
    observeAgentChildProcess?: (params: Readonly<{ runnerPid: number }>) => Promise<Readonly<{
      pid: number;
      processStartTimeMs?: number;
      processCommandHash?: string;
    }> | null>;
  }>;
  observeRetainedPluginLifecycle?: () => Promise<RetainedPluginLifecycleObservations>;
  onReplacementDaemon?: (daemon: StartedDaemon) => void | Promise<void>;
  timeoutMs?: number;
  deps?: ContinuityDeps;
}>): Promise<DaemonRunnerContinuityEvidence> {
  const deps = params.deps ?? defaultDeps;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const daemonA = params.daemonA.state;
  const runnerPid = await deps.readTrackedRunnerPid({ daemon: daemonA, sessionId: params.sessionId });
  if (!deps.isProcessAlive(runnerPid)) throw new Error(`Runner PID ${runnerPid} is not alive under daemon A`);
  const authorityA = await deps.waitForAuthority({
    daemon: daemonA,
    happyHomeDir: params.happyHomeDir,
    sessionId: params.sessionId,
  });
  assertCurrentAuthorityProbe(await deps.probeAuthority(authorityA), 'A');

  let previousDaemon = daemonA;
  let previousAuthority = authorityA;
  const daemonPids: [number, number, number] = [daemonA.pid, 0, 0];
  const daemonIdentityFingerprints = {
    a: fingerprintSessionScopedValue('daemon', authorityA.sessionId, { pid: daemonA.pid }),
    b: '',
    c: '',
  };
  const runtimeIdentityKind = classifyRunnerRuntimeIdentity(
    authorityA.runner.snapshotIdentity,
  );
  if (
    params.launchEntrypointKind === 'candidate_artifact'
    && runtimeIdentityKind !== 'immutable_snapshot'
    && runtimeIdentityKind !== 'versioned_runtime'
  ) {
    throw new Error('candidate_artifact requires an immutable or versioned runner runtime identity');
  }
  const runtimeEntrypointIdentityFingerprints = {
    a: fingerprintSessionScopedValue(
      'runtime_entrypoint',
      authorityA.sessionId,
      authorityA.runner.snapshotIdentity,
    ),
    b: '',
    c: '',
  };
  const runnerIdentityFingerprints = {
    a: fingerprintSessionScopedValue('runner_identity', authorityA.sessionId, {
      pid: authorityA.runner.pid,
      processStartTimeMs: authorityA.runner.processStartTimeMs,
    }),
    b: '',
    c: '',
  };
  const runnerProcessCommandHashFingerprints = {
    a: fingerprintSessionScopedValue(
      'runner_process_command_hash',
      authorityA.sessionId,
      authorityA.runner.processCommandHash,
    ),
    b: '',
    c: '',
  };
  const logicalSessionIdentityFingerprints = {
    a: fingerprintSessionScopedValue('logical_session', authorityA.sessionId, authorityA.sessionId),
    b: '',
    c: '',
  };
  const retainedAgentBindingFingerprints = {
    a: fingerprintSessionScopedValue(
      'retained_agent_binding',
      authorityA.sessionId,
      authorityA.retainedAgent,
    ),
    b: '',
    c: '',
  };
  const completedTurnFingerprints = { a: '', b: '', c: '' };
  const capabilityFingerprints = {
    a: capabilityFingerprint(authorityA.capability),
    b: '',
    c: '',
  };
  const childProcessIdentities: Record<'a' | 'b' | 'c', unknown | null> = {
    a: null,
    b: null,
    c: null,
  };
  const vendorSessionIdentities: Record<'a' | 'b' | 'c', string | null> = {
    a: null,
    b: null,
    c: null,
  };
  const matchingAssistantTranscriptOutputCounts: Record<'b' | 'c', number> = { b: 0, c: 0 };
  const matchingEffectCounts: Record<'b' | 'c', number> = { b: 0, c: 0 };
  const terminalEventCounts: Record<'b' | 'c', number> = { b: 0, c: 0 };
  let previousCompletedTurnId = await deps.waitForNextCompletedTurn({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    previousTurnId: null,
    timeoutMs,
  });
  completedTurnFingerprints.a = fingerprintSessionScopedValue(
    'completed_turn',
    authorityA.sessionId,
    previousCompletedTurnId,
  );
  const initialUnderlyingIdentity = await deps.observeUnderlyingAgentIdentity({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    secret: params.secret,
    runnerPid,
    ...(params.identityEvidence?.vendorSessionMetadataKey
      ? { vendorSessionMetadataKey: params.identityEvidence.vendorSessionMetadataKey }
      : {}),
    ...(params.identityEvidence?.observeAgentChildProcess
      ? { observeAgentChildProcess: params.identityEvidence.observeAgentChildProcess }
      : {}),
  });
  childProcessIdentities.a = initialUnderlyingIdentity.childProcessIdentity;
  vendorSessionIdentities.a = initialUnderlyingIdentity.vendorSessionId;

  const transitionToDaemon = async (
    phase: 'b' | 'c',
    originalDaemon?: StartedDaemon,
  ): Promise<void> => {
    const nextStartedDaemon = await deps.replaceDaemon({
      previousDaemon,
      ...(originalDaemon ? { originalDaemon } : {}),
      testDir: params.testDir,
      happyHomeDir: params.happyHomeDir,
      env: params.daemonEnv,
      phase,
      ...(params.cliLaunchSpec ? { cliLaunchSpec: params.cliLaunchSpec } : {}),
    });
    const nextDaemon = nextStartedDaemon.state;
    await params.onReplacementDaemon?.(nextStartedDaemon);
    if (nextDaemon.pid === previousDaemon.pid) {
      throw new Error(`Daemon ${phase.toUpperCase()} did not replace daemon PID ${previousDaemon.pid}`);
    }
    daemonPids[phase === 'b' ? 1 : 2] = nextDaemon.pid;
    daemonIdentityFingerprints[phase] = fingerprintSessionScopedValue(
      'daemon',
      authorityA.sessionId,
      { pid: nextDaemon.pid },
    );

    const nextRunnerPid = await deps.readTrackedRunnerPid({ daemon: nextDaemon, sessionId: params.sessionId });
    if (nextRunnerPid !== runnerPid || !deps.isProcessAlive(runnerPid)) {
      throw new Error(`Daemon ${phase.toUpperCase()} did not preserve live runner PID ${runnerPid}`);
    }
    const nextAuthority = await deps.waitForAuthority({
      daemon: nextDaemon,
      happyHomeDir: params.happyHomeDir,
      sessionId: params.sessionId,
    });
    if (nextAuthority.httpPort !== nextDaemon.httpPort) {
      throw new Error(`Daemon ${phase.toUpperCase()} published authority for the wrong control port`);
    }
    assertSameRunnerAuthority(authorityA, nextAuthority, phase.toUpperCase());
    assertStaleAuthorityRejected(
      await deps.probeAuthority({ ...previousAuthority, httpPort: nextDaemon.httpPort }),
      phase.toUpperCase(),
    );
    assertCurrentAuthorityProbe(await deps.probeAuthority(nextAuthority), phase.toUpperCase());
    if (classifyRunnerRuntimeIdentity(nextAuthority.runner.snapshotIdentity) !== runtimeIdentityKind) {
      throw new Error(`Daemon ${phase.toUpperCase()} changed runner runtime identity kind`);
    }
    runtimeEntrypointIdentityFingerprints[phase] = fingerprintSessionScopedValue(
      'runtime_entrypoint',
      nextAuthority.sessionId,
      nextAuthority.runner.snapshotIdentity,
    );
    runnerIdentityFingerprints[phase] = fingerprintSessionScopedValue(
      'runner_identity',
      nextAuthority.sessionId,
      {
        pid: nextAuthority.runner.pid,
        processStartTimeMs: nextAuthority.runner.processStartTimeMs,
      },
    );
    runnerProcessCommandHashFingerprints[phase] = fingerprintSessionScopedValue(
      'runner_process_command_hash',
      nextAuthority.sessionId,
      nextAuthority.runner.processCommandHash,
    );
    logicalSessionIdentityFingerprints[phase] = fingerprintSessionScopedValue(
      'logical_session',
      nextAuthority.sessionId,
      nextAuthority.sessionId,
    );
    retainedAgentBindingFingerprints[phase] = fingerprintSessionScopedValue(
      'retained_agent_binding',
      nextAuthority.sessionId,
      nextAuthority.retainedAgent,
    );
    capabilityFingerprints[phase] = capabilityFingerprint(nextAuthority.capability);
    const underlyingIdentity = await deps.observeUnderlyingAgentIdentity({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      secret: params.secret,
      runnerPid,
      ...(params.identityEvidence?.vendorSessionMetadataKey
        ? { vendorSessionMetadataKey: params.identityEvidence.vendorSessionMetadataKey }
        : {}),
      ...(params.identityEvidence?.observeAgentChildProcess
        ? { observeAgentChildProcess: params.identityEvidence.observeAgentChildProcess }
        : {}),
    });
    childProcessIdentities[phase] = underlyingIdentity.childProcessIdentity;
    vendorSessionIdentities[phase] = underlyingIdentity.vendorSessionId;
    previousDaemon = nextDaemon;
    previousAuthority = nextAuthority;
  };

  const [phaseB, phaseC] = params.phases;
  await deps.enqueuePrompt({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    secret: params.secret,
    text: phaseB.prompt,
  });
  const activeTurnId = await deps.waitForActiveTurn({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    previousTurnId: previousCompletedTurnId,
    timeoutMs,
  });
  await deps.waitForMatchingEffect({ ...phaseB.effect, timeoutMs });
  await transitionToDaemon('b', params.daemonA);
  await deps.waitForMatchingAssistantTranscriptOutput({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    secret: params.secret,
    requiredSubstring: phaseB.requiredAssistantSubstring,
    timeoutMs,
  });
  const completedTurnB = await deps.waitForNextCompletedTurn({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    previousTurnId: previousCompletedTurnId,
    timeoutMs,
  });
  if (completedTurnB !== activeTurnId) {
    throw new Error('Daemon A to B active turn identity changed before terminal settlement');
  }
  completedTurnFingerprints.b = fingerprintSessionScopedValue(
    'completed_turn',
    authorityA.sessionId,
    completedTurnB,
  );
  previousCompletedTurnId = completedTurnB;

  await transitionToDaemon('c');
  await deps.enqueuePrompt({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    secret: params.secret,
    text: phaseC.prompt,
  });
  await deps.waitForMatchingEffect({ ...phaseC.effect, timeoutMs });
  await deps.waitForMatchingAssistantTranscriptOutput({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    secret: params.secret,
    requiredSubstring: phaseC.requiredAssistantSubstring,
    timeoutMs,
  });
  const completedTurnC = await deps.waitForNextCompletedTurn({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    previousTurnId: previousCompletedTurnId,
    timeoutMs,
  });
  completedTurnFingerprints.c = fingerprintSessionScopedValue(
    'completed_turn',
    authorityA.sessionId,
    completedTurnC,
  );
  for (const phase of params.phases) {
    const completedTurnId = phase.id === 'b' ? completedTurnB : completedTurnC;
    matchingAssistantTranscriptOutputCounts[phase.id] = await deps.countMatchingAssistantTranscriptOutputs({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      secret: params.secret,
      requiredSubstring: phase.requiredAssistantSubstring,
    });
    matchingEffectCounts[phase.id] = await deps.countMatchingEffects(phase.effect);
    terminalEventCounts[phase.id] = await deps.countTerminalEvents({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      secret: params.secret,
      turnId: completedTurnId,
    });
    if (matchingAssistantTranscriptOutputCounts[phase.id] !== 1) {
      throw new Error(
        `Daemon ${phase.id.toUpperCase()} matching assistant transcript/output count was `
          + `${matchingAssistantTranscriptOutputCounts[phase.id]}; `
          + 'expected exactly one',
      );
    }
    if (matchingEffectCounts[phase.id] !== 1) {
      throw new Error(
        `Daemon ${phase.id.toUpperCase()} matching effect count was ${matchingEffectCounts[phase.id]}; `
          + 'expected exactly one',
      );
    }
    if (terminalEventCounts[phase.id] !== 1) {
      throw new Error(
        `Daemon ${phase.id.toUpperCase()} terminal event count was ${terminalEventCounts[phase.id]}; `
          + 'expected exactly one',
      );
    }
  }

  if (new Set(daemonPids).size !== 3 || distinctValueCount(daemonIdentityFingerprints) !== 3) {
    throw new Error('Daemon A to B to C identity cardinality was not three');
  }
  if (
    distinctValueCount(runtimeEntrypointIdentityFingerprints) !== 1
    || distinctValueCount(runnerIdentityFingerprints) !== 1
    || distinctValueCount(runnerProcessCommandHashFingerprints) !== 1
    || distinctValueCount(logicalSessionIdentityFingerprints) !== 1
    || distinctValueCount(retainedAgentBindingFingerprints) !== 1
  ) {
    throw new Error('Runner, logical session, or execution authority changed across daemon A to B to C');
  }
  if (distinctValueCount(capabilityFingerprints) !== 3) {
    throw new Error('Daemon runner authority capability cardinality was not three');
  }
  if (distinctValueCount(completedTurnFingerprints) !== 3) {
    throw new Error('Completed turn A to B to C identity cardinality was not three');
  }

  const retainedPluginLifecycle = params.observeRetainedPluginLifecycle === undefined
    ? undefined
    : projectRetainedPluginLifecycleEvidence(await params.observeRetainedPluginLifecycle());
  return sanitizeDaemonRunnerContinuityManifestEvidence({
    phaseCount: 3,
    runtime: {
      launchEntrypointKind: params.launchEntrypointKind,
      identityKind: runtimeIdentityKind,
      entrypointIdentityFingerprints: runtimeEntrypointIdentityFingerprints,
      distinctEntrypointIdentityCount: 1,
      stableAcrossAllPhases: true,
    },
    daemon: {
      identityFingerprints: daemonIdentityFingerprints,
      distinctIdentityCount: 3,
      replacedAcrossAllPhases: true,
    },
    runner: {
      identityFingerprints: runnerIdentityFingerprints,
      processCommandHashFingerprints: runnerProcessCommandHashFingerprints,
      distinctIdentityCount: 1,
      distinctProcessCommandHashCount: 1,
      aliveAcrossAllPhases: true,
    },
    logicalSession: {
      identityFingerprints: logicalSessionIdentityFingerprints,
      distinctIdentityCount: 1,
      stableAcrossAllPhases: true,
    },
    executionAuthority: {
      retainedAgentBindingFingerprints,
      distinctRetainedAgentBindingCount: 1,
      stableAcrossAllPhases: true,
    },
    underlyingAgent: {
      childProcess: summarizeOptionalIdentity(
        'agent_child_process',
        authorityA.sessionId,
        childProcessIdentities,
      ),
      vendorSession: summarizeOptionalIdentity(
        'vendor_session',
        authorityA.sessionId,
        vendorSessionIdentities,
      ),
    },
    authority: {
      capabilityFingerprints,
      distinctCapabilityCount: 3,
      rotatedAcrossAllPhases: true,
      currentAcceptedAcrossAllPhases: true,
      predecessorRejectedAtBAndC: true,
    },
    turns: {
      completedTurnFingerprints,
      distinctCompletedTurnCount: 3,
      matchingAssistantTranscriptOutputCounts: { b: 1, c: 1 },
      matchingEffectCounts: { b: 1, c: 1 },
      terminalEventCounts: { b: 1, c: 1 },
      activeTurnCrossedAToB: true,
      exactlyOneMatchingAssistantTranscriptOutputPerLaterPhase: true,
      exactlyOneMatchingEffectPerLaterPhase: true,
      exactlyOneTerminalEventPerLaterPhase: true,
    },
    ...(retainedPluginLifecycle === undefined ? {} : { retainedPluginLifecycle }),
  });
}
