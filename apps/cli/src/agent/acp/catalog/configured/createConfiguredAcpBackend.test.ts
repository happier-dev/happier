import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfiguredAcpBackend } from './createConfiguredAcpBackend';

describe('createConfiguredAcpBackend', () => {
  it('resolves plugin-contributed system-tool launches through the canonical exec bridge', async () => {
    const toolDir = await mkdtemp(join(tmpdir(), 'happier-configured-acp-tool-'));
    const executablePath = join(toolDir, process.platform === 'win32' ? 'acme-tool.cmd' : 'acme-tool');
    await writeFile(executablePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(executablePath, 0o755);
    }
    const backend = await createConfiguredAcpBackend({
      cwd: '/repo',
      backend: {
        backendId: 'custom-backend',
        source: {
          kind: 'plugin_contributed',
          pluginId: 'acme.plugin',
          systemTools: [{
            id: 'acme-cli',
            title: 'Acme CLI',
            executableNames: [executablePath],
          }],
        },
        name: 'custom-backend',
        title: 'Custom Backend',
        command: 'acme-cli',
        args: ['--acp'],
        launch: {
          kind: 'system-tool',
          toolId: 'acme-cli',
          purpose: 'Launch ACP backend custom-backend',
          args: ['--acp'],
          env: { FROM_LAUNCH: 'yes' },
        },
        env: {},
        transportProfile: 'generic',
        capabilities: {
          supportsLoadSession: true,
          supportsModes: 'yes',
          supportsModels: 'yes',
          supportsConfigOptions: 'unknown',
          promptImageSupport: 'unknown',
        },
      },
      launchEnv: {
        ACP_HOME: '/custom/home',
      },
      env: {
        PATH: '/custom/bin',
      },
      mcpServers: {},
      permissionHandler: {} as never,
    });

    const options = (backend as unknown as {
      options: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> };
    }).options;
    expect(options.command).toBe(executablePath);
    expect(options.args).toEqual(['--acp']);
    expect(options.env).toEqual(expect.objectContaining({
      ACP_HOME: '/custom/home',
      FROM_LAUNCH: 'yes',
    }));
  });
});
