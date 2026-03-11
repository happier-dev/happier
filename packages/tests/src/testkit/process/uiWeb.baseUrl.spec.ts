import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';

let lastSpawnArgs: string[] | null = null;
let lastSpawnEnv: NodeJS.ProcessEnv | null = null;
let spawnCallCount = 0;
let runLoggedCalls: Array<{ args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
let runLoggedFailureQueue: string[] = [];
let spawnStdoutText: string | null = null;
let spawnStderrText: string | null = null;

vi.mock('./spawnProcess', () => {
  return {
    runLoggedCommand: async (params: { args?: unknown; cwd: string; env?: unknown }) => {
      const args = Array.isArray(params.args) ? (params.args as string[]) : [];
      runLoggedCalls.push({
        args,
        cwd: params.cwd,
        env: params.env && typeof params.env === 'object' ? (params.env as NodeJS.ProcessEnv) : undefined,
      });

      const queuedFailure = runLoggedFailureQueue.shift();
      if (queuedFailure) {
        throw new Error(queuedFailure);
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

function resolveUrlString(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'url' in input && typeof (input as { url?: unknown }).url === 'string') {
    return (input as { url: string }).url;
  }
  return String(input);
}

type FakeFetchResponse = {
  ok: boolean;
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
    headers: { get: () => null },
    text: async () => '',
  };
}

describe('startUiWeb baseUrl resolution', () => {
  beforeEach(() => {
    vi.useRealTimers();
    lastSpawnArgs = null;
    lastSpawnEnv = null;
    spawnCallCount = 0;
    runLoggedCalls = [];
    runLoggedFailureQueue = [];
    spawnStdoutText = null;
    spawnStderrText = null;
  });

  it('uses exported web mode by default and reuses the shared export build', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDirA = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const testDirB = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));

    const startedA = await startUiWeb({
      testDir: testDirA,
      env: {
        EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:4011',
        EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({ changesPageLimit: 12 }),
      },
    });
    const startedB = await startUiWeb({
      testDir: testDirB,
      env: {
        EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:4012',
      },
    });

    try {
      expect(runLoggedCalls).toHaveLength(1);
      expect(spawnCallCount).toBe(0);

      const html = await fetch(startedA.baseUrl).then((response) => response.text());
      expect(html).toContain('__HAPPIER_WEB_RUNTIME_CONFIG__');
      expect(html).toContain('http://127.0.0.1:4011');
      expect(html).toContain('HAPPIER_SYNC_TUNING_JSON');

      const asset = await fetch(new URL('/_expo/static/js/web/index.js', startedB.baseUrl)).then((response) => response.text());
      expect(asset).toContain('__HAPPIER_E2E__');
    } finally {
      await startedA.stop();
      await startedB.stop();
    }
  });

  it('rebuilds the exported web bundle when build-time public env changes', async () => {
    vi.resetModules();
    const { startUiWeb } = await import('./uiWeb');

    const testDirA = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const testDirB = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));

    const startedA = await startUiWeb({
      testDir: testDirA,
      env: {
        EXPO_PUBLIC_POSTHOG_KEY: 'phc_first',
      },
    });
    const startedB = await startUiWeb({
      testDir: testDirB,
      env: {
        EXPO_PUBLIC_POSTHOG_KEY: 'phc_second',
      },
    });

    try {
      expect(runLoggedCalls).toHaveLength(2);
      expect(runLoggedCalls[0]?.env?.EXPO_PUBLIC_POSTHOG_KEY).toBe('phc_first');
      expect(runLoggedCalls[1]?.env?.EXPO_PUBLIC_POSTHOG_KEY).toBe('phc_second');
    } finally {
      await startedA.stop();
      await startedB.stop();
    }
  });

  it('stops the exported web server cleanly', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    const started = await startUiWeb({ testDir, env: {} });

    await started.stop();

    await expect(fetch(started.baseUrl)).rejects.toBeTruthy();
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
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
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

    const startedPromise = startUiWeb({ testDir, env: { HAPPIER_E2E_UI_WEB_MODE: 'metro' } });
    try {
      const started = await Promise.race([
        startedPromise.then(() => 'resolved'),
        new Promise<'waiting'>((resolve) => {
          setTimeout(() => resolve('waiting'), 50);
        }),
      ]);

      expect(started).toBe('waiting');
      expect(bundleFetchCount).toBeGreaterThan(0);
      expect(htmlFetchCount).toBe(2);
    } finally {
      const pendingBundleResolver = pendingBundleRef.current;
      if (pendingBundleResolver) {
        pendingBundleResolver(okText('globalThis.__HAPPIER_E2E__ = true;', 'application/javascript'));
      }
      const started = await startedPromise.catch(() => null);
      await started?.stop().catch(() => {});
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  }, 10_000);

  it('retries the primary app script fetch after an aborted attempt', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
    await writeFile(join(testDir, 'ui.web.stderr.log'), '', 'utf8');

    const webEntryHtml = '<!doctype html><html><head><script src="/index.bundle?platform=web&dev=false&minify=true"></script></head></html>';
    let bundleFetchCount = 0;

    const fetchMock = vi.fn(async (input: unknown, init?: { signal?: AbortSignal }): Promise<FakeFetchResponse> => {
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
          return await new Promise<FakeFetchResponse>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            }, { once: true });
          });
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
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS: '50',
          },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`startUiWeb did not recover from aborted bundle fetch; bundleFetchCount=${bundleFetchCount}`));
          }, 450);
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

  it('returns once the entry page is available even if the primary script stays cold', async () => {
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
      const started = await Promise.race([
        startUiWeb({
          testDir,
          env: {
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS: '50',
            HAPPIER_E2E_UI_WEB_SCRIPT_HTML_REFRESH_RETRY_COUNT: '1',
          },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`startUiWeb did not return after script timeout; html=${htmlFetchCount} bundle=${bundleFetchCount}`));
          }, 1_500);
        }),
      ]);

      expect(htmlFetchCount).toBeGreaterThan(0);
      expect(bundleFetchCount).toBeGreaterThan(0);
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
    runLoggedFailureQueue = ['expo export hung at Starting Metro Bundler'];
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
      const started = await startUiWeb({
        testDir,
        env: {
          HAPPIER_E2E_UI_WEB_MODE: 'export',
          HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO: '1',
        },
      });

      expect(runLoggedCalls).toHaveLength(1);
      expect(spawnCallCount).toBe(1);
      expect(lastSpawnArgs).toEqual(expect.arrayContaining(['start', '--web']));
      await started.stop();
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  });

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

  it('uses a bounded metro script-fetch attempt budget unless explicitly overridden', async () => {
    const metroModule = await import('./uiWebMetro');
    const resolveUiWebScriptFetchTotalTimeoutMs = (metroModule as Record<string, unknown>).resolveUiWebScriptFetchTotalTimeoutMs;
    const resolveUiWebScriptFetchAttemptTimeoutMs = (metroModule as Record<string, unknown>).resolveUiWebScriptFetchAttemptTimeoutMs;

    expect(typeof resolveUiWebScriptFetchTotalTimeoutMs).toBe('function');
    expect(typeof resolveUiWebScriptFetchAttemptTimeoutMs).toBe('function');
    const totalTimeoutMs = (resolveUiWebScriptFetchTotalTimeoutMs as (env: NodeJS.ProcessEnv) => number)({});
    expect(
      totalTimeoutMs,
    ).toBe(420_000);
    expect(
      (resolveUiWebScriptFetchAttemptTimeoutMs as (env: NodeJS.ProcessEnv, totalTimeoutMs: number) => number)({}, totalTimeoutMs),
    ).toBe(15_000);
    expect(
      (resolveUiWebScriptFetchAttemptTimeoutMs as (env: NodeJS.ProcessEnv, totalTimeoutMs: number) => number)({
        HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS: '15000',
      }, 420_000),
    ).toBe(15_000);
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
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS: '50',
          },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`startUiWeb did not recover from entry html changing; htmlFetchCount=${htmlFetchCount}`));
          }, 450);
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
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS: '50',
          },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`startUiWeb did not accept later bundle-like script; runtime=${runtimeFetchCount} entry=${entryFetchCount}`));
          }, 450);
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
      const started = await Promise.race([
        startUiWeb({
          testDir,
          env: {
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '500',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS: '50',
            HAPPIER_E2E_UI_WEB_SCRIPT_HTML_REFRESH_RETRY_COUNT: '1',
          },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `startUiWeb did not recover from stale script content; html=${htmlFetchCount} stale=${staleScriptFetchCount} ready=${readyScriptFetchCount}`,
              ),
            );
          }, 450);
        }),
      ]);

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
