import { describe, expect, it } from 'vitest';

import { createConfiguredAcpBackend } from './createConfiguredAcpBackend';

describe('createConfiguredAcpBackend', () => {
  it('launches an account-configured ACP backend through its configured executable', async () => {
    const backend = await createConfiguredAcpBackend({
      cwd: '/repo',
      backend: {
        backendId: 'custom-backend',
        source: { kind: 'account_configured' },
        name: 'custom-backend',
        title: 'Custom Backend',
        command: 'acme-cli',
        args: ['--acp'],
        env: {},
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
    expect(options.command).toBe('acme-cli');
    expect(options.args).toEqual(['--acp']);
    expect(options.env).toEqual(expect.objectContaining({
      ACP_HOME: '/custom/home',
    }));
  });
});
