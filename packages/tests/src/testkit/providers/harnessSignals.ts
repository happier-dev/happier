import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { envFlag } from '../env';
import { parsePositiveInt } from '../numbers';

import type { ProviderScenario } from './types';

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

export async function readFatalProviderErrorFromCliLogs(params: { cliHome: string }): Promise<string | null> {
  const logsDir = join(params.cliHome, 'logs');
  if (!existsSync(logsDir)) return null;

  const entries = await readdir(logsDir, { withFileTypes: true }).catch(() => []);
  const logFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
    .map((entry) => join(logsDir, entry.name))
    .sort()
    .slice(-4)
    .reverse();

  for (const filePath of logFiles) {
    const raw = await readFile(filePath, 'utf8').catch(() => '');
    if (!raw) continue;

    const tail = raw.slice(-16_000);
    const lower = tail.toLowerCase();
    const fatal = fatalCliLogSubstrings.find((needle) => lower.includes(needle));
    if (!fatal) continue;

    if (fatal === 'out of credits') return 'Out of credits';
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

export function resolveProviderInactivityTimeoutMs(
  raw: string | undefined,
  maxWaitMs: number,
  providerId?: string,
): number {
  const defaultTimeoutMs = providerId === 'kimi' ? 240_000 : 120_000;
  const parsed = parsePositiveInt(raw, defaultTimeoutMs);
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

export function shouldAutoApprovePermissionRequest(params: {
  yolo: boolean;
  toolName: string | null | undefined;
  allowPermissionAutoApproveInYolo: boolean;
}): boolean {
  if (!params.yolo) return true;
  if ((params.toolName ?? '').trim() === 'AcpHistoryImport') return true;
  return params.allowPermissionAutoApproveInYolo;
}
