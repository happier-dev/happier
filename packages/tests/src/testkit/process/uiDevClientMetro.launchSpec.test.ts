import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  __testables,
  resolveUiDevClientMetroLaunchSpec,
  resolveUiDevClientMetroProbeBaseUrl,
} from './uiDevClientMetro';

describe('uiDevClientMetro launch spec', () => {
  it('uses the apps/ui Expo CLI when Expo is not installed at the repository root', async () => {
    const rootDir = resolve(
      tmpdir(),
      `happier-ui-dev-client-metro-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const uiWorkspaceDir = resolve(rootDir, 'apps', 'ui');
    const workspaceExpoCli = resolve(uiWorkspaceDir, 'node_modules', 'expo', 'bin', 'cli');
    await mkdir(resolve(workspaceExpoCli, '..'), { recursive: true });
    await writeFile(workspaceExpoCli, '#!/usr/bin/env node\n', 'utf8');

    expect(
      resolveUiDevClientMetroLaunchSpec({
        rootDir,
        uiWorkspaceDir,
        port: 19_081,
        host: 'localhost',
        clearCache: true,
      }),
    ).toEqual({
      command: process.execPath,
      args: [
        workspaceExpoCli,
        'start',
        '--dev-client',
        '--host',
        'localhost',
        '--port',
        '19081',
        '--clear',
      ],
      cwd: uiWorkspaceDir,
    });
  });

  it('uses Expo no-dev mode when a loaded native row requires Fast Refresh to stay off', async () => {
    const rootDir = resolve(
      tmpdir(),
      `happier-ui-dev-client-metro-no-dev-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const uiWorkspaceDir = resolve(rootDir, 'apps', 'ui');
    const workspaceExpoCli = resolve(uiWorkspaceDir, 'node_modules', 'expo', 'bin', 'cli');
    await mkdir(resolve(workspaceExpoCli, '..'), { recursive: true });
    await writeFile(workspaceExpoCli, '#!/usr/bin/env node\n', 'utf8');

    expect(
      resolveUiDevClientMetroLaunchSpec({
        rootDir,
        uiWorkspaceDir,
        port: 19_082,
        host: 'localhost',
        clearCache: true,
        noDev: true,
      }),
    ).toMatchObject({
      args: expect.arrayContaining(['--dev-client', '--no-dev', '--clear']),
    });
  });

  it('probes the same localhost name passed to Expo so IPv6-only localhost binds are reachable', () => {
    expect(resolveUiDevClientMetroProbeBaseUrl({ host: 'localhost', port: 19_081 }))
      .toBe('http://localhost:19081');
  });

  it('accepts Expo 55 Metro readiness headers when the chunked status body stays open', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-React-Native-Project-Root': '/tmp/happier-ui',
      });
      response.flushHeaders();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the Metro readiness test server to expose a TCP address');
    }

    try {
      await expect(
        __testables.isMetroPackagerReady(`http://127.0.0.1:${address.port}`),
      ).resolves.toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
  });
});
