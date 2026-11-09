import { createHash } from 'node:crypto';

import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { readRuntimeDescriptorV1 } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { SessionCapabilitySelectionV1Schema } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';

import { readCanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { pickSessionCreateOriginFields } from '@/session/shared/sessionCreateOrigin';

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

function normalizeCapabilitySelectionForFingerprint(value: SpawnSessionOptions['capabilitySelection']): Json {
  if (value === undefined) return null;
  const parsed = SessionCapabilitySelectionV1Schema.safeParse(value);
  if (!parsed.success) return null;

  const { mcp, skills } = parsed.data;
  return {
    ...(mcp ? { mcp: {
      v: mcp.v,
      managedServersEnabled: mcp.managedServersEnabled,
      happierToolsEnabled: mcp.happierToolsEnabled ?? true,
      forceIncludeServerIds: [...mcp.forceIncludeServerIds].sort(),
      forceExcludeServerIds: [...mcp.forceExcludeServerIds].sort(),
    } } : {}),
    ...(skills ? { skills: {
      v: skills.v,
      forceIncludeSkillIds: [...skills.forceIncludeSkillIds].sort(),
      forceExcludeSkillIds: [...skills.forceExcludeSkillIds].sort(),
      excludeNativeSkillNames: [...skills.excludeNativeSkillNames].sort(),
    } } : {}),
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
    directoryKind: options.directoryKind ?? 'path',
    agentTarget: options.agentTarget === undefined
      ? null
      : toStableJson(options.agentTarget, new WeakSet()),
    backendTarget: options.backendTarget === undefined
      ? null
      : toStableJson(options.backendTarget, new WeakSet()),
    runtimeDescriptor: normalizeRuntimeDescriptorForFingerprint(runtimeSelection.runtimeDescriptorV1),
    approvedNewDirectoryCreation: options.approvedNewDirectoryCreation === true,
    profileId: options.profileId !== undefined ? String(options.profileId ?? '') : null,
    terminal: toStableJson(options.terminal ?? null, new WeakSet()),
    windowsRemoteSessionLaunchMode: normalizeNonEmptyString(options.windowsRemoteSessionLaunchMode),
    windowsRemoteSessionConsole: normalizeNonEmptyString(options.windowsRemoteSessionConsole),
    windowsTerminalWindowName: normalizeNonEmptyString(options.windowsTerminalWindowName),
    permissionMode: normalizeNonEmptyString(options.permissionMode),
    agentModeId: normalizeNonEmptyString(options.agentModeId),
    modelSelection: normalizeModelSelectionForFingerprint(options.modelSelection),
    // The Agent's own opaque session id: two requests that differ only in its
    // whitespace name different sessions and must not share one spawn.
    resume: readNonBlankOpaqueIdentifier(options.resume),
    initialAccessHash: options.initialAccess === undefined
      ? null
      : sha256Hex(stableJsonStringify(options.initialAccess)),
    primaryTeamId: options.primaryTeamId === undefined ? null : [options.primaryTeamId],
    manager: options.manager ?? null,
    identity: options.identity ?? null,
    memoryEnabled: options.memoryEnabled ?? null,
    approvalProfileId: options.approvalProfileId ?? null,
    authoringOriginHash: options.authoringOrigin === undefined ? null : sha256Hex(stableJsonStringify(options.authoringOrigin)),
    initialSessionRolesHash: options.initialSessionRolesV1 === undefined
      ? null
      : sha256Hex(stableJsonStringify(options.initialSessionRolesV1)),
    creationOrigin: options.existingSessionId ? null : toStableJson(pickSessionCreateOriginFields(options), new WeakSet()),
    pendingFirstInputHash: options.pendingFirstInput === undefined
      ? null
      : sha256Hex(stableJsonStringify(options.pendingFirstInput)),
    initialGoalHash: options.initialGoal === undefined
      ? null
      : sha256Hex(stableJsonStringify(options.initialGoal)),
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
    capabilitySelection: normalizeCapabilitySelectionForFingerprint(options.capabilitySelection),
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
    const authorizationKey = executionAuthorization
      ? executionAuthorization.requestedAt === undefined
        ? `${serializationKey}:authorization:${sha256Hex(executionAuthorization.requestId)}`
        : `${serializationKey}:authorization-revision:${sha256Hex(stableJsonStringify({
            requestId: executionAuthorization.requestId,
            requestedAt: executionAuthorization.requestedAt,
          }))}`
      : null;
    const requestKey = `:request:${sha256Hex(stableJsonStringify({
      ...(executionAuthorization ? { executionAuthorization } : {}),
      spawnSemantics: buildSpawnSemanticFingerprint(options),
    }))}`;
    return {
      kind: 'existing',
      key: `${serializationKey}${requestKey}`,
      serializationKey,
      ...(authorizationKey
        ? { authorizationKey }
        : {}),
    };
  }

  const spawnNonce = normalizeNonEmptyString(options.spawnNonce);
  if (spawnNonce) {
    return { kind: 'new', key: `new:nonce:${sha256Hex(spawnNonce)}` };
  }

  return { kind: 'new', key: `new:${sha256Hex(stableJsonStringify(buildSpawnSemanticFingerprint(options)))}` };
}

export function createSpawnRequestCoalescer() {
  const inFlightByKey = new Map<string, {
    promise: Promise<SpawnSessionResult>;
    isAdmissionCurrent?: () => boolean;
  }>();
  const changeListeners = new Set<() => void>();
  const notifyChanged = () => { for (const listener of changeListeners) listener(); };
  const inFlightKeyByAuthorizationKey = new Map<string, string>();
  const serializationTailByKey = new Map<string, Promise<SpawnSessionResult>>();

  return {
    readInFlightRequests: () => [...inFlightByKey.values()].map(request => request.promise),
    subscribeChanges(listener: () => void) {
      changeListeners.add(listener);
      return () => { changeListeners.delete(listener); };
    },
    run: async (
      key: DaemonSpawnRequestKey,
      work: () => Promise<SpawnSessionResult>,
      isAdmissionCurrent?: () => boolean,
    ): Promise<SpawnSessionResult> => {
      const existing = inFlightByKey.get(key.key);
      // A fresh Resume must wait for retired work through the existing Session
      // lane, then run with its own admission instead of inheriting a refusal.
      if (existing && (existing.isAdmissionCurrent?.() ?? true)) return await existing.promise;

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
          return await work();
        } finally {
          const ownsInFlightKey = inFlightByKey.get(key.key)?.promise === promise;
          if (ownsInFlightKey) {
            inFlightByKey.delete(key.key);
            notifyChanged();
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
            && ownsInFlightKey
            && inFlightKeyByAuthorizationKey.get(key.authorizationKey) === key.key
          ) {
            inFlightKeyByAuthorizationKey.delete(key.authorizationKey);
          }
        }
      })();
      inFlightByKey.set(key.key, { promise, isAdmissionCurrent });
      notifyChanged();
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
