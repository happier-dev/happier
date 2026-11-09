import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfiguredAcpBackend } from './createConfiguredAcpBackend';

describe('createConfiguredAcpBackend', () => {
  it.runIf(process.platform !== 'win32')('starts the exact configured relative command with its args, env and session cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-acp-package-runner-'));
    try {
      const npx = join(root, 'npx');
      const agent = join(root, 'agent.cjs');
      await writeFile(agent, `#!${process.execPath}\nconst readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? {
    protocolVersion: request.params.protocolVersion, agentCapabilities: {}, authMethods: [],
  } : { sessionId: 'configured-command-session' };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});\n`);
      await chmod(agent, 0o755);
      await writeFile(npx, `#!${process.execPath}\nconst { spawn } = require('node:child_process');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['-y', 'acme-agent@1.2.3', '--acp', '--', '--yes'])) process.exit(2);
if (process.cwd() !== process.env.GOOD_CWD || process.env.AUTHORED_VALUE !== 'retained') process.exit(3);
const child = spawn(${JSON.stringify(agent)}, [], { stdio: 'inherit', env: process.env });
child.on('exit', code => process.exit(code ?? 1));\n`);
      await chmod(npx, 0o755);
      const backend = await createConfiguredAcpBackend({
        cwd: root,
        backend: {
          backendId: 'npm-command', source: { kind: 'account_configured' }, name: 'npm-command', title: 'Npm command',
          launch: { kind: 'command', command: './npx', args: ['-y', 'acme-agent@1.2.3', '--acp', '--', '--yes'] }, env: {},
          capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown', supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' },
        },
        launchEnv: { PATH: root, GOOD_CWD: root, AUTHORED_VALUE: 'retained' }, env: { PATH: '', HAPPIER_HOME_DIR: root, HAPPIER_JS_RUNTIME_PATH: process.execPath },
      });
      try {
        await expect(backend.startSession()).resolves.toMatchObject({ sessionId: 'configured-command-session' });
      } finally { await backend.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('launches an account-configured ACP backend through its configured executable', async () => {
    const backend = await createConfiguredAcpBackend({
      cwd: '/repo',
      backend: {
        backendId: 'custom-backend',
        source: { kind: 'account_configured' },
        name: 'custom-backend',
        title: 'Custom Backend',
        launch: { kind: 'command', command: 'acme-cli', args: ['--acp'] },
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
