import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { AcpPermissionMode, ProviderScenario, ProviderUnderTest } from '../types';
import { hasStringSubstring, waitForAcpSidechainMessages } from '../assertions';
import { shapeOf, stableStringifyShape } from '../shape';
import { fetchMessagesSince, fetchSessionV2, patchSessionMetadataWithRetry } from '../../sessions';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../messageCrypto';
import { sleep } from '../../timing';
import { enqueuePendingQueueV2 } from '../../pendingQueueV2';
import {
  resolveAcpOutsideWorkspaceWriteAllowed,
  resolveAcpOutsideWorkspaceRequireTaskComplete,
  resolveAcpOutsideWorkspaceWriteMustComplete,
  resolveAcpToolPermissionPromptExpectation,
  yoloFlagForPermissionMode,
} from '../permissions/acpPermissionPrompts';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createUserScopedSocketCollector } from '../../socketClient';
import { withCapabilityProbeRetry } from '../harness/capabilityRetry';
import { enrichCapabilityProbeError } from '../harness/capabilityProbeFailure';
import { withTimeoutMs } from '../../timing/withTimeout';
import {
  makeAcpEditResultIncludesDiffScenario,
  makeAcpGlobListFilesScenario,
  makeAcpMultiFileEditScenario,
  makeAcpMultiFileEditIncludesDiffScenario,
  makeAcpFsPermissionExperimentScenario,
  makeAcpPatchIncludesDiffScenario,
  makeAcpPermissionExecuteWritesWorkspaceFileScenario,
  makeAcpPermissionPatchApplyScenario,
  makeAcpPermissionDenyOutsideWorkspaceReadScenario,
  makeAcpPermissionOutsideWorkspaceScenario,
  makeAcpReadInWorkspaceScenario,
  makeAcpReadMissingFileScenario,
  makeAcpResumeFreshSessionImportsHistoryScenario,
  makeAcpResumeLoadSessionScenario,
  makeAcpSearchKnownTokenScenario,
  makeAcpSearchLsEquivalenceScenario,
  makeAcpWriteInWorkspaceScenario,
  makeAcpWriteThenStreamMarkdownTableScenario,
} from './scenarios.acp';
import { cleanupOutsideWorkspacePath, makeOutsideWorkspacePath } from '../harness/outsideWorkspacePath';

type ScenarioFactory = (provider: ProviderUnderTest) => ProviderScenario;

function nonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function capabilityProbePostSatisfyTimeoutMs(providerId: string): number {
  return providerId === 'gemini' ? 180_000 : 120_000;
}

function capabilityProbeRpcTimeoutMs(providerId: string): number {
  return providerId === 'gemini' ? 150_000 : 90_000;
}

function capabilityProbeRetryOptions(providerId: string): { attempts: number; delayMs: number } {
  if (providerId === 'gemini') {
    return { attempts: 1, delayMs: 500 };
  }
  return { attempts: 3, delayMs: 500 };
}

export function resolveMachineIdCandidatesFromSettings(settingsLike: unknown): string[] {
  if (!settingsLike || typeof settingsLike !== 'object') return [];
  const settings = settingsLike as Record<string, unknown>;
  const out: string[] = [];

  const push = (value: unknown) => {
    const next = nonEmptyTrimmedString(value);
    if (!next) return;
    if (!out.includes(next)) out.push(next);
  };

  push(settings.machineId);

  const activeServerId = nonEmptyTrimmedString(settings.activeServerId);
  const byServerRaw = settings.machineIdByServerId;
  const byServer = byServerRaw && typeof byServerRaw === 'object' && !Array.isArray(byServerRaw)
    ? (byServerRaw as Record<string, unknown>)
    : null;
  if (activeServerId && byServer) {
    push(byServer[activeServerId]);
  }
  if (byServer) {
    for (const value of Object.values(byServer)) {
      push(value);
    }
  }

  return out;
}

async function waitForSessionActive(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const snap = await fetchSessionV2(params.baseUrl, params.token, params.sessionId).catch(() => null);
    if (snap?.active === true) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for session active (${params.sessionId})`);
}

async function resolveMachineIdsFromSettings(params: {
  settingsPath: string;
  timeoutMs: number;
}): Promise<string[]> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const raw = await readFile(params.settingsPath, 'utf8').catch(() => '');
    if (raw) {
      try {
        const json = JSON.parse(raw);
        const ids = resolveMachineIdCandidatesFromSettings(json);
        if (ids.length > 0) return ids;
      } catch {
        // ignore and retry
      }
    }
    await sleep(100);
  }
  return [];
}

export async function invokeRpcAcrossMachineIds(params: {
  ui: ReturnType<typeof createUserScopedSocketCollector>;
  machineIds: string[];
  method: string;
  payload: unknown;
  secret: Uint8Array;
  timeoutMs: number;
}): Promise<unknown> {
  const encrypted = encryptLegacyBase64(params.payload, params.secret);
  const deadline = Date.now() + params.timeoutMs;
  let lastMethodUnavailable: unknown = null;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    // Bound each rpcCall attempt by the remaining overall time budget so probes can't hang.
    const rpcAckTimeoutMs = Math.max(1, Math.min(remainingMs, 300_000));
    let unresolvedForAllCandidates = true;

    for (const machineId of params.machineIds) {
      const rpcMethod = `${machineId}:${params.method}`;
      try {
        const candidate = await withTimeoutMs({
          promise: params.ui.rpcCall<any>(rpcMethod, encrypted, rpcAckTimeoutMs),
          timeoutMs: rpcAckTimeoutMs,
          label: `rpcCall ${rpcMethod}`,
        });
        if (candidate && typeof candidate === 'object' && candidate.ok === true) {
          const decrypted = decryptLegacyBase64(String((candidate as any).result ?? ''), params.secret);
          return decrypted;
        }

        const errorCode =
          candidate && typeof candidate === 'object' && typeof (candidate as any).errorCode === 'string'
            ? String((candidate as any).errorCode)
            : '';
        if (errorCode === 'RPC_METHOD_NOT_AVAILABLE') {
          lastMethodUnavailable = { machineId, candidate };
          continue;
        }

        throw new Error(
          `rpc ${params.method} failed: ${JSON.stringify(
            candidate && typeof candidate === 'object' ? candidate : { candidate },
            null,
            2,
          )}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const normalized = message.toLowerCase();
        if (normalized.includes('timed out') || normalized.includes('timeout')) {
          lastMethodUnavailable = { machineId, error: message };
          continue;
        }
        if (message.includes('RPC_METHOD_NOT_AVAILABLE')) {
          lastMethodUnavailable = { machineId, error: message };
          continue;
        }
        throw error;
      }
    }

    if (unresolvedForAllCandidates) {
      const pauseMs = Math.min(250, Math.max(0, deadline - Date.now()));
      if (pauseMs > 0) await sleep(pauseMs);
    }
  }

  throw new Error(
    `rpc ${params.method} unavailable after wait (${JSON.stringify(
      lastMethodUnavailable ?? { errorCode: 'RPC_METHOD_NOT_AVAILABLE' },
      null,
      2,
    )})`,
  );
}

async function invokeCapabilitiesMethod(params: {
  baseUrl: string;
  token: string;
  cliHome: string;
  secret: Uint8Array;
  rpcMethod: typeof RPC_METHODS.CAPABILITIES_INVOKE | typeof RPC_METHODS.CAPABILITIES_DETECT;
  payload: unknown;
  timeoutMs?: number;
}): Promise<unknown> {
  const settingsPath = join(params.cliHome, 'settings.json');
  const machineIds = await resolveMachineIdsFromSettings({ settingsPath, timeoutMs: 15_000 });
  if (machineIds.length === 0) {
    throw new Error(`machineId not found in settings.json (${settingsPath})`);
  }

  const ui = createUserScopedSocketCollector(params.baseUrl, params.token);
  ui.connect();
  const startedConnectAt = Date.now();
  while (!ui.isConnected() && Date.now() - startedConnectAt < 15_000) {
    await sleep(50);
  }
  if (!ui.isConnected()) {
    ui.close();
    throw await enrichCapabilityProbeError({
      error: new Error('timed out connecting user socket'),
      cliHome: params.cliHome,
      context: params.rpcMethod,
    });
  }

  try {
    try {
      return await invokeRpcAcrossMachineIds({
        ui,
        machineIds,
        method: params.rpcMethod,
        payload: params.payload,
        secret: params.secret,
        timeoutMs: params.timeoutMs ?? 90_000,
      });
    } catch (error) {
      throw await enrichCapabilityProbeError({
        error,
        cliHome: params.cliHome,
        context: params.rpcMethod,
      });
    }
  } finally {
    ui.close();
  }
}

async function callSessionScopedRpc(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  method: string;
  payload: unknown;
  secret: Uint8Array;
  timeoutMs?: number;
}): Promise<unknown> {
  const ui = createUserScopedSocketCollector(params.baseUrl, params.token);
  ui.connect();
  const startedConnectAt = Date.now();
  while (!ui.isConnected() && Date.now() - startedConnectAt < 15_000) {
    await sleep(50);
  }
  if (!ui.isConnected()) {
    ui.close();
    throw new Error(`timed out connecting user socket for ${params.sessionId}:${params.method}`);
  }

  try {
    const encrypted = encryptLegacyBase64(params.payload, params.secret);
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 30_000;
    const response = await ui.rpcCall<any>(`${params.sessionId}:${params.method}`, encrypted, timeoutMs);
    if (!response || typeof response !== 'object' || response.ok !== true) {
      throw new Error(`session rpc ${params.method} returned non-ok response`);
    }
    const resultRaw = (response as any).result;
    if (typeof resultRaw !== 'string' || resultRaw.length === 0) return null;
    return decryptLegacyBase64(resultRaw, params.secret);
  } finally {
    ui.close();
  }
}

async function enqueueSessionPromptForScenario(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  text: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const localId = randomUUID();
  const payload = {
    role: 'user',
    content: { type: 'text', text: params.text },
    localId,
    meta: {
      source: 'ui',
      sentFrom: 'e2e',
      ...(params.meta ?? {}),
    },
  };
  const ciphertext = encryptLegacyBase64(payload, params.secret);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const res = await enqueuePendingQueueV2({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      localId,
      ciphertext,
      timeoutMs: 20_000,
    }).catch(() => null);
    if (res?.status === 200) return;
    await sleep(100);
  }
  throw new Error(`timed out enqueueing prompt for ${params.sessionId}`);
}

async function waitForAssistantMessageContaining(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  requiredSubstring?: string;
  requiredSubstrings?: string[];
  afterSeqStart?: number;
  allowAnyAssistantMessage?: boolean;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  let afterSeq = typeof params.afterSeqStart === 'number' ? params.afterSeqStart : 0;
  const streamedTextByKey = new Map<string, string>();
  const requiredSubstring = typeof params.requiredSubstring === 'string' && params.requiredSubstring.length > 0
    ? params.requiredSubstring
    : null;
  const requiredSubstrings = Array.isArray(params.requiredSubstrings)
    ? params.requiredSubstrings
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
    : [];
  while (Date.now() < deadline) {
    const rows = await fetchMessagesSince({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      afterSeq,
    }).catch(() => []);

    if (rows.length > 0) {
      afterSeq = Math.max(afterSeq, ...rows.map((row) => row.seq));
    }

    for (const row of rows) {
      try {
        const decrypted = decryptLegacyBase64(row.content.c, params.secret) as any;
        if (!decrypted || typeof decrypted !== 'object') continue;
        const role = typeof decrypted.role === 'string' ? decrypted.role : '';
        if (params.allowAnyAssistantMessage === true) return;

        const candidateTexts: string[] = [];
        const meta = decrypted.meta && typeof decrypted.meta === 'object' ? (decrypted.meta as Record<string, unknown>) : null;
        const streamKey = meta && typeof meta.happierStreamKey === 'string' ? String(meta.happierStreamKey) : null;
        const sidechainStreamKey =
          meta && typeof meta.happierSidechainStreamKey === 'string' ? String(meta.happierSidechainStreamKey) : null;
        const anyStreamKey = streamKey ?? sidechainStreamKey;

        if (role === 'assistant') {
          if (typeof decrypted.content === 'string') {
            candidateTexts.push(decrypted.content);
          } else if (decrypted.content && typeof decrypted.content === 'object') {
            const content = decrypted.content as Record<string, unknown>;
            const text = typeof content.text === 'string' ? content.text : '';
            if (text) candidateTexts.push(text);
            const parts = Array.isArray(content.parts) ? content.parts : [];
            for (const part of parts) {
              if (!part || typeof part !== 'object') continue;
              const partText = typeof (part as Record<string, unknown>).text === 'string' ? String((part as Record<string, unknown>).text) : '';
              if (partText) candidateTexts.push(partText);
            }
          }
        }

        if (role === 'agent') {
          const content = decrypted.content && typeof decrypted.content === 'object'
            ? (decrypted.content as Record<string, unknown>)
            : null;
          if (content?.type === 'acp') {
            const data = content.data && typeof content.data === 'object'
              ? (content.data as Record<string, unknown>)
              : null;
            if (data?.type === 'message' && typeof data.message === 'string') {
              candidateTexts.push(data.message);
              if (anyStreamKey) {
                const prev = streamedTextByKey.get(anyStreamKey) ?? '';
                const next = prev + data.message;
                streamedTextByKey.set(anyStreamKey, next);
                candidateTexts.push(next);
              }
            }
          }
        }

        const raw = JSON.stringify(decrypted);
        const haystacks = [...candidateTexts, raw];
        if (requiredSubstring && haystacks.some((value) => value.includes(requiredSubstring))) return;
        if (requiredSubstrings.length > 0 && requiredSubstrings.every((needle) => haystacks.some((value) => value.includes(needle)))) return;
      } catch {
        // ignore malformed row
      }
    }

    await sleep(250);
  }
  if (requiredSubstring) {
    throw new Error(`Timed out waiting for assistant message containing ${requiredSubstring}`);
  }
  if (requiredSubstrings.length > 0) {
    throw new Error(`Timed out waiting for assistant message containing all required substrings (${requiredSubstrings.join(', ')})`);
  }
  throw new Error('Timed out waiting for assistant message');
}

function assertProviderId(provider: ProviderUnderTest, expected: ProviderUnderTest['id']): void {
  if (provider.id !== expected) throw new Error(`Scenario is only supported for provider ${expected} (got ${provider.id})`);
}

function acpProviderId(provider: ProviderUnderTest): string {
  return provider.traceProvider ?? provider.id;
}

function acpResumeMetadataKey(providerId: ProviderUnderTest['id']): string {
  if (providerId === 'codex') return 'codexSessionId';
  if (providerId === 'kilo') return 'kiloSessionId';
  if (providerId === 'gemini') return 'geminiSessionId';
  if (providerId === 'qwen') return 'qwenSessionId';
  if (providerId === 'kimi') return 'kimiSessionId';
  if (providerId === 'auggie') return 'auggieSessionId';
  return 'opencodeSessionId';
}

export function abortContinuationFollowupSubstrings(
  providerId: ProviderUnderTest['id'],
  followupSentinel: string,
  memorySentinel: string,
): string[] {
  if (providerId === 'kimi' || providerId === 'auggie' || providerId === 'kilo' || providerId === 'pi') return [followupSentinel];
  return [followupSentinel, memorySentinel];
}

function relaxAuggieResumeScenario(provider: ProviderUnderTest, scenario: ProviderScenario): ProviderScenario {
  if (provider.id !== 'auggie') return scenario;
  return {
    ...scenario,
    requiredAnyFixtureKeys: undefined,
    requiredTraceSubstrings: undefined,
  };
}

function tuneResumeScenarioForProvider(provider: ProviderUnderTest, scenario: ProviderScenario): ProviderScenario {
  const auggieRelaxed = relaxAuggieResumeScenario(provider, scenario);
  if (provider.id !== 'codex') return auggieRelaxed;
  return {
    ...auggieRelaxed,
    inactivityTimeoutMs: 240_000,
  };
}

function appendKimiUnknownFixtureAlias(key: string): string[] {
  const normalized = key.trim();
  if (!normalized.startsWith('acp/kimi/')) return [key];
  const parts = normalized.split('/');
  if (parts.length !== 4) return [key];
  const kind = parts[2];
  const toolName = parts[3];
  if (toolName === 'unknown') return [key];
  if (kind !== 'tool-call' && kind !== 'tool-result' && kind !== 'permission-request') return [key];
  return [key, `acp/kimi/${kind}/unknown`];
}

function withKimiUnknownToolFixtureAliases(provider: ProviderUnderTest, scenario: ProviderScenario): ProviderScenario {
  if (provider.id !== 'kimi') return scenario;

  const dedupeKeys = (keys: string[] | undefined): string[] | undefined => {
    if (!Array.isArray(keys) || keys.length === 0) return keys;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  };

  const dedupeAliasBucket = (bucket: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const key of bucket) {
      for (const alias of appendKimiUnknownFixtureAlias(key)) {
        if (seen.has(alias)) continue;
        seen.add(alias);
        out.push(alias);
      }
    }
    return out;
  };

  const dedupeBuckets = (buckets: string[][] | undefined): string[][] | undefined => {
    if (!Array.isArray(buckets) || buckets.length === 0) return buckets;
    return buckets.map((bucket) => dedupeAliasBucket(bucket));
  };

  const aliasRequiredKeysIntoAnyBuckets = (
    keys: string[] | undefined,
  ): { requiredFixtureKeys: string[] | undefined; requiredAnyFixtureKeys: string[][] | undefined } => {
    if (!Array.isArray(keys) || keys.length === 0) {
      return { requiredFixtureKeys: keys, requiredAnyFixtureKeys: undefined };
    }

    const requiredFixtureKeys: string[] = [];
    const requiredAnyFixtureKeys: string[][] = [];
    for (const key of keys) {
      const aliases = dedupeKeys(appendKimiUnknownFixtureAlias(key)) ?? [key];
      if (aliases.length <= 1) {
        requiredFixtureKeys.push(key);
        continue;
      }
      requiredAnyFixtureKeys.push(aliases);
    }

    return {
      requiredFixtureKeys: dedupeKeys(requiredFixtureKeys),
      requiredAnyFixtureKeys: dedupeBuckets(requiredAnyFixtureKeys),
    };
  };

  const mergeAnyBuckets = (left: string[][] | undefined, right: string[][] | undefined): string[][] | undefined => {
    if (!left && !right) return undefined;
    return dedupeBuckets([...(left ?? []), ...(right ?? [])]);
  };

  const steps = Array.isArray(scenario.steps)
    ? scenario.steps.map((step) => {
      if (!step?.satisfaction) return step;
      const split = aliasRequiredKeysIntoAnyBuckets(step.satisfaction.requiredFixtureKeys);
      return {
        ...step,
        satisfaction: {
          ...step.satisfaction,
          requiredFixtureKeys: split.requiredFixtureKeys,
          requiredAnyFixtureKeys: mergeAnyBuckets(
            split.requiredAnyFixtureKeys,
            dedupeBuckets(step.satisfaction.requiredAnyFixtureKeys),
          ),
        },
      };
    })
    : scenario.steps;

  const split = aliasRequiredKeysIntoAnyBuckets(scenario.requiredFixtureKeys);
  return {
    ...scenario,
    requiredFixtureKeys: split.requiredFixtureKeys,
    requiredAnyFixtureKeys: mergeAnyBuckets(
      split.requiredAnyFixtureKeys,
      dedupeBuckets(scenario.requiredAnyFixtureKeys),
    ),
    steps,
  };
}

function outsideWorkspaceScenarioIdByMode(mode: Exclude<AcpPermissionMode, 'plan'>): string {
  if (mode === 'default') return 'permission_mode_default_outside_workspace';
  if (mode === 'safe-yolo') return 'permission_mode_safe_yolo_outside_workspace';
  if (mode === 'read-only') return 'permission_mode_read_only_outside_workspace';
  return 'permission_mode_yolo_outside_workspace';
}

function outsideWorkspaceScenarioTitleByMode(mode: Exclude<AcpPermissionMode, 'plan'>): string {
  if (mode === 'read-only') return 'permissions: read-only mode denies outside-workspace write';
  if (mode === 'yolo') return 'permissions: yolo mode allows outside-workspace write without prompt';
  return `permissions: ${mode} mode outside-workspace write behavior`;
}

function makeAcpPermissionModeOutsideWorkspaceScenario(
  provider: ProviderUnderTest,
  mode: Exclude<AcpPermissionMode, 'plan'>,
): ProviderScenario {
  const providerId = acpProviderId(provider);
  const acpPermissions = provider.permissions?.acp;
  const expectPermissionRequest = resolveAcpToolPermissionPromptExpectation({
    acpPermissions,
    mode,
  });
  const decision = resolveAcpOutsideWorkspaceWriteAllowed({
    acpPermissions,
    mode,
  })
    ? 'approve'
    : 'deny';
  const expectWriteCompletion = resolveAcpOutsideWorkspaceWriteMustComplete({
    acpPermissions,
    mode,
  });
  const requireTaskCompleteWhenNoToolAttempt = resolveAcpOutsideWorkspaceRequireTaskComplete({
    acpPermissions,
    mode,
  });
  const yolo = yoloFlagForPermissionMode(mode);

  const base = makeAcpPermissionOutsideWorkspaceScenario({
    providerId,
    id: outsideWorkspaceScenarioIdByMode(mode),
    title: outsideWorkspaceScenarioTitleByMode(mode),
    content: provider.id === 'codex' ? `CODEX_OUTSIDE_${mode.toUpperCase().replace(/-/g, '_')}_OK` : `OUTSIDE_${mode.toUpperCase().replace(/-/g, '_')}_E2E`,
    decision,
    expectPermissionRequest,
    expectWriteCompletion,
    requireTaskCompleteWhenNoToolAttempt,
  });

  const scenario: ProviderScenario = {
    ...base,
    yolo,
    messageMeta: {
      permissionMode: mode,
      permissionModeUpdatedAt: Date.now(),
    },
    permissionAutoDecision: decision === 'deny' ? 'denied' : 'approved',
  };

  if (
    (provider.id === 'opencode' || provider.id === 'kilo') &&
    mode !== 'yolo' &&
    decision === 'approve' &&
    expectPermissionRequest
  ) {
    scenario.permissionAutoDecision = 'approved_for_session';
  }

  // Keep YOLO-mode scenarios resilient to occasional provider-side prompt surfacing.
  if (yolo) {
    scenario.allowPermissionAutoApproveInYolo = true;
  }

  return scenario;
}

const agentSdkRemoteMetaBase = {
  claudeRemoteAgentSdkEnabled: true,
  claudeRemoteSettingSources: 'project',
} as const;

function withAgentSdkRemoteMeta(
  base: ProviderScenario,
  params: { id: string; title: string; metaExtras?: Record<string, unknown> },
): ProviderScenario {
  const mergeMeta = (meta: Record<string, unknown>) => ({
    ...meta,
    ...agentSdkRemoteMetaBase,
    ...(params.metaExtras ?? {}),
  });

  const messageMeta = base.messageMeta;
  const existingMeta =
    messageMeta && typeof messageMeta === 'object' && !Array.isArray(messageMeta)
      ? (messageMeta as Record<string, unknown>)
      : null;
  return {
    ...base,
    id: params.id,
    title: params.title,
    messageMeta:
      typeof messageMeta === 'function'
        ? (ctx) => {
            const resolved = messageMeta(ctx);
            const record =
              resolved && typeof resolved === 'object' && !Array.isArray(resolved) ? (resolved as Record<string, unknown>) : {};
            return mergeMeta(record);
          }
        : mergeMeta(existingMeta ?? {}),
  };
}

export const scenarioCatalog: Record<string, ScenarioFactory> = {
  // --------------------
  // Claude (local/remote)
  // --------------------
  bash_echo_trace_ok: () => ({
    id: 'bash_echo_trace_ok',
    title: 'Bash: echo CLAUDE_TRACE_OK',
    tier: 'smoke',
    yolo: true,
    maxTraceEvents: { toolCalls: 1, toolResults: 1, permissionRequests: 1 },
    prompt: () =>
      [
        'Run exactly one tool call:',
        '- Use the Bash tool to run: echo CLAUDE_TRACE_OK',
        '- Then reply DONE.',
        '',
        'Do not use any other tool.',
      ].join('\n'),
    requiredFixtureKeys: ['claude/claude/tool-call/Bash', 'claude/claude/tool-result/Bash'],
    requiredTraceSubstrings: ['CLAUDE_TRACE_OK'],
    verify: async ({ fixtures }) => {
      const examples = fixtures?.examples;
      if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');

      const calls = (examples['claude/claude/tool-call/Bash'] ?? []) as any[];
      if (!Array.isArray(calls) || calls.length === 0) throw new Error('Missing Bash tool-call fixtures');
      const hasEcho = calls.some((e) => hasStringSubstring(e?.payload?.input, 'echo CLAUDE_TRACE_OK'));
      if (!hasEcho) throw new Error('Bash tool-call did not include expected command substring');
    },
  }),

  read_known_file: (provider) => {
    if (provider.id === 'claude') {
      const scenario: ProviderScenario = {
        id: 'read_known_file',
        title: 'Read: read a known file in workspace',
        tier: 'extended',
        yolo: true,
        maxTraceEvents: { toolCalls: 1, toolResults: 1, permissionRequests: 1 },
        setup: async ({ workspaceDir }) => {
          await writeFile(join(workspaceDir, 'e2e-read.txt'), `READ_SENTINEL_CLAUDE_${randomUUID()}\n`, 'utf8');
        },
        prompt: ({ workspaceDir }) =>
          [
            'Use the Read tool (not Bash) to read the file at this absolute path:',
            join(workspaceDir, 'e2e-read.txt'),
            '',
            'Then reply with EXACTLY two lines:',
            '1) the exact first line of that file (the READ_SENTINEL...)',
            '2) DONE',
          ].join('\n'),
        requiredFixtureKeys: ['claude/claude/tool-call/Read', 'claude/claude/tool-result/Read'],
        verify: async ({ fixtures, workspaceDir }) => {
          const examples = fixtures?.examples;
          if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');
          const calls = (examples['claude/claude/tool-call/Read'] ?? []) as any[];
          if (!Array.isArray(calls) || calls.length === 0) throw new Error('Missing Read tool-call fixtures');
          const expectedPath = join(workspaceDir, 'e2e-read.txt');
          const hasPath = calls.some((e) => hasStringSubstring(e?.payload?.input, expectedPath));
          if (!hasPath) throw new Error('Read tool-call did not include expected file path');
        },
      };

      return scenario;
    }

    // ACP providers share the same scenario id, with ACP-specific fixtures.
    return makeAcpReadInWorkspaceScenario({
      providerId: acpProviderId(provider),
      content: provider.id === 'codex' ? 'CODEX_READ_OK' : 'READ_SENTINEL_123',
      id: provider.id === 'codex' ? 'read_in_workspace' : 'read_known_file',
      title: provider.id === 'codex' ? 'read: read a known small file in workspace' : 'read: read a known file in workspace',
      useAbsolutePath: provider.id === 'auggie',
      useExecuteFallbackOnReadFailure: provider.id === 'kimi' || provider.id === 'auggie',
    });
  },

  pi_read_known_file_smoke: (provider) => {
    assertProviderId(provider, 'pi');
    const base = makeAcpReadInWorkspaceScenario({
      providerId: acpProviderId(provider),
      content: 'PI_READ_SMOKE_OK',
      id: 'pi_read_known_file_smoke',
      title: 'pi smoke: read a known file in workspace',
    });

    return {
      ...base,
      tier: 'smoke',
    } satisfies ProviderScenario;
  },

  // -----------------------------------------
  // Experimental / opt-in scenarios (ACP fs)
  // -----------------------------------------
  acp_fs_permission_experiment: (provider) => {
    if (provider.protocol !== 'acp') {
      throw new Error(`acp_fs_permission_experiment only supports ACP providers (got ${provider.protocol})`);
    }
    return makeAcpFsPermissionExperimentScenario({
      providerId: acpProviderId(provider),
      content: `ACP_FS_SENTINEL_${randomUUID()}`,
    });
  },

  acp_in_flight_steer: (provider) => {
    if (provider.protocol !== 'acp') {
      throw new Error(`acp_in_flight_steer only supports ACP providers (got ${provider.protocol})`);
    }

    if (provider.id === 'codex') {
      // Real-provider variant: use an `execute` call that takes long enough for the harness to enqueue
      // the second step while the turn is still running, then assert the runtime routed step2 via steer.
      const id = randomUUID();
      const sleepMs = 8_000;
      const command = `node -e 'console.log(\"HAPPIER_E2E_STEER_PRIMARY_BEGIN ${id}\"); setTimeout(() => { console.log(\"HAPPIER_E2E_STEER_PRIMARY_END ${id}\"); }, ${sleepMs});'`;
      return {
        id: 'acp_in_flight_steer',
        title: 'acp: codex in-flight steer routes second message without interrupt (requires creds)',
        tier: 'extended',
        yolo: true,
	      steps: [
	        {
	          id: 'start',
	          allowInFlightSteer: true,
	          prompt: () => [
	            'Use the execute tool to run this command exactly (do not shorten it):',
	            command,
	            `Then respond with: PRIMARY_DONE ${id}`,
	          ].join('\n'),
	          satisfaction: {
	            // Gate step2 on the primary execute call actually starting (not just status=running),
	            // so the steer prompt is injected while the primary command is truly in-flight.
	            requiredFixtureKeys: ['acp/codex/tool-call/Bash'],
	          },
	        },
          {
            id: 'steer',
            prompt: () => `STEER_NOW ${id}`,
          },
        ],
        requiredFixtureKeys: ['acp/codex/tool-call/Bash', 'acp/codex/tool-result/Bash'],
        requiredTraceSubstrings: ['acp_in_flight_steer'],
      };
    }

    // Deterministic ACP stub provider variant (no real credentials needed).
    // The harness enqueues step2 only once step1 satisfaction is met, so step1 must emit
    // an early trace marker while the primary turn is still running.
    const primary = `ACP_STUB_PRIMARY_${randomUUID()}`;
    const steer = `ACP_STUB_STEER_${randomUUID()}`;

	    return {
	      id: 'acp_in_flight_steer',
	      title: 'acp: in-flight steer drains pending while a turn is running (no interrupt)',
	      tier: 'smoke',
	      yolo: true,
	      steps: [
	        {
	          id: 'start',
	          allowInFlightSteer: true,
	          prompt: () => `ACP_STUB_PRIMARY=${primary}`,
	          satisfaction: {
	            // Gate step2 on tool-trace, not session messages. Depending on backend buffering,
	            // the RUNNING marker may not land in persisted messages until the turn completes.
            requiredTraceSubstrings: [`ACP_STUB_RUNNING primary=${primary}`],
          },
        },
        {
          id: 'steer',
          prompt: () => `ACP_STUB_STEER=${steer}`,
        },
      ],
      // Final satisfaction is also trace-based to avoid relying on streaming message persistence behavior.
      requiredTraceSubstrings: [`ACP_STUB_DONE primary=${primary} steer=${steer}`],
    };
  },

  acp_stub_usage_update: (provider) => {
    if (provider.protocol !== 'acp') {
      throw new Error(`acp_stub_usage_update only supports ACP providers (got ${provider.protocol})`);
    }

    // Deterministic token telemetry smoke: the ACP stub provider emits `usage_update`,
    // which the CLI forwards as a `token_count` session message.
    const sentinel = `ACP_STUB_USAGE_UPDATE_${randomUUID()}`;
    return {
      id: 'acp_stub_usage_update',
      title: 'acp: stub emits usage_update and CLI forwards token_count',
      tier: 'smoke',
      yolo: true,
      prompt: () => `ACP_STUB_USAGE_UPDATE=${sentinel}`,
      requiredMessageSubstrings: [`ACP_STUB_USAGE_UPDATE_DONE ${sentinel}`],
    };
  },

  acp_probe_models: (provider) => {
    if (provider.protocol !== 'acp') {
      throw new Error(`acp_probe_models only supports ACP providers (got ${provider.protocol})`);
    }

    const providerId = acpProviderId(provider);
    const sentinel = `ACP_MODEL_PROBE_SENTINEL_${randomUUID()}`;
    const outputRel = 'e2e-probe-models.json';

    const base = makeAcpReadInWorkspaceScenario({
      providerId,
      content: sentinel,
      id: 'acp_probe_models',
      title: 'acp: capabilities.invoke cli.* probeModels returns a valid model list',
    });

    return {
      ...base,
      requiredFixtureKeys: undefined,
      requiredAnyFixtureKeys: undefined,
      requiredTraceSubstrings: undefined,
      postSatisfy: {
        timeoutMs: capabilityProbePostSatisfyTimeoutMs(provider.id),
        run: async ({ workspaceDir, baseUrl, token, sessionId, secret, cliHome }) => {
          await waitForSessionActive({ baseUrl, token, sessionId, timeoutMs: 60_000 });

          const parsed = await withCapabilityProbeRetry(
            () =>
              invokeCapabilitiesMethod({
                baseUrl,
                token,
                cliHome,
                secret,
                rpcMethod: RPC_METHODS.CAPABILITIES_INVOKE,
                payload: {
                  id: `cli.${provider.id}`,
                  method: 'probeModels',
                  // Some providers can take >10s to enumerate models under load (especially when
                  // multiple provider harnesses run concurrently). Keep this comfortably above the
                  // typical cold-start+handshake window to avoid flaky timeouts.
                  params: { timeoutMs: 30_000 },
                },
                timeoutMs: capabilityProbeRpcTimeoutMs(provider.id),
              }),
            capabilityProbeRetryOptions(provider.id),
          );
          const envelope = parsed && typeof parsed === 'object' ? parsed as any : null;
          if (!envelope || envelope.ok !== true) {
            throw new Error(`acp_probe_models: capabilities.invoke returned non-ok: ${JSON.stringify(envelope, null, 2)}`);
          }

          await writeFile(join(workspaceDir, outputRel), JSON.stringify(envelope.result, null, 2) + '\n', 'utf8');
          await sleep(50);
        },
      },
      verify: async ({ workspaceDir }) => {
        const outPath = join(workspaceDir, outputRel);
        const raw = await readFile(outPath, 'utf8').catch(() => '');
        if (!raw) throw new Error(`acp_probe_models: missing output file: ${outPath}`);

        let json: any = null;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new Error(`acp_probe_models: output file is not valid JSON: ${outPath}`);
        }

        if (!json || typeof json !== 'object') {
          throw new Error(`acp_probe_models: invalid output shape: ${stableStringifyShape(shapeOf(json))}`);
        }

        const providerName = typeof json.provider === 'string' ? json.provider : '';
        if (providerName !== provider.id) {
          throw new Error(`acp_probe_models: expected provider=${provider.id}, got ${providerName}`);
        }

        const source = typeof json.source === 'string' ? json.source : '';
        if (source !== 'dynamic' && source !== 'static') {
          throw new Error(`acp_probe_models: invalid source=${String(source)}`);
        }

        if (!Array.isArray(json.availableModels)) {
          throw new Error(`acp_probe_models: availableModels is not an array: ${stableStringifyShape(shapeOf(json.availableModels))}`);
        }

        // Accept either dynamic or static lists; require at least the "default" entry.
        const hasDefault = json.availableModels.some((m: any) => m && typeof m === 'object' && m.id === 'default');
        if (!hasDefault) {
          throw new Error(`acp_probe_models: expected availableModels to include {id:'default'} (shape: ${stableStringifyShape(shapeOf(json))})`);
        }
      },
    } satisfies ProviderScenario;
  },

  acp_probe_capabilities: (provider) => {
    if (provider.protocol !== 'acp') {
      throw new Error(`acp_probe_capabilities only supports ACP providers (got ${provider.protocol})`);
    }

    const outputRel = 'e2e-probe-capabilities.json';
    const base = makeAcpReadInWorkspaceScenario({
      providerId: acpProviderId(provider),
      content: `ACP_CAPS_SENTINEL_${randomUUID()}`,
      id: 'acp_probe_capabilities',
      title: 'acp: capabilities.detect cli.* returns ACP capability snapshot',
    });

    return {
      ...base,
      tier: 'smoke',
      requiredFixtureKeys: undefined,
      requiredAnyFixtureKeys: undefined,
      requiredTraceSubstrings: undefined,
      postSatisfy: {
        timeoutMs: capabilityProbePostSatisfyTimeoutMs(provider.id),
        run: async ({ workspaceDir, baseUrl, token, sessionId, secret, cliHome }) => {
          await waitForSessionActive({ baseUrl, token, sessionId, timeoutMs: 60_000 });

          const parsed = await withCapabilityProbeRetry(
            () =>
              invokeCapabilitiesMethod({
                baseUrl,
                token,
                cliHome,
                secret,
                rpcMethod: RPC_METHODS.CAPABILITIES_DETECT,
                payload: {
                  requests: [
                    {
                      id: `cli.${provider.id}`,
                      params: { includeAcpCapabilities: true, includeLoginStatus: true },
                    },
                  ],
                },
                timeoutMs: capabilityProbeRpcTimeoutMs(provider.id),
              }),
            capabilityProbeRetryOptions(provider.id),
          );
          const envelope = parsed && typeof parsed === 'object' ? parsed as any : null;
          await writeFile(join(workspaceDir, outputRel), JSON.stringify(envelope, null, 2) + '\n', 'utf8');
          await sleep(50);
        },
      },
      verify: async ({ workspaceDir }) => {
        const outPath = join(workspaceDir, outputRel);
        const raw = await readFile(outPath, 'utf8').catch(() => '');
        if (!raw) throw new Error(`acp_probe_capabilities: missing output file: ${outPath}`);

        let json: any = null;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new Error(`acp_probe_capabilities: output file is not valid JSON: ${outPath}`);
        }

        const entry = json?.results?.[`cli.${provider.id}`];
        if (!entry || entry.ok !== true) {
          throw new Error(`acp_probe_capabilities: missing successful result for cli.${provider.id}`);
        }

        const data = entry.data;
        if (!data || typeof data !== 'object') {
          throw new Error(`acp_probe_capabilities: result.data is not an object`);
        }
        if (data.available !== true) {
          throw new Error(`acp_probe_capabilities: expected available=true for cli.${provider.id}`);
        }

        const acp = data.acp;
        if (!acp || typeof acp !== 'object') {
          throw new Error(`acp_probe_capabilities: missing acp snapshot for cli.${provider.id}`);
        }
        if (acp.ok !== true) {
          if (provider.id === 'gemini') {
            const message = typeof acp.error?.message === 'string' ? acp.error.message.trim() : '';
            if (!message) {
              throw new Error(`acp_probe_capabilities: expected acp.error.message for degraded cli.${provider.id} probe`);
            }
            return;
          }
          throw new Error(`acp_probe_capabilities: expected acp.ok=true for cli.${provider.id}`);
        }
        if (typeof acp.loadSession !== 'boolean') {
          throw new Error(`acp_probe_capabilities: expected acp.loadSession boolean`);
        }

        const agentCapabilities = acp.agentCapabilities;
        if (!agentCapabilities || typeof agentCapabilities !== 'object') {
          throw new Error(`acp_probe_capabilities: expected acp.agentCapabilities object`);
        }
        if (!agentCapabilities.promptCapabilities || typeof agentCapabilities.promptCapabilities !== 'object') {
          throw new Error(`acp_probe_capabilities: expected promptCapabilities object`);
        }
        if (!agentCapabilities.mcpCapabilities || typeof agentCapabilities.mcpCapabilities !== 'object') {
          throw new Error(`acp_probe_capabilities: expected mcpCapabilities object`);
        }
        if (!agentCapabilities.sessionCapabilities || typeof agentCapabilities.sessionCapabilities !== 'object') {
          throw new Error(`acp_probe_capabilities: expected sessionCapabilities object`);
        }
      },
    } satisfies ProviderScenario;
  },

  acp_set_model_dynamic: (provider) => {
    if (provider.protocol !== 'acp') {
      throw new Error(`acp_set_model_dynamic only supports ACP providers (got ${provider.protocol})`);
    }
    if (!['opencode', 'kilo', 'auggie', 'codex'].includes(provider.id)) {
      throw new Error(`acp_set_model_dynamic requires dynamic model providers (got ${provider.id})`);
    }

    const outputRel = 'e2e-set-model-dynamic.json';
    const base = makeAcpReadInWorkspaceScenario({
      providerId: acpProviderId(provider),
      content: `ACP_SET_MODEL_SENTINEL_${randomUUID()}`,
      id: 'acp_set_model_dynamic',
      title: 'acp: model override applies with dynamic model ids while idle',
    });

    return {
      ...base,
      requiredFixtureKeys: undefined,
      requiredAnyFixtureKeys: undefined,
      requiredTraceSubstrings: undefined,
      postSatisfy: {
        timeoutMs: 180_000,
        run: async ({ workspaceDir, baseUrl, token, sessionId, secret, cliHome }) => {
          await waitForSessionActive({ baseUrl, token, sessionId, timeoutMs: 60_000 });

          // Some providers can report only the placeholder "default" model briefly while they are
          // still warming up / fetching model inventories. Keep probing until we get a non-default
          // model id or we hit a deadline.
          const probeDeadline = Date.now() + 90_000;
          let probeEnvelope: any | null = null;
          let selectedModel: string | null = null;
          while (Date.now() < probeDeadline) {
            const probeParsed = await withCapabilityProbeRetry(
              () =>
                invokeCapabilitiesMethod({
                  baseUrl,
                  token,
                  cliHome,
                  secret,
                  rpcMethod: RPC_METHODS.CAPABILITIES_INVOKE,
                  payload: {
                    id: `cli.${provider.id}`,
                    method: 'probeModels',
                    params: { timeoutMs: 30_000 },
                  },
                  timeoutMs: capabilityProbeRpcTimeoutMs(provider.id),
                }),
              capabilityProbeRetryOptions(provider.id),
            ).catch((error) => enrichCapabilityProbeError(error) as any);

            const envelope = probeParsed && typeof probeParsed === 'object' ? (probeParsed as any) : null;
            if (envelope && envelope.ok === true && envelope.result && typeof envelope.result === 'object') {
              const models = Array.isArray(envelope.result.availableModels) ? envelope.result.availableModels : [];
              const nonDefault =
                models.find((m: any) => m && typeof m.id === 'string' && m.id.trim() !== '' && m.id !== 'default')?.id ?? null;
              if (nonDefault) {
                probeEnvelope = envelope;
                selectedModel = nonDefault;
                break;
              }
            }

            await sleep(500);
          }

          if (!probeEnvelope || !selectedModel) {
            throw new Error('acp_set_model_dynamic: no dynamic non-default model id found');
          }

          const snapBefore = await fetchSessionV2(baseUrl, token, sessionId);
          const metadataBefore = decryptLegacyBase64(snapBefore.metadata, secret) as any;
          const updatedAt = Date.now();
          const updatedCiphertext = encryptLegacyBase64(
            {
              ...metadataBefore,
              modelOverrideV1: { v: 1, updatedAt, modelId: selectedModel },
            },
            secret,
          );
          await patchSessionMetadataWithRetry({
            baseUrl,
            token,
            sessionId,
            ciphertext: updatedCiphertext,
            expectedVersion: snapBefore.metadataVersion,
          });

          let appliedCurrentModelId: string | null = null;
          const deadline = Date.now() + 90_000;
          while (Date.now() < deadline) {
            const snap = await fetchSessionV2(baseUrl, token, sessionId);
            const metadata = decryptLegacyBase64(snap.metadata, secret) as any;
            const currentModelId = typeof metadata?.acpSessionModelsV1?.currentModelId === 'string'
              ? metadata.acpSessionModelsV1.currentModelId
              : null;
            const overrideModelId = typeof metadata?.modelOverrideV1?.modelId === 'string'
              ? metadata.modelOverrideV1.modelId
              : null;

            if (overrideModelId === selectedModel && currentModelId === selectedModel) {
              appliedCurrentModelId = currentModelId;
              break;
            }
            await sleep(250);
          }

          if (appliedCurrentModelId !== selectedModel) {
            throw new Error(`acp_set_model_dynamic: model override did not apply to ACP runtime (target=${selectedModel})`);
          }

          await writeFile(
            join(workspaceDir, outputRel),
            JSON.stringify(
              {
                provider: provider.id,
                selectedModel,
                appliedCurrentModelId,
                source: probeEnvelope.result.source,
              },
              null,
              2,
            ) + '\n',
            'utf8',
          );
          await sleep(50);
        },
      },
      verify: async ({ workspaceDir }) => {
        const outPath = join(workspaceDir, outputRel);
        const raw = await readFile(outPath, 'utf8').catch(() => '');
        if (!raw) throw new Error(`acp_set_model_dynamic: missing output file: ${outPath}`);
        const parsed = JSON.parse(raw) as any;
        if (typeof parsed?.selectedModel !== 'string' || parsed.selectedModel.length === 0) {
          throw new Error('acp_set_model_dynamic: selectedModel missing');
        }
        if (parsed.appliedCurrentModelId !== parsed.selectedModel) {
          throw new Error('acp_set_model_dynamic: applied model does not match selected model');
        }
      },
    } satisfies ProviderScenario;
  },

  acp_set_model_inventory: (provider) => {
    if (provider.protocol !== 'acp') {
      throw new Error(`acp_set_model_inventory only supports ACP providers (got ${provider.protocol})`);
    }
    if (provider.id !== 'gemini') {
      throw new Error(`acp_set_model_inventory only supports gemini provider (got ${provider.id})`);
    }

    const outputRel = 'e2e-set-model-inventory.json';
    const base = makeAcpReadInWorkspaceScenario({
      providerId: acpProviderId(provider),
      content: `ACP_SET_MODEL_INVENTORY_${randomUUID()}`,
      id: 'acp_set_model_inventory',
      title: 'acp: gemini model switch inventory (probe + metadata override)',
    });

    return {
      ...base,
      requiredFixtureKeys: undefined,
      requiredAnyFixtureKeys: undefined,
      requiredTraceSubstrings: undefined,
      postSatisfy: {
        timeoutMs: 240_000,
        run: async ({ workspaceDir, baseUrl, token, sessionId, secret, cliHome }) => {
          await waitForSessionActive({ baseUrl, token, sessionId, timeoutMs: 90_000 });

          const probeParsed = await withCapabilityProbeRetry(
            () =>
              invokeCapabilitiesMethod({
                baseUrl,
                token,
                cliHome,
                secret,
                rpcMethod: RPC_METHODS.CAPABILITIES_INVOKE,
                payload: {
                  id: `cli.${provider.id}`,
                  method: 'probeModels',
                  params: { timeoutMs: 30_000 },
                },
                timeoutMs: capabilityProbeRpcTimeoutMs(provider.id),
              }),
            capabilityProbeRetryOptions(provider.id),
          );
          const probeEnvelope = probeParsed && typeof probeParsed === 'object' ? (probeParsed as any) : null;
          if (!probeEnvelope || probeEnvelope.ok !== true || !probeEnvelope.result || typeof probeEnvelope.result !== 'object') {
            throw new Error('acp_set_model_inventory: probeModels returned invalid envelope');
          }

          const models = Array.isArray(probeEnvelope.result.availableModels) ? probeEnvelope.result.availableModels : [];
          const selectedModel =
            models.find((m: any) => m && typeof m.id === 'string' && m.id.trim() !== '' && m.id !== 'default')?.id ?? null;
          if (!selectedModel) {
            throw new Error('acp_set_model_inventory: no non-default model id found');
          }

          const snapBefore = await fetchSessionV2(baseUrl, token, sessionId);
          const metadataBefore = decryptLegacyBase64(snapBefore.metadata, secret) as any;
          const updatedAt = Date.now();
          const updatedCiphertext = encryptLegacyBase64(
            {
              ...metadataBefore,
              modelOverrideV1: { v: 1, updatedAt, modelId: selectedModel },
            },
            secret,
          );
          await patchSessionMetadataWithRetry({
            baseUrl,
            token,
            sessionId,
            ciphertext: updatedCiphertext,
            expectedVersion: snapBefore.metadataVersion,
          });

          let runtimeObservedCurrentModelId: string | null = null;
          let sessionModelsStatePresent = false;
          let overridePersisted = false;
          const deadline = Date.now() + 120_000;
          while (Date.now() < deadline) {
            const snap = await fetchSessionV2(baseUrl, token, sessionId);
            const metadata = decryptLegacyBase64(snap.metadata, secret) as any;

            const overrideModelId =
              typeof metadata?.modelOverrideV1?.modelId === 'string' ? String(metadata.modelOverrideV1.modelId) : null;
            if (overrideModelId === selectedModel) {
              overridePersisted = true;
            }

            const sessionModels = metadata?.acpSessionModelsV1;
            if (sessionModels && typeof sessionModels === 'object') {
              sessionModelsStatePresent = true;
              const currentModelId =
                typeof sessionModels.currentModelId === 'string' ? String(sessionModels.currentModelId) : null;
              if (currentModelId === selectedModel) {
                runtimeObservedCurrentModelId = currentModelId;
                break;
              }
            }

            await sleep(250);
          }

          if (!overridePersisted) {
            throw new Error(`acp_set_model_inventory: model override did not persist (target=${selectedModel})`);
          }

          await writeFile(
            join(workspaceDir, outputRel),
            JSON.stringify(
              {
                provider: provider.id,
                selectedModel,
                source: probeEnvelope.result.source,
                supportsFreeform: probeEnvelope.result.supportsFreeform === true,
                sessionModelsStatePresent,
                runtimeObservedCurrentModelId,
                runtimeSwitchObserved: runtimeObservedCurrentModelId === selectedModel,
              },
              null,
              2,
            ) + '\n',
            'utf8',
          );
          await sleep(50);
        },
      },
      verify: async ({ workspaceDir }) => {
        const outPath = join(workspaceDir, outputRel);
        const raw = await readFile(outPath, 'utf8').catch(() => '');
        if (!raw) throw new Error(`acp_set_model_inventory: missing output file: ${outPath}`);

        const parsed = JSON.parse(raw) as any;
        if (parsed?.provider !== 'gemini') {
          throw new Error(`acp_set_model_inventory: expected provider=gemini, got ${String(parsed?.provider)}`);
        }
        if (typeof parsed?.selectedModel !== 'string' || parsed.selectedModel.length === 0 || parsed.selectedModel === 'default') {
          throw new Error('acp_set_model_inventory: selectedModel missing or invalid');
        }
        if (parsed?.source !== 'dynamic' && parsed?.source !== 'static') {
          throw new Error(`acp_set_model_inventory: invalid source=${String(parsed?.source)}`);
        }
        if (typeof parsed?.sessionModelsStatePresent !== 'boolean') {
          throw new Error('acp_set_model_inventory: sessionModelsStatePresent must be boolean');
        }
        if (typeof parsed?.runtimeSwitchObserved !== 'boolean') {
          throw new Error('acp_set_model_inventory: runtimeSwitchObserved must be boolean');
        }
      },
    } satisfies ProviderScenario;
  },

  agent_sdk_read_known_file: (provider) => {
    assertProviderId(provider, 'claude');
    const base = scenarioCatalog.read_known_file(provider);
    return withAgentSdkRemoteMeta(base, {
      id: 'agent_sdk_read_known_file',
      title: 'agent sdk: Read: read a known file in workspace',
    });
  },

  permission_surface_outside_workspace: (provider) => {
    if (provider.id === 'claude') {
      let outsidePath: string | null = null;
      const scenario: ProviderScenario = {
        id: 'permission_surface_outside_workspace',
        title: 'permissions: writing outside workspace surfaces a permission-request trace (approve)',
        tier: 'extended',
        yolo: false,
        permissionAutoDecision: 'approved',
        messageMeta: {
          allowedTools: ['Write', 'Edit'],
        },
        requiredFixtureKeys: [],
        setup: async ({ workspaceDir }) => {
          outsidePath = makeOutsideWorkspacePath({
            workspaceDir,
            prefix: 'happy-e2e-claude-outside-approve',
          });
          await cleanupOutsideWorkspacePath(outsidePath);
        },
        prompt: ({ workspaceDir }) => {
          if (!outsidePath) {
            outsidePath = makeOutsideWorkspacePath({
              workspaceDir,
              prefix: 'happy-e2e-claude-outside-approve',
            });
          }
          return [
            'Run exactly one tool call (even if it triggers a permission prompt):',
            'Use the Write tool to write a file OUTSIDE the current working directory:',
            `- Absolute path: ${outsidePath}`,
            '- Content: OUTSIDE_CLAUDE_E2E',
            '',
            'This is an automated test. Do not use Bash to write the file.',
            'Then reply DONE.',
            `Note: current working directory is ${workspaceDir}`,
          ].join('\n');
        },
        requiredAnyFixtureKeys: [
          ['claude/claude/tool-call/Write', 'claude/claude/tool-call/Edit'],
          ['claude/claude/tool-result/Write', 'claude/claude/tool-result/Edit'],
        ],
        verify: async ({ fixtures }) => {
          const writes = ((fixtures?.examples?.['claude/claude/permission-request/Write'] ?? []) as any[])
            .concat((fixtures?.examples?.['claude/claude/permission-request/Edit'] ?? []) as any[])
            .concat((fixtures?.examples?.['claude/claude/tool-call/Write'] ?? []) as any[])
            .concat((fixtures?.examples?.['claude/claude/tool-call/Edit'] ?? []) as any[]);
          if (!Array.isArray(writes) || writes.length === 0) throw new Error('Missing outside-workspace write evidence in fixtures');
          const filepath = writes[0]?.payload?.input?.file_path;
          const resolvedPath = typeof filepath === 'string' && filepath.length > 0 ? filepath : outsidePath;
          if (typeof resolvedPath !== 'string' || resolvedPath.length === 0) throw new Error('permission-request/Write missing input.file_path');
          try {
            const content = await readFile(resolvedPath, 'utf8').catch(() => '');
            if (content.trim().length > 0 && !content.includes('OUTSIDE_CLAUDE_E2E')) {
              throw new Error(`Approved permission but expected content was not written: ${resolvedPath}`);
            }
          } finally {
            await cleanupOutsideWorkspacePath(resolvedPath);
            outsidePath = null;
          }
        },
      };
      return scenario;
    }

    const acpPermissions = provider.permissions?.acp;
    const yolo = acpPermissions?.permissionSurfaceOutsideWorkspaceYolo;
    const shouldRunYolo = typeof yolo === 'boolean' ? yolo : false;
    const mode: Exclude<AcpPermissionMode, 'plan'> = shouldRunYolo ? 'yolo' : 'safe-yolo';
    const expectPermissionRequest = resolveAcpToolPermissionPromptExpectation({
      acpPermissions,
      mode,
    });
    const scenario = makeAcpPermissionOutsideWorkspaceScenario({
      providerId: acpProviderId(provider),
      content: provider.id === 'codex' ? 'CODEX_OUTSIDE_OK' : 'OUTSIDE_E2E',
      decision: 'approve',
      expectPermissionRequest,
    });

    const scenarioWithYolo = {
      ...(typeof yolo === 'boolean' ? { ...scenario, yolo } : scenario),
      messageMeta: {
        permissionMode: mode,
        permissionModeUpdatedAt: Date.now(),
      },
    };

    // OpenCode-family ACP permission prompts have been observed to stall tool completion when the
    // "allow once" option is selected. Prefer auto-selecting "always allow" in the harness so the
    // scenario can validate permission surfacing + enforcement deterministically.
    if (
      (provider.id === 'opencode' || provider.id === 'kilo') &&
      scenarioWithYolo.yolo === false &&
      scenarioWithYolo.permissionAutoDecision === 'approved' &&
      expectPermissionRequest
    ) {
      return { ...scenarioWithYolo, permissionAutoDecision: 'approved_for_session' };
    }

    if (
      (provider.id === 'opencode' || provider.id === 'kilo') &&
      scenarioWithYolo.yolo === true
    ) {
      return { ...scenarioWithYolo, allowPermissionAutoApproveInYolo: true };
    }

    return scenarioWithYolo;
  },

  permission_mode_default_outside_workspace: (provider) => {
    if (provider.protocol !== 'acp') {
      throw new Error(`permission_mode_default_outside_workspace only supports ACP providers (got ${provider.protocol})`);
    }
    return makeAcpPermissionModeOutsideWorkspaceScenario(provider, 'default');
  },

  permission_mode_safe_yolo_outside_workspace: (provider) => {
    if (provider.protocol !== 'acp') {
      throw new Error(`permission_mode_safe_yolo_outside_workspace only supports ACP providers (got ${provider.protocol})`);
    }
    return makeAcpPermissionModeOutsideWorkspaceScenario(provider, 'safe-yolo');
  },

  permission_mode_read_only_outside_workspace: (provider) => {
    if (provider.protocol !== 'acp') {
      throw new Error(`permission_mode_read_only_outside_workspace only supports ACP providers (got ${provider.protocol})`);
    }
    return makeAcpPermissionModeOutsideWorkspaceScenario(provider, 'read-only');
  },

  permission_mode_yolo_outside_workspace: (provider) => {
    if (provider.protocol !== 'acp') {
      throw new Error(`permission_mode_yolo_outside_workspace only supports ACP providers (got ${provider.protocol})`);
    }
    return makeAcpPermissionModeOutsideWorkspaceScenario(provider, 'yolo');
  },

  agent_sdk_permission_surface_outside_workspace: (provider) => {
    assertProviderId(provider, 'claude');
    const base = scenarioCatalog.permission_surface_outside_workspace(provider);
    return withAgentSdkRemoteMeta(base, {
      id: 'agent_sdk_permission_surface_outside_workspace',
      title: 'agent sdk: permissions: writing outside workspace surfaces a permission-request trace (approve)',
    });
  },

  permission_deny_outside_workspace: (provider) => {
    if (provider.id === 'claude') {
      let outsidePath: string | null = null;
      const scenario: ProviderScenario = {
        id: 'permission_deny_outside_workspace',
        title: 'permissions: deny an outside-workspace write and verify it did not happen',
        tier: 'extended',
        yolo: false,
        permissionAutoDecision: 'denied',
        messageMeta: {
          allowedTools: ['Write', 'Edit'],
        },
        requiredFixtureKeys: [],
        setup: async ({ workspaceDir }) => {
          outsidePath = makeOutsideWorkspacePath({
            workspaceDir,
            prefix: 'happy-e2e-claude-outside-denied',
          });
          await cleanupOutsideWorkspacePath(outsidePath);
        },
        prompt: ({ workspaceDir }) => {
          if (!outsidePath) {
            outsidePath = makeOutsideWorkspacePath({
              workspaceDir,
              prefix: 'happy-e2e-claude-outside-denied',
            });
          }
          return [
            'Run exactly one tool call (even if it triggers a permission prompt):',
            'Use the Write tool to write a file OUTSIDE the current working directory:',
            `- Absolute path: ${outsidePath}`,
            '- Content: OUTSIDE_CLAUDE_DENIED_E2E',
            '',
            'This is an automated test. Do not use Bash to write the file.',
            'If the permission is denied, do not retry with other tools.',
            'Then reply DONE.',
            `Note: current working directory is ${workspaceDir}`,
          ].join('\n');
        },
        requiredAnyFixtureKeys: [
          ['claude/claude/tool-call/Write', 'claude/claude/tool-call/Edit'],
        ],
        verify: async ({ fixtures }) => {
          const permissionRequests = ((fixtures?.examples?.['claude/claude/permission-request/Write'] ?? []) as any[])
            .concat((fixtures?.examples?.['claude/claude/permission-request/Edit'] ?? []) as any[]);
          const writes = permissionRequests
            .concat((fixtures?.examples?.['claude/claude/tool-call/Write'] ?? []) as any[])
            .concat((fixtures?.examples?.['claude/claude/tool-call/Edit'] ?? []) as any[]);
          if (!Array.isArray(writes) || writes.length === 0) throw new Error('Missing outside-workspace write evidence in fixtures');
          const filepath = writes[0]?.payload?.input?.file_path;
          const resolvedPath = typeof filepath === 'string' && filepath.length > 0 ? filepath : outsidePath;
          if (typeof resolvedPath !== 'string' || resolvedPath.length === 0) throw new Error('permission-request/Write missing input.file_path');
          try {
            // Enforce denied-write side effects only when the provider surfaced an interactive
            // permission request we could answer. Some Claude runtimes can execute this write
            // directly without emitting permission-request fixtures.
            if (permissionRequests.length > 0 && existsSync(resolvedPath)) {
              throw new Error(`Denied permission but file exists on disk: ${resolvedPath}`);
            }
          } finally {
            await cleanupOutsideWorkspacePath(resolvedPath);
            outsidePath = null;
          }
        },
      };
      return scenario;
    }

    const acpPermissions = provider.permissions?.acp;
    const expectPermissionRequest = resolveAcpToolPermissionPromptExpectation({
      acpPermissions,
      mode: 'read-only',
    });
    const requireTaskCompleteWhenNoToolAttempt = resolveAcpOutsideWorkspaceRequireTaskComplete({
      acpPermissions,
      mode: 'read-only',
    });

    const scenario = makeAcpPermissionOutsideWorkspaceScenario({
      providerId: acpProviderId(provider),
      content: provider.id === 'codex' ? 'CODEX_OUTSIDE_DENIED_OK' : 'OUTSIDE_DENIED_E2E',
      decision: 'deny',
      expectPermissionRequest,
      requireTaskCompleteWhenNoToolAttempt,
    });
    return {
      ...scenario,
      messageMeta: {
        permissionMode: 'read-only',
        permissionModeUpdatedAt: Date.now(),
      },
    };
  },

  agent_sdk_permission_deny_outside_workspace: (provider) => {
    assertProviderId(provider, 'claude');
    const base = scenarioCatalog.permission_deny_outside_workspace(provider);
    return withAgentSdkRemoteMeta(base, {
      id: 'agent_sdk_permission_deny_outside_workspace',
      title: 'agent sdk: permissions: deny an outside-workspace write and verify it did not happen',
    });
  },

  agent_sdk_transcript_path_published: (provider) => {
    assertProviderId(provider, 'claude');
    return {
      id: 'agent_sdk_transcript_path_published',
      title: 'agent sdk: SessionStart hook publishes transcript path in session metadata',
      tier: 'extended',
      yolo: true,
      messageMeta: agentSdkRemoteMetaBase,
      maxTraceEvents: { toolCalls: 1, toolResults: 1, permissionRequests: 1 },
      prompt: () =>
        [
          'Run exactly one tool call:',
          '- Use the Bash tool to run: echo AGENTSDK_TRANSCRIPT_OK',
          '- Then reply DONE.',
          '',
          'Do not use any other tool.',
        ].join('\n'),
      requiredFixtureKeys: ['claude/claude/tool-call/Bash', 'claude/claude/tool-result/Bash'],
      requiredTraceSubstrings: ['AGENTSDK_TRANSCRIPT_OK'],
      verify: async ({ baseUrl, token, sessionId, secret }) => {
        const snap = await fetchSessionV2(baseUrl, token, sessionId);
        const metadata = decryptLegacyBase64(snap.metadata, secret) as any;
        const claudeSessionId = typeof metadata?.claudeSessionId === 'string' ? metadata.claudeSessionId : '';
        const transcriptPath = typeof metadata?.claudeTranscriptPath === 'string' ? metadata.claudeTranscriptPath : '';
        if (!claudeSessionId) throw new Error('Missing metadata.claudeSessionId (expected Agent SDK hook to publish it)');
        if (!transcriptPath) throw new Error('Missing metadata.claudeTranscriptPath (expected Agent SDK hook to publish it)');
        const startedAt = Date.now();
        while (Date.now() - startedAt < 15_000 && !existsSync(transcriptPath)) {
          await sleep(250);
        }
        if (!existsSync(transcriptPath)) throw new Error(`metadata.claudeTranscriptPath does not exist: ${transcriptPath}`);
      },
    };
  },

  agent_sdk_partial_messages_smoke: (provider) => {
    assertProviderId(provider, 'claude');
    return {
      id: 'agent_sdk_partial_messages_smoke',
      title: 'agent sdk: includePartialMessages does not break tool-trace session flow (Read)',
      tier: 'extended',
      yolo: true,
      messageMeta: { ...agentSdkRemoteMetaBase, claudeRemoteIncludePartialMessages: true },
      maxTraceEvents: { toolCalls: 1, toolResults: 1, permissionRequests: 1 },
      setup: async ({ workspaceDir }) => {
        await writeFile(join(workspaceDir, 'partial-messages-read.txt'), `AGENTSDK_PARTIAL_OK_${Date.now()}\n`, 'utf8');
      },
      prompt: ({ workspaceDir }) =>
        [
          'Run exactly one tool call:',
          '- Use the Read tool (not Bash) to read the file at this absolute path:',
          join(workspaceDir, 'partial-messages-read.txt'),
          '- Then reply DONE.',
          '',
          'Do not use any other tool.',
        ].join('\n'),
      requiredFixtureKeys: ['claude/claude/tool-call/Read', 'claude/claude/tool-result/Read'],
      verify: async ({ fixtures, workspaceDir }) => {
        const examples = fixtures?.examples;
        if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');
        const calls = (examples['claude/claude/tool-call/Read'] ?? []) as any[];
        if (!Array.isArray(calls) || calls.length === 0) throw new Error('Missing Read tool-call fixtures');
        const expectedPath = join(workspaceDir, 'partial-messages-read.txt');
        const hasPath = calls.some((e) => hasStringSubstring(e?.payload?.input, expectedPath));
        if (!hasPath) throw new Error('Read tool-call did not include expected file path');
      },
    };
  },

  agent_sdk_checkpoint_and_rewind_restores_fs: (provider) => {
    assertProviderId(provider, 'claude');
    return {
      id: 'agent_sdk_checkpoint_and_rewind_restores_fs',
      title: 'agent sdk: file checkpointing + /rewind restores workspace filesystem',
      tier: 'extended',
      yolo: true,
      messageMeta: {
        ...agentSdkRemoteMetaBase,
        claudeRemoteEnableFileCheckpointing: true,
      },
      steps: [
        {
          id: 'write',
          prompt: ({ workspaceDir }) =>
            [
              'Use the Write tool (not Bash) to create a new file in the current working directory:',
              `- Absolute path: ${join(workspaceDir, 'rewind-sentinel.txt')}`,
              '- Content: REWIND_SENTINEL_CLAUDE_E2E',
              'Then reply DONE.',
            ].join('\n'),
          satisfaction: {
            requiredAnyFixtureKeys: [
              ['claude/claude/tool-call/Write', 'claude/claude/tool-call/Edit'],
              ['claude/claude/tool-result/Write', 'claude/claude/tool-result/Edit'],
            ],
          },
        },
        {
          id: 'rewind',
          prompt: () => '/rewind --confirm',
          satisfaction: {
            requiredTraceSubstrings: ['checkpoint-rewind'],
          },
        },
      ],
      requiredFixtureKeys: [],
      requiredAnyFixtureKeys: [
        ['claude/claude/tool-call/Write', 'claude/claude/tool-call/Edit'],
        ['claude/claude/tool-result/Write', 'claude/claude/tool-result/Edit'],
      ],
      requiredTraceSubstrings: ['checkpoint-rewind'],
      verify: async ({ baseUrl, token, sessionId, secret, workspaceDir }) => {
        const snap = await fetchSessionV2(baseUrl, token, sessionId);
        const metadata = decryptLegacyBase64(snap.metadata, secret) as any;
        const checkpointId = typeof metadata?.claudeLastCheckpointId === 'string' ? metadata.claudeLastCheckpointId : '';
        if (!checkpointId) throw new Error('Missing metadata.claudeLastCheckpointId after checkpointing run');

        const sentinelPath = join(workspaceDir, 'rewind-sentinel.txt');
        if (existsSync(sentinelPath)) {
          throw new Error(`Expected /rewind to remove ${sentinelPath}, but it still exists`);
        }
      },
    };
  },

  abort_turn_then_continue: (provider) => {
    const followupSentinel = `ABORT_CONTINUE_OK_${randomUUID()}`;
    const memorySentinel = `ABORT_MEMORY_${randomUUID().slice(0, 8)}`;
    const readySentinel = `ABORT_READY_${randomUUID().slice(0, 8)}`;

    if (provider.id === 'claude') {
      return {
        id: 'abort_turn_then_continue',
        title: 'abort: interrupt a running turn and continue in the same session',
        tier: 'extended',
        yolo: true,
        maxTraceEvents: { toolCalls: 2, toolResults: 2, permissionRequests: 1 },
        prompt: () => `Reply with EXACTLY this token and nothing else: ${readySentinel}`,
        requiredFixtureKeys: [],
        postSatisfy: {
          timeoutMs: 180_000,
          run: async ({ baseUrl, token, sessionId, secret }) => {
            await waitForAssistantMessageContaining({
              baseUrl,
              token,
              sessionId,
              secret,
              requiredSubstring: readySentinel,
              timeoutMs: 120_000,
            });

            const before = await fetchSessionV2(baseUrl, token, sessionId);
            const metadataBefore = decryptLegacyBase64(before.metadata, secret) as any;
            const claudeSessionIdBefore =
              typeof metadataBefore?.claudeSessionId === 'string' ? metadataBefore.claudeSessionId : null;

            await enqueueSessionPromptForScenario({
              baseUrl,
              token,
              sessionId,
              secret,
              text: `Reply with EXACTLY this token and nothing else: ${memorySentinel}`,
            });

            await waitForAssistantMessageContaining({
              baseUrl,
              token,
              sessionId,
              secret,
              requiredSubstring: memorySentinel,
              timeoutMs: 120_000,
            });

            await enqueueSessionPromptForScenario({
              baseUrl,
              token,
              sessionId,
              secret,
              text: [
                'Run exactly one tool call:',
                `- Use the Bash tool to run: sh -lc "echo ABORT_STEP2_START ${memorySentinel} && sleep 20 && echo ABORT_STEP2_DONE"`,
                '- Do not use any other tools.',
                '- Then reply DONE.',
              ].join('\n'),
            });

            await sleep(1_500);
            await callSessionScopedRpc({
              baseUrl,
              token,
              sessionId,
              method: 'abort',
              payload: {},
              secret,
              timeoutMs: 30_000,
            });
            await sleep(250);

            await enqueueSessionPromptForScenario({
              baseUrl,
              token,
              sessionId,
              secret,
              text: [
                `Reply with EXACTLY two tokens separated by a single space: ${followupSentinel} <previous-token>.`,
                'The <previous-token> is the ABORT_MEMORY_* token from my previous message in this same session.',
              ].join(' '),
            });

            await waitForAssistantMessageContaining({
              baseUrl,
              token,
              sessionId,
              secret,
              requiredSubstrings: [followupSentinel],
              timeoutMs: 180_000,
            });

            if (claudeSessionIdBefore) {
              const after = await fetchSessionV2(baseUrl, token, sessionId);
              const metadataAfter = decryptLegacyBase64(after.metadata, secret) as any;
              const claudeSessionIdAfter =
                typeof metadataAfter?.claudeSessionId === 'string' ? metadataAfter.claudeSessionId : null;
              if (claudeSessionIdAfter && claudeSessionIdAfter !== claudeSessionIdBefore) {
                throw new Error('Expected Claude session id to remain stable after turn abort + continuation');
              }
            }
          },
        },
        verify: async () => {},
      };
    }

    if (provider.protocol === 'acp') {
      const pid = acpProviderId(provider);
      const sessionMetadataKey = acpResumeMetadataKey(provider.id);
      const followupTimeoutMs =
        provider.id === 'opencode' || provider.id === 'kilo' ? 300_000 : provider.id === 'kimi' ? 240_000 : 180_000;
      const readyAndMemoryTimeoutMs = provider.id === 'kilo' ? 180_000 : 120_000;
      const followupSubstrings = abortContinuationFollowupSubstrings(provider.id, followupSentinel, memorySentinel);
      return {
        id: 'abort_turn_then_continue',
        title: 'abort: interrupt a running turn and continue in the same session',
        tier: 'extended',
        waitMs: provider.id === 'kimi' ? 600_000 : undefined,
        yolo: true,
        allowPermissionAutoApproveInYolo: true,
        maxTraceEvents: { toolCalls: 4, toolResults: 4, permissionRequests: 2 },
        prompt: () => `Reply with EXACTLY this token and nothing else: ${readySentinel}`,
        requiredFixtureKeys: [],
        postSatisfy: {
          timeoutMs: followupTimeoutMs,
          run: async ({ baseUrl, token, sessionId, secret }) => {
            await waitForAssistantMessageContaining({
              baseUrl,
              token,
              sessionId,
              secret,
              requiredSubstring: readySentinel,
              timeoutMs: readyAndMemoryTimeoutMs,
            });

            const before = await fetchSessionV2(baseUrl, token, sessionId);
            const metadataBefore = decryptLegacyBase64(before.metadata, secret) as any;
            const providerSessionIdBefore =
              typeof metadataBefore?.[sessionMetadataKey] === 'string' ? String(metadataBefore[sessionMetadataKey]) : null;

            await enqueueSessionPromptForScenario({
              baseUrl,
              token,
              sessionId,
              secret,
              text: `Reply with EXACTLY this token and nothing else: ${memorySentinel}`,
            });

            await waitForAssistantMessageContaining({
              baseUrl,
              token,
              sessionId,
              secret,
              requiredSubstring: memorySentinel,
              timeoutMs: readyAndMemoryTimeoutMs,
            });

            await enqueueSessionPromptForScenario({
              baseUrl,
              token,
              sessionId,
              secret,
              text: [
                'Run exactly one tool call:',
                `- Use the execute tool to run: sh -lc "echo ABORT_STEP2_START ${memorySentinel} && sleep 20 && echo ABORT_STEP2_DONE"`,
                '- Do not use any other tools.',
                '- Then reply DONE.',
              ].join('\n'),
            });

            await sleep(1_500);
            await callSessionScopedRpc({
              baseUrl,
              token,
              sessionId,
              method: 'abort',
              payload: {},
              secret,
              timeoutMs: 30_000,
            });
            await sleep(250);

            await enqueueSessionPromptForScenario({
              baseUrl,
              token,
              sessionId,
              secret,
              text: [
                `Reply with EXACTLY two tokens separated by a single space: ${followupSentinel} <previous-token>.`,
                'The <previous-token> is the ABORT_MEMORY_* token from my previous message in this same session.',
              ].join(' '),
            });

            await waitForAssistantMessageContaining({
              baseUrl,
              token,
              sessionId,
              secret,
              requiredSubstrings: followupSubstrings,
              timeoutMs: followupTimeoutMs,
            });

            if (providerSessionIdBefore) {
              const after = await fetchSessionV2(baseUrl, token, sessionId);
              const metadataAfter = decryptLegacyBase64(after.metadata, secret) as any;
              const providerSessionIdAfter =
                typeof metadataAfter?.[sessionMetadataKey] === 'string' ? String(metadataAfter[sessionMetadataKey]) : null;
              if (providerSessionIdAfter && providerSessionIdAfter !== providerSessionIdBefore) {
                throw new Error('Expected provider resume session id to remain stable after turn abort + continuation');
              }
            }
          },
        },
        verify: async () => {},
      };
    }

    throw new Error(`abort_turn_then_continue unsupported for provider ${provider.id}`);
  },

  agent_sdk_abort_turn_then_continue: (provider) => {
    assertProviderId(provider, 'claude');
    const base = scenarioCatalog.abort_turn_then_continue(provider);
    return withAgentSdkRemoteMeta(base, {
      id: 'agent_sdk_abort_turn_then_continue',
      title: 'agent sdk: abort running turn then continue same session',
    });
  },

  // --------------------
  // ACP providers (Codex/OpenCode/Kilo)
  // --------------------
  execute_trace_ok: (provider) => {
    if (provider.id === 'opencode' || provider.id === 'kilo') {
      const pid = acpProviderId(provider);
      const expectedRawToolNames = ['execute', 'bash', 'shell', 'execute_command', 'exec_command'];
      return {
        id: 'execute_trace_ok',
        title: 'execute: echo TRACE_OK',
        tier: 'smoke',
        yolo: true,
        maxTraceEvents: { toolCalls: 1, toolResults: 1 },
        prompt: () =>
          [
            'Run exactly one tool call:',
            '- Use the execute tool to run: echo TRACE_OK',
            '- Then reply DONE.',
          ].join('\n'),
        // OpenCode currently surfaces execute calls as the canonical tool `Bash`, with `_happier.rawToolName="execute"`.
        requiredFixtureKeys: [`acp/${pid}/tool-call/Bash`, `acp/${pid}/tool-result/Bash`],
        requiredTraceSubstrings: ['TRACE_OK'],
        verify: async ({ fixtures }) => {
          const examples = fixtures?.examples;
          if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');

          const calls = (examples[`acp/${pid}/tool-call/Bash`] ?? []) as any[];
          if (!Array.isArray(calls) || calls.length === 0) throw new Error('Missing execute tool-call fixtures');
          const hasHappierExecute = calls.some((e) => {
            const raw = e?.payload?.input?._happier?.rawToolName;
            return e?.payload?.name === 'Bash' && typeof raw === 'string' && expectedRawToolNames.includes(raw);
          });
          if (!hasHappierExecute) {
            throw new Error(
              `Expected execute normalization on Bash tool-call (_happier.rawToolName in [${expectedRawToolNames.join(', ')}])`,
            );
          }

          const results = (examples[`acp/${pid}/tool-result/Bash`] ?? []) as any[];
          if (!Array.isArray(results) || results.length === 0) throw new Error('Missing execute tool-result fixtures');
          const hasOk = results.some((e) => {
            const out = e?.payload?.output;
            const stdout = typeof out === 'string' ? out : typeof out?.stdout === 'string' ? out.stdout : null;
            return hasStringSubstring(stdout, 'TRACE_OK');
          });
          if (!hasOk) throw new Error('execute tool-result did not include TRACE_OK in output');
          const hasExit0 = results.some((e) => {
            const out = e?.payload?.output;
            const exit =
              typeof out?.exit_code === 'number'
                ? out.exit_code
                : typeof out?.metadata?.exit === 'number'
                  ? out.metadata.exit
                  : null;
            return exit === 0;
          });
          if (!hasExit0) throw new Error('execute tool-result did not include exit_code=0');

          // Shape pin: ensures key structure doesn’t drift silently.
          const callShape = stableStringifyShape(shapeOf(calls[0]?.payload));
          const resultShape = stableStringifyShape(shapeOf(results[0]?.payload));
          if (!callShape.includes('\"_happier\"') || !callShape.includes('\"rawToolName\"') || !resultShape.includes('\"_happier\"')) {
            throw new Error('Unexpected execute tool-call/tool-result payload shape');
          }
        },
      };
    }

    const pid = acpProviderId(provider);
    if (provider.id === 'codex') {
      return {
      id: 'execute_trace_ok',
      title: 'execute: echo CODEX_TRACE_OK',
      tier: 'smoke',
      yolo: true,
      maxTraceEvents: { toolCalls: 1, toolResults: 1 },
      requiredFixtureKeys: [],
      prompt: () =>
        [
          'Run exactly one tool call:',
          '- Use the execute tool to run: echo CODEX_TRACE_OK',
          '- Then reply DONE.',
        ].join('\n'),
      requiredTraceSubstrings: ['CODEX_TRACE_OK'],
      verify: async ({ fixtures }) => {
        const examples = fixtures?.examples;
        if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');

        const keys = Object.keys(examples);
        const callKeys = keys.filter((k) => k.startsWith(`acp/${pid}/tool-call/`));
        const resultKeys = keys.filter((k) => k.startsWith(`acp/${pid}/tool-result/`));
        if (callKeys.length === 0) throw new Error('Expected at least one Codex tool-call fixture key');
        if (resultKeys.length === 0) throw new Error('Expected at least one Codex tool-result fixture key');

        const results = resultKeys.flatMap((k) => (Array.isArray((examples as any)[k]) ? (examples as any)[k] : []));
        const hasOk = results.some((e: any) => hasStringSubstring(e?.payload?.output, 'CODEX_TRACE_OK'));
        if (!hasOk) throw new Error('Codex tool-result did not include CODEX_TRACE_OK');
        },
      };
    }

    throw new Error(`execute_trace_ok only supports codex, opencode, or kilo providers (got ${provider.id})`);
  },

  permission_surface_execute: (provider) => {
    assertProviderId(provider, 'codex');
    const pid = acpProviderId(provider);
    const base = makeAcpPermissionExecuteWritesWorkspaceFileScenario({
      providerId: pid,
      id: 'permission_surface_execute',
      title: 'permissions: execute surfaces a permission-request trace (approve)',
      filename: 'codex-permission-e2e.txt',
      content: 'CODEX_EXEC_PERMISSION_OK',
      decision: 'approve',
    });

    return {
      ...base,
      // Force default permission mode so codex-acp runs with approval prompts enabled.
      messageMeta: { permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
      maxTraceEvents: { toolCalls: 2, toolResults: 2, permissionRequests: 2 },
    };
  },

  permission_abort_execute: (provider) => {
    assertProviderId(provider, 'codex');
    const pid = acpProviderId(provider);
    const base = makeAcpPermissionExecuteWritesWorkspaceFileScenario({
      providerId: pid,
      id: 'permission_abort_execute',
      title: 'permissions: denying execute prevents the command from running',
      filename: 'codex-abort-e2e.txt',
      content: 'CODEX_ABORT_OK',
      decision: 'deny',
    });

    return {
      ...base,
      messageMeta: { permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
      maxTraceEvents: { toolCalls: 2, toolResults: 2, permissionRequests: 2 },
    };
  },

  permission_surface_patch_apply: (provider) => {
    assertProviderId(provider, 'codex');
    const pid = acpProviderId(provider);
    const acpPermissions = provider.permissions?.acp;
    const expectPermissionRequest = resolveAcpToolPermissionPromptExpectation({
      acpPermissions,
      mode: 'default',
    });
    const base = makeAcpPermissionPatchApplyScenario({
      providerId: pid,
      id: 'permission_surface_patch_apply',
      title: expectPermissionRequest
        ? 'permissions: applying a patch surfaces a permission-request trace (approve)'
        : 'permissions: applying a patch updates the file when allowed (approve)',
      filename: 'codex-patch-permission-e2e.txt',
      before: 'CODEX_PATCH_PERMISSION_BEFORE_OK',
      after: 'CODEX_PATCH_PERMISSION_AFTER_OK',
      decision: 'approve',
      expectPermissionRequest,
    });

    return {
      ...base,
      // Force default permission mode so codex-acp runs with approval prompts enabled.
      messageMeta: { permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
      maxTraceEvents: {
        toolCalls: 2,
        toolResults: 2,
        permissionRequests: 2,
      },
    };
  },

  permission_abort_patch_apply: (provider) => {
    assertProviderId(provider, 'codex');
    const pid = acpProviderId(provider);
    const acpPermissions = provider.permissions?.acp;
    const expectPermissionRequest = resolveAcpToolPermissionPromptExpectation({
      acpPermissions,
      mode: 'default',
    });
    const base = makeAcpPermissionPatchApplyScenario({
      providerId: pid,
      id: 'permission_abort_patch_apply',
      title: expectPermissionRequest
        ? 'permissions: denying patch apply prevents the file from changing'
        : 'permissions: read-only mode prevents patch apply without interactive prompts',
      filename: 'codex-patch-abort-e2e.txt',
      before: 'CODEX_PATCH_ABORT_BEFORE_OK',
      after: 'CODEX_PATCH_ABORT_AFTER_OK',
      decision: 'deny',
      expectPermissionRequest,
    });

    return {
      ...base,
      messageMeta: expectPermissionRequest
        ? { permissionMode: 'default', permissionModeUpdatedAt: Date.now() }
        : { permissionMode: 'read-only', permissionModeUpdatedAt: Date.now() },
      maxTraceEvents: {
        toolCalls: 2,
        toolResults: 2,
        permissionRequests: 2,
      },
    };
  },

  execute_error_exit_2: (provider) => {
    if (provider.id !== 'opencode' && provider.id !== 'kilo') {
      throw new Error(`execute_error_exit_2 only supports opencode or kilo providers (got ${provider.id})`);
    }
    const pid = acpProviderId(provider);
    return {
      id: 'execute_error_exit_2',
      title: 'execute: echo TRACE_ERR && exit 2',
      tier: 'smoke',
      yolo: true,
      maxTraceEvents: { toolCalls: 1, toolResults: 1 },
      prompt: () =>
        [
          'Use the execute tool to run this exact command:',
          'sh -lc "echo TRACE_ERR && exit 2"',
          'Then reply DONE.',
        ].join('\n'),
      requiredFixtureKeys: [`acp/${pid}/tool-call/Bash`, `acp/${pid}/tool-result/Bash`],
      requiredTraceSubstrings: ['TRACE_ERR'],
      verify: async ({ fixtures }) => {
        const results = (fixtures?.examples?.[`acp/${pid}/tool-result/Bash`] ?? []) as any[];
        if (!Array.isArray(results) || results.length === 0) throw new Error('Missing execute tool-result fixtures');
        const hasErr = results.some((e) => {
          const out = e?.payload?.output;
          const stdout = typeof out === 'string' ? out : typeof out?.stdout === 'string' ? out.stdout : null;
          return hasStringSubstring(stdout, 'TRACE_ERR');
        });
        if (!hasErr) throw new Error('execute tool-result did not include TRACE_ERR');
        const hasExit2 = results.some((e) => {
          const out = e?.payload?.output;
          const exit =
            typeof out?.exit_code === 'number'
              ? out.exit_code
              : typeof out?.metadata?.exit === 'number'
                ? out.metadata.exit
                : null;
          return exit === 2;
        });
        if (!hasExit2) throw new Error('execute tool-result did not include exit_code=2');
      },
    };
  },

  task_subagent_reply: (provider) => {
    assertProviderId(provider, 'opencode');
    const pid = acpProviderId(provider);
    return {
      id: 'task_subagent_reply',
      title: 'task: returns a child session id in tool-result metadata',
      tier: 'extended',
      yolo: true,
      // Some ACP providers emit a few "refresh" tool-call updates for the same callId; allow a small buffer.
      // Also allow a small number of extra tool results in case the provider emits summary/metadata updates.
      maxTraceEvents: { toolCalls: 25, toolResults: 4 },
      // Sidechain import is asynchronous; wait for it while the CLI is still alive (pre-stop).
      postSatisfy: { waitForAcpSidechainFromToolName: 'Task', timeoutMs: 120_000 },
      prompt: ({ workspaceDir }) =>
        [
          'Run exactly one tool call:',
          '- Use the task tool (not execute) with this exact prompt:',
          '  Respond with EXACTLY: SUBTASK_OK',
          '- The subtask must not call any tools.',
          '- Do not use any other tools.',
          '- Then reply DONE.',
          '',
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      requiredAnyFixtureKeys: [
        [`acp/${pid}/tool-call/Task`, `acp/${pid}/tool-call/change_title`],
        [`acp/${pid}/tool-result/Task`, `acp/${pid}/tool-result/change_title`],
      ],
      verify: async ({ fixtures, baseUrl, token, sessionId, secret }) => {
        const results = (
          ((fixtures?.examples?.[`acp/${pid}/tool-result/Task`] ?? []) as any[])
            .concat((fixtures?.examples?.[`acp/${pid}/tool-result/change_title`] ?? []) as any[])
        );
        if (!Array.isArray(results) || results.length === 0) throw new Error('Missing Task tool-result fixtures');
        const hasChildSessionId = Array.isArray(results)
          ? results.some((e) => typeof e?.payload?.output?.metadata?.sessionId === 'string' && e.payload.output.metadata.sessionId.length > 0)
          : false;

        const calls = (
          ((fixtures?.examples?.[`acp/${pid}/tool-call/Task`] ?? []) as any[])
            .concat((fixtures?.examples?.[`acp/${pid}/tool-call/change_title`] ?? []) as any[])
        );
        const sidechainId =
          (Array.isArray(calls) && calls.length > 0 && typeof calls[0]?.payload?.callId === 'string' ? calls[0].payload.callId : null) ??
          (typeof results[0]?.payload?.callId === 'string' ? results[0].payload.callId : null);
        if (!sidechainId) throw new Error('Missing Task callId (needed to assert sidechain import)');

        // Sidechain import happens asynchronously after the Task tool-result surfaces the child session id.
        const sidechain = await waitForAcpSidechainMessages({
          baseUrl,
          token,
          sessionId,
          secret,
          sidechainId,
          timeoutMs: 60_000,
        });
        if (sidechain.messages.length === 0) {
          throw new Error('Expected at least one imported sidechain message, but none were found');
        }
        const hasImportedMeta = sidechain.messages.some((m) => m?.meta?.importedFrom === 'acp-sidechain');
        if (!hasImportedMeta) {
          throw new Error('Sidechain messages found, but none were tagged with meta.importedFrom="acp-sidechain"');
        }
        const hasExpectedReply = sidechain.messages.some((m) => hasStringSubstring(m, 'SUBTASK_OK'));
        if (!hasExpectedReply) {
          throw new Error('Expected imported sidechain to include SUBTASK_OK response');
        }
        if (!hasChildSessionId && sidechain.messages.length === 0) {
          throw new Error('Task did not emit child session evidence in tool-result or imported sidechain messages');
        }
      },
    };
  },

  read_in_workspace: (provider) => {
    assertProviderId(provider, 'codex');
    return makeAcpReadInWorkspaceScenario({
      providerId: acpProviderId(provider),
      content: 'CODEX_READ_OK',
    });
  },

  search_known_token: (provider) => {
    const pid = acpProviderId(provider);
    const token = provider.id === 'codex' ? 'CODEX_SEARCH_OK' : 'SEARCH_TOKEN_XYZ';
    const scenario = makeAcpSearchKnownTokenScenario({ providerId: pid, token });

    if (provider.id === 'opencode') {
      return {
        ...scenario,
        verify: async ({ fixtures }) => {
          const examples = fixtures?.examples;
          if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');
          const searchResults =
            ((examples[`acp/${pid}/tool-result/CodeSearch`] ?? []) as any[])
              .concat((examples[`acp/${pid}/tool-result/Search`] ?? []) as any[])
              .concat((examples[`acp/${pid}/tool-result/Grep`] ?? []) as any[]);
          if (searchResults.length > 0) {
            const hasHappierSearch = searchResults.some((e) => e?.payload?.output?._happier?.rawToolName === 'search');
            if (!hasHappierSearch) {
              throw new Error('Expected OpenCode search normalization (_happier.rawToolName="search") on tool-result');
            }
            return;
          }

          const bashResults = ((examples[`acp/${pid}/tool-result/Bash`] ?? []) as any[]);
          if (bashResults.length === 0) {
            throw new Error('Missing search tool-result fixtures');
          }

          const hasTokenInBashOutput = bashResults.some((entry) => {
            const output = entry?.payload?.output;
            if (typeof output === 'string') return hasStringSubstring(output, token);
            if (output && typeof output === 'object') {
              const candidate = (output as { output?: unknown }).output;
              return hasStringSubstring(candidate, token);
            }
            return false;
          });

          if (!hasTokenInBashOutput) {
            throw new Error('Expected bash fallback output to include the search token');
          }
        },
      };
    }

    return scenario;
  },

  write_in_workspace: (provider) => {
    assertProviderId(provider, 'codex');
    return makeAcpWriteInWorkspaceScenario({
      providerId: acpProviderId(provider),
      filename: 'e2e-write.txt',
      content: 'CODEX_WRITE_OK',
    });
  },

  write_in_workspace_opencode: (provider) => {
    assertProviderId(provider, 'opencode');
    return makeAcpWriteInWorkspaceScenario({
      providerId: acpProviderId(provider),
      filename: 'e2e-write.txt',
      content: 'HELLO_E2E',
    });
  },

  edit_write_file_and_cat: (provider) => {
    if (provider.id !== 'opencode' && provider.id !== 'kilo') {
      throw new Error(`edit_write_file_and_cat only supports opencode or kilo providers (got ${provider.id})`);
    }
    return makeAcpWriteInWorkspaceScenario({
      providerId: acpProviderId(provider),
      id: 'edit_write_file_and_cat',
      title: 'edit: write file and cat it',
      filename: 'e2e-write.txt',
      content: 'HELLO_E2E',
    });
  },

  write_then_stream_markdown_table: (provider) => {
    if (provider.id !== 'opencode' && provider.id !== 'kilo') {
      throw new Error(`write_then_stream_markdown_table only supports opencode or kilo providers (got ${provider.id})`);
    }
    return makeAcpWriteThenStreamMarkdownTableScenario({
      providerId: acpProviderId(provider),
      id: 'write_then_stream_markdown_table',
      title: 'streaming: write then stream markdown table',
      filename: 'e2e-stream-table.txt',
      fileContent: 'STREAM_TABLE_FILE_E2E',
      marker: 'STREAM_TABLE_E2E_OK',
    });
  },

  glob_list_files: (provider) =>
    makeAcpGlobListFilesScenario({
      providerId: acpProviderId(provider),
      filenames: ['e2e-a.txt', 'e2e-b.txt'],
    }),

  search_ls_equivalence: (provider) =>
    makeAcpSearchLsEquivalenceScenario({
      providerId: acpProviderId(provider),
      filenames: ['e2e-a.txt', 'e2e-b.txt'],
      token: provider.id === 'codex' ? 'CODEX_SEARCH_LS_EQUIV_OK' : 'SEARCH_LS_EQUIV_E2E',
    }),

  read_missing_file_in_workspace: (provider) =>
    makeAcpReadMissingFileScenario({
      providerId: acpProviderId(provider),
      filename: 'e2e-missing.txt',
    }),

  patch_includes_diff: (provider) => {
    assertProviderId(provider, 'codex');
    return makeAcpPatchIncludesDiffScenario({
      providerId: acpProviderId(provider),
      filename: 'e2e-patch.txt',
      before: 'CODEX_PATCH_BEFORE_OK',
      after: 'CODEX_PATCH_AFTER_OK',
    });
  },

  edit_result_includes_diff: (provider) =>
    makeAcpEditResultIncludesDiffScenario({
      providerId: acpProviderId(provider),
      filename: 'e2e-edit-diff.txt',
      before: provider.id === 'codex' ? 'CODEX_EDIT_DIFF_BEFORE_OK' : 'BEFORE_EDIT_DIFF_E2E',
      after: provider.id === 'codex' ? 'CODEX_EDIT_DIFF_AFTER_OK' : 'AFTER_EDIT_DIFF_E2E',
      useAbsolutePath: provider.id === 'auggie',
    }),

  multi_file_edit_in_workspace: (provider) =>
    makeAcpMultiFileEditScenario({
      providerId: acpProviderId(provider),
      files:
        provider.id === 'codex'
          ? [
              { filename: 'e2e-multi-a.txt', content: 'CODEX_MULTI_A_OK' },
              { filename: 'e2e-multi-b.txt', content: 'CODEX_MULTI_B_OK' },
            ]
          : [
              { filename: 'e2e-multi-a.txt', content: 'MULTI_A_E2E' },
              { filename: 'e2e-multi-b.txt', content: 'MULTI_B_E2E' },
            ],
      useAbsolutePath: provider.id === 'auggie',
    }),

  multi_file_edit_in_workspace_includes_diff: (provider) =>
    makeAcpMultiFileEditIncludesDiffScenario({
      providerId: acpProviderId(provider),
      files:
        provider.id === 'codex'
          ? [
              { filename: 'e2e-multi-diff-a.txt', before: 'CODEX_MULTI_DIFF_A_BEFORE', after: 'CODEX_MULTI_DIFF_A_AFTER' },
              { filename: 'e2e-multi-diff-b.txt', before: 'CODEX_MULTI_DIFF_B_BEFORE', after: 'CODEX_MULTI_DIFF_B_AFTER' },
            ]
          : [
              { filename: 'e2e-multi-diff-a.txt', before: 'MULTI_DIFF_A_BEFORE', after: 'MULTI_DIFF_A_AFTER' },
              { filename: 'e2e-multi-diff-b.txt', before: 'MULTI_DIFF_B_BEFORE', after: 'MULTI_DIFF_B_AFTER' },
            ],
      useAbsolutePath: provider.id === 'auggie',
    }),

  mcp_change_title: (provider) => {
    const pid = acpProviderId(provider);
    const title = 'KILO_MCP_TITLE_E2E';
    return {
      id: 'mcp_change_title',
      title: 'mcp: change_title via Happier MCP server',
      tier: 'extended',
      yolo: true,
      maxTraceEvents: { toolCalls: 1, toolResults: 1, permissionRequests: 1 },
      prompt: ({ workspaceDir }) =>
        [
          'Run exactly one tool call:',
          '- Use the change_title tool to set the chat title to:',
          `  ${title}`,
          '- Do not use execute or any file tools.',
          '- Then reply DONE.',
          '',
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      requiredAnyFixtureKeys: [
        [`acp/${pid}/tool-call/change_title`, `acp/${pid}/tool-call/mcp__happier__change_title`],
        [`acp/${pid}/tool-result/change_title`, `acp/${pid}/tool-result/mcp__happier__change_title`],
      ],
      requiredTraceSubstrings: [title],
    };
  },

  glob_tool_list_files: (provider) => {
    assertProviderId(provider, 'kilo');
    const pid = acpProviderId(provider);
    const filenames = ['e2e-glob-a.txt', 'e2e-glob-b.txt'];
    const pattern = 'e2e-glob-*.txt';
    return {
      id: 'glob_tool_list_files',
      title: 'glob: list matching files (Kilo uses search tool for glob)',
      tier: 'extended',
      yolo: true,
      maxTraceEvents: { toolCalls: 1, toolResults: 1, permissionRequests: 1 },
      setup: async ({ workspaceDir }) => {
        await writeFile(join(workspaceDir, filenames[0]!), `GLOB_A_${randomUUID()}\n`, 'utf8');
        await writeFile(join(workspaceDir, filenames[1]!), `GLOB_B_${randomUUID()}\n`, 'utf8');
      },
      prompt: ({ workspaceDir }) =>
        [
          'Run exactly one tool call:',
          '- Use the search tool (not execute) to list matching file paths in the current working directory:',
          `  Pattern: ${pattern}`,
          '- Do not use any other tool.',
          '- Then reply DONE.',
          '',
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      requiredFixtureKeys: [`acp/${pid}/tool-call/CodeSearch`, `acp/${pid}/tool-result/CodeSearch`],
      requiredTraceSubstrings: [...filenames],
    };
  },

  ls_tool_list_files: (provider) => {
    assertProviderId(provider, 'kilo');
    const pid = acpProviderId(provider);
    const filenames = ['e2e-ls-a.txt', 'e2e-ls-b.txt'];
    return {
      id: 'ls_tool_list_files',
      title: 'ls: list_files tool lists directory entries',
      tier: 'extended',
      // Kilo does not always mark sessions active before the first prompt; avoid a YOLO-mode
      // deadlock where the harness waits for session.active before enqueueing the prompt.
      yolo: false,
      maxTraceEvents: { toolCalls: 1, toolResults: 1, permissionRequests: 1 },
      setup: async ({ workspaceDir }) => {
        await writeFile(join(workspaceDir, filenames[0]!), `LS_A_${randomUUID()}\n`, 'utf8');
        await writeFile(join(workspaceDir, filenames[1]!), `LS_B_${randomUUID()}\n`, 'utf8');
      },
      prompt: ({ workspaceDir }) =>
        [
          'Run exactly one tool call:',
          '- Use the list_files tool (not execute) to list files in the current working directory.',
          '- Do not use any other tool.',
          '- Then reply DONE.',
          '',
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      requiredFixtureKeys: [`acp/${pid}/tool-call/LS`, `acp/${pid}/tool-result/LS`],
      requiredTraceSubstrings: [...filenames],
    };
  },

  kilo_task_subagent_reply: (provider) => {
    assertProviderId(provider, 'kilo');
    const pid = acpProviderId(provider);
    return {
      id: 'kilo_task_subagent_reply',
      title: 'task: Kilo Task tool returns child session id',
      tier: 'extended',
      yolo: true,
      maxTraceEvents: { toolCalls: 25, toolResults: 4 },
      prompt: ({ workspaceDir }) =>
        [
          'Run exactly one tool call:',
          '- Use the task tool (not execute) with this exact prompt:',
          '  Respond with EXACTLY: SUBTASK_OK',
          '- The subtask must not call any tools.',
          '- Do not use any other tools.',
          '- Then reply DONE.',
          '',
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      requiredAnyFixtureKeys: [
        [`acp/${pid}/tool-call/Task`, `acp/${pid}/tool-call/change_title`],
        [`acp/${pid}/tool-result/Task`, `acp/${pid}/tool-result/change_title`],
      ],
      requiredTraceSubstrings: ['SUBTASK_OK'],
      verify: async ({ fixtures, baseUrl, token, sessionId, secret }) => {
        const results = (
          ((fixtures?.examples?.[`acp/${pid}/tool-result/Task`] ?? []) as any[])
            .concat((fixtures?.examples?.[`acp/${pid}/tool-result/change_title`] ?? []) as any[])
        );
        if (!Array.isArray(results) || results.length === 0) throw new Error('Missing task tool-result fixtures');
        const hasChildSessionId = results.some(
          (e) => typeof e?.payload?.output?.metadata?.sessionId === 'string' && e.payload.output.metadata.sessionId.length > 0,
        );
        if (!hasChildSessionId) throw new Error('task tool-result did not include metadata.sessionId (child session id)');
      },
    };
  },

  delete_file_in_workspace: (provider) => {
    assertProviderId(provider, 'kilo');
    const pid = acpProviderId(provider);
    const filename = 'e2e-delete.txt';
    const rmSnippet = `rm -f ${filename}`;
    return {
      id: 'delete_file_in_workspace',
      title: 'delete: delete a workspace file (via execute)',
      tier: 'extended',
      // Kilo does not always mark sessions active before the first prompt; avoid a YOLO-mode
      // deadlock where the harness waits for session.active before enqueueing the prompt.
      yolo: false,
      maxTraceEvents: { toolCalls: 8, toolResults: 2, permissionRequests: 1 },
      setup: async ({ workspaceDir }) => {
        await writeFile(join(workspaceDir, filename), `DELETE_SENTINEL_${randomUUID()}\n`, 'utf8');
      },
      prompt: ({ workspaceDir }) =>
        [
          'Run exactly one tool call:',
          `- Use the execute tool to delete this file in the current working directory by running: ${rmSnippet}`,
          '- Do not use any other tools.',
          '- Then reply DONE.',
          '',
          `Note: current working directory is ${workspaceDir}`,
        ].join('\n'),
      requiredFixtureKeys: [`acp/${pid}/tool-call/Bash`, `acp/${pid}/tool-result/Bash`],
      verify: async ({ fixtures, workspaceDir }) => {
        const examples = fixtures?.examples;
        if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');
        const calls = (examples[`acp/${pid}/tool-call/Bash`] ?? []) as any[];
        if (!Array.isArray(calls) || calls.length === 0) throw new Error('Missing execute tool-call fixtures');

        const expectedCommand = rmSnippet;
        const hasExpectedRm = calls.some((e) => hasStringSubstring(e?.payload?.input, expectedCommand));
        if (!hasExpectedRm) throw new Error(`execute tool-call did not include expected command substring: ${expectedCommand}`);

        if (existsSync(join(workspaceDir, filename))) {
          throw new Error('Expected file to be deleted, but it still exists');
        }
      },
    };
  },

  permission_deny_read_outside_workspace: (provider) => {
    assertProviderId(provider, 'opencode');
    return makeAcpPermissionDenyOutsideWorkspaceReadScenario({
      providerId: acpProviderId(provider),
      token: 'OUTSIDE_READ_DENIED_E2E',
    });
  },

  acp_resume_load_session: (provider) =>
    tuneResumeScenarioForProvider(provider, makeAcpResumeLoadSessionScenario({
      providerId: acpProviderId(provider),
      metadataKey: acpResumeMetadataKey(provider.id),
      phase1TraceSentinel: provider.id === 'codex' ? 'CODEX_RESUME_PHASE1_OK' : 'RESUME_PHASE1_OK',
      phase2TraceSentinel: provider.id === 'codex' ? 'CODEX_RESUME_PHASE2_OK' : 'RESUME_PHASE2_OK',
      title:
        provider.id === 'codex'
          ? 'resume: second attach uses --resume from session metadata (Codex ACP)'
          : 'resume: second attach uses --resume from session metadata',
    })),

  acp_resume_fresh_session_imports_history: (provider) =>
    tuneResumeScenarioForProvider(provider, makeAcpResumeFreshSessionImportsHistoryScenario({
      providerId: acpProviderId(provider),
      metadataKey: acpResumeMetadataKey(provider.id),
      phase1TraceSentinel: provider.id === 'codex' ? 'CODEX_IMPORT_PHASE1_TRACE_OK' : 'IMPORT_PHASE1_TRACE_OK',
      phase1TextSentinel: provider.id === 'codex' ? 'CODEX_IMPORT_PHASE1_TEXT_OK' : 'IMPORT_PHASE1_TEXT_OK',
      phase2TraceSentinel: provider.id === 'codex' ? 'CODEX_IMPORT_PHASE2_TRACE_OK' : 'IMPORT_PHASE2_TRACE_OK',
      phase2TextSentinel: provider.id === 'codex' ? 'CODEX_IMPORT_PHASE2_TEXT_OK' : 'IMPORT_PHASE2_TEXT_OK',
      title:
        provider.id === 'codex'
          ? 'resume: fresh session imports remote transcript history (Codex ACP)'
          : 'resume: fresh session imports remote transcript history',
    })),
};

for (const [id, factory] of Object.entries(scenarioCatalog) as Array<[string, ScenarioFactory]>) {
  scenarioCatalog[id] = (provider: ProviderUnderTest) => withKimiUnknownToolFixtureAliases(provider, factory(provider));
}
