import { createHash } from 'node:crypto';

import {
  AcpConfigOptionOverridesV1Schema,
  readAgentRuntimeDescriptorV1,
  SessionMcpSelectionV1Schema,
  SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';

import { resolveCanonicalCodexBackendMode } from '@/rpc/handlers/codexBackendMode';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { normalizeSpawnSessionDirectory } from '@/rpc/handlers/spawnSessionOptionsContract';

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
  value: SpawnSessionOptions['agentRuntimeDescriptorV1'],
): Json {
  const parsed = readAgentRuntimeDescriptorV1(value);
  if (!parsed) return null;

  return toStableJson(parsed, new WeakSet());
}

function buildSpawnSemanticFingerprint(options: SpawnSessionOptions): Json {
  const directory = normalizeSpawnSessionDirectory(String(options.directory ?? ''), process.env);
  const backendTarget = options.backendTarget === undefined
    ? null
    : toStableJson(options.backendTarget, new WeakSet());
  const transcriptStorage = normalizeNonEmptyString(options.transcriptStorage) === 'direct' ? 'direct' : null;
  const profileId = options.profileId !== undefined ? String(options.profileId ?? '') : null;
  const terminal = options.terminal ?? null;
  const permissionMode = normalizeNonEmptyString(options.permissionMode);
  const agentModeId = normalizeNonEmptyString(options.agentModeId);
  const modelId = normalizeNonEmptyString(options.modelId);
  const codexBackendMode = resolveCanonicalCodexBackendMode({
    codexBackendMode: options.codexBackendMode,
    experimentalCodexAcp: options.experimentalCodexAcp,
    agentRuntimeDescriptorV1: options.agentRuntimeDescriptorV1,
  }) ?? null;
  const resume = normalizeNonEmptyString(options.resume);
  const pendingFirstInput = options.pendingFirstInput ?? null;
  const initialTranscriptAfterSeq = typeof options.initialTranscriptAfterSeq === 'number'
    && Number.isSafeInteger(options.initialTranscriptAfterSeq)
    && options.initialTranscriptAfterSeq >= 0
    ? options.initialTranscriptAfterSeq
    : null;

  return {
    directory,
    backendTarget,
    runtimeDescriptor: normalizeRuntimeDescriptorForFingerprint(options.agentRuntimeDescriptorV1),
    approvedNewDirectoryCreation: options.approvedNewDirectoryCreation === true,
    profileId,
    terminal: toStableJson(terminal, new WeakSet()),
    windowsRemoteSessionLaunchMode: normalizeNonEmptyString(options.windowsRemoteSessionLaunchMode),
    windowsRemoteSessionConsole: normalizeNonEmptyString(options.windowsRemoteSessionConsole),
    windowsTerminalWindowName: normalizeNonEmptyString(options.windowsTerminalWindowName),
    permissionMode,
    agentModeId,
    modelId,
    codexBackendMode,
    resume,
    pendingFirstInputHash: pendingFirstInput ? sha256Hex(stableJsonStringify(pendingFirstInput)) : null,
    initialTranscriptAfterSeq,
    initialGoal: options.initialGoal === undefined ? null : toStableJson(options.initialGoal, new WeakSet()),
    attachMetadataIdentityPolicy: normalizeNonEmptyString(options.attachMetadataIdentityPolicy),
    existingSessionAttachPayloadHash: options.existingSessionAttachPayload === undefined
      ? null
      : sha256Hex(stableJsonStringify(options.existingSessionAttachPayload)),
    envValueHashes: hashRecordValues(options.environmentVariables),
    connectedServicesHash: options.connectedServices === undefined
      ? null
      : sha256Hex(stableJsonStringify(options.connectedServices)),
    connectedServiceMaterializationIdentity: options.connectedServiceMaterializationIdentityV1 === undefined
      ? null
      : toStableJson(options.connectedServiceMaterializationIdentityV1, new WeakSet()),
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
    const requestKey = executionAuthorization
      ? `:request:${sha256Hex(stableJsonStringify({
        executionAuthorization,
        spawnSemantics: buildSpawnSemanticFingerprint(options),
      }))}`
      : '';
    return {
      kind: 'existing',
      key: `${serializationKey}${requestKey}`,
      serializationKey,
      ...(executionAuthorization
        ? { authorizationKey: `${serializationKey}:authorization:${sha256Hex(stableJsonStringify(executionAuthorization))}` }
        : {}),
    };
  }

  const spawnNonce = normalizeNonEmptyString(options.spawnNonce);
  if (spawnNonce) {
    return { kind: 'new', key: `new:nonce:${sha256Hex(spawnNonce)}` };
  }

  return { kind: 'new', key: `new:${sha256Hex(stableJsonStringify(buildSpawnSemanticFingerprint(options)))}` };
}

export function createSpawnRequestCoalescer(params: Readonly<{ recentSuccessTtlMs: number; nowMs?: () => number }>) {
  const inFlightByKey = new Map<string, Promise<SpawnSessionResult>>();
  const inFlightKeyByAuthorizationKey = new Map<string, string>();
  const serializationTailByKey = new Map<string, Promise<SpawnSessionResult>>();
  const recentSuccessByKey = new Map<string, { result: SpawnSessionResult; atMs: number }>();
  const nowMs = params.nowMs ?? (() => Date.now());
  const ttlMs = Math.max(0, Math.floor(Number(params.recentSuccessTtlMs)));

  const tryGetRecent = (key: DaemonSpawnRequestKey): SpawnSessionResult | null => {
    if (key.kind === 'existing' && !key.authorizationKey) return null;
    if (ttlMs <= 0) return null;
    const cached = recentSuccessByKey.get(key.key);
    if (!cached) return null;
    const age = nowMs() - cached.atMs;
    if (!Number.isFinite(age) || age < 0 || age > ttlMs) {
      recentSuccessByKey.delete(key.key);
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
      return;
    }
    const sessionId = normalizeNonEmptyString(result.sessionId);
    if (!sessionId) return;
    recentSuccessByKey.set(key.key, {
      result: { type: 'success', sessionId },
      atMs: nowMs(),
    });
  };

  return {
    run: async (key: DaemonSpawnRequestKey, work: () => Promise<SpawnSessionResult>): Promise<SpawnSessionResult> => {
      const cached = tryGetRecent(key);
      if (cached) return cached;

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
