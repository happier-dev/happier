import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

import { reloadConfiguration } from '@/configuration';
import { addServerProfile } from '@/server/serverProfiles';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { handleServerCommand } from './server';

describe('happier server --json', () => {
  let home = '';
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

  beforeEach(async () => {
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    home = await createTempDir('happier-server-json-');
    envScope.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    if (home) {
      await removeTempDir(home);
    }
  });

  it('prints a server_list JSON envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await addServerProfile({ name: 'A', serverUrl: 'https://a.example.test', webappUrl: 'https://a.example.test', use: true });
      await addServerProfile({ name: 'B', serverUrl: 'https://b.example.test', webappUrl: 'https://b.example.test', use: false });

      await handleServerCommand(['list', '--json']);

      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_list');
      expect(typeof parsed.data?.activeServerId).toBe('string');
      expect(Array.isArray(parsed.data?.profiles)).toBe(true);
      expect(parsed.data.profiles.length).toBeGreaterThanOrEqual(2);
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('does not crash when a stored serverUrl is not a valid URL', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await addServerProfile({ name: 'A', serverUrl: 'https://a.example.test', webappUrl: 'https://a.example.test', use: true });
      const invalidUrl = 'not a url';
      const invalid = await addServerProfile({ name: 'Broken', serverUrl: invalidUrl, webappUrl: 'https://broken.example.test', use: false });

      await handleServerCommand(['list', '--json']);

      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      const list = Array.isArray(parsed.data?.profiles) ? parsed.data.profiles : [];
      const found = list.find((p: any) => p?.id === invalid.id);
      expect(found).toBeTruthy();
      expect(found.serverUrl).toBe(invalidUrl);
      expect(found.comparableKey).toBe(invalidUrl);
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a server_current JSON envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await addServerProfile({ name: 'A', serverUrl: 'https://a.example.test', webappUrl: 'https://a.example.test', use: true });

      await handleServerCommand(['current', '--json']);

      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_current');
      expect(parsed.data?.active?.serverUrl).toBe('https://a.example.test');
      expect(parsed.data?.active?.comparableKey).toBe('https://a.example.test');
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a server_add JSON envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
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

      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_add');
      expect(parsed.data?.created?.serverUrl).toBe('https://api.company.example');
      expect(parsed.data?.active?.serverUrl).toBe('https://api.company.example');
      expect(parsed.data?.used).toBe(true);
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a server_use JSON envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await addServerProfile({ name: 'A', serverUrl: 'https://a.example.test', webappUrl: 'https://a.example.test', use: true });
      const createdB = await addServerProfile({ name: 'B', serverUrl: 'https://b.example.test', webappUrl: 'https://b.example.test', use: false });

      await handleServerCommand(['use', createdB.id, '--json']);

      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_use');
      expect(parsed.data?.active?.serverUrl).toBe('https://b.example.test');
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a server_remove JSON envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await addServerProfile({ name: 'A', serverUrl: 'https://a.example.test', webappUrl: 'https://a.example.test', use: true });
      const createdB = await addServerProfile({ name: 'B', serverUrl: 'https://b.example.test', webappUrl: 'https://b.example.test', use: false });

      await handleServerCommand(['remove', createdB.id, '--json']);

      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_remove');
      expect(parsed.data?.removed?.serverUrl).toBe('https://b.example.test');
      expect(typeof parsed.data?.active?.serverUrl).toBe('string');
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a server_set JSON envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleServerCommand([
        'set',
        '--server-url',
        'https://s.example.test',
        '--webapp-url',
        'https://w.example.test',
        '--json',
      ]);

      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_set');
      expect(parsed.data?.active?.serverUrl).toBe('https://s.example.test');
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('derives webappUrl from the new serverUrl when --webapp-url is omitted', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await addServerProfile({
        name: 'Old',
        serverUrl: 'https://old.example.test',
        webappUrl: 'https://old-webapp.example.test',
        use: true,
      });

      await handleServerCommand([
        'set',
        '--server-url',
        'https://s.example.test',
        '--json',
      ]);

      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_set');
      expect(parsed.data?.active?.serverUrl).toBe('https://s.example.test');
      expect(parsed.data?.active?.webappUrl).toBe('https://s.example.test');
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a server_test JSON envelope (ok=true)', async () => {
    const output = captureConsoleLogAndMuteStdout();
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

      await addServerProfile({ name: 'Local', serverUrl: url, webappUrl: url, use: true });

      await handleServerCommand(['test', '--json']);

      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_test');
      expect(parsed.data?.ok).toBe(true);
      expect(parsed.data?.version).toBe('1.2.3');
      expect(process.exitCode).toBe(0);
    } finally {
      exitSpy.mockRestore();
      output.restore();
      if (server) {
        await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
      }
      process.exitCode = prevExitCode;
    }
  });

  it('prints a server_test JSON envelope (ok=false)', async () => {
    const output = captureConsoleLogAndMuteStdout();
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

      await addServerProfile({ name: 'Local', serverUrl: url, webappUrl: url, use: true });

      await handleServerCommand(['test', '--json']);

      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_test');
      expect(parsed.data?.ok).toBe(false);
      expect(parsed.data?.status).toBe(500);
      expect(process.exitCode).toBe(1);
    } finally {
      exitSpy.mockRestore();
      output.restore();
      if (server) {
        await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
      }
      process.exitCode = prevExitCode;
    }
  });

  it('prints a server_add error envelope on invalid arguments in --json mode', async () => {
    const output = captureConsoleLogAndMuteStdout();

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as any);

    try {
      await handleServerCommand(['add', '--json']);

      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('server_add');
      expect(parsed.error?.code).toBe('invalid_arguments');
      expect(process.exitCode).toBe(1);
    } finally {
      exitSpy.mockRestore();
      output.restore();
      process.exitCode = prevExitCode;
    }
  });
});
