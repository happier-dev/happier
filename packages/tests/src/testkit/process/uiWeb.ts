import { mkdir, readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { repoRootDir } from '../paths';
import { waitFor } from '../timing';
import { spawnLoggedProcess, type SpawnedProcess } from './spawnProcess';
import { resolveScriptUrlsFromHtml, selectPrimaryAppScriptUrl } from './uiWebHtml';

export type StartedUiWeb = {
  baseUrl: string;
  proc: SpawnedProcess;
  stop: () => Promise<void>;
};

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
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
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    const text = await res.text().catch(() => '');
    if (!text.includes('<html') && !text.toLowerCase().includes('<!doctype html')) return false;

    const scripts = resolveScriptUrlsFromHtml(text, url);
    if (scripts.length === 0) return false;
    const primary = selectPrimaryAppScriptUrl(scripts);
    if (!primary) return false;
    // Base URL selection only needs to ensure we're looking at the Expo web entry HTML.
    // Bundle readiness is handled later (after Metro /status is confirmed).
    return true;
  } catch {
    return false;
  }
}

async function resolveExpoWebBaseUrl(params: { stdoutPath: string; timeoutMs: number }): Promise<string> {
  const candidates = new Set<string>([
    'http://localhost:19006',
    'http://127.0.0.1:19006',
    'http://localhost:8081',
    'http://127.0.0.1:8081',
  ]);

  let resolved: string | null = null;
  await waitFor(async () => {
    const text = await readFile(params.stdoutPath, 'utf8').catch(() => '');
    for (const url of extractHttpUrls(text)) {
      const normalized = url.replace(/\/+$/, '');
      candidates.add(normalized);
    }

    for (const url of candidates) {
      if (await looksLikeUiWebEntryPage(url)) {
        resolved = url;
        return true;
      }
    }
    return false;
  }, { timeoutMs: params.timeoutMs, intervalMs: 250, context: 'expo web ready' });

  if (resolved) return resolved;

  // The waitFor above succeeded but did not set a baseUrl (should be unreachable). Re-check candidates for safety.
  for (const url of candidates) {
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

async function isScriptReady(url: string): Promise<boolean> {
  try {
    // Metro holds the response open while bundling; short timeouts can repeatedly abort the build and
    // keep the progress stuck at 0%. Allow enough time for a cold build to complete.
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return false;
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('javascript')) return true;
    const text = await res.text().catch(() => '');
    return text.includes('__d(') || text.includes('webpackBootstrap') || text.includes('globalThis');
  } catch {
    return false;
  }
}

export async function startUiWeb(params: {
  testDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<StartedUiWeb> {
  const stdoutPath = resolvePath(params.testDir, 'ui.web.stdout.log');
  const stderrPath = resolvePath(params.testDir, 'ui.web.stderr.log');

  const clearRaw = (params.env.HAPPIER_E2E_EXPO_CLEAR ?? '').toString().trim().toLowerCase();
  const clearCache = clearRaw === '1' || clearRaw === 'true' || clearRaw === 'yes' || clearRaw === 'y';

  const expoCliPath = resolvePath(repoRootDir(), 'node_modules', 'expo', 'bin', 'cli');
  const uiWorkspaceDir = resolvePath(repoRootDir(), 'apps', 'ui');
  const tmpDir = resolvePath(params.testDir, 'ui.web.tmp');
  await mkdir(tmpDir, { recursive: true });

  const proc = spawnLoggedProcess({
    args: [
      expoCliPath,
      'start',
      '--web',
      '--localhost',
      '--no-dev',
      '--minify',
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
      // Isolate Metro cache per run to avoid stale EXPO_PUBLIC_* values being reused across E2E runs.
      // Metro cache defaults under os.tmpdir(), which can be shared across processes and users.
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
      resolveExpoWebBaseUrl({ stdoutPath, timeoutMs: 180_000 }),
      exitedEarly,
    ]);

    // Even if the web page is served (often on :19006), Metro may still be initializing (or misconfigured).
    // Ensure Metro is actually ready before handing back control to Playwright.
    await waitFor(
      async () =>
        (await isMetroPackagerReady('http://localhost:8081'))
        || (await isMetroPackagerReady('http://127.0.0.1:8081')),
      { timeoutMs: 120_000, intervalMs: 250, context: 'metro /status ready' },
    );

    // Metro can serve HTML before the initial app bundle is ready. Parse the web entry HTML and wait for
    // the primary script to be fetchable so Playwright navigation doesn't hang on DOMContentLoaded.
    await waitFor(async () => {
      const html = await fetch(baseUrl, { method: 'GET', signal: AbortSignal.timeout(2_000) })
        .then((r) => r.ok ? r.text() : '')
        .catch(() => '');
      const scripts = resolveScriptUrlsFromHtml(html, baseUrl);
      const primary = scripts.length > 0 ? selectPrimaryAppScriptUrl(scripts) : null;
      if (!primary) return false;
      return await isScriptReady(primary);
    }, { timeoutMs: 420_000, intervalMs: 250, context: 'web bundle ready' });
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
