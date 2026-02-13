import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { envFlag } from '../../env';
import { parsePositiveInt } from '../../numbers';

import type { ProviderScenario } from '../types';

const fatalAssistantErrorSubstrings = [
  'authentication required',
  'not configured',
  'api key',
  'unauthorized',
  '401',
  'verify your account',
  'validation required',
];

const fatalCliLogSubstrings = [
  'out of credits',
  'usage_limit_exceeded',
  'hit your usage limit',
  'usage limit',
  'failed to connect mcp servers',
  'client failed to connect',
  'authentication required',
  'unauthorized',
  'api key',
  'not configured',
  'verify your account',
  'validation_required',
  'permission_denied',
  'error during prompt',
];

const providerUnavailabilityErrorSubstrings = [
  'missing required binary for provider',
  'missing required env for provider',
  'missing required env for provider auth mode',
  'authentication required',
  'provider not configured',
  'llm not set',
  'failed to connect mcp servers',
  'client failed to connect',
  'out of credits',
  'usage_limit_exceeded',
  'usage limit',
  'unauthorized',
  'api key',
  'verify your account',
  'account verification required',
  'validation required',
  'validation_required',
  'prompt request failed',
  'error during prompt',
];

export function resolveResumeSessionMode(resume: ProviderScenario['resume'] | undefined): 'same' | 'fresh' {
  return resume && resume.freshSession === true ? 'fresh' : 'same';
}

export function shouldStartProviderDaemon(params: {
  providerProtocol: string;
  hasPostSatisfyRunHook: boolean;
}): boolean {
  return params.providerProtocol === 'acp';
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

export function countTaskCompleteMessages(messages: unknown[]): number {
  let count = 0;
  for (const msg of messages) {
    const record = asRecord(msg);
    if (record?.type === 'task_complete') count++;
  }
  return count;
}

export function countTaskCompleteTraceEvents(events: unknown[]): number {
  let count = 0;
  for (const event of events) {
    const record = asRecord(event);
    if (record?.kind === 'task_complete') count++;
  }
  return count;
}

export function resolveTaskCompleteBaselineAtStepStart(params: {
  providerProtocol: string;
  allowInFlightSteer?: boolean;
  traceEvents: unknown[];
  decodedMessagesSeen: unknown[];
}): number | null {
  if (params.allowInFlightSteer) return null;
  if (params.providerProtocol !== 'acp') return null;
  return Math.max(
    countTaskCompleteMessages(params.decodedMessagesSeen),
    countTaskCompleteTraceEvents(params.traceEvents),
  );
}

export function shouldEnqueueNextStepAfterSatisfaction(params: {
  providerProtocol: string;
  allowInFlightSteer?: boolean;
  traceEvents: unknown[];
  decodedMessagesSeen: unknown[];
  taskCompleteCountAtStepSatisfaction: number | null;
}): boolean {
  if (params.allowInFlightSteer) return true;
  if (params.providerProtocol !== 'acp') return true;
  if (params.taskCompleteCountAtStepSatisfaction == null) return false;
  const taskCompleteCount = Math.max(
    countTaskCompleteMessages(params.decodedMessagesSeen),
    countTaskCompleteTraceEvents(params.traceEvents),
  );
  return taskCompleteCount > params.taskCompleteCountAtStepSatisfaction;
}

export function isSkippableProviderUnavailabilityError(error: unknown): boolean {
  const text = String(error ?? '').toLowerCase();
  if (!text.trim()) return false;
  return providerUnavailabilityErrorSubstrings.some((needle) => text.includes(needle));
}

function extractTextMessageContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return null;
  const value = content as Record<string, unknown>;
  if (typeof value.text === 'string') return value.text;
  if (Array.isArray(value.parts)) {
    for (const part of value.parts) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim().length > 0) return text;
    }
  }
  return null;
}

export function extractFatalAgentErrorMessage(messages: unknown[]): string | null {
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const row = message as Record<string, unknown>;
    if (row.role !== 'assistant') continue;

    const text = extractTextMessageContent(row.content);
    if (!text) continue;

    const lower = text.toLowerCase();
    const isExplicitError = lower.trimStart().startsWith('error:');
    if (!isExplicitError) continue;

    if (fatalAssistantErrorSubstrings.some((needle) => lower.includes(needle))) {
      return text.trim();
    }
  }
  return null;
}

export async function readFatalProviderErrorFromCliLogs(params: {
  cliHome: string;
  extraLogPaths?: string[];
}): Promise<string | null> {
  const logsDir = join(params.cliHome, 'logs');
  const candidateSet = new Set<string>();
  if (existsSync(logsDir)) {
    const entries = await readdir(logsDir, { withFileTypes: true }).catch(() => []);
    for (const filePath of entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
      .map((entry) => join(logsDir, entry.name))
      .sort()
      .slice(-4)
      .reverse()) {
      candidateSet.add(filePath);
    }
  }

  for (const extraPath of params.extraLogPaths ?? []) {
    const normalized = String(extraPath ?? '').trim();
    if (!normalized || !normalized.endsWith('.log')) continue;
    candidateSet.add(normalized);
  }

  const candidates = [...candidateSet];

  for (const filePath of candidates) {
    const raw = await readFile(filePath, 'utf8').catch(() => '');
    if (!raw) continue;

    const sample = raw.length > 80_000
      ? `${raw.slice(0, 32_000)}\n${raw.slice(-80_000)}`
      : raw;
    const lower = sample.toLowerCase();
    const fatal = fatalCliLogSubstrings.find((needle) => lower.includes(needle));
    if (!fatal) continue;

    // Some providers log non-fatal "No API key found" warnings when they support alternate
    // auth methods (for example OAuth). Avoid treating those warnings as hard failures.
    if (fatal === 'api key' && lower.includes('no api key found')) {
      continue;
    }

    if (fatal === 'out of credits') return 'Out of credits';
    if (fatal === 'usage_limit_exceeded' || fatal === 'hit your usage limit' || fatal === 'usage limit') {
      return 'Usage limit exceeded';
    }
    if (fatal === 'failed to connect mcp servers' || fatal === 'client failed to connect') {
      return 'Failed to connect MCP servers';
    }
    if (fatal === 'authentication required') return 'Authentication required';
    if (fatal === 'unauthorized') return 'Unauthorized';
    if (fatal === 'api key') return 'API key error';
    if (fatal === 'not configured') return 'Provider not configured';
    if (fatal === 'verify your account' || fatal === 'validation_required' || fatal === 'permission_denied') {
      return 'Account verification required';
    }
    if (fatal === 'error during prompt') return 'Prompt request failed';
    return 'Provider fatal error';
  }

  return null;
}

export function resolveSessionActiveWaitMs(globalWaitMsRaw: string | undefined): number {
  const globalWaitMs = parsePositiveInt(globalWaitMsRaw, 240_000);
  return Math.max(60_000, Math.min(globalWaitMs, 240_000));
}

export function resolveScenarioWaitMs(params: {
  scenarioWaitMs: number | undefined;
  globalWaitMsRaw: string | undefined;
}): number {
  const globalWaitMs = parsePositiveInt(params.globalWaitMsRaw, 240_000);
  const scenarioWaitMs =
    typeof params.scenarioWaitMs === 'number' && Number.isFinite(params.scenarioWaitMs)
      ? Math.floor(params.scenarioWaitMs)
      : globalWaitMs;
  return Math.max(30_000, Math.min(scenarioWaitMs, 3_600_000));
}

export function resolveProviderInactivityTimeoutMs(
  raw: string | undefined,
  maxWaitMs: number,
  providerId?: string,
  scenarioInactivityTimeoutMs?: number,
): number {
  const defaultTimeoutMs = providerId === 'kimi' ? 240_000 : 120_000;
  const scenarioDefaultTimeoutMs =
    typeof scenarioInactivityTimeoutMs === 'number' && Number.isFinite(scenarioInactivityTimeoutMs)
      ? Math.max(30_000, Math.floor(scenarioInactivityTimeoutMs))
      : defaultTimeoutMs;
  const parsed = parsePositiveInt(raw, scenarioDefaultTimeoutMs);
  return Math.max(30_000, Math.min(parsed, maxWaitMs));
}

export function resolveProviderPermissionBlockTimeoutMs(raw: string | undefined, maxWaitMs: number): number {
  const parsed = parsePositiveInt(raw, 45_000);
  return Math.max(10_000, Math.min(parsed, maxWaitMs));
}

export async function waitForSessionActiveBestEffort(params: {
  yolo: boolean;
  wait: () => Promise<void>;
}): Promise<void> {
  if (!params.yolo) return;
  await params.wait().catch(() => {
    // Some provider/daemon combinations may not mark sessions active until after the first prompt enqueue.
    // Treat this as best-effort.
  });
}

export function resolvePendingDrainTimeoutMs(params: {
  providerId: string;
  scenarioMeta: Record<string, unknown>;
}): number {
  if (params.providerId === 'claude' && params.scenarioMeta?.claudeRemoteAgentSdkEnabled === true) {
    return 300_000;
  }
  if (params.providerId === 'codex') return 180_000;
  return 60_000;
}

export function shouldAssertPendingDrain(params: { assertPendingDrain?: boolean }): boolean {
  const enabledByEnv = envFlag(['HAPPIER_E2E_PROVIDER_ASSERT_PENDING_EMPTY', 'HAPPY_E2E_PROVIDER_ASSERT_PENDING_EMPTY'], true);
  if (!enabledByEnv) return false;
  return params.assertPendingDrain !== false;
}

export function resolveCliDistAvailabilityWaitMs(raw: string | undefined): number {
  const parsed = parsePositiveInt(raw, 180_000);
  return Math.max(30_000, Math.min(parsed, 600_000));
}

export function resolveCliDistPreflightAllowRebuild(): boolean {
  return envFlag(
    ['HAPPIER_E2E_PROVIDER_ALLOW_CLI_PREBUILD_REBUILD', 'HAPPY_E2E_PROVIDER_ALLOW_CLI_PREBUILD_REBUILD'],
    true,
  );
}

export function shouldAutoApprovePermissionRequest(params: {
  yolo: boolean;
  toolName: string | null | undefined;
  allowPermissionAutoApproveInYolo: boolean;
}): boolean {
  if (!params.yolo) return true;
  if ((params.toolName ?? '').trim() === 'AcpHistoryImport') return true;
  return params.allowPermissionAutoApproveInYolo;
}
