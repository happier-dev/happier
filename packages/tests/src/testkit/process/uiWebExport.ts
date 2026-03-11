import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, dirname, resolve as resolvePath } from 'node:path';
import { repoRootDir } from '../paths';
import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { runLoggedCommand } from './spawnProcess';
import { yarnCommand } from './commands';
import { readPositiveEnvInt } from './uiWebEnv';
import type { StartedUiWeb } from './uiWebTypes';

const EXPORTED_DIST_PARENT = resolvePath(repoRootDir(), '.project', 'tmp', 'ui-web-export');
const EXPORTED_DIST_DIR = resolvePath(EXPORTED_DIST_PARENT, 'dist');
const EXPORTED_DIST_LOCK_PATH = resolvePath(EXPORTED_DIST_PARENT, 'build.lock');

let sharedExportPromise: Promise<string> | null = null;
let sharedExportDir: string | null = null;
let sharedExportCacheKey: string | null = null;

type UiWebRuntimeConfig = Readonly<{
  serverUrl: string;
  syncTuningJson: string;
}>;

type LockOwner = {
  pid: number | null;
  createdAtMs: number | null;
};

function parseLockOwner(raw: string): LockOwner {
  const text = raw.trim();
  if (!text) return { pid: null, createdAtMs: null };
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; createdAtMs?: unknown };
    return {
      pid: typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
      createdAtMs:
        typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs) && parsed.createdAtMs > 0
          ? parsed.createdAtMs
          : null,
    };
  } catch {
    return { pid: null, createdAtMs: null };
  }
}

function isRunningPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withUiWebExportLock<T>(fn: () => Promise<T>, options?: { timeoutMs?: number; staleAfterMs?: number }): Promise<T> {
  mkdirSync(dirname(EXPORTED_DIST_LOCK_PATH), { recursive: true });
  const timeoutMs = options?.timeoutMs ?? 900_000;
  const staleAfterMs = options?.staleAfterMs ?? timeoutMs;
  const startedAt = Date.now();

  let fd: number | null = null;
  while (true) {
    try {
      fd = openSync(EXPORTED_DIST_LOCK_PATH, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), 'utf8');
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;

      let reclaim = false;
      try {
        const owner = parseLockOwner(readFileSync(EXPORTED_DIST_LOCK_PATH, 'utf8'));
        if (owner.pid != null && !isRunningPid(owner.pid)) reclaim = true;
        else if (owner.createdAtMs != null && Date.now() - owner.createdAtMs > staleAfterMs) reclaim = true;
      } catch {
        reclaim = false;
      }

      if (reclaim) {
        try {
          unlinkSync(EXPORTED_DIST_LOCK_PATH);
          continue;
        } catch {
          // ignore and continue waiting
        }
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for UI web export build lock: ${EXPORTED_DIST_LOCK_PATH}`);
      }
      await sleep(250);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      if (fd != null) closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(EXPORTED_DIST_LOCK_PATH);
    } catch {
      // ignore
    }
  }
}

export function resolveUiWebExportBuildTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS, 120_000);
}

export function resolveUiWebExportBeforeAllTimeoutMs(env: NodeJS.ProcessEnv): number {
  const minTimeoutMs = readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_BEFORE_ALL_MIN_TIMEOUT_MS, 900_000);
  const headroomMs = readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_BEFORE_ALL_HEADROOM_MS, 60_000);
  return Math.max(minTimeoutMs, resolveUiWebExportBuildTimeoutMs(env) + headroomMs);
}

function readServerUrlFromEnv(env: NodeJS.ProcessEnv): string {
  return String(
    env.EXPO_PUBLIC_HAPPIER_SERVER_URL
    ?? env.EXPO_PUBLIC_HAPPY_SERVER_URL
    ?? env.EXPO_PUBLIC_SERVER_URL
    ?? '',
  ).trim();
}

function readSyncTuningJsonFromEnv(env: NodeJS.ProcessEnv): string {
  return String(env.EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON ?? '').trim();
}

function buildRuntimeConfig(env: NodeJS.ProcessEnv): UiWebRuntimeConfig {
  return {
    serverUrl: readServerUrlFromEnv(env),
    syncTuningJson: readSyncTuningJsonFromEnv(env),
  };
}

function buildExportEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const debug = String(env.EXPO_PUBLIC_DEBUG ?? '1').trim() || '1';
  return {
    ...process.env,
    ...env,
    CI: '1',
    NODE_ENV: 'production',
    EXPO_NO_TELEMETRY: '1',
    EXPO_PUBLIC_DEBUG: debug,
    EXPO_PUBLIC_HAPPIER_SERVER_URL: '',
    EXPO_PUBLIC_HAPPY_SERVER_URL: '',
    EXPO_PUBLIC_SERVER_URL: '',
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: '',
    EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: '',
  };
}

function buildUiWebExportCacheKey(env: NodeJS.ProcessEnv): string {
  const exportEnv = buildExportEnv(env);
  const relevantEntries = Object.entries(exportEnv)
    .filter(([key]) =>
      key.startsWith('EXPO_PUBLIC_')
      || key === 'APP_ENV'
      || key === 'APP_VARIANT'
      || key === 'HAPPIER_APP_VARIANT_OVERRIDE'
      || key === 'EAS_BUILD_PROFILE'
      || key === 'EAS_UPDATE_CHANNEL'
      || key === 'NODE_ENV'
    )
    .sort(([left], [right]) => left.localeCompare(right));

  return JSON.stringify(relevantEntries);
}

async function ensureUiWebExportBuilt(params: { testDir: string; env: NodeJS.ProcessEnv }): Promise<string> {
  const cacheKey = buildUiWebExportCacheKey(params.env);

  if (sharedExportDir && sharedExportCacheKey === cacheKey) return sharedExportDir;
  if (sharedExportPromise && sharedExportCacheKey === cacheKey) return await sharedExportPromise;

  const buildPromise = withUiWebExportLock(async () => {
    const stagingDir = resolvePath(EXPORTED_DIST_PARENT, `dist-staging-${process.pid}-${Date.now()}`);
    const stdoutPath = resolvePath(params.testDir, 'ui.web.export.stdout.log');
    const stderrPath = resolvePath(params.testDir, 'ui.web.export.stderr.log');

    await mkdir(EXPORTED_DIST_PARENT, { recursive: true });
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});

    try {
      await runLoggedCommand({
        command: yarnCommand(),
        args: ['expo', 'export', '--platform', 'web', '--output-dir', stagingDir],
        cwd: resolvePath(repoRootDir(), 'apps', 'ui'),
        env: buildExportEnv(params.env),
        stdoutPath,
        stderrPath,
        timeoutMs: resolveUiWebExportBuildTimeoutMs(params.env),
      });

      const indexPath = resolvePath(stagingDir, 'index.html');
      await stat(indexPath);
      await rm(EXPORTED_DIST_DIR, { recursive: true, force: true }).catch(() => {});
      await rename(stagingDir, EXPORTED_DIST_DIR);
      return EXPORTED_DIST_DIR;
    } catch (error) {
      const stdoutTail = await readFile(stdoutPath, 'utf8').catch(() => '');
      const stderrTail = await readFile(stderrPath, 'utf8').catch(() => '');
      const tailLimit = 8_000;
      throw new Error([
        error instanceof Error ? error.message : String(error),
        `stdoutTail=${JSON.stringify(stdoutTail.slice(Math.max(0, stdoutTail.length - tailLimit)))}`,
        `stderrTail=${JSON.stringify(stderrTail.slice(Math.max(0, stderrTail.length - tailLimit)))}`,
      ].join(' | '));
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }, { timeoutMs: resolveUiWebExportBuildTimeoutMs(params.env) });
  sharedExportPromise = buildPromise;
  sharedExportCacheKey = cacheKey;

  try {
    const builtDir = await buildPromise;
    if (sharedExportPromise === buildPromise) {
      sharedExportDir = builtDir;
      sharedExportCacheKey = cacheKey;
    }
    return builtDir;
  } finally {
    if (sharedExportPromise === buildPromise) {
      sharedExportPromise = null;
    }
  }
}

function mimeTypeFor(pathname: string): string {
  switch (extname(pathname).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.map': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function escapeInlineScriptJson(value: string): string {
  return value.replace(/</g, '\\u003c');
}

function buildBootstrapScript(config: UiWebRuntimeConfig): string {
  const runtimeConfigJson = escapeInlineScriptJson(JSON.stringify(config.serverUrl ? { serverUrl: config.serverUrl } : {}));
  const syncTuningJsonLiteral = config.syncTuningJson ? JSON.stringify(config.syncTuningJson) : 'null';
  return [
    '<script>',
    '(function(){',
    `window.__HAPPIER_WEB_RUNTIME_CONFIG__=${runtimeConfigJson};`,
    `var syncTuningJson=${syncTuningJsonLiteral};`,
    "try {",
    "  if (syncTuningJson) window.localStorage.setItem('HAPPIER_SYNC_TUNING_JSON', syncTuningJson);",
    "  else window.localStorage.removeItem('HAPPIER_SYNC_TUNING_JSON');",
    '} catch {}',
    '})();',
    '</script>',
  ].join('');
}

function injectBootstrap(html: string, config: UiWebRuntimeConfig): string {
  const bootstrap = buildBootstrapScript(config);
  const headCloseIndex = html.toLowerCase().indexOf('</head>');
  if (headCloseIndex >= 0) {
    return `${html.slice(0, headCloseIndex)}${bootstrap}${html.slice(headCloseIndex)}`;
  }
  return `${bootstrap}${html}`;
}

function resolveRequestFilePath(distDir: string, pathname: string): { filePath: string; isHtmlShell: boolean } {
  const normalizedPath = pathname === '/' ? '/index.html' : pathname;
  const candidate = resolvePath(distDir, `.${normalizedPath}`);
  const isWithinDist = candidate === distDir || candidate.startsWith(`${distDir}/`);
  if (isWithinDist && existsSync(candidate)) {
    return { filePath: candidate, isHtmlShell: candidate.endsWith('index.html') };
  }
  if (extname(normalizedPath)) {
    return { filePath: candidate, isHtmlShell: false };
  }
  return { filePath: resolvePath(distDir, 'index.html'), isHtmlShell: true };
}

async function startStaticUiServer(params: {
  testDir: string;
  distDir: string;
  port?: number;
  runtimeConfig: UiWebRuntimeConfig;
}): Promise<StartedUiWeb> {
  const port = typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0
    ? params.port
    : await reserveAvailablePort();
  const stdoutPath = resolvePath(params.testDir, 'ui.web.stdout.log');
  const stderrPath = resolvePath(params.testDir, 'ui.web.stderr.log');
  const indexHtml = await readFile(resolvePath(params.distDir, 'index.html'), 'utf8');

  const sockets = new Set<import('node:net').Socket>();
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }

      const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const { filePath, isHtmlShell } = resolveRequestFilePath(params.distDir, requestUrl.pathname);

      if (isHtmlShell) {
        const html = injectBootstrap(indexHtml, params.runtimeConfig);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        if (method === 'HEAD') {
          res.end();
          return;
        }
        res.end(html);
        return;
      }

      if (!existsSync(filePath)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Not Found');
        return;
      }

      res.writeHead(200, {
        'content-type': mimeTypeFor(filePath),
        'cache-control': 'no-store',
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(filePath).pipe(res);
    } catch (error) {
      await appendFile(stderrPath, `[ui-web-export] request failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`).catch(() => {});
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  await appendFile(stdoutPath, `http://127.0.0.1:${port}\n`).catch(() => {});

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    proc: null,
    stop: async () => {
      await new Promise<void>((resolve) => {
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        }
        server.close(() => resolve());
      });
    },
  };
}

export async function startUiWebExport(params: {
  testDir: string;
  env: NodeJS.ProcessEnv;
  port?: number;
}): Promise<StartedUiWeb> {
  const distDir = await ensureUiWebExportBuilt(params);
  return await startStaticUiServer({
    testDir: params.testDir,
    distDir,
    port: params.port,
    runtimeConfig: buildRuntimeConfig(params.env),
  });
}
