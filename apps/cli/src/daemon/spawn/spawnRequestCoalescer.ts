import { createHash } from 'node:crypto';

import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

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

export type DaemonSpawnRequestKey = Readonly<{ kind: 'existing' | 'new'; key: string }>;

export function computeDaemonSpawnRequestKey(options: SpawnSessionOptions): DaemonSpawnRequestKey {
  const existingSessionId = normalizeNonEmptyString(options.existingSessionId);
  if (existingSessionId) {
    return { kind: 'existing', key: `existing:${existingSessionId}` };
  }

  const directory = normalizeNonEmptyString(options.directory) ?? '';
  const agent = normalizeNonEmptyString(options.agent) ?? null;
  const spawnNonce = normalizeNonEmptyString(options.spawnNonce);
  const profileId = options.profileId !== undefined ? String(options.profileId ?? '') : null;
  const terminal = options.terminal ?? null;
  const windowsRemoteSessionConsole = normalizeNonEmptyString(options.windowsRemoteSessionConsole);

  const permissionMode = normalizeNonEmptyString(options.permissionMode);

  const modelId = normalizeNonEmptyString(options.modelId);

  const resume = normalizeNonEmptyString(options.resume);
  const experimentalCodexResume = options.experimentalCodexResume === true;
  const experimentalCodexAcp = options.experimentalCodexAcp === true;

  const token = normalizeNonEmptyString(options.token);
  const initialPrompt = normalizeNonEmptyString(options.initialPrompt);

  const environmentVariables = options.environmentVariables;
  const connectedServices = options.connectedServices;

  const fingerprint = {
    directory,
    agent,
    approvedNewDirectoryCreation: options.approvedNewDirectoryCreation === true,
    profileId,
    terminal: toStableJson(terminal, new WeakSet()),
    windowsRemoteSessionConsole: windowsRemoteSessionConsole ?? null,
    permissionMode: permissionMode ?? null,
    modelId: modelId ?? null,
    resume: resume ?? null,
    experimentalCodexResume,
    experimentalCodexAcp,
    tokenHash: token ? sha256Hex(token) : null,
    initialPromptHash: initialPrompt ? sha256Hex(initialPrompt) : null,
    envValueHashes: hashRecordValues(environmentVariables),
    connectedServicesHash: connectedServices === undefined ? null : sha256Hex(stableJsonStringify(connectedServices)),
    ...(spawnNonce ? { spawnNonce } : {}),
  } as const;

  return { kind: 'new', key: `new:${sha256Hex(stableJsonStringify(fingerprint))}` };
}

export function createSpawnRequestCoalescer(params: Readonly<{ recentSuccessTtlMs: number; nowMs?: () => number }>) {
  const inFlightByKey = new Map<string, Promise<SpawnSessionResult>>();
  const recentSuccessByKey = new Map<string, { sessionId: string; atMs: number }>();
  const nowMs = params.nowMs ?? (() => Date.now());
  const ttlMs = Math.max(0, Math.floor(Number(params.recentSuccessTtlMs)));

  const tryGetRecent = (key: DaemonSpawnRequestKey): SpawnSessionResult | null => {
    if (key.kind !== 'new') return null;
    if (ttlMs <= 0) return null;
    const cached = recentSuccessByKey.get(key.key);
    if (!cached) return null;
    const age = nowMs() - cached.atMs;
    if (!Number.isFinite(age) || age < 0 || age > ttlMs) {
      recentSuccessByKey.delete(key.key);
      return null;
    }
    return { type: 'success', sessionId: cached.sessionId };
  };

  const recordRecentSuccess = (key: DaemonSpawnRequestKey, result: SpawnSessionResult) => {
    if (key.kind !== 'new') return;
    if (ttlMs <= 0) return;
    if (result.type !== 'success') return;
    const sessionId = normalizeNonEmptyString(result.sessionId);
    if (!sessionId) return;
    recentSuccessByKey.set(key.key, { sessionId, atMs: nowMs() });
  };

  return {
    run: async (key: DaemonSpawnRequestKey, work: () => Promise<SpawnSessionResult>): Promise<SpawnSessionResult> => {
      const cached = tryGetRecent(key);
      if (cached) return cached;

      const existing = inFlightByKey.get(key.key);
      if (existing) return await existing;

      const promise = (async () => {
        try {
          const result = await work();
          recordRecentSuccess(key, result);
          return result;
        } finally {
          inFlightByKey.delete(key.key);
        }
      })();
      inFlightByKey.set(key.key, promise);
      return await promise;
    },
  };
}
