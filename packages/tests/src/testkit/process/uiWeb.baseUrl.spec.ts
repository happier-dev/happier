import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

let lastSpawnArgs: string[] | null = null;
let lastSpawnEnv: NodeJS.ProcessEnv | null = null;

vi.mock('./spawnProcess', () => {
  return {
    spawnLoggedProcess: (params: { stdoutPath: string; stderrPath: string; args?: unknown; env?: unknown }) => {
      if (Array.isArray(params.args)) lastSpawnArgs = params.args as string[];
      if (params.env && typeof params.env === 'object') lastSpawnEnv = params.env as NodeJS.ProcessEnv;
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
  });

  it('prefers the Expo web entry page over Metro root HTML', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
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
        startUiWeb({ testDir, env: {} }),
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
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
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
        startUiWeb({ testDir, env: {} }),
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
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
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
        startUiWeb({ testDir, env: {} }),
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

  it('can enable clearing Metro cache via env', async () => {
    const { startUiWeb } = await import('./uiWeb');

    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-'));
    await writeFile(join(testDir, 'ui.web.stdout.log'), '', 'utf8');
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
        startUiWeb({ testDir, env: { HAPPIER_E2E_EXPO_CLEAR: '1' } }),
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
});
