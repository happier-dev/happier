import { mkdir, readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { repoRootDir } from '../paths';
import { waitFor } from '../timing';
import { readPositiveEnvInt } from './uiWebEnv';
import { resolveScriptUrlsFromHtml, selectPrimaryAppScriptUrl } from './uiWebHtml';
import { spawnLoggedProcess } from './spawnProcess';
import type { StartedUiWeb } from './uiWebTypes';

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

export function resolveUiWebBaseUrlTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS, 180_000);
}

export function resolveUiWebMetroStatusTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_METRO_STATUS_TIMEOUT_MS, 120_000);
}

export function resolveUiWebScriptFetchTotalTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS, 420_000);
}

export function resolveUiWebMetroBeforeAllTimeoutMs(env: NodeJS.ProcessEnv): number {
  const minTimeoutMs = readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_BEFORE_ALL_MIN_TIMEOUT_MS, 900_000);
  const headroomMs = readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_BEFORE_ALL_HEADROOM_MS, 60_000);
  const requiredBudgetMs =
    resolveUiWebBaseUrlTimeoutMs(env)
    + resolveUiWebMetroStatusTimeoutMs(env)
    + resolveUiWebScriptFetchTotalTimeoutMs(env)
    + headroomMs;
  return Math.max(minTimeoutMs, requiredBudgetMs);
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

async function looksLikeUiWebEntryPage(url: string): Promise<boolean> {
  try {
    const timeoutMs = readPositiveEnvInt(process.env.HAPPIER_E2E_UI_WEB_ENTRY_FETCH_TIMEOUT_MS, 10_000);
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const text = await res.text().catch(() => '');
    if (!text.includes('<html') && !text.toLowerCase().includes('<!doctype html')) return false;

    const scripts = resolveScriptUrlsFromHtml(text, url);
    if (scripts.length === 0) return false;
    return Boolean(selectPrimaryAppScriptUrl(scripts));
  } catch {
    return false;
  }
}

async function resolveExpoWebBaseUrl(params: { stdoutPath: string; timeoutMs: number; expectedPort?: number }): Promise<string> {
  const defaultCandidates = [
    'http://localhost:19006',
    'http://127.0.0.1:19006',
    'http://localhost:8081',
    'http://127.0.0.1:8081',
  ];

  const expectedCandidates =
    typeof params.expectedPort === 'number' && Number.isFinite(params.expectedPort) && params.expectedPort > 0
      ? [`http://localhost:${params.expectedPort}`, `http://127.0.0.1:${params.expectedPort}`]
      : [];

  let resolved: string | null = null;
  await waitFor(async () => {
    const text = await readFile(params.stdoutPath, 'utf8').catch(() => '');
    const stdoutCandidates = extractHttpUrls(text).map((url) => url.replace(/\/+$/, ''));
    const orderedCandidates: string[] = [];
    const seen = new Set<string>();

    for (const raw of [...stdoutCandidates, ...expectedCandidates, ...(expectedCandidates.length > 0 ? [] : defaultCandidates)]) {
      const url = raw.trim().replace(/\/+$/, '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      orderedCandidates.push(url);
    }

    for (const url of orderedCandidates) {
      if (await looksLikeUiWebEntryPage(url)) {
        resolved = url;
        return true;
      }
    }
    return false;
  }, { timeoutMs: params.timeoutMs, intervalMs: 250, context: 'expo web ready' });

  if (resolved) return resolved;

  for (const url of expectedCandidates.length > 0 ? expectedCandidates : defaultCandidates) {
    if (await looksLikeUiWebEntryPage(url)) return url;
  }

  throw new Error(`Failed to resolve Expo web baseUrl from stdout log: ${params.stdoutPath}`);
}

async function isMetroPackagerReady(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/status`, { method: 'GET', signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    const text = await res.text().catch(() => '');
    return text.includes('packager-status:running');
  } catch {
    return false;
  }
}

export function resolveUiWebScriptFetchAttemptTimeoutMs(env: NodeJS.ProcessEnv, totalTimeoutMs: number): number {
  return Math.min(totalTimeoutMs, readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS, 15_000));
}

export function resolveUiWebScriptHtmlRefreshRetryCount(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_SCRIPT_HTML_REFRESH_RETRY_COUNT, 3);
}

export function resolveUiWebAllowScriptReadyTimeout(env: NodeJS.ProcessEnv): boolean {
  const raw = String(env.HAPPIER_E2E_UI_WEB_ALLOW_SCRIPT_READY_TIMEOUT ?? '1').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

type ScriptReadyProbe = 'ready' | 'retry' | 'refresh-html';

async function probeScriptReady(url: string, timeoutMs: number): Promise<ScriptReadyProbe> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return 'refresh-html';
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('javascript')) return 'ready';
    const text = await res.text().catch(() => '');
    return text.includes('__d(') || text.includes('webpackBootstrap') || text.includes('globalThis')
      ? 'ready'
      : 'retry';
  } catch {
    return 'retry';
  }
}

async function resolvePrimaryAppScriptUrl(baseUrl: string): Promise<string | null> {
  const entryTimeoutMs = readPositiveEnvInt(process.env.HAPPIER_E2E_UI_WEB_ENTRY_FETCH_TIMEOUT_MS, 10_000);
  const html = await fetch(baseUrl, { method: 'GET', signal: AbortSignal.timeout(entryTimeoutMs) })
    .then((response) => response.ok ? response.text() : '')
    .catch(() => '');
  const scripts = resolveScriptUrlsFromHtml(html, baseUrl);
  return scripts.length > 0 ? selectPrimaryAppScriptUrl(scripts) : null;
}

async function waitForPrimaryAppScriptReady(baseUrl: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const totalTimeoutMs = resolveUiWebScriptFetchTotalTimeoutMs(env);
  const attemptTimeoutMs = resolveUiWebScriptFetchAttemptTimeoutMs(env, totalTimeoutMs);
  const htmlRefreshRetryCount = resolveUiWebScriptHtmlRefreshRetryCount(env);
  let primaryAppScriptUrl: string | null = null;
  let retryCountForCurrentScript = 0;

  try {
    await waitFor(async () => {
      if (!primaryAppScriptUrl) {
        primaryAppScriptUrl = await resolvePrimaryAppScriptUrl(baseUrl);
        retryCountForCurrentScript = 0;
      }
      if (!primaryAppScriptUrl) return false;
      const probe = await probeScriptReady(primaryAppScriptUrl, attemptTimeoutMs);
      if (probe === 'ready') return true;
      if (probe === 'refresh-html') {
        primaryAppScriptUrl = null;
        retryCountForCurrentScript = 0;
        return false;
      }
      retryCountForCurrentScript += 1;
      if (retryCountForCurrentScript >= htmlRefreshRetryCount) {
        primaryAppScriptUrl = null;
        retryCountForCurrentScript = 0;
      }
      return false;
    }, {
      timeoutMs: totalTimeoutMs,
      intervalMs: 250,
      context: 'expo web primary script ready',
    });
    return true;
  } catch (error) {
    if (!resolveUiWebAllowScriptReadyTimeout(env)) {
      throw error;
    }
    return false;
  }
}

export async function startUiWebMetro(params: {
  testDir: string;
  env: NodeJS.ProcessEnv;
  port?: number;
}): Promise<StartedUiWeb> {
  const stdoutPath = resolvePath(params.testDir, 'ui.web.stdout.log');
  const stderrPath = resolvePath(params.testDir, 'ui.web.stderr.log');

  const clearRaw = (params.env.HAPPIER_E2E_EXPO_CLEAR ?? '').toString().trim().toLowerCase();
  const clearCache = clearRaw === '1' || clearRaw === 'true' || clearRaw === 'yes' || clearRaw === 'y';
  const noDevRaw = (params.env.HAPPIER_E2E_UI_WEB_NO_DEV ?? '1').toString().trim().toLowerCase();
  const noDev = noDevRaw === '1' || noDevRaw === 'true' || noDevRaw === 'yes' || noDevRaw === 'y';

  const expoCliPath = resolvePath(repoRootDir(), 'node_modules', 'expo', 'bin', 'cli');
  const uiWorkspaceDir = resolvePath(repoRootDir(), 'apps', 'ui');
  const tmpDir = resolvePath(params.testDir, 'ui.web.tmp');
  await mkdir(tmpDir, { recursive: true });
  const metroPort = typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0
    ? params.port
    : await reserveAvailablePort();

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
    env: {
      ...params.env,
      CI: '1',
      EXPO_NO_TELEMETRY: '1',
      EXPO_UNSTABLE_WEB_MODAL: '1',
      BROWSER: 'none',
      TMPDIR: tmpDir,
      TMP: tmpDir,
      TEMP: tmpDir,
    },
    stdoutPath,
    stderrPath,
  });

  let baseUrl: string;
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

    baseUrl = await Promise.race([
      resolveExpoWebBaseUrl({ stdoutPath, timeoutMs: resolveUiWebBaseUrlTimeoutMs(params.env), expectedPort: metroPort }),
      exitedEarly,
    ]);

    await waitFor(
      async () =>
        (await isMetroPackagerReady(`http://localhost:${metroPort}`))
        || (await isMetroPackagerReady(`http://127.0.0.1:${metroPort}`)),
      { timeoutMs: resolveUiWebMetroStatusTimeoutMs(params.env), intervalMs: 250, context: 'metro /status ready' },
    );

    await waitForPrimaryAppScriptReady(baseUrl, params.env);
  } catch (e) {
    await proc.stop().catch(() => {});
    const stdoutText = await readFile(stdoutPath, 'utf8').catch(() => '');
    const stderrText = await readFile(stderrPath, 'utf8').catch(() => '');
    const tailLimit = 8_000;
    const stdoutTail = stdoutText.slice(Math.max(0, stdoutText.length - tailLimit));
    const stderrTail = stderrText.slice(Math.max(0, stderrText.length - tailLimit));
    const detail = [
      e instanceof Error ? e.message : String(e),
      `stdoutTail=${JSON.stringify(stdoutTail)}`,
      `stderrTail=${JSON.stringify(stderrTail)}`,
    ].join(' | ');
    throw new Error(detail);
  }

  return {
    baseUrl,
    proc,
    stop: async () => {
      await proc.stop().catch(() => {});
    },
  };
}
