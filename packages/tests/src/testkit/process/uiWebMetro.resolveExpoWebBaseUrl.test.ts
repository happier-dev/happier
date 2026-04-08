import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { __testables } from './uiWebMetro';

type FakeFetchResponse = Readonly<{
  ok: boolean;
  text: () => Promise<string>;
  headers: Headers;
}>;

function okText(body: string, contentType: string): FakeFetchResponse {
  return {
    ok: true,
    text: async () => body,
    headers: new Headers({ 'content-type': contentType }),
  };
}

function notOk(): FakeFetchResponse {
  return {
    ok: false,
    text: async () => '',
    headers: new Headers(),
  };
}

function resolveUrlString(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input && typeof input.url === 'string') {
    return input.url;
  }
  throw new Error(`Unsupported fetch input: ${String(input)}`);
}

describe('uiWebMetro resolveExpoWebBaseUrl', () => {
  it('waits for the dev server url to appear in stdout and then resolves it', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
        return;
      }
      if (req.url === '/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('console.log("ok");');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr !== 'object') {
      server.close();
      throw new Error('missing server address');
    }

    const port = addr.port;
    const baseUrl = `http://localhost:${port}`;

    const dir = await mkdtemp(join(tmpdir(), 'happier-uiwebmetro-'));
    const stdoutPath = join(dir, 'ui.web.stdout.log');
    await writeFile(stdoutPath, '', 'utf8');

    setTimeout(() => {
      void writeFile(stdoutPath, `Waiting on ${baseUrl}\n`, 'utf8');
    }, 40);

    const resolved = await __testables.resolveExpoWebBaseUrl({
      stdoutPath,
      timeoutMs: 1000,
      expectedPort: 55555,
      env: { NODE_ENV: 'test' },
    });

    expect(resolved.baseUrl).toBe(baseUrl);
    expect(resolved.hasScriptTags).toBe(true);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('does not return the advertised expected port until that port serves a live entry page', async () => {
    const port = await reserveAvailablePort();
    const baseUrl = `http://localhost:${port}`;

    const server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
        return;
      }
      if (req.url === '/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('console.log("ok");');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const dir = await mkdtemp(join(tmpdir(), 'happier-uiwebmetro-'));
    const stdoutPath = join(dir, 'ui.web.stdout.log');
    await writeFile(stdoutPath, `Waiting on ${baseUrl}\n`, 'utf8');

    const startedAtMs = Date.now();
    const startServer = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
      }, 200);
    });

    const resolved = await __testables.resolveExpoWebBaseUrl({
      stdoutPath,
      timeoutMs: 1_000,
      expectedPort: port,
      env: {
        NODE_ENV: 'test',
        HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '25',
      },
    });

    const elapsedMs = Date.now() - startedAtMs;
    expect(elapsedMs).toBeGreaterThanOrEqual(180);
    expect(new URL(resolved.baseUrl).port).toBe(String(port));
    expect(resolved.hasScriptTags).toBe(true);

    await startServer;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }, 10_000);

  it('does not fall back to an unrelated entry page when stdout advertises the expected port but that port is not ready yet', async () => {
    const expectedPort = await reserveAvailablePort();
    const wrongPort = await reserveAvailablePort();
    expect(wrongPort).not.toBe(expectedPort);

    const expectedBaseUrl = `http://localhost:${expectedPort}`;
    const wrongBaseUrl = `http://localhost:${wrongPort}`;

    const wrongServer = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
        return;
      }
      if (req.url === '/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('console.log("wrong");');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const expectedServer = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
        return;
      }
      if (req.url === '/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('console.log("expected");');
        return;
      }
      if (req.url === '/status') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('packager-status:running');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      wrongServer.listen(wrongPort, '127.0.0.1', () => resolve());
    });

    const dir = await mkdtemp(join(tmpdir(), 'happier-uiwebmetro-'));
    const stdoutPath = join(dir, 'ui.web.stdout.log');
    // stdout contains both ports; expected port appears, but the wrong entry page should not win.
    await writeFile(stdoutPath, `Waiting on ${wrongBaseUrl}\nWaiting on ${expectedBaseUrl}\n`, 'utf8');

    const startExpectedServer = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        expectedServer.once('error', reject);
        expectedServer.listen(expectedPort, '127.0.0.1', () => resolve());
      }, 200);
    });

    try {
      const resolved = await __testables.resolveExpoWebBaseUrl({
        stdoutPath,
        timeoutMs: 1_500,
        expectedPort,
        env: {
          NODE_ENV: 'test',
          HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '25',
          HAPPIER_E2E_UI_WEB_METRO_STATUS_ATTEMPT_TIMEOUT_MS: '25',
        },
      });

      expect(new URL(resolved.baseUrl).port).toBe(String(expectedPort));
      expect(resolved.baseUrl).toBe(expectedBaseUrl);
      expect(resolved.hasScriptTags).toBe(true);
    } finally {
      await startExpectedServer.catch(() => {});
      await new Promise<void>((resolve) => wrongServer.close(() => resolve()));
      await new Promise<void>((resolve) => expectedServer.close(() => resolve()));
    }
  }, 10_000);

  it('falls back to the IPv4 loopback variant when stdout advertises localhost but only 127.0.0.1 is reachable', async () => {
    const port = await reserveAvailablePort();
    const stdoutBaseUrl = `http://localhost:${port}`;
    const ipv4BaseUrl = `http://127.0.0.1:${port}`;

    const dir = await mkdtemp(join(tmpdir(), 'happier-uiwebmetro-'));
    const stdoutPath = join(dir, 'ui.web.stdout.log');
    await writeFile(stdoutPath, `Waiting on ${stdoutBaseUrl}\n`, 'utf8');

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.hostname === 'localhost') {
        throw new TypeError('connect ECONNREFUSED ::1');
      }

      if (parsed.hostname === '127.0.0.1' && parsed.port === String(port) && (parsed.pathname === '/' || parsed.pathname === '/index.html')) {
        return okText('<!doctype html><html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>', 'text/html');
      }

      if (parsed.hostname === '127.0.0.1' && parsed.port === String(port) && parsed.pathname === '/app.js') {
        return okText('console.log("ok");', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const resolved = await __testables.resolveExpoWebBaseUrl({
        stdoutPath,
        timeoutMs: 1_000,
        env: {
          NODE_ENV: 'test',
          HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '25',
        },
      });

      expect(resolved.baseUrl).toBe(ipv4BaseUrl);
      expect(resolved.hasScriptTags).toBe(true);
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  });

  it('falls back to the IPv6 loopback variant when stdout advertises localhost but only ::1 is reachable', async () => {
    const port = await reserveAvailablePort();
    const stdoutBaseUrl = `http://localhost:${port}`;
    const ipv6BaseUrl = `http://[::1]:${port}`;

    const dir = await mkdtemp(join(tmpdir(), 'happier-uiwebmetro-'));
    const stdoutPath = join(dir, 'ui.web.stdout.log');
    await writeFile(stdoutPath, `Waiting on ${stdoutBaseUrl}\n`, 'utf8');

    const fetchMock = vi.fn(async (input: unknown): Promise<FakeFetchResponse> => {
      const url = resolveUrlString(input);
      const parsed = new URL(url);

      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        throw new TypeError('connect ECONNREFUSED');
      }

      if (parsed.hostname === '[::1]' && parsed.port === String(port) && (parsed.pathname === '/' || parsed.pathname === '/index.html')) {
        return okText('<!doctype html><html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>', 'text/html');
      }

      if (parsed.hostname === '[::1]' && parsed.port === String(port) && parsed.pathname === '/app.js') {
        return okText('console.log("ok");', 'application/javascript');
      }

      return notOk();
    });

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const resolved = await __testables.resolveExpoWebBaseUrl({
        stdoutPath,
        timeoutMs: 1_000,
        env: {
          NODE_ENV: 'test',
          HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '25',
        },
      });

      expect(resolved.baseUrl).toBe(ipv6BaseUrl);
      expect(resolved.hasScriptTags).toBe(true);
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  });

  it('falls back to the ANSI-formatted advertised expected port when no entry page is ready before timeout', async () => {
    const port = await reserveAvailablePort();
    const baseUrl = `http://localhost:${port}`;

    const dir = await mkdtemp(join(tmpdir(), 'happier-uiwebmetro-'));
    const stdoutPath = join(dir, 'ui.web.stdout.log');
    await writeFile(
      stdoutPath,
      `\u001b[2mStarting Metro Bundler\u001b[22m\n\nWaiting on \u001b[4m${baseUrl}\u001b[24m\n`,
      'utf8',
    );

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED');
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const resolved = await __testables.resolveExpoWebBaseUrl({
        stdoutPath,
        timeoutMs: 120,
        expectedPort: port,
        env: {
          NODE_ENV: 'test',
          HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '25',
        },
      });

      expect(resolved.baseUrl).toBe(baseUrl);
      expect(resolved.hasScriptTags).toBe(false);
      expect(resolved.stdoutAdvertisesExpectedPort).toBe(true);
    } finally {
      if (typeof originalFetch === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  });

  it('allows a slow but eventually ready entry page to resolve with the default probe budget', async () => {
    const port = await reserveAvailablePort();
    const baseUrl = `http://localhost:${port}`;

    const server = createServer(async (req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
        return;
      }
      if (req.url === '/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('console.log("ok");');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(port, '127.0.0.1', () => resolve());
    });

    const dir = await mkdtemp(join(tmpdir(), 'happier-uiwebmetro-'));
    const stdoutPath = join(dir, 'ui.web.stdout.log');
    await writeFile(stdoutPath, `Waiting on ${baseUrl}\n`, 'utf8');

    try {
      const resolved = await __testables.resolveExpoWebBaseUrl({
        stdoutPath,
        timeoutMs: 4_000,
        expectedPort: port,
        env: {
          NODE_ENV: 'test',
        },
      });

      expect(resolved.baseUrl).toBe(baseUrl);
      expect(resolved.hasScriptTags).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 10_000);
});
