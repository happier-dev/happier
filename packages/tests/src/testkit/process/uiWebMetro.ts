import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { relative, resolve as resolvePath } from 'node:path';

import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { expandLoopbackBaseUrlCandidates } from '../network/loopbackBaseUrl';
import { repoRootDir } from '../paths';
import { sleep, waitFor } from '../timing';
import {
  inspectOwnedProcess,
  registerProcessOwnershipLease,
  resolveProcessOwnershipLeasesDir,
  sweepProcessOwnershipLeases,
} from './processOwnershipLease';
import { redactHarnessLogText } from './harnessLogRedaction';
import { readPositiveEnvInt, resolveUiWebEntryProbeTimeoutMs } from './uiWebEnv';
import { resolveScriptUrlsFromHtml, selectPrimaryAppScriptUrl } from './uiWebHtml';
import { resolveUiWebSourceFingerprint } from './uiWebSourceFingerprint';
import { spawnLoggedProcess } from './spawnProcess';
import { ensureUiWebWorkspacePrebuild } from './uiWebWorkspacePrebuild';
import type { StartedUiWeb } from './uiWebTypes';
import { resolveExpoCliPath } from './expoCliPath';
import { inspectMetroPackagerStatusResponse } from './metroPackagerStatus';

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

const uiWebMetroSessionCacheBustSymbol = Symbol.for('happier.tests.uiWebMetroSessionCacheBust');

function resolveUiWebMetroSessionCacheBust(): string {
  const globalState = globalThis as typeof globalThis & {
    [uiWebMetroSessionCacheBustSymbol]?: string;
  };
  const cachedBust = globalState[uiWebMetroSessionCacheBustSymbol];
  if (typeof cachedBust === 'string' && cachedBust.trim().length > 0) {
    return cachedBust;
  }

  const sessionBust = createHash('sha256')
    .update(repoRootDir())
    .update('\0')
    .update(String(process.pid))
    .update('\0')
    .update(String(process.ppid))
    .update('\0')
    .update(String(process.uptime()))
    .update('\0')
    .update(String(Date.now()))
    .digest('hex');
  globalState[uiWebMetroSessionCacheBustSymbol] = sessionBust;
  return sessionBust;
}

function resolveUiWebMetroCacheVersionBust(env: NodeJS.ProcessEnv): string {
  const sessionBust = resolveUiWebMetroSessionCacheBust();
  const sourceFingerprint = resolveUiWebSourceFingerprint();
  const explicitBust = String(env.HAPPIER_UI_METRO_CACHE_VERSION_BUST ?? '').trim();
  return createHash('sha256')
    .update(sessionBust)
    .update('\0')
    .update(sourceFingerprint)
    .update('\0')
    .update(explicitBust)
    .digest('hex');
}

function looksLikeUiWebMetroCommand(command: string): boolean {
  const normalized = command.replaceAll('\\', '/');
  return normalized.includes('start --web')
    && normalized.includes('--host localhost')
    && (normalized.includes('/expo/bin/cli') || normalized.includes('expo') || normalized.includes('node'));
}

export function resolveUiWebMetroOwnershipLeasesDir(rootDir: string = repoRootDir()): string {
  return resolveProcessOwnershipLeasesDir({ rootDir, leaseKind: 'ui-web-metro' });
}

function resolveUiWebMetroNodeOptions(raw: string | undefined): string {
  const existing = String(raw ?? '').trim();
  const ipv4First = '--dns-result-order=ipv4first';
  if (existing.split(/\s+/).includes(ipv4First)) {
    return existing;
  }
  return existing ? `${existing} ${ipv4First}` : ipv4First;
}

type UiWebMetroStartParams = {
  testDir: string;
  env: NodeJS.ProcessEnv;
  port?: number;
  skipWorkspacePrebuild?: boolean;
};

function shouldRunWorkspacePrebuild(params: Pick<UiWebMetroStartParams, 'skipWorkspacePrebuild'>): boolean {
  return params.skipWorkspacePrebuild !== true;
}

function resolveUiWebMetroSpawnEnv(params: Readonly<{
  env: NodeJS.ProcessEnv;
  tmpDir: string;
  metroCacheVersionBust: string;
  noDev: boolean;
}>): NodeJS.ProcessEnv {
  // In "no-dev" mode we force `CI=1` to avoid Expo interactive prompts/noise and to
  // better match production behavior. When running with dev enabled, allow callers
  // to opt out of CI so React errors are not minified and debugging is practical.
  const baseEnv: NodeJS.ProcessEnv = {
    ...params.env,
    EXPO_NO_TELEMETRY: '1',
    EXPO_NO_INTERACTIVE: '1',
    EXPO_UNSTABLE_WEB_MODAL: '1',
    BROWSER: 'none',
    ...(typeof params.env.HAPPIER_UI_METRO_WATCH_MONOREPO_ROOT_NODE_MODULES === 'string'
      ? {
          HAPPIER_UI_METRO_WATCH_MONOREPO_ROOT_NODE_MODULES:
            params.env.HAPPIER_UI_METRO_WATCH_MONOREPO_ROOT_NODE_MODULES,
        }
      : {}),
    HAPPIER_UI_METRO_CACHE_VERSION_BUST: params.metroCacheVersionBust,
    // Expo's localhost mode passes the hostname directly to `server.listen`. Pin its
    // resolution to the same IPv4 loopback origin returned by the E2E URL normalizer.
    NODE_OPTIONS: resolveUiWebMetroNodeOptions(params.env.NODE_OPTIONS),
    TMPDIR: params.tmpDir,
    TMP: params.tmpDir,
    TEMP: params.tmpDir,
  };

  if (params.noDev) {
    return { ...baseEnv, CI: '1' };
  }
  return baseEnv;
}

export function resolveUiWebBaseUrlTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS, 180_000);
}

export function resolveUiWebMetroStatusTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_METRO_STATUS_TIMEOUT_MS, 240_000);
}

export function resolveUiWebMetroStatusAttemptTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS, 5_000);
}

export function resolveUiWebScriptFetchTotalTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS, 420_000);
}

export function resolveUiWebMetroWorkspacePrebuildTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_METRO_WORKSPACE_PREBUILD_TIMEOUT_MS, 480_000);
}

export function resolveUiWebMetroBeforeAllTimeoutMs(env: NodeJS.ProcessEnv): number {
  const minTimeoutMs = readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_BEFORE_ALL_MIN_TIMEOUT_MS, 900_000);
  const headroomMs = readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_BEFORE_ALL_HEADROOM_MS, 60_000);
  const requiredBudgetMs =
    resolveUiWebMetroWorkspacePrebuildTimeoutMs(env)
    + resolveUiWebBaseUrlTimeoutMs(env)
    + resolveUiWebMetroStatusTimeoutMs(env)
    + resolveUiWebScriptFetchTotalTimeoutMs(env)
    + headroomMs;
  return Math.max(minTimeoutMs, requiredBudgetMs);
}

function resolveUiWebMetroStartAttempts(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_METRO_START_ATTEMPTS, 2);
}

function shouldRetryUiWebMetroStartFromError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('expo web dev server exited before ready');
}

function extractHttpUrls(text: string): string[] {
  const out: string[] = [];
  const sanitized = stripAnsi(text);
  const pattern = /\bhttps?:\/\/[^\s)]+/g;
  for (const match of sanitized.matchAll(pattern)) {
    const url = match[0];
    if (!url) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

type UiWebEntryPageProbe = Readonly<{
  isEntryPage: boolean;
  hasScriptTags: boolean;
  primaryScriptUrl: string | null;
  diagnostic: UiWebHttpProbeDiagnostic;
}>;

type UiWebHttpProbeOutcome = 'ready' | 'http-error' | 'invalid-body' | 'request-failed' | 'timeout';

type UiWebHttpProbeDiagnostic = Readonly<{
  outcome: UiWebHttpProbeOutcome;
  latencyMs: number;
  detail: string;
}>;

function sanitizeUiWebProbeDetail(raw: unknown, maxLength = 320): string {
  const text = raw instanceof Error
    ? `${raw.name}: ${raw.message}`
    : String(raw ?? '');
  return redactHarnessLogText(stripAnsi(text))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function classifyUiWebProbeError(error: unknown): 'request-failed' | 'timeout' {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'timeout';
  }
  return 'request-failed';
}

function createUiWebProbeDiagnostic(params: Readonly<{
  outcome: UiWebHttpProbeOutcome;
  startedAtMs: number;
  detail: unknown;
}>): UiWebHttpProbeDiagnostic {
  return {
    outcome: params.outcome,
    latencyMs: Math.max(0, Date.now() - params.startedAtMs),
    detail: sanitizeUiWebProbeDetail(params.detail),
  };
}

function createUiWebEntryPageProbe(params: Readonly<{
  startedAtMs: number;
  outcome: UiWebHttpProbeOutcome;
  detail: unknown;
  isEntryPage?: boolean;
  primaryScriptUrl?: string | null;
}>): UiWebEntryPageProbe {
  const primaryScriptUrl = params.primaryScriptUrl ?? null;
  return {
    isEntryPage: params.isEntryPage === true,
    hasScriptTags: Boolean(primaryScriptUrl),
    primaryScriptUrl,
    diagnostic: createUiWebProbeDiagnostic({
      outcome: params.outcome,
      startedAtMs: params.startedAtMs,
      detail: params.detail,
    }),
  };
}

async function inspectUiWebEntryPage(url: string, env: NodeJS.ProcessEnv): Promise<UiWebEntryPageProbe> {
  const startedAtMs = Date.now();
  try {
    const timeoutMs = resolveUiWebEntryProbeTimeoutMs(env);
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return createUiWebEntryPageProbe({
        startedAtMs,
        outcome: 'http-error',
        detail: `HTTP ${res.status}`,
      });
    }
    const text = await res.text().catch(() => '');
    if (!text.includes('<html') && !text.toLowerCase().includes('<!doctype html')) {
      return createUiWebEntryPageProbe({
        startedAtMs,
        outcome: 'invalid-body',
        detail: 'response was not an HTML entry page',
      });
    }
    if (text.toLowerCase().includes('metro bundler')) {
      return createUiWebEntryPageProbe({
        startedAtMs,
        outcome: 'invalid-body',
        detail: 'response was the Metro landing page, not the app entry page',
      });
    }

    const scripts = resolveScriptUrlsFromHtml(text, url);
    const primaryScriptUrl = scripts.length > 0 ? (selectPrimaryAppScriptUrl(scripts) ?? null) : null;
    const hasScriptTags = scripts.length > 0 && Boolean(primaryScriptUrl);
    return createUiWebEntryPageProbe({
      startedAtMs,
      isEntryPage: true,
      primaryScriptUrl,
      outcome: hasScriptTags ? 'ready' : 'invalid-body',
      detail: hasScriptTags ? 'entry page exposed a primary app script' : 'entry page had no primary app script',
    });
  } catch (error) {
    return createUiWebEntryPageProbe({
      startedAtMs,
      outcome: classifyUiWebProbeError(error),
      detail: error,
    });
  }
}

type ResolvedExpoWebBaseUrl = Readonly<{
  baseUrl: string;
  hasScriptTags: boolean;
  stdoutAdvertisesExpectedPort: boolean;
}>;

function resolveUrlPort(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port) {
      const port = Number(parsed.port);
      return Number.isFinite(port) && port > 0 ? Math.floor(port) : null;
    }
    if (parsed.protocol === 'https:') return 443;
    if (parsed.protocol === 'http:') return 80;
    return null;
  } catch {
    return null;
  }
}

function entryPageMatchesExpectedMetroPort(
  probe: UiWebEntryPageProbe,
  baseUrl: string,
  expectedPort: number | undefined,
): boolean {
  if (!expectedPort || !Number.isFinite(expectedPort) || expectedPort <= 0) {
    return false;
  }
  if (probe.primaryScriptUrl) {
    const port = resolveUrlPort(probe.primaryScriptUrl);
    return port === expectedPort;
  }
  // If no script URL is detected, treat as mismatch (we can still fall back to the entry page).
  return false;
}

async function resolveExpoWebBaseUrl(params: {
  stdoutPath: string;
  timeoutMs: number;
  expectedPort?: number;
  env: NodeJS.ProcessEnv;
  onEntryProbe?: (diagnostic: UiWebHttpProbeDiagnostic) => void;
  onStatusProbe?: (diagnostic: UiWebHttpProbeDiagnostic) => void;
}): Promise<ResolvedExpoWebBaseUrl> {
  const expectedCandidates =
    typeof params.expectedPort === 'number' && Number.isFinite(params.expectedPort) && params.expectedPort > 0
      ? expandLoopbackBaseUrlCandidates(`http://localhost:${params.expectedPort}`)
      : [];
  const defaultCandidates = [
    ...expandLoopbackBaseUrlCandidates('http://localhost:19006'),
    ...expandLoopbackBaseUrlCandidates('http://localhost:8081'),
  ];

  const startedAt = Date.now();
  let lastOrderedCandidates: string[] = [];

  while (Date.now() - startedAt < params.timeoutMs) {
    const text = await readFile(params.stdoutPath, 'utf8').catch(() => '');
    const stdoutCandidates = extractHttpUrls(text)
      .flatMap((url) => expandLoopbackBaseUrlCandidates(url))
      .map((url) => url.replace(/\/+$/, ''));
    const stdoutAdvertisesExpectedPort =
      typeof params.expectedPort === 'number'
      && Number.isFinite(params.expectedPort)
      && params.expectedPort > 0
      && stdoutCandidates.some((url) => resolveUrlPort(url) === params.expectedPort);
    const orderedCandidates: string[] = [];
    const seen = new Set<string>();

    for (const raw of [...stdoutCandidates, ...expectedCandidates, ...(expectedCandidates.length > 0 ? [] : defaultCandidates)]) {
      const url = raw.trim().replace(/\/+$/, '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      orderedCandidates.push(url);
    }

    lastOrderedCandidates = orderedCandidates;

    let firstEntryPage: ResolvedExpoWebBaseUrl | null = null;
    for (const url of orderedCandidates) {
      const probe = await inspectUiWebEntryPage(url, params.env);
      params.onEntryProbe?.(probe.diagnostic);
      if (probe.isEntryPage) {
        const matchesExpectedPort =
          typeof params.expectedPort === 'number'
          && Number.isFinite(params.expectedPort)
          && params.expectedPort > 0
          && (entryPageMatchesExpectedMetroPort(probe, url, params.expectedPort) || resolveUrlPort(url) === params.expectedPort);
        if (stdoutAdvertisesExpectedPort && expectedCandidates.length > 0 && !matchesExpectedPort) {
          continue;
        }
        if (!firstEntryPage) {
          firstEntryPage = {
            baseUrl: url,
            hasScriptTags: probe.hasScriptTags,
            stdoutAdvertisesExpectedPort,
          };
        }
        if (entryPageMatchesExpectedMetroPort(probe, url, params.expectedPort)) {
          return {
            baseUrl: url,
            hasScriptTags: probe.hasScriptTags,
            stdoutAdvertisesExpectedPort,
          };
        }
      }
    }
    if (stdoutAdvertisesExpectedPort && expectedCandidates.length > 0) {
      for (const url of expectedCandidates) {
        const statusDiagnostic = await probeMetroPackagerStatus(url, params.env);
        params.onStatusProbe?.(statusDiagnostic);
        if (statusDiagnostic.outcome === 'ready') {
          return {
            baseUrl: url,
            hasScriptTags: false,
            stdoutAdvertisesExpectedPort,
          };
        }
      }
    }
    if (firstEntryPage) {
      return firstEntryPage;
    }
    await sleep(120);
  }

  if (expectedCandidates.length === 0 && lastOrderedCandidates.length > 0) {
    return {
      baseUrl: lastOrderedCandidates[0] as string,
      hasScriptTags: false,
      stdoutAdvertisesExpectedPort: false,
    };
  }

  if (expectedCandidates.length > 0) {
    const advertisedExpectedPortCandidate = lastOrderedCandidates.find(
      (url) => typeof params.expectedPort === 'number' && resolveUrlPort(url) === params.expectedPort,
    );
    if (advertisedExpectedPortCandidate) {
      return {
        baseUrl: advertisedExpectedPortCandidate,
        hasScriptTags: false,
        stdoutAdvertisesExpectedPort: true,
      };
    }
  }

  throw new Error(`Failed to resolve Expo web baseUrl from stdout log: ${params.stdoutPath}`);
}

export const __testables = {
  resolveExpoWebBaseUrl,
  resolveExpoCliPath,
  resolvePreferredLiveMetroBaseUrl,
  inspectUiWebEntryPage,
  probeMetroPackagerStatus,
  probeScriptReady,
  waitForPrimaryAppScriptReady,
  formatUiWebHttpProbeDiagnostic,
  resolveUiWebMetroSpawnEnv,
  shouldRunWorkspacePrebuild,
};

async function probeMetroPackagerStatus(
  baseUrl: string,
  env: NodeJS.ProcessEnv,
): Promise<UiWebHttpProbeDiagnostic> {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/status`;
  const startedAtMs = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(resolveUiWebMetroStatusAttemptTimeoutMs(env)),
    });
    const inspection = await inspectMetroPackagerStatusResponse(res);
    if (inspection.outcome === 'http-error') {
      return createUiWebProbeDiagnostic({
        outcome: 'http-error',
        startedAtMs,
        detail: inspection.detail,
      });
    }
    return createUiWebProbeDiagnostic({
      outcome: inspection.outcome,
      startedAtMs,
      detail: inspection.detail,
    });
  } catch (error) {
    return createUiWebProbeDiagnostic({
      outcome: classifyUiWebProbeError(error),
      startedAtMs,
      detail: error,
    });
  }
}

function formatUiWebHttpProbeDiagnostic(
  label: 'status' | 'entry',
  diagnostic: UiWebHttpProbeDiagnostic | null,
): string {
  if (!diagnostic) {
    return `${label}=not-probed`;
  }
  const detail = diagnostic.detail ? ` detail=${JSON.stringify(diagnostic.detail)}` : '';
  return `${label}=${diagnostic.outcome} latencyMs=${diagnostic.latencyMs}${detail}`;
}

async function resolvePreferredLiveMetroBaseUrl(params: {
  currentBaseUrl: string;
  metroPort: number;
  env: NodeJS.ProcessEnv;
  onEntryProbe?: (diagnostic: UiWebHttpProbeDiagnostic) => void;
}): Promise<ResolvedExpoWebBaseUrl | null> {
  const currentUrl = new URL(params.currentBaseUrl);
  if (resolveUrlPort(params.currentBaseUrl) === params.metroPort) {
    const currentProbe = await inspectUiWebEntryPage(params.currentBaseUrl, params.env);
    params.onEntryProbe?.(currentProbe.diagnostic);
    if (currentProbe.isEntryPage) {
      return {
        baseUrl: params.currentBaseUrl,
        hasScriptTags: currentProbe.hasScriptTags,
        stdoutAdvertisesExpectedPort: false,
      };
    }
  }

  const currentHostCandidateUrl = new URL(params.currentBaseUrl);
  currentHostCandidateUrl.port = String(params.metroPort);
  currentHostCandidateUrl.pathname = '';
  currentHostCandidateUrl.search = '';
  currentHostCandidateUrl.hash = '';
  const candidates = [
    ...expandLoopbackBaseUrlCandidates(currentHostCandidateUrl.toString()),
    ...expandLoopbackBaseUrlCandidates(`${currentUrl.protocol}//localhost:${params.metroPort}`),
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const probe = await inspectUiWebEntryPage(candidate, params.env);
    params.onEntryProbe?.(probe.diagnostic);
    if (!probe.isEntryPage) continue;
    return {
      baseUrl: candidate,
      hasScriptTags: probe.hasScriptTags,
      stdoutAdvertisesExpectedPort: false,
    };
  }

  return null;
}

export function resolveUiWebScriptHtmlRefreshRetryCount(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_SCRIPT_HTML_REFRESH_RETRY_COUNT, 3);
}

export function resolveUiWebAllowScriptReadyTimeout(env: NodeJS.ProcessEnv): boolean {
  const raw = String(env.HAPPIER_E2E_UI_WEB_ALLOW_SCRIPT_READY_TIMEOUT ?? '0').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

class MetroBundleFailureError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'MetroBundleFailureError';
  }
}

type ScriptReadyProbe = 'ready' | 'retry' | 'refresh-html';

async function fetchWithTimeout<TResult>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  consumeResponse: (response: Response) => Promise<TResult> | TResult,
): Promise<TResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('The operation was aborted.', 'AbortError'));
  }, timeoutMs);
  let handleAbort: (() => void) | null = null;

  try {
    const mergedInit: RequestInit = {
      ...init,
      signal: controller.signal,
    };
    return await Promise.race([
      fetch(url, mergedInit).then(consumeResponse),
      new Promise<never>((_, reject) => {
        handleAbort = () => {
          reject(controller.signal.reason instanceof Error ? controller.signal.reason : new DOMException('The operation was aborted.', 'AbortError'));
        };
        controller.signal.addEventListener('abort', handleAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
    if (handleAbort) {
      controller.signal.removeEventListener('abort', handleAbort);
    }
  }
}

function extractMetroBundleFailureDetail(text: string): string | null {
  const sanitized = stripAnsi(text).trim();
  if (!sanitized) return null;

  const markers = [
    'Unable to resolve ',
    'TransformError',
    'Web Bundling failed',
    'Bundling failed',
  ];

  const markerIndex = markers
    .map((marker) => sanitized.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  if (typeof markerIndex !== 'number') {
    return null;
  }

  const detail = sanitized.slice(markerIndex, markerIndex + 1_600).trim();
  return detail.length > 0 ? detail : null;
}

function extractMetroBundleFailureMessageFromJson(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown; type?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
      return parsed.message.trim();
    }
    if (typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
      return parsed.error.trim();
    }
    if (typeof parsed.type === 'string' && parsed.type.trim().length > 0) {
      return parsed.type.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function resolveMetroBundleFailureResponseDetail(params: Readonly<{
  url: string;
  status: number;
  contentType: string;
  body: string;
}>): string | null {
  const logDetail = extractMetroBundleFailureDetail(params.body);
  if (logDetail) {
    return `Primary app script ${params.url} failed with status ${params.status} (${params.contentType || 'unknown'}) | ${logDetail}`;
  }

  const jsonMessage = extractMetroBundleFailureMessageFromJson(params.body);
  if (params.contentType.includes('application/json') && jsonMessage) {
    return `Primary app script ${params.url} failed with status ${params.status} (${params.contentType}) | ${jsonMessage}`;
  }

  if (params.contentType.includes('application/json') && params.body.trim().length > 0) {
    return `Primary app script ${params.url} failed with status ${params.status} (${params.contentType}) | ${params.body.trim().slice(0, 1_200)}`;
  }

  return null;
}

async function readMetroBundleFailureDetailFromLogs(stdoutPath: string, stderrPath: string): Promise<string | null> {
  const stdoutText = await readFile(stdoutPath, 'utf8').catch(() => '');
  const stderrText = await readFile(stderrPath, 'utf8').catch(() => '');
  return extractMetroBundleFailureDetail(stdoutText) ?? extractMetroBundleFailureDetail(stderrText);
}

async function probeScriptReady(url: string, timeoutMs: number): Promise<ScriptReadyProbe> {
  try {
    return await fetchWithTimeout(url, { method: 'GET' }, timeoutMs, async (res) => {
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

      if (res.ok && contentType.includes('javascript')) {
        return 'ready';
      }

      const text = await res.text().catch(() => '');

      if (!res.ok) {
        const detail = resolveMetroBundleFailureResponseDetail({
          url,
          status: typeof res.status === 'number' ? res.status : 500,
          contentType,
          body: text,
        });
        if (detail) {
          throw new MetroBundleFailureError(detail);
        }
        return 'refresh-html';
      }

      const detail = resolveMetroBundleFailureResponseDetail({
        url,
        status: typeof res.status === 'number' ? res.status : 200,
        contentType,
        body: text,
      });
      if (detail) {
        throw new MetroBundleFailureError(detail);
      }

      return text.includes('__d(') || text.includes('webpackBootstrap') || text.includes('globalThis')
        ? 'ready'
        : 'retry';
    });
  } catch (error) {
    if (error instanceof MetroBundleFailureError) {
      throw error;
    }
    return 'retry';
  }
}

function resolveRemainingTimeoutMs(deadlineAtMs: number, fallbackTimeoutMs: number): number {
  const remainingMs = deadlineAtMs - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(fallbackTimeoutMs, remainingMs));
}

async function resolvePrimaryAppScriptUrl(
  baseUrl: string,
  env: NodeJS.ProcessEnv,
  deadlineAtMs: number,
): Promise<string | null> {
  const entryTimeoutMs = resolveRemainingTimeoutMs(deadlineAtMs, resolveUiWebEntryProbeTimeoutMs(env));
  const html = await fetchWithTimeout(
    baseUrl,
    { method: 'GET' },
    entryTimeoutMs,
    async (response) => response.ok ? await response.text() : '',
  )
    .catch(() => '');
  const scripts = resolveScriptUrlsFromHtml(html, baseUrl);
  return scripts.length > 0 ? selectPrimaryAppScriptUrl(scripts) : null;
}

async function waitForPrimaryAppScriptReady(baseUrl: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const totalTimeoutMs = resolveUiWebScriptFetchTotalTimeoutMs(env);
  const htmlRefreshRetryCount = resolveUiWebScriptHtmlRefreshRetryCount(env);
  const deadlineAtMs = Date.now() + totalTimeoutMs;
  const retryDelayMs = 100;
  let primaryAppScriptUrl: string | null = null;
  let retryCountForCurrentScript = 0;
  let lastError: unknown = null;

  try {
    while (Date.now() < deadlineAtMs) {
      if (!primaryAppScriptUrl) {
        primaryAppScriptUrl = await resolvePrimaryAppScriptUrl(baseUrl, env, deadlineAtMs);
        retryCountForCurrentScript = 0;
      }
      if (!primaryAppScriptUrl) {
        const remainingSleepMs = deadlineAtMs - Date.now();
        if (remainingSleepMs <= 0) break;
        await sleep(Math.min(retryDelayMs, remainingSleepMs));
        continue;
      }
      try {
        const probe = await probeScriptReady(
          primaryAppScriptUrl,
          resolveRemainingTimeoutMs(deadlineAtMs, totalTimeoutMs),
        );
        if (probe === 'ready') {
          return true;
        }
        if (probe === 'refresh-html') {
          primaryAppScriptUrl = null;
          retryCountForCurrentScript = 0;
          const remainingSleepMs = deadlineAtMs - Date.now();
          if (remainingSleepMs <= 0) break;
          await sleep(Math.min(retryDelayMs, remainingSleepMs));
          continue;
        }
        retryCountForCurrentScript += 1;
        if (retryCountForCurrentScript >= htmlRefreshRetryCount) {
          primaryAppScriptUrl = null;
          retryCountForCurrentScript = 0;
        }
      } catch (error) {
        lastError = error;
        if (error instanceof MetroBundleFailureError) {
          throw error;
        }
      }
      const remainingSleepMs = deadlineAtMs - Date.now();
      if (remainingSleepMs <= 0) break;
      await sleep(Math.min(retryDelayMs, remainingSleepMs));
    }
  } catch (error) {
    if (error instanceof MetroBundleFailureError) {
      throw error;
    }
    lastError = error;
  }

  if (!resolveUiWebAllowScriptReadyTimeout(env)) {
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error('Timed out waiting for condition (expo web primary script ready)');
  }

  return false;
}

export async function startUiWebMetro(params: UiWebMetroStartParams): Promise<StartedUiWeb> {
  const maxAttempts = Math.max(1, resolveUiWebMetroStartAttempts(params.env));
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await startUiWebMetroSingleAttempt(params);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetryUiWebMetroStartFromError(error)) {
        throw error;
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(String(lastError));
}

async function startUiWebMetroSingleAttempt(params: UiWebMetroStartParams): Promise<StartedUiWeb> {
  const currentOwnerInspection = inspectOwnedProcess(process.pid);
  if (currentOwnerInspection.ok) {
    await sweepProcessOwnershipLeases({
      rootDir: repoRootDir(),
      leaseKind: 'ui-web-metro',
      currentOwnerPid: process.pid,
      currentOwnerStartTime: currentOwnerInspection.startTime,
      isOwnedProcessCommand: (command) => looksLikeUiWebMetroCommand(command),
    });
  }

  const stdoutPath = resolvePath(params.testDir, 'ui.web.stdout.log');
  const stderrPath = resolvePath(params.testDir, 'ui.web.stderr.log');

  const clearRaw = (params.env.HAPPIER_E2E_EXPO_CLEAR ?? '').toString().trim().toLowerCase();
  const clearCache = clearRaw === '1' || clearRaw === 'true' || clearRaw === 'yes' || clearRaw === 'y';
  const noDevRaw = (params.env.HAPPIER_E2E_UI_WEB_NO_DEV ?? '1').toString().trim().toLowerCase();
  const noDev = noDevRaw === '1' || noDevRaw === 'true' || noDevRaw === 'yes' || noDevRaw === 'y';

  const uiWorkspaceDir = resolvePath(repoRootDir(), 'apps', 'ui');
  if (shouldRunWorkspacePrebuild(params)) {
    await ensureUiWebWorkspacePrebuild({
      testDir: params.testDir,
      env: params.env,
      workspaceRootDir: uiWorkspaceDir,
      logPrefix: 'ui-web-metro',
      timeoutMs: resolveUiWebMetroWorkspacePrebuildTimeoutMs(params.env),
      stdoutPath,
      stderrPath,
    });
  }

  const expoCliPath = resolveExpoCliPath({ rootDir: repoRootDir(), uiWorkspaceDir });
  const tmpDir = resolvePath(params.testDir, 'ui.web.tmp');
  await mkdir(tmpDir, { recursive: true });
  const metroPort = typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0
    ? params.port
    : await reserveAvailablePort();
  const metroCacheVersionBust = resolveUiWebMetroCacheVersionBust(params.env);

  const proc = spawnLoggedProcess({
    args: [
      expoCliPath,
      'start',
      '--web',
      '--host',
      'localhost',
      '--port',
      String(metroPort),
      ...(noDev ? ['--no-dev'] : []),
      ...(clearCache ? ['--clear'] : []),
    ],
    command: process.execPath,
    cwd: uiWorkspaceDir,
    env: resolveUiWebMetroSpawnEnv({
      env: params.env,
      tmpDir,
      metroCacheVersionBust,
      noDev,
    }),
    stdoutPath,
    stderrPath,
  });

  await registerProcessOwnershipLease({
    rootDir: repoRootDir(),
    leaseKind: 'ui-web-metro',
    child: proc.child,
    ownerPid: process.pid,
    ownerStartTime: currentOwnerInspection.ok ? currentOwnerInspection.startTime : null,
    metadata: {
      port: metroPort,
      testDir: params.testDir,
    },
  });

  let baseUrl: string;
  let lastStatusDiagnostic: UiWebHttpProbeDiagnostic | null = null;
  let lastEntryDiagnostic: UiWebHttpProbeDiagnostic | null = null;
  try {
    const exitedEarly = new Promise<never>((_, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = signal ? `signal=${signal}` : `code=${code ?? 'null'}`;
        reject(new Error(`expo web dev server exited before ready (${detail})`));
      };
      proc.child.once('exit', onExit);
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
        proc.child.off('exit', onExit);
        onExit(proc.child.exitCode, proc.child.signalCode as NodeJS.Signals | null);
      }
    });

    const resolved = await Promise.race([
      resolveExpoWebBaseUrl({
        stdoutPath,
        timeoutMs: resolveUiWebBaseUrlTimeoutMs(params.env),
        expectedPort: metroPort,
        env: params.env,
        onEntryProbe: (diagnostic) => {
          lastEntryDiagnostic = diagnostic;
        },
        onStatusProbe: (diagnostic) => {
          lastStatusDiagnostic = diagnostic;
        },
      }),
      exitedEarly,
    ]);
    baseUrl = resolved.baseUrl;
    let hasReadyEntryPage = resolved.hasScriptTags;
    const hasExplicitMetroPort = typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0;
    const requiresLivePortReanchor = hasExplicitMetroPort && resolveUrlPort(baseUrl) !== metroPort;
    if (requiresLivePortReanchor || !hasReadyEntryPage) {
      await waitFor(
        async () => {
          const metroStatusCandidates = expandLoopbackBaseUrlCandidates(`http://localhost:${metroPort}`);
          let metroStatusReady = false;
          for (const candidate of metroStatusCandidates) {
            const statusDiagnostic = await probeMetroPackagerStatus(candidate, params.env);
            lastStatusDiagnostic = statusDiagnostic;
            if (statusDiagnostic.outcome === 'ready') {
              metroStatusReady = true;
              break;
            }
          }

          if (metroStatusReady) {
            if (resolveUrlPort(baseUrl) !== metroPort) {
              const preferredBaseUrl = await resolvePreferredLiveMetroBaseUrl({
                currentBaseUrl: baseUrl,
                metroPort,
                env: params.env,
                onEntryProbe: (diagnostic) => {
                  lastEntryDiagnostic = diagnostic;
                },
              });
              if (preferredBaseUrl) {
                baseUrl = preferredBaseUrl.baseUrl;
                hasReadyEntryPage = preferredBaseUrl.hasScriptTags;
                return preferredBaseUrl.hasScriptTags;
              }
            } else {
              const probe = await inspectUiWebEntryPage(baseUrl, params.env);
              lastEntryDiagnostic = probe.diagnostic;
              if (probe.isEntryPage && probe.hasScriptTags) {
                hasReadyEntryPage = probe.hasScriptTags;
                return true;
              }
            }
          }

          if (requiresLivePortReanchor && resolveUrlPort(baseUrl) !== metroPort) {
            return false;
          }

          const probe = await inspectUiWebEntryPage(baseUrl, params.env);
          lastEntryDiagnostic = probe.diagnostic;
          if (!(probe.isEntryPage && probe.hasScriptTags)) {
            return false;
          }
          hasReadyEntryPage = probe.hasScriptTags;
          return true;
        },
        { timeoutMs: resolveUiWebMetroStatusTimeoutMs(params.env), intervalMs: 250, context: 'metro /status ready' },
      );
    }

    if (hasReadyEntryPage) {
      const primaryScriptReady = await waitForPrimaryAppScriptReady(baseUrl, params.env);
      if (!primaryScriptReady) {
        const bundleFailureDetail = await readMetroBundleFailureDetailFromLogs(stdoutPath, stderrPath);
        if (bundleFailureDetail) {
          throw new MetroBundleFailureError(bundleFailureDetail);
        }
      }
    }
  } catch (e) {
    await proc.stop().catch(() => {});
    const stdoutText = await readFile(stdoutPath, 'utf8').catch(() => '');
    const stderrText = await readFile(stderrPath, 'utf8').catch(() => '');
    const tailLimit = 8_000;
    const stdoutTail = redactHarnessLogText(stdoutText.slice(Math.max(0, stdoutText.length - tailLimit)));
    const stderrTail = redactHarnessLogText(stderrText.slice(Math.max(0, stderrText.length - tailLimit)));
    const detail = [
      sanitizeUiWebProbeDetail(e, 2_000),
      formatUiWebHttpProbeDiagnostic('status', lastStatusDiagnostic),
      formatUiWebHttpProbeDiagnostic('entry', lastEntryDiagnostic),
      `stdoutTail=${JSON.stringify(stdoutTail)}`,
      `stderrTail=${JSON.stringify(stderrTail)}`,
    ].join(' | ');
    throw new Error(detail);
  }

  return {
    mode: 'metro',
    baseUrl,
    proc,
    stop: async () => {
      await proc.stop().catch(() => {});
    },
  };
}
