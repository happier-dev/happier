import { z } from 'zod';

import {
  OPEN_CODE_BROKER_PROVIDERS,
  type OpenCodeBrokerProvider,
} from './openCodeBrokerPluginEnv';
import { lazySchema } from '@happier-dev/protocol';

/**
 * Daemon-side registry of broker load handshakes (F4).
 *
 * The broker plugin, on activation inside the OpenCode runtime, POSTs a "loaded" handshake to the
 * daemon (via the scoped-token bridge), keyed by the stable connected-service selection identity plus
 * the per-spawn load nonce. The
 * preflight (`verifyOpenCodeBrokerReadyForConnectedSession`) consults this registry — through the
 * daemon control client — to confirm the plugin ACTUALLY loaded before the first connected prompt,
 * rather than only that its file exists on disk.
 *
 * This Map is intentionally daemon-process-local. OpenCode's independently managed child can outlive
 * the daemon, so its exact activation fact is copied into that child's existing trusted state only
 * after the daemon observes this handshake and re-verifies the process generation. Pi's stdio child
 * is not independently adoptable; its surviving PiRpcBackend retains the exact readiness result and
 * every subprocess replacement rotates the nonce and handshakes again.
 */

const OpenCodeBrokerProviderSchema: z.ZodType<OpenCodeBrokerProvider> = lazySchema(() => z.enum(
  [...OPEN_CODE_BROKER_PROVIDERS] as [OpenCodeBrokerProvider, ...OpenCodeBrokerProvider[]],
));

export const OpenCodeBrokerLoadHandshakeRuntimeKindSchema = lazySchema(() => z.enum([
  'opencode_managed_server',
  'pi_rpc_process',
]));
export type OpenCodeBrokerLoadHandshakeRuntimeKind =
  z.infer<typeof OpenCodeBrokerLoadHandshakeRuntimeKindSchema>;

function doesRuntimeKindMatchSelectionIdentity(
  runtimeKind: OpenCodeBrokerLoadHandshakeRuntimeKind,
  selectionIdentity: string,
): boolean {
  return runtimeKind === 'opencode_managed_server'
    ? selectionIdentity.startsWith('opencode|')
    : selectionIdentity.startsWith('pi|');
}

function isExactRuntimeSelectionIdentity(
  runtimeKind: OpenCodeBrokerLoadHandshakeRuntimeKind,
  selectionIdentity: string,
): boolean {
  const prefix = runtimeKind === 'opencode_managed_server' ? 'opencode|' : 'pi|';
  return selectionIdentity.startsWith(prefix) && selectionIdentity.length > prefix.length;
}

const OpenCodeBrokerLoadHandshakeBaseRequestSchema = lazySchema(() => z.object({
  runtimeKind: OpenCodeBrokerLoadHandshakeRuntimeKindSchema,
  selectionIdentity: z.string().trim().min(1).max(4_096),
  loadNonce: z.string().trim().min(1).max(256),
  providers: z.array(OpenCodeBrokerProviderSchema)
    .min(1)
    .max(OPEN_CODE_BROKER_PROVIDERS.length),
  pluginVersion: z.string().trim().min(1).max(64),
}).strict());

function addRuntimeKindSelectionIdentityIssue(
  value: Readonly<{
    runtimeKind: OpenCodeBrokerLoadHandshakeRuntimeKind;
    selectionIdentity: string;
  }>,
  context: z.RefinementCtx,
): void {
  if (
    doesRuntimeKindMatchSelectionIdentity(value.runtimeKind, value.selectionIdentity)
    && isExactRuntimeSelectionIdentity(value.runtimeKind, value.selectionIdentity)
  ) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['selectionIdentity'],
    message: 'Selection identity does not match the broker runtime kind',
  });
}

export const OpenCodeBrokerLoadHandshakeRequestSchema =
  lazySchema(() => OpenCodeBrokerLoadHandshakeBaseRequestSchema.extend({
  processPid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine(addRuntimeKindSelectionIdentityIssue));
export const OpenCodeBrokerLoadHandshakeStatusRequestSchema =
  lazySchema(() => OpenCodeBrokerLoadHandshakeBaseRequestSchema.superRefine(addRuntimeKindSelectionIdentityIssue));

export type OpenCodeBrokerLoadHandshakeRequest = z.infer<typeof OpenCodeBrokerLoadHandshakeRequestSchema>;
export type OpenCodeBrokerLoadHandshakeKey = Readonly<{
  runtimeKind: OpenCodeBrokerLoadHandshakeRuntimeKind;
  selectionIdentity: string;
  loadNonce: string;
  providers: readonly OpenCodeBrokerProvider[];
  pluginVersion: string;
}>;
export type OpenCodeBrokerLoadHandshakeObservation = Readonly<{
  runtimeKind: OpenCodeBrokerLoadHandshakeRuntimeKind;
  selectionIdentity: string;
  loadNonce: string;
  providers: readonly OpenCodeBrokerProvider[];
  pluginVersion: string;
  processPid: number;
  observedAtMs: number;
}>;

type HandshakeRecord = Readonly<{
  observedAtMs: number;
  providers: readonly OpenCodeBrokerProvider[];
  pluginVersion: string;
  processPid: number;
  runtimeKind: OpenCodeBrokerLoadHandshakeRuntimeKind;
  conflicted: boolean;
}>;

// One daemon normally observes only a handful of live provider children. Keep retries idempotent
// without time-expiring healthy children, while bounding malformed/abandoned nonce accumulation.
const MAX_DAEMON_HANDSHAKE_RECORDS = 1_024;
const handshakesByIdentityAndNonce = new Map<string, HandshakeRecord>();

function enforceHandshakeRegistryBound(): void {
  while (handshakesByIdentityAndNonce.size > MAX_DAEMON_HANDSHAKE_RECORDS) {
    const oldestKey = handshakesByIdentityAndNonce.keys().next().value;
    if (typeof oldestKey !== 'string') return;
    handshakesByIdentityAndNonce.delete(oldestKey);
  }
}

function normalizeHandshakeKey(
  input: Pick<OpenCodeBrokerLoadHandshakeKey, 'selectionIdentity' | 'loadNonce'>,
): string | null {
  const identity = input.selectionIdentity.trim();
  const nonce = input.loadNonce.trim();
  if (!identity || !nonce) return null;
  return `${identity}\0${nonce}`;
}

function normalizeProviders(providers: readonly string[]): readonly OpenCodeBrokerProvider[] {
  return [...new Set(
    providers
      .map((provider) => provider.trim())
      .filter((provider): provider is OpenCodeBrokerProvider =>
        OPEN_CODE_BROKER_PROVIDERS.some((candidate) => candidate === provider)),
  )].sort();
}

function haveExactProviders(actual: readonly string[], expected: readonly string[]): boolean {
  const normalizedActual = normalizeProviders(actual);
  const normalizedExpected = normalizeProviders(expected);
  return normalizedActual.length === normalizedExpected.length
    && normalizedActual.every((provider, index) => provider === normalizedExpected[index]);
}

export function recordOpenCodeBrokerLoadHandshake(
  request: Readonly<{
    runtimeKind: OpenCodeBrokerLoadHandshakeRuntimeKind;
    selectionIdentity: string;
    loadNonce: string;
    providers: readonly string[];
    pluginVersion: string;
    processPid: number;
  }>,
  nowMs: number = Date.now(),
): void {
  const key = normalizeHandshakeKey(request);
  if (!key) return;
  const pluginVersion = request.pluginVersion.trim();
  const providers = normalizeProviders(request.providers);
  if (!pluginVersion || providers.length === 0 || !Number.isInteger(request.processPid) || request.processPid <= 0) {
    return;
  }
  const existing = handshakesByIdentityAndNonce.get(key);
  if (existing) {
    const conflicted = existing.conflicted
      || existing.runtimeKind !== request.runtimeKind
      || existing.pluginVersion !== pluginVersion
      || existing.processPid !== request.processPid;
    handshakesByIdentityAndNonce.delete(key);
    handshakesByIdentityAndNonce.set(key, {
      observedAtMs: Math.max(existing.observedAtMs, nowMs),
      providers: normalizeProviders([...existing.providers, ...providers]),
      pluginVersion: existing.pluginVersion,
      processPid: existing.processPid,
      runtimeKind: existing.runtimeKind,
      conflicted,
    });
    enforceHandshakeRegistryBound();
    return;
  }
  handshakesByIdentityAndNonce.set(key, {
    observedAtMs: nowMs,
    providers,
    pluginVersion,
    processPid: request.processPid,
    runtimeKind: request.runtimeKind,
    conflicted: false,
  });
  enforceHandshakeRegistryBound();
}

export function readOpenCodeBrokerLoadHandshakeObservation(
  keyInput: OpenCodeBrokerLoadHandshakeKey,
  _nowMs: number = Date.now(),
): OpenCodeBrokerLoadHandshakeObservation | null {
  const key = normalizeHandshakeKey(keyInput);
  if (!key) return null;
  const record = handshakesByIdentityAndNonce.get(key);
  if (!record || record.conflicted) return null;
  if (record.runtimeKind !== keyInput.runtimeKind) return null;
  if (record.pluginVersion !== keyInput.pluginVersion.trim()) return null;
  if (!haveExactProviders(record.providers, keyInput.providers)) return null;
  return {
    runtimeKind: record.runtimeKind,
    selectionIdentity: keyInput.selectionIdentity.trim(),
    loadNonce: keyInput.loadNonce.trim(),
    providers: [...record.providers],
    pluginVersion: record.pluginVersion,
    processPid: record.processPid,
    observedAtMs: record.observedAtMs,
  };
}

export function wasOpenCodeBrokerLoadHandshakeObserved(
  keyInput: OpenCodeBrokerLoadHandshakeKey,
  nowMs: number = Date.now(),
): boolean {
  return readOpenCodeBrokerLoadHandshakeObservation(keyInput, nowMs) !== null;
}

export function isOpenCodeBrokerLoadHandshakeConflicted(
  keyInput: Pick<OpenCodeBrokerLoadHandshakeKey, 'selectionIdentity' | 'loadNonce'>,
): boolean {
  const key = normalizeHandshakeKey(keyInput);
  return key ? handshakesByIdentityAndNonce.get(key)?.conflicted === true : false;
}

export function resetOpenCodeBrokerLoadHandshakesForTests(): void {
  handshakesByIdentityAndNonce.clear();
}
