import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

import { reloadConfiguration } from '@/configuration';
import { addServerProfile } from '@/server/serverProfiles';
import { handleServerCommand } from './server';

describe('happier server --json', () => {
  it('prints a server_list JSON envelope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-json-list-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await addServerProfile({ name: 'A', serverUrl: 'https://a.example.test', webappUrl: 'https://a.example.test', use: true });
      await addServerProfile({ name: 'B', serverUrl: 'https://b.example.test', webappUrl: 'https://b.example.test', use: false });

      await handleServerCommand(['list', '--json']);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_list');
      expect(typeof parsed.data?.activeServerId).toBe('string');
      expect(Array.isArray(parsed.data?.profiles)).toBe(true);
      expect(parsed.data.profiles.length).toBeGreaterThanOrEqual(2);
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      process.exitCode = prevExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints a server_current JSON envelope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-json-current-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await addServerProfile({ name: 'A', serverUrl: 'https://a.example.test', webappUrl: 'https://a.example.test', use: true });

      await handleServerCommand(['current', '--json']);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_current');
      expect(parsed.data?.active?.serverUrl).toBe('https://a.example.test');
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      process.exitCode = prevExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints a server_add JSON envelope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-json-add-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'Company',
        '--server-url',
        'https://api.company.example',
        '--webapp-url',
        'https://app.company.example',
        '--use',
        '--json',
      ]);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_add');
      expect(parsed.data?.created?.serverUrl).toBe('https://api.company.example');
      expect(parsed.data?.active?.serverUrl).toBe('https://api.company.example');
      expect(parsed.data?.used).toBe(true);
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      process.exitCode = prevExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints a server_use JSON envelope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-json-use-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await addServerProfile({ name: 'A', serverUrl: 'https://a.example.test', webappUrl: 'https://a.example.test', use: true });
      const createdB = await addServerProfile({ name: 'B', serverUrl: 'https://b.example.test', webappUrl: 'https://b.example.test', use: false });

      await handleServerCommand(['use', createdB.id, '--json']);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_use');
      expect(parsed.data?.active?.serverUrl).toBe('https://b.example.test');
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      process.exitCode = prevExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints a server_remove JSON envelope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-json-remove-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await addServerProfile({ name: 'A', serverUrl: 'https://a.example.test', webappUrl: 'https://a.example.test', use: true });
      const createdB = await addServerProfile({ name: 'B', serverUrl: 'https://b.example.test', webappUrl: 'https://b.example.test', use: false });

      await handleServerCommand(['remove', createdB.id, '--json']);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_remove');
      expect(parsed.data?.removed?.serverUrl).toBe('https://b.example.test');
      expect(typeof parsed.data?.active?.serverUrl).toBe('string');
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      process.exitCode = prevExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints a server_set JSON envelope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-json-set-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await handleServerCommand([
        'set',
        '--server-url',
        'https://s.example.test',
        '--webapp-url',
        'https://w.example.test',
        '--json',
      ]);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_set');
      expect(parsed.data?.active?.serverUrl).toBe('https://s.example.test');
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      process.exitCode = prevExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints a server_test JSON envelope (ok=true)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-json-test-ok-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    let server: Server | null = null;

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as any);
    try {
      server = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/v1/version') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ version: '1.2.3' }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Failed to resolve test server address');
      const url = `http://127.0.0.1:${address.port}`;

      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();
      await addServerProfile({ name: 'Local', serverUrl: url, webappUrl: url, use: true });

      await handleServerCommand(['test', '--json']);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_test');
      expect(parsed.data?.ok).toBe(true);
      expect(parsed.data?.version).toBe('1.2.3');
      expect(process.exitCode).toBe(0);
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      if (server) {
        await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
      }
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      process.exitCode = prevExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints a server_test JSON envelope (ok=false)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-json-test-fail-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    let server: Server | null = null;

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as any);
    try {
      server = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/v1/version') {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain');
          res.end('nope');
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Failed to resolve test server address');
      const url = `http://127.0.0.1:${address.port}`;

      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();
      await addServerProfile({ name: 'Local', serverUrl: url, webappUrl: url, use: true });

      await handleServerCommand(['test', '--json']);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_test');
      expect(parsed.data?.ok).toBe(false);
      expect(parsed.data?.status).toBe(500);
      expect(process.exitCode).toBe(1);
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      if (server) {
        await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
      }
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      process.exitCode = prevExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints a server_add error envelope on invalid arguments in --json mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-json-add-invalid-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as any);

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await handleServerCommand(['add', '--json']);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('server_add');
      expect(parsed.error?.code).toBe('invalid_arguments');
      expect(process.exitCode).toBe(1);
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      process.exitCode = prevExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });
});
