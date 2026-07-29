import { createHash } from 'node:crypto';

import {
  AcpConfigOptionOverridesV1Schema,
  readRuntimeDescriptorV1,
  SessionMcpSelectionV1Schema,
  SessionModelSelectionV1Schema,
} from '@happier-dev/protocol';

import { readCanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeNonEmptyString(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  return s.length > 0 ? s : null;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function toStableJson(value: unknown, seen: WeakSet<object>): Json {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => toStableJson(v, seen));
  if (typeof value !== 'object') return null;

  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return null;
  seen.add(obj);
  const out: Record<string, Json> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = toStableJson(v, seen);
  }
  return out;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(toStableJson(value, new WeakSet()), null, 0);
}

function hashRecordValues(record: Record<string, string> | undefined): Record<string, string> | null {
  if (!record || typeof record !== 'object') return null;
  const keys = Object.keys(record).sort();
  if (keys.length === 0) return null;
  const out: Record<string, string> = {};
  for (const k of keys) {
    out[k] = sha256Hex(String(record[k] ?? ''));
  }
  return out;
}

function normalizeMcpSelectionForFingerprint(value: SpawnSessionOptions['mcpSelection']): Json {
  if (value === undefined) return null;
  const parsed = SessionMcpSelectionV1Schema.safeParse(value);
  if (!parsed.success) return null;

  const { v, managedServersEnabled, forceIncludeServerIds, forceExcludeServerIds } = parsed.data;
  return {
    v,
    managedServersEnabled,
    forceIncludeServerIds: [...forceIncludeServerIds].sort(),
    forceExcludeServerIds: [...forceExcludeServerIds].sort(),
  };
}

function normalizeModelSelectionForFingerprint(value: SpawnSessionOptions['modelSelection']): Json {
  if (value === undefined) return null;
  const parsed = SessionModelSelectionV1Schema.safeParse(value);
  if (!parsed.success) return null;

  return {
    v: parsed.data.v,
    ref: toStableJson(parsed.data.ref, new WeakSet()),
  };
}

function normalizeSessionConfigOptionOverridesForFingerprint(
  value: SpawnSessionOptions['sessionConfigOptionOverrides'],
): Json {
  if (value === undefined) return null;
  const parsed = AcpConfigOptionOverridesV1Schema.safeParse(value);
  if (!parsed.success) return null;

  return {
    v: parsed.data.v,
    overrides: Object.fromEntries(
      Object.entries(parsed.data.overrides)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, override]) => [key, override.value]),
    ),
  };
}

function normalizeRuntimeDescriptorForFingerprint(
  value: SpawnSessionOptions['runtimeDescriptorV1'],
): Json {
  const parsed = readRuntimeDescriptorV1(value);
  if (!parsed) return null;
  return toStableJson(parsed, new WeakSet());
}

function buildSpawnSemanticFingerprint(options: SpawnSessionOptions): Json {
  const runtimeSelection = readCanonicalSpawnRuntimeSelection(options);
  const transcriptStorage = normalizeNonEmptyString(options.transcriptStorage) === 'direct' ? 'direct' : null;
  const initialTranscriptAfterSeq = typeof options.initialTranscriptAfterSeq === 'number'
    && Number.isSafeInteger(options.initialTranscriptAfterSeq)
    && options.initialTranscriptAfterSeq >= 0
    ? options.initialTranscriptAfterSeq
    : null;

  return {
    machineId: normalizeNonEmptyString(options.machineId),
    directory: normalizeNonEmptyString(options.directory) ?? '',
    backendTarget: options.backendTarget === undefined
      ? null
      : toStableJson(options.backendTarget, new WeakSet()),
    runtimeDescriptor: normalizeRuntimeDescriptorForFingerprint(runtimeSelection.runtimeDescriptorV1),
    providerRuntimeSelection: toStableJson(runtimeSelection.providerRuntimeSelection ?? null, new WeakSet()),
    approvedNewDirectoryCreation: options.approvedNewDirectoryCreation === true,
    profileId: options.profileId !== undefined ? String(options.profileId ?? '') : null,
    terminal: toStableJson(options.terminal ?? null, new WeakSet()),
    windowsRemoteSessionLaunchMode: normalizeNonEmptyString(options.windowsRemoteSessionLaunchMode),
    windowsRemoteSessionConsole: normalizeNonEmptyString(options.windowsRemoteSessionConsole),
    windowsTerminalWindowName: normalizeNonEmptyString(options.windowsTerminalWindowName),
    permissionMode: normalizeNonEmptyString(options.permissionMode),
    agentModeId: normalizeNonEmptyString(options.agentModeId),
    modelSelection: normalizeModelSelectionForFingerprint(options.modelSelection),
    resume: normalizeNonEmptyString(options.resume),
    pendingFirstInputHash: options.pendingFirstInput === undefined
      ? null
      : sha256Hex(stableJsonStringify(options.pendingFirstInput)),
    initialTranscriptAfterSeq,
    attachMetadataIdentityPolicy: normalizeNonEmptyString(options.attachMetadataIdentityPolicy),
    envValueHashes: hashRecordValues(options.environmentVariables),
    connectedServicesHash: options.connectedServices === undefined
      ? null
      : sha256Hex(stableJsonStringify(options.connectedServices)),
    connectedServiceMaterializationIdentity: options.connectedServiceMaterializationIdentityV1 === undefined
      ? null
      : toStableJson(options.connectedServiceMaterializationIdentityV1, new WeakSet()),
    providerBindingMetadata: options.providerBindingMetadataV1 === undefined
      ? null
      : toStableJson(options.providerBindingMetadataV1, new WeakSet()),
    providerBindingSecurityChangeConfirmation: options.providerBindingSecurityChangeConfirmationV1 === undefined
      ? null
      : toStableJson(options.providerBindingSecurityChangeConfirmationV1, new WeakSet()),
    mcpSelection: normalizeMcpSelectionForFingerprint(options.mcpSelection),
    sessionConfigOptionOverrides: normalizeSessionConfigOptionOverridesForFingerprint(
      options.sessionConfigOptionOverrides,
    ),
    ...(transcriptStorage ? { transcriptStorage } : {}),
  };
}

export type DaemonSpawnRequestKey =
  | Readonly<{ kind: 'existing'; key: string; serializationKey: string; authorizationKey?: string }>
  | Readonly<{ kind: 'new'; key: string }>;

export function computeDaemonSpawnRequestKey(options: SpawnSessionOptions): DaemonSpawnRequestKey {
  const existingSessionId = normalizeNonEmptyString(options.existingSessionId);
  if (existingSessionId) {
    const serializationKey = `existing:${existingSessionId}`;
    const executionAuthorization = options.executionAuthorization;
    const requestKey = `:request:${sha256Hex(stableJsonStringify({
      ...(executionAuthorization ? { executionAuthorization } : {}),
      spawnSemantics: buildSpawnSemanticFingerprint(options),
    }))}`;
    return {
      kind: 'existing',
      key: `${serializationKey}${requestKey}`,
      serializationKey,
      ...(executionAuthorization
        ? { authorizationKey: `${serializationKey}:authorization:${sha256Hex(executionAuthorization.requestId)}` }
        : {}),
    };
  }

  const spawnNonce = normalizeNonEmptyString(options.spawnNonce);
  if (spawnNonce) {
    return { kind: 'new', key: `new:nonce:${sha256Hex(spawnNonce)}` };
  }

  return { kind: 'new', key: `new:${sha256Hex(stableJsonStringify(buildSpawnSemanticFingerprint(options)))}` };
}

function isSpawnWebhookTimeoutResult(result: SpawnSessionResult): boolean {
  return result.type === 'error' && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT;
}

export function createSpawnRequestCoalescer(params: Readonly<{
  recentSuccessTtlMs: number;
  pendingTimeoutTtlMs?: number;
  nowMs?: () => number;
}>) {
  const inFlightByKey = new Map<string, Promise<SpawnSessionResult>>();
  const inFlightKeyByAuthorizationKey = new Map<string, string>();
  const serializationTailByKey = new Map<string, Promise<SpawnSessionResult>>();
  const recentSuccessByKey = new Map<string, { result: SpawnSessionResult; atMs: number }>();
  const pendingTimeoutByKey = new Map<string, { result: SpawnSessionResult; atMs: number }>();
  const nowMs = params.nowMs ?? (() => Date.now());
  const ttlMs = Math.max(0, Math.floor(Number(params.recentSuccessTtlMs)));
  const pendingTimeoutTtlMs = Math.max(0, Math.floor(Number(params.pendingTimeoutTtlMs ?? 0)));

  const tryGetRecent = (
    map: Map<string, { result: SpawnSessionResult; atMs: number }>,
    key: DaemonSpawnRequestKey,
    ttl: number,
  ): SpawnSessionResult | null => {
    if (key.kind === 'existing' && !key.authorizationKey) return null;
    if (ttl <= 0) return null;
    const cached = map.get(key.key);
    if (!cached) return null;
    const age = nowMs() - cached.atMs;
    if (!Number.isFinite(age) || age < 0 || age > ttl) {
      map.delete(key.key);
      return null;
    }
    return cached.result;
  };

  const recordRecentSuccess = (key: DaemonSpawnRequestKey, result: SpawnSessionResult) => {
    if (key.kind === 'existing' && !key.authorizationKey) return;
    if (ttlMs <= 0) return;
    if (result.type !== 'success') return;
    if (key.kind === 'existing') {
      recentSuccessByKey.set(key.key, { result, atMs: nowMs() });
      pendingTimeoutByKey.delete(key.key);
      return;
    }
    const sessionId = normalizeNonEmptyString(result.sessionId);
    if (!sessionId) return;
    recentSuccessByKey.set(key.key, { result: { type: 'success', sessionId }, atMs: nowMs() });
    pendingTimeoutByKey.delete(key.key);
  };

  const recordPendingTimeout = (key: DaemonSpawnRequestKey, result: SpawnSessionResult) => {
    if (key.kind !== 'new') return;
    if (pendingTimeoutTtlMs <= 0) return;
    if (!isSpawnWebhookTimeoutResult(result)) return;
    pendingTimeoutByKey.set(key.key, { result, atMs: nowMs() });
  };

  return {
    run: async (key: DaemonSpawnRequestKey, work: () => Promise<SpawnSessionResult>): Promise<SpawnSessionResult> => {
      const recentSuccess = tryGetRecent(recentSuccessByKey, key, ttlMs);
      if (recentSuccess) return recentSuccess;

      const pendingTimeout = tryGetRecent(pendingTimeoutByKey, key, pendingTimeoutTtlMs);
      if (pendingTimeout) return pendingTimeout;

      const existing = inFlightByKey.get(key.key);
      if (existing) return await existing;

      if (key.kind === 'existing' && key.authorizationKey) {
        const activeKey = inFlightKeyByAuthorizationKey.get(key.authorizationKey);
        if (activeKey && activeKey !== key.key) {
          return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'Conflicting exact execution authorization is already in flight for this pending input',
          };
        }
      }

      const previousInSerializationLane = key.kind === 'existing'
        ? serializationTailByKey.get(key.serializationKey)
        : undefined;
      let promise!: Promise<SpawnSessionResult>;
      promise = (async () => {
        try {
          if (previousInSerializationLane) {
            try {
              await previousInSerializationLane;
            } catch {
              // A failed predecessor must not poison subsequent exact requests.
            }
          }
          const result = await work();
          recordRecentSuccess(key, result);
          recordPendingTimeout(key, result);
          return result;
        } finally {
          if (inFlightByKey.get(key.key) === promise) {
            inFlightByKey.delete(key.key);
          }
          if (
            key.kind === 'existing'
            && serializationTailByKey.get(key.serializationKey) === promise
          ) {
            serializationTailByKey.delete(key.serializationKey);
          }
          if (
            key.kind === 'existing'
            && key.authorizationKey
            && inFlightKeyByAuthorizationKey.get(key.authorizationKey) === key.key
          ) {
            inFlightKeyByAuthorizationKey.delete(key.authorizationKey);
          }
        }
      })();
      inFlightByKey.set(key.key, promise);
      if (key.kind === 'existing') {
        serializationTailByKey.set(key.serializationKey, promise);
        if (key.authorizationKey) {
          inFlightKeyByAuthorizationKey.set(key.authorizationKey, key.key);
        }
      }
      return await promise;
    },
  };
}
