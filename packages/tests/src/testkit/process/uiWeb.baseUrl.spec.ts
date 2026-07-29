import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

import { repoRootDir } from '../paths';
import { waitFor } from '../timing';
import { buildUiWebExportCacheKey } from './uiWebExportCacheKey';

let lastSpawnArgs: string[] | null = null;
let lastSpawnEnv: NodeJS.ProcessEnv | null = null;
let spawnCallCount = 0;
let runLoggedCalls: Array<{ args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
type RunLoggedBehavior =
  | { type: 'throw'; message: string }
  | { type: 'stallAtStartup' };
let runLoggedFailureQueue: RunLoggedBehavior[] = [];
let spawnStdoutText: string | null = null;
let spawnStderrText: string | null = null;

vi.mock('./spawnProcess', () => {
  return {
    runLoggedCommand: async (params: {
      args?: unknown;
      cwd: string;
      env?: unknown;
      stdoutPath: string;
      abortSignal?: AbortSignal;
    }) => {
      const args = Array.isArray(params.args) ? (params.args as string[]) : [];
      runLoggedCalls.push({
        args,
        cwd: params.cwd,
        env: params.env && typeof params.env === 'object' ? (params.env as NodeJS.ProcessEnv) : undefined,
      });

      const isExportRun = isUiWebExportRunLoggedCall({ args, cwd: params.cwd });
      const queuedBehavior = isExportRun ? runLoggedFailureQueue.shift() : undefined;
      if (queuedBehavior?.type === 'throw') {
        throw new Error(queuedBehavior.message);
      }
      if (queuedBehavior?.type === 'stallAtStartup') {
        writeFileSync(
          params.stdoutPath,
          ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler'].join('\n'),
          'utf8',
        );
        await new Promise<never>((_, reject) => {
          if (params.abortSignal?.aborted) {
            reject(params.abortSignal.reason instanceof Error ? params.abortSignal.reason : new Error(String(params.abortSignal.reason ?? 'aborted')));
            return;
          }
          params.abortSignal?.addEventListener('abort', () => {
            reject(params.abortSignal?.reason instanceof Error ? params.abortSignal.reason : new Error(String(params.abortSignal?.reason ?? 'aborted')));
          }, { once: true });
        });
      }

      const outputDirFlagIndex = args.findIndex((value) => value === '--output-dir');
      const outputDir = outputDirFlagIndex >= 0 ? args[outputDirFlagIndex + 1] : null;
      if (outputDir) {
        await mkdir(outputDir, { recursive: true });
        await writeFile(
          join(outputDir, 'index.html'),
          '<!doctype html><html><head><script src="/_expo/static/js/web/index.js"></script></head><body><div id="root"></div></body></html>',
          'utf8',
        );
        await writeFile(join(outputDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');
        await mkdir(join(outputDir, '_expo/static/js/web'), { recursive: true });
        await writeFile(join(outputDir, '_expo/static/js/web/index.js'), 'globalThis.__HAPPIER_E2E__ = true;', 'utf8');
      }
    },
    spawnLoggedProcess: (params: { stdoutPath: string; stderrPath: string; args?: unknown; env?: unknown }) => {
      spawnCallCount += 1;
      if (Array.isArray(params.args)) lastSpawnArgs = params.args as string[];
      if (params.env && typeof params.env === 'object') lastSpawnEnv = params.env as NodeJS.ProcessEnv;
      if (spawnStdoutText != null) {
        writeFileSync(params.stdoutPath, spawnStdoutText, 'utf8');
      }
      if (spawnStderrText != null) {
        writeFileSync(params.stderrPath, spawnStderrText, 'utf8');
      }
      const child = new EventEmitter() as EventEmitter & {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      child.exitCode = null;
      child.signalCode = null;
      return {
        child,
        stdoutPath: params.stdoutPath,
        stderrPath: params.stderrPath,
        stop: async () => {},
      };
    },
  };
});

function isUiWebExportRunLoggedCall(call: Readonly<{ args: readonly string[]; cwd: string }>): boolean {
  return call.args.includes('export') && call.args.includes('--output-dir');
}

function readUiWebExportRunLoggedCalls(): Array<{ args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> {
  return runLoggedCalls.filter(isUiWebExportRunLoggedCall);
}

function resolveUrlString(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'url' in input && typeof (input as { url?: unknown }).url === 'string') {
    return (input as { url: string }).url;
  }
  return String(input);
}

type FakeFetchResponse = {
  ok: boolean;
  status?: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
};

function okText(body: string, contentType: string): FakeFetchResponse {
  return {
    ok: true,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
    text: async () => body,
  };
}

function notOk(): FakeFetchResponse {
  return {
    ok: false,
    status: 500,
    headers: { get: () => null },
    text: async () => '',
  };
}

function responseText(body: string, contentType: string, options?: { ok?: boolean; status?: number }): FakeFetchResponse {
  return {
    ok: options?.ok ?? true,
    status: options?.status ?? (options?.ok === false ? 500 : 200),
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
    text: async () => body,
  };
}

function buildUiWebExportCacheKeyLike(env: NodeJS.ProcessEnv): string {
  return buildUiWebExportCacheKey(env);
}

function writeUiWebExportManifestLike(path: string): void {
  writeFileSync(path, JSON.stringify({
    formatVersion: 1,
    createdAtMs: Date.now(),
  }), 'utf8');
}

function buildUniqueUiWebExportNamespace(label: string): string {
  return `uiweb-${label}-${Date.now()}`;
}

async function removePathWithRetries(path: string, options?: { timeoutMs?: number; intervalMs?: number }): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const intervalMs = options?.intervalMs ?? 100;
  const retryableCodes = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);
  const startedAt = Date.now();

  while (true) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (!retryableCodes.has(code ?? '')) {
        throw error;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

describe('startUiWeb baseUrl resolution', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useRealTimers();
    const { __testables } = await import('./uiWebExport');
    __testables.resetSharedUiWebExportState();
    lastSpawnArgs = null;
    lastSpawnEnv = null;
    spawnCallCount = 0;
    runLoggedCalls = [];
    runLoggedFailureQueue = [];
    spawnStdoutText = null;
    spawnStderrText = null;
  });

  it('uses a shared export root directory by default', async () => {
    const { resolveUiWebExportRootDir } = await import('./uiWeb');
    expect(resolveUiWebExportRootDir()).toBe(resolve(repoRootDir(), '.project', 'tmp', 'ui-web-export'));
  });

  it('shares a default export root for matching export cache keys even across testDirs', async () => {
    const { startUiWeb } = await import('./uiWeb');
    const uniqueChannel = buildUniqueUiWebExportNamespace('isolated-default-root');

    const testDirA = await mkdtemp(join(tmpdir(), 'happier-uiweb-default-a-'));
    const testDirB = await mkdtemp(join(tmpdir(), 'happier-uiweb-default-b-'));

    const startedA = await startUiWeb({
      testDir: testDirA,
      env: {
        EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:4111',
        EXPO_UPDATES_CHANNEL: uniqueChannel,
      },
    });
    const startedB = await startUiWeb({
      testDir: testDirB,
      env: {
        EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:4112',
        EXPO_UPDATES_CHANNEL: uniqueChannel,
      },
    });

    try {
      const exportCalls = readUiWebExportRunLoggedCalls();
      expect(exportCalls).toHaveLength(1);
      const outputDirs = exportCalls
        .map((call) => {
          const outputFlagIndex = call.args.findIndex((value) => value === '--output-dir');
          return outputFlagIndex >= 0 ? call.args[outputFlagIndex + 1] : null;
        })
        .filter((value): value is string => typeof value === 'string');

      expect(outputDirs).toHaveLength(1);
      expect(outputDirs[0]).toContain('/.project/tmp/ui-web-export/');
    } finally {
      await startedA.stop();
      await startedB.stop();
    }
  }, 15_000);

  it('reuses a completed matching export namespace before building an isolated auto namespace', async () => {
    const { startUiWeb, resolveUiWebExportRootDir } = await import('./uiWeb');
    const sharedRoot = resolveUiWebExportRootDir();
    const cachedNamespaceRoot = resolveUiWebExportRootDir({
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: buildUniqueUiWebExportNamespace('cached-export-match'),
    });
    await removePathWithRetries(cachedNamespaceRoot);

    const sharedDistDir = resolve(cachedNamespaceRoot, 'dist');
    await mkdir(sharedDistDir, { recursive: true });
    await writeFile(
      resolve(sharedDistDir, 'index.html'),
      '<!doctype html><html><head><script src="/_expo/static/js/web/index.js"></script></head><body><div id="root"></div></body></html>',
      'utf8',
    );
    await writeFile(resolve(sharedDistDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');
    await mkdir(resolve(sharedDistDir, '_expo/static/js/web'), { recursive: true });
    await writeFile(resolve(sharedDistDir, '_expo/static/js/web/index.js'), 'globalThis.__HAPPIER_E2E__ = true;', 'utf8');

    const env: NodeJS.ProcessEnv = {
      EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:4123',
    };
    await writeFile(
      resolve(cachedNamespaceRoot, 'cache-key.json'),
      JSON.stringify({ cacheKey: buildUiWebExportCacheKeyLike(env) }),
      'utf8',
    );
    writeUiWebExportManifestLike(resolve(cachedNamespaceRoot, 'export-manifest.json'));

    const started = await Promise.race([
      startUiWeb({
        testDir: await mkdtemp(join(tmpdir(), 'happier-uiweb-shared-default-')),
        env,
      }),
      new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`startUiWeb did not resolve quickly; runLoggedCalls=${JSON.stringify(runLoggedCalls)}`));
      }, 3_000);
    }),
  ]);

    try {
      expect(runLoggedCalls).toHaveLength(0);
    } finally {
      await started.stop();
      await removePathWithRetries(cachedNamespaceRoot);
    }
  }, 10_000);

  it('uses a stable PostHog key when export env omits one', async () => {
    vi.resetModules();
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const started = await startUiWeb({
      testDir,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `uiweb-posthog-${Date.now()}`,
      },
    });

    try {
      const exportCalls = readUiWebExportRunLoggedCalls();
      expect(exportCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of exportCalls) {
        expect(call.env?.EXPO_PUBLIC_POSTHOG_KEY).toBe('phc-clear-export');
      }
    } finally {
      await started.stop();
    }
  }, 10_000);

  it('uses exported web mode by default and reuses the shared export build', async () => {
    const { startUiWeb, resolveUiWebExportRootDir } = await import('./uiWeb');
    const exportNamespace = buildUniqueUiWebExportNamespace('shared-export-build');
    const cacheDir = resolveUiWebExportRootDir({
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
    });
    await removePathWithRetries(cacheDir);

    const testDirA = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const testDirB = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));

    const startedA = await startUiWeb({
      testDir: testDirA,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
        EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:4011',
        EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({ changesPageLimit: 12 }),
      },
    });
    const buildCallsAfterA = runLoggedCalls.length;
    const startedB = await startUiWeb({
      testDir: testDirB,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
        EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:4011',
      },
    });

    try {
      expect(buildCallsAfterA).toBeGreaterThanOrEqual(1);
      expect(runLoggedCalls).toHaveLength(buildCallsAfterA);
      expect(spawnCallCount).toBe(0);
      expect(startedA.mode).toBe('export');
      expect(startedB.mode).toBe('export');

      const html = await fetch(startedA.baseUrl).then((response) => response.text());
      expect(html).toContain('__HAPPIER_WEB_RUNTIME_CONFIG__');
      expect(html).toContain('http://127.0.0.1:4011');
      expect(html).toContain('HAPPIER_SYNC_TUNING_JSON');

      const htmlB = await fetch(startedB.baseUrl).then((response) => response.text());
      expect(htmlB).toContain('__HAPPIER_WEB_RUNTIME_CONFIG__');
      expect(htmlB).toContain('http://127.0.0.1:4011');

      const asset = await fetch(new URL('/_expo/static/js/web/index.js', startedB.baseUrl)).then((response) => response.text());
      expect(asset).toContain('__HAPPIER_E2E__');
    } finally {
      await startedA.stop();
      await startedB.stop();
    }
  }, 15_000);

  it('reuses a persisted export cache without rerunning expo export', async () => {
    const { startUiWeb, resolveUiWebExportRootDir } = await import('./uiWeb');
    const exportNamespace = buildUniqueUiWebExportNamespace('persisted-cache');
    const cacheDir = resolveUiWebExportRootDir({
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
    });
    const distDir = resolve(cacheDir, 'dist');
    const cacheKeyPath = resolve(cacheDir, 'cache-key.json');
    const manifestPath = resolve(cacheDir, 'export-manifest.json');

    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, 'index.html'), '<!doctype html><html><head></head><body>cached</body></html>', 'utf8');
    await writeFile(join(distDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');
    await mkdir(join(distDir, '_expo', 'static', 'js', 'web'), { recursive: true });
    await writeFile(join(distDir, '_expo', 'static', 'js', 'web', 'index.js'), 'globalThis.__HAPPIER_E2E__ = true;', 'utf8');

    const env = {
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:4011',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: 'e2e-cache-test',
    };
    await mkdir(dirname(cacheKeyPath), { recursive: true });
    writeFileSync(cacheKeyPath, JSON.stringify({ cacheKey: buildUiWebExportCacheKeyLike(env) }), 'utf8');
    writeUiWebExportManifestLike(manifestPath);

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const started = await startUiWeb({ testDir, env });

    try {
      expect(runLoggedCalls).toHaveLength(0);
      expect(spawnCallCount).toBe(0);
      const html = await fetch(started.baseUrl).then((response) => response.text());
      expect(html).toContain('cached');
    } finally {
      await started.stop();
    }
  });

  it('rebuilds a persisted export cache that is missing the export manifest', async () => {
    const { startUiWeb, resolveUiWebExportRootDir } = await import('./uiWeb');
    const exportNamespace = buildUniqueUiWebExportNamespace('persisted-cache-missing-manifest');
    const cacheDir = resolveUiWebExportRootDir({
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
    });
    const distDir = resolve(cacheDir, 'dist');
    const cacheKeyPath = resolve(cacheDir, 'cache-key.json');

    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, 'index.html'), '<!doctype html><html><head></head><body>cached</body></html>', 'utf8');
    await writeFile(join(distDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');
    await mkdir(join(distDir, '_expo', 'static', 'js', 'web'), { recursive: true });
    await writeFile(join(distDir, '_expo', 'static', 'js', 'web', 'index.js'), 'globalThis.__HAPPIER_E2E__ = true;', 'utf8');

    const env = {
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:4011',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: 'e2e-cache-test',
    };
    await mkdir(dirname(cacheKeyPath), { recursive: true });
    writeFileSync(cacheKeyPath, JSON.stringify({ cacheKey: buildUiWebExportCacheKeyLike(env) }), 'utf8');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const started = await startUiWeb({ testDir, env });

    try {
      expect(readUiWebExportRunLoggedCalls()).toHaveLength(1);
      expect(spawnCallCount).toBe(0);
      const html = await fetch(started.baseUrl).then((response) => response.text());
      expect(html).toContain('__HAPPIER_WEB_RUNTIME_CONFIG__');
    } finally {
      await started.stop();
    }
  });

  it('rebuilds the exported web bundle when build-time public env changes', async () => {
    vi.resetModules();
    const { startUiWeb } = await import('./uiWeb');
    const exportNamespace = buildUniqueUiWebExportNamespace('build-time-env-change');

    const testDirA = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const testDirB = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));

    const startedA = await startUiWeb({
      testDir: testDirA,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
        EXPO_PUBLIC_POSTHOG_KEY: 'phc_first',
      },
    });
    const startedB = await startUiWeb({
      testDir: testDirB,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
        EXPO_PUBLIC_POSTHOG_KEY: 'phc_second',
      },
    });

    try {
      expect(runLoggedCalls.length).toBeGreaterThanOrEqual(2);
      expect(runLoggedCalls.some((call) => call.env?.EXPO_PUBLIC_POSTHOG_KEY === 'phc_first')).toBe(true);
      expect(runLoggedCalls.some((call) => call.env?.EXPO_PUBLIC_POSTHOG_KEY === 'phc_second')).toBe(true);
    } finally {
      await startedA.stop();
      await startedB.stop();
    }
  }, 15_000);

  it('rebuilds the exported web bundle when only EXPO_UPDATES_CHANNEL changes', async () => {
    vi.resetModules();
    const { startUiWeb } = await import('./uiWeb');
    const exportNamespace = buildUniqueUiWebExportNamespace('updates-channel-change');

    const testDirA = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const testDirB = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));

    const startedA = await startUiWeb({
      testDir: testDirA,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
        EXPO_UPDATES_CHANNEL: 'preview',
      },
    });
    const startedB = await startUiWeb({
      testDir: testDirB,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
        EXPO_UPDATES_CHANNEL: 'production',
      },
    });

    try {
      expect(runLoggedCalls.length).toBeGreaterThanOrEqual(2);
      expect(runLoggedCalls.some((call) => call.env?.EXPO_UPDATES_CHANNEL === 'preview')).toBe(true);
      expect(runLoggedCalls.some((call) => call.env?.EXPO_UPDATES_CHANNEL === 'production')).toBe(true);
    } finally {
      await startedA.stop();
      await startedB.stop();
    }
  }, 15_000);

  it('stops the exported web server cleanly', async () => {
    const { startUiWeb } = await import('./uiWeb');
    const exportNamespace = buildUniqueUiWebExportNamespace('server-stop');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const started = await startUiWeb({
      testDir,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
      },
    });

    await started.stop();

    await expect.poll(async () => {
      try {
        await fetch(started.baseUrl, { signal: AbortSignal.timeout(250) });
        return 'reachable';
      } catch (error) {
        return error instanceof Error ? error.name : 'failed';
      }
    }, { timeout: 5_000, interval: 100 }).not.toBe('reachable');
  });

  it('reclaims an unreadable shared export lock before building', async () => {
    vi.resetModules();
    const { startUiWeb, resolveUiWebExportRootDir } = await import('./uiWeb');
    const exportNamespace = buildUniqueUiWebExportNamespace('reclaim-lock');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const lockPath = resolve(resolveUiWebExportRootDir({
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
    }), 'build.lock');
    await mkdir(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '', 'utf8');

    const started = await startUiWeb({
      testDir,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
        EXPO_PUBLIC_POSTHOG_KEY: `phc-lock-${Date.now()}`,
      },
    });

    try {
      expect(readUiWebExportRunLoggedCalls()).toHaveLength(1);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await started.stop();
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
      }
    }
  });

  it('escapes sync tuning JSON before injecting it into exported html', async () => {
    const { startUiWeb } = await import('./uiWeb');
    const exportNamespace = buildUniqueUiWebExportNamespace('sync-tuning-escape');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const started = await startUiWeb({
      testDir,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: exportNamespace,
        EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({ injected: '</script><script>window.__BROKEN__=true</script>' }),
      },
    });

    try {
      const html = await fetch(started.baseUrl).then((response) => response.text());
      expect(html).toContain('\\u003c/script>');
      expect(html).not.toContain('</script><script>window.__BROKEN__=true</script>');
    } finally {
      await started.stop();
    }
  });

  it('prefers the Expo web entry page over Metro root HTML', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), 'http://localhost:19006\nhttp://localhost:8081\n', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    const webEntryHtml = '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>';
    const metroRootHtml = '<!doctype html><html><head></head><body>Metro Bundler</body></html>';
    let localhostWebAttempts = 0;

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      if (parsed.port === '19006') {
        if (parsed.hostname === 'localhost') {
          localhostWebAttempts += 1;
          return localhostWebAttempts >= 2 ? okText(webEntryHtml, 'text/html') : notOk();
        }
        return notOk();
      }

      if (parsed.port === '8081' && parsed.pathname === '/') {
        return okText(metroRootHtml, 'text/html');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({ testDir, env: { HAPPIER_E2E_UI_WEB_MODE: 'metro' } }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            const calledUrls = fetchMock.mock.calls
              .map((call) => resolveUrlString(call[0]))
              .slice(0, 20)
              .join('\n');
            reject(new Error(`startUiWeb did not finish quickly; fetch calls=${fetchMock.mock.calls.length}\n${calledUrls}`));
          }, 5_000);
        }),
      ]);
      expect(new URL(started.baseUrl).port).toBe('19006');
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('can resolve baseUrl to :8081 when it serves the Expo web entry page', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), 'http://localhost:8081\n', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    const webEntryHtml = '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>';

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      if (parsed.port === '19006') return notOk();
      if (parsed.port === '8081' && parsed.pathname === '/') return okText(webEntryHtml, 'text/plain');

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({ testDir, env: { HAPPIER_E2E_UI_WEB_MODE: 'metro' } }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            const calledUrls = fetchMock.mock.calls
              .map((call) => resolveUrlString(call[0]))
              .slice(0, 20)
              .join('\n');
            reject(new Error(`startUiWeb did not finish quickly; fetch calls=${fetchMock.mock.calls.length}\n${calledUrls}`));
          }, 5_000);
        }),
      ]);
      expect(new URL(started.baseUrl).port).toBe('8081');
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('does not clear Metro cache by default', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), 'http://localhost:8081\n', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    const webEntryHtml = '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>';

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      if (parsed.port === '19006') return notOk();
      if (parsed.port === '8081' && parsed.pathname === '/') return okText(webEntryHtml, 'text/html');

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({ testDir, env: { HAPPIER_E2E_UI_WEB_MODE: 'metro' } }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('startUiWeb did not finish quickly'));
          }, 5_000);
        }),
      ]);

      expect(lastSpawnArgs).not.toBeNull();
      expect(lastSpawnArgs ?? []).not.toContain('--clear');
      expect(typeof lastSpawnEnv?.TMPDIR).toBe('string');
      expect(String(lastSpawnEnv?.TMPDIR ?? '')).toContain(testDir);
      expect(lastSpawnEnv?.EXPO_NO_METRO_WORKSPACE_ROOT).toBeUndefined();
      expect(lastSpawnEnv?.HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS).toBeUndefined();
      expect(lastSpawnEnv?.HAPPIER_UI_METRO_WATCH_MONOREPO_ROOT_NODE_MODULES).toBeUndefined();
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('skips the Metro workspace prebuild when the caller provides a source-backed snapshot', async () => {
    const metroModule = await import('./uiWebMetro');
    const shouldRunWorkspacePrebuild = (metroModule.__testables as Record<string, unknown>).shouldRunWorkspacePrebuild;

    expect(typeof shouldRunWorkspacePrebuild).toBe('function');
    expect(
      (shouldRunWorkspacePrebuild as (params: { skipWorkspacePrebuild?: boolean }) => boolean)({
        skipWorkspacePrebuild: true,
      }),
    ).toBe(false);
    expect(
      (shouldRunWorkspacePrebuild as (params: { skipWorkspacePrebuild?: boolean }) => boolean)({}),
    ).toBe(true);
  });

  it('passes --clear to expo export when requested', async () => {
    vi.resetModules();
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const started = await Promise.race([
      startUiWeb({
        testDir,
        env: {
          HAPPIER_E2E_UI_WEB_MODE: 'export',
          HAPPIER_E2E_EXPO_CLEAR: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `uiweb-clear-${Date.now()}`,
          EXPO_PUBLIC_POSTHOG_KEY: 'phc-clear-export',
        },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('startUiWeb did not finish quickly')), 5_000);
      }),
    ]);

    try {
      const exportCalls = readUiWebExportRunLoggedCalls();
      expect(exportCalls).toHaveLength(1);
      expect(exportCalls[0]?.args ?? []).toContain('--clear');
      await started.stop();
    } finally {
      // no-op
    }
  }, 10_000);

  it('overwrites stale metro stdout from a previous run before resolving the base url', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), 'http://localhost:19006\n', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), 'stale stderr\n', 'utf8');
    spawnStdoutText = 'http://localhost:8081\n';

    const webEntryHtml = '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>';

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      if (parsed.port === '19006' && parsed.pathname === '/') {
        return okText(webEntryHtml, 'text/html');
      }

      if (parsed.port === '8081' && parsed.pathname === '/') {
        return okText(webEntryHtml, 'text/html');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({ testDir, env: { HAPPIER_E2E_UI_WEB_MODE: 'metro' } }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('startUiWeb did not finish quickly'));
          }, 5_000);
        }),
      ]);

      expect(new URL(started.baseUrl).port).toBe('8081');
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('can enable clearing Metro cache via env', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), 'http://localhost:8081\n', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    const webEntryHtml = '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>';

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      if (parsed.port === '19006') return notOk();
      if (parsed.port === '8081' && parsed.pathname === '/') return okText(webEntryHtml, 'text/html');

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({ testDir, env: { HAPPIER_E2E_UI_WEB_MODE: 'metro', HAPPIER_E2E_EXPO_CLEAR: '1' } }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('startUiWeb did not finish quickly'));
          }, 5_000);
        }),
      ]);

      expect(lastSpawnArgs).not.toBeNull();
      expect(lastSpawnArgs ?? []).toContain('--clear');
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('waits for the primary app script to become fetchable before returning', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');
    spawnStdoutText = 'http://localhost:43123\n';

    const webEntryHtml = '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>';
    let htmlFetchCount = 0;
    let bundleFetchCount = 0;
    const pendingBundleRef: { current: ((response: FakeFetchResponse) => void) | null } = { current: null };

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        bundleFetchCount += 1;
        return await new Promise<FakeFetchResponse>((resolve) => {
          pendingBundleRef.current = resolve;
        });
      }

      if (parsed.pathname === '/') {
        htmlFetchCount += 1;
        return okText(webEntryHtml, 'text/html');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const startedPromise = startUiWeb({
      testDir,
      env: {
        HAPPIER_E2E_UI_WEB_MODE: 'metro',
        HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '4000',
      },
      port: 43123,
    });
    try {
      const started = await Promise.race([
        startedPromise.then(() => 'resolved'),
        (async (): Promise<'waiting'> => {
          await waitFor(() => bundleFetchCount > 0 && htmlFetchCount > 0, {
            timeoutMs: 1_000,
            intervalMs: 25,
            context: 'initial metro html + bundle probe',
          });
          return 'waiting';
        })(),
      ]);

      expect(started).toBe('waiting');
      expect(bundleFetchCount).toBeGreaterThan(0);
      expect(htmlFetchCount).toBeGreaterThan(0);
    } finally {
      const pendingBundleResolver = pendingBundleRef.current;
      if (pendingBundleResolver) {
        pendingBundleResolver(okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript'));
      }
      const started = await Promise.race([
        startedPromise,
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 12_000);
        }),
      ]).catch(() => null);
      if (!started) {
        throw new Error('startUiWeb did not resolve after releasing the pending primary script response');
      }
      await started.stop().catch(() => {});
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 15_000);

  it('re-anchors metro baseUrl to the live port once the spawned metro becomes reachable', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), 'http://localhost:19006\n', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');
    spawnStdoutText = 'http://localhost:19006\n';

    let livePortEntryFetchCount = 0;
    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.port === '43123' && parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.port === '43123' && parsed.pathname === '/') {
        livePortEntryFetchCount += 1;
        return okText(
          '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>',
          'text/html',
        );
      }

      if (parsed.port === '43123' && parsed.pathname.startsWith('/index.bundle')) {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      if (parsed.port === '19006') {
        return notOk();
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({
          testDir,
          env: {
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
          },
          port: 43123,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`startUiWeb did not re-anchor to the live metro port; livePortEntryFetchCount=${livePortEntryFetchCount}`));
          }, 1_500);
        }),
      ]);

      expect(new URL(started.baseUrl).port).toBe('43123');
      expect(livePortEntryFetchCount).toBeGreaterThan(0);
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('waits for the live metro port when the stale stdout port still serves an entry page', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), 'http://localhost:19006\n', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');
    spawnStdoutText = 'http://localhost:19006\n';

    let metroReady = false;
    setTimeout(() => {
      metroReady = true;
    }, 220);

    let livePortEntryFetchCount = 0;
    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.port === '43123' && parsed.pathname === '/status' && metroReady) {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.port === '43123' && parsed.pathname === '/' && metroReady) {
        livePortEntryFetchCount += 1;
        return okText(
          '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>',
          'text/html',
        );
      }

      if (parsed.port === '43123' && parsed.pathname.startsWith('/index.bundle') && metroReady) {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      if (parsed.port === '19006' && parsed.pathname === '/') {
        return okText(
          '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>',
          'text/html',
        );
      }

      if (parsed.port === '19006' && parsed.pathname.startsWith('/index.bundle')) {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({
          testDir,
          env: {
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
          },
          port: 43123,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`startUiWeb did not wait for the live metro port; livePortEntryFetchCount=${livePortEntryFetchCount}`));
          }, 1_500);
        }),
      ]);

      expect(new URL(started.baseUrl).port).toBe('43123');
      expect(livePortEntryFetchCount).toBeGreaterThan(0);
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('retries the primary app script fetch after a transport abort', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    const webEntryHtml = '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>';
    let bundleFetchCount = 0;

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname === '/') {
        return okText(webEntryHtml, 'text/html');
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        bundleFetchCount += 1;
        if (bundleFetchCount === 1) {
          throw new DOMException('The transport aborted the request.', 'AbortError');
        }
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({
          testDir,
          env: {
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
          },
          port: 43123,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`startUiWeb did not recover from aborted bundle fetch; bundleFetchCount=${bundleFetchCount}`));
          }, 1_800);
        }),
      ]);

      expect(bundleFetchCount).toBeGreaterThanOrEqual(2);
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('treats a successful javascript primary app script response as ready without draining the full body', async () => {
    const metroModule = await import('./uiWebMetro');
    const probeScriptReady = (metroModule.__testables as Record<string, unknown>).probeScriptReady;

    expect(typeof probeScriptReady).toBe('function');

    let bundleTextRead = false;
    const fetchMock = vi.fn(async (): Promise<FakeFetchResponse> => ({
      ok: true,
      headers: new Headers({ 'content-type': 'application/javascript; charset=UTF-8' }),
      text: async () => {
        bundleTextRead = true;
        return await new Promise<string>(() => {});
      },
    }));

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        (probeScriptReady as (url: string, timeoutMs: number) => Promise<unknown>)(
          'http://localhost:43123/index.bundle?platform=web&dev=false&minify=true',
          50,
        ),
      ).resolves.toBe('ready');
      expect(bundleTextRead).toBe(false);
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  });

  it('fails fast when the primary app script returns a Metro JSON bundle error', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname === '/') {
        return okText(
          '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>',
          'text/html',
        );
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        return responseText(JSON.stringify({
          type: 'TransformError',
          message: 'Unable to resolve "../selection/resolveActivitySurfaceSlots" from "apps/ui/sources/activity/liveActivities/buildLiveActivitySnapshots.ts"',
        }), 'application/json', { ok: false, status: 500 });
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(startUiWeb({
        testDir,
        env: {
          HAPPIER_E2E_UI_WEB_MODE: 'metro',
          HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
        },
      })).rejects.toThrow(/resolveActivitySurfaceSlots/);
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('fails fast when the primary script stays cold by default', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    let htmlFetchCount = 0;
    let bundleFetchCount = 0;

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname === '/') {
        htmlFetchCount += 1;
        return okText(
          '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>',
          'text/html',
        );
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        bundleFetchCount += 1;
        return okText('<!doctype html><html><body>Still compiling</body></html>', 'text/html');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(Promise.race([
        startUiWeb({
          testDir,
          env: {
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
            HAPPIER_E2E_UI_WEB_SCRIPT_HTML_REFRESH_RETRY_COUNT: '1',
          },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`startUiWeb did not fail after script timeout; html=${htmlFetchCount} bundle=${bundleFetchCount}`));
          }, 5_000);
        }),
      ])).rejects.toThrow(/expo web primary script ready/);
      expect(htmlFetchCount).toBeGreaterThan(0);
      expect(bundleFetchCount).toBeGreaterThan(0);
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('fails fast on script-ready timeout when Metro stdout already reports a bundle failure', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    spawnStdoutText = [
      'Starting Metro Bundler',
      'Waiting on http://localhost:19006',
      'Web Bundling failed 48164ms apps/ui/index.ts (6483 modules)',
      'Unable to resolve "../selection/resolveActivitySurfaceSlots" from "apps/ui/sources/activity/liveActivities/buildLiveActivitySnapshots.ts"',
    ].join('\n');

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname === '/') {
        return okText(
          '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>',
          'text/html',
        );
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        return okText('<!doctype html><html><body>Still compiling</body></html>', 'text/html');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(startUiWeb({
        testDir,
        env: {
          HAPPIER_E2E_UI_WEB_MODE: 'metro',
          HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '250',
          HAPPIER_E2E_UI_WEB_SCRIPT_HTML_REFRESH_RETRY_COUNT: '1',
        },
      })).rejects.toThrow(/resolveActivitySurfaceSlots/);
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('waits until the entry html includes script tags before returning', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    const startedAtMs = Date.now();
    let htmlFetchCount = 0;
    let scriptFetchCount = 0;

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);
      const elapsedMs = Date.now() - startedAtMs;

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname === '/') {
        htmlFetchCount += 1;
        if (elapsedMs < 250) {
          return okText('<!doctype html><html><head></head><body>Compiling…</body></html>', 'text/html');
        }
        return okText('<!doctype html><html><head><script src="/app.js"></script></head><body>Ready</body></html>', 'text/html');
      }

      if (parsed.pathname === '/app.js') {
        scriptFetchCount += 1;
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({ testDir, env: { HAPPIER_E2E_UI_WEB_MODE: 'metro' } }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('startUiWeb did not finish quickly')), 5_000);
        }),
      ]);

      expect(htmlFetchCount).toBeGreaterThan(0);
      expect(scriptFetchCount).toBeGreaterThan(0);
      expect(Date.now() - startedAtMs).toBeGreaterThanOrEqual(200);
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('does not require metro /status when the entry page and primary bundle are already reachable', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');
    spawnStdoutText = 'http://localhost:43123\n';

    const fetchMock = vi.fn(async (input: unknown, init?: { signal?: AbortSignal }): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return await new Promise<FakeFetchResponse>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
        });
      }

      if (parsed.pathname === '/') {
        return okText(
          '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>',
          'text/html',
        );
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({
          testDir,
          env: {
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
            HAPPIER_E2E_UI_WEB_METRO_STATUS_TIMEOUT_MS: '150',
            HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
          },
          port: 43123,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('startUiWeb did not finish quickly')), 2_500);
        }),
      ]);

      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('waits on the advertised expected metro port even when stdout beats HTTP readiness', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');
    spawnStdoutText = 'Waiting on http://localhost:43123\n';

    let metroReady = false;
    setTimeout(() => {
      metroReady = true;
    }, 220);

    const fetchMock = vi.fn(async (input: unknown, init?: { signal?: AbortSignal }): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (!metroReady && (parsed.pathname === '/status' || parsed.pathname === '/')) {
        return await new Promise<FakeFetchResponse>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
        });
      }

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname === '/') {
        return okText(
          '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>',
          'text/html',
        );
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({
          testDir,
          env: {
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
            HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS: '600',
            HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '25',
            HAPPIER_E2E_UI_WEB_METRO_STATUS_TIMEOUT_MS: '800',
            HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
          },
          port: 43123,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('startUiWeb did not recover from stdout leading HTTP readiness')), 2_500);
        }),
      ]);

      expect(metroReady).toBe(true);
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('falls back to Metro when exported web startup fails and fallback is enabled', async () => {
    vi.resetModules();
    runLoggedFailureQueue = [{ type: 'stallAtStartup' }];
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), 'http://localhost:19006\n', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname === '/') {
        return okText(
          '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>',
          'text/html',
        );
      }

      if (parsed.pathname.startsWith('/index.bundle')) {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({
          testDir,
          env: {
            HAPPIER_E2E_UI_WEB_MODE: 'export',
            HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO: '1',
            HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `uiweb-fallback-${Date.now()}`,
            HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '25',
            HAPPIER_E2E_UI_WEB_METRO_STATUS_TIMEOUT_MS: '150',
            HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
          },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('startUiWeb did not finish within the fallback budget')), 6_000);
        }),
      ]);

      expect(readUiWebExportRunLoggedCalls()).toHaveLength(1);
      expect(spawnCallCount).toBe(1);
      expect(lastSpawnArgs).toEqual(expect.arrayContaining(['start', '--web']));
      expect(started.mode).toBe('metro');
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('exports a beforeAll timeout budget that covers cold Expo startup phases', async () => {
    const uiWebModule = await import('./uiWeb');
    const resolveUiWebBeforeAllTimeoutMs = (uiWebModule as Record<string, unknown>).resolveUiWebBeforeAllTimeoutMs;

    expect(typeof resolveUiWebBeforeAllTimeoutMs).toBe('function');
    expect(
      (resolveUiWebBeforeAllTimeoutMs as (env: NodeJS.ProcessEnv) => number)({
        HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '420000',
      }),
    ).toBeGreaterThan(420_000);
  });

  it('keeps the export build timeout above the observed cold export wall time', async () => {
    const uiWebExportModule = await import('./uiWebExport');
    const resolveUiWebExportBuildTimeoutMs = (uiWebExportModule as Record<string, unknown>).resolveUiWebExportBuildTimeoutMs;

    expect(typeof resolveUiWebExportBuildTimeoutMs).toBe('function');
    expect((resolveUiWebExportBuildTimeoutMs as (env: NodeJS.ProcessEnv) => number)({})).toBe(480_000);
  });

  it('keeps the Metro readiness timeout high enough for cold CI startup', async () => {
    const metroModule = await import('./uiWebMetro');
    const resolveUiWebMetroStatusTimeoutMs = (metroModule as Record<string, unknown>).resolveUiWebMetroStatusTimeoutMs;

    expect(typeof resolveUiWebMetroStatusTimeoutMs).toBe('function');
    expect((resolveUiWebMetroStatusTimeoutMs as (env: NodeJS.ProcessEnv) => number)({})).toBe(240_000);
    expect(
      (resolveUiWebMetroStatusTimeoutMs as (env: NodeJS.ProcessEnv) => number)({
        HAPPIER_E2E_UI_WEB_METRO_STATUS_TIMEOUT_MS: '9000',
      }),
    ).toBe(9000);
  });

  it('re-resolves the primary app script when the entry html changes during cold startup', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    let htmlFetchCount = 0;
    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname === '/') {
        htmlFetchCount += 1;
        const bundleName = htmlFetchCount === 1 ? 'bundle-a' : 'bundle-b';
        return okText(
          `<!doctype html><html><head><script src="/${bundleName}.js"></script></head></html>`,
          'text/html',
        );
      }

      if (parsed.pathname === '/bundle-a.js') {
        return notOk();
      }

      if (parsed.pathname === '/bundle-b.js') {
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({
          testDir,
          env: {
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
          },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`startUiWeb did not recover from entry html changing; htmlFetchCount=${htmlFetchCount}`));
          }, 3_000);
        }),
      ]);

      expect(htmlFetchCount).toBeGreaterThanOrEqual(2);
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('tries later bundle-like scripts when an earlier script is not the app entry', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    let runtimeFetchCount = 0;
    let entryFetchCount = 0;

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname === '/') {
        return okText(
          [
            '<!doctype html>',
            '<html>',
            '<head>',
            '<script src="/runtime.js"></script>',
            '<script src="/node_modules/expo-router/entry.bundle?platform=web&dev=true&hot=false"></script>',
            '</head>',
            '</html>',
          ].join(''),
          'text/html',
        );
      }

      if (parsed.pathname === '/runtime.js') {
        runtimeFetchCount += 1;
        return notOk();
      }

      if (parsed.pathname === '/node_modules/expo-router/entry.bundle') {
        entryFetchCount += 1;
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await Promise.race([
        startUiWeb({
          testDir,
          env: {
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
          },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`startUiWeb did not accept later bundle-like script; runtime=${runtimeFetchCount} entry=${entryFetchCount}`));
          }, 8_000);
        }),
      ]);

      expect(entryFetchCount).toBeGreaterThan(0);
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 15_000);

  it('waits for the Expo entry bundle even when runtime.js is already ready', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    let entryReady = false;
    let entryFetchCount = 0;

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname === '/') {
        return okText(
          [
            '<!doctype html>',
            '<html>',
            '<head>',
            '<script src="/runtime.js"></script>',
            '<script src="/node_modules/expo-router/entry.bundle?platform=web&dev=true&hot=false"></script>',
            '</head>',
            '</html>',
          ].join(''),
          'text/html',
        );
      }

      if (parsed.pathname === '/runtime.js') {
        return okText('globalThis.__HAPPIER_RUNTIME__ = true;', 'application/javascript');
      }

      if (parsed.pathname === '/node_modules/expo-router/entry.bundle') {
        entryFetchCount += 1;
        if (!entryReady) {
          return okText('<!doctype html><html><head></head><body>not ready</body></html>', 'text/html');
        }
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const startPromise = startUiWeb({
        testDir,
        env: {
          HAPPIER_E2E_UI_WEB_MODE: 'metro',
          HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '2000',
        },
      });

      setTimeout(() => {
        entryReady = true;
      }, 350);

      const resolvedBeforeEntryIsReady = await Promise.race([
        startPromise.then(() => true),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 200);
        }),
      ]);
      expect(resolvedBeforeEntryIsReady).toBe(false);

      const started = await Promise.race([
        startPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`startUiWeb did not wait for the entry bundle; entryFetchCount=${entryFetchCount}`)), 1800);
        }),
      ]);
      expect(entryFetchCount).toBeGreaterThan(0);
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('re-resolves the entry html when a stale script keeps returning non-script content', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    let htmlFetchCount = 0;
    let staleScriptFetchCount = 0;
    let readyScriptFetchCount = 0;

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.pathname === '/status') {
        return okText('packager-status:running', 'text/plain');
      }

      if (parsed.pathname === '/') {
        htmlFetchCount += 1;
        const bundleName = staleScriptFetchCount === 0 ? 'bundle-a' : 'bundle-b';
        return okText(
          `<!doctype html><html><head><script src="/${bundleName}.js"></script></head></html>`,
          'text/html',
        );
      }

      if (parsed.pathname === '/bundle-a.js') {
        staleScriptFetchCount += 1;
        return okText('<!doctype html><html><body>Compiling...</body></html>', 'text/html');
      }

      if (parsed.pathname === '/bundle-b.js') {
        readyScriptFetchCount += 1;
        return okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const started = await startUiWeb({
        testDir,
        env: {
          HAPPIER_E2E_UI_WEB_MODE: 'metro',
          HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
          HAPPIER_E2E_UI_WEB_SCRIPT_HTML_REFRESH_RETRY_COUNT: '1',
        },
      });

      expect(htmlFetchCount).toBeGreaterThanOrEqual(2);
      expect(staleScriptFetchCount).toBeGreaterThan(0);
      expect(readyScriptFetchCount).toBeGreaterThan(0);
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);
});
