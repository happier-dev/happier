import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents';
import { getAcpNpmRuntimeSpec, resolveAcpLaunch, type AcpLaunchDefinition } from './resolveAcpLaunch';
import { createConfiguredAcpBackend } from './createConfiguredAcpBackend';

describe('configured ACP typed launch resolution', () => {
  it('resolves a pinned managed npm install and refuses a stale version or system executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-acp-npm-resolution-'));
    try {
      const env = { HAPPIER_HOME_DIR: root, PATH: root };
      const definition: AcpLaunchDefinition = { id: 'npm-agent', title: 'Npm agent', launch: {
        kind: 'npm', package: '@fixture/agent', version: '1.2.3', args: ['--acp'],
      } };
      const params = { accountId: 'alice', definition, platform: process.platform, arch: process.arch, env };
      await writeFile(join(root, 'agent'), '#!/bin/sh\nexit 0\n'); await chmod(join(root, 'agent'), 0o755);
      expect(await resolveAcpLaunch(params)).toMatchObject({ kind: 'needs_install' });
      const command = resolveAgentCliManagedCommandPathForRuntime(getAcpNpmRuntimeSpec(definition, 'alice')!, { processEnv: env });
      await mkdir(dirname(command), { recursive: true }); await writeFile(command, '#!/bin/sh\nexit 0\n'); await chmod(command, 0o755);
      const packageRoot = join(dirname(dirname(command)), 'workspace', 'node_modules', '@fixture', 'agent');
      await mkdir(packageRoot, { recursive: true });
      const bin = join(dirname(dirname(command)), 'workspace', 'node_modules', '.bin', process.platform === 'win32' ? 'actual-cli.cmd' : 'actual-cli');
      await mkdir(dirname(bin), { recursive: true }); await writeFile(bin, '#!/bin/sh\nexit 0\n'); await chmod(bin, 0o755);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@fixture/agent', version: '1.1.0', bin: { 'actual-cli': 'cli.js' } }));
      expect(await resolveAcpLaunch(params)).toMatchObject({ kind: 'needs_install' });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@fixture/agent', version: '1.2.3', bin: { 'actual-cli': 'cli.js' } }));
      expect(await resolveAcpLaunch(params)).toMatchObject({ kind: 'ready', command, args: ['--acp'] });
      const backend = await createConfiguredAcpBackend({ accountId: 'alice', cwd: root, env,
        backend: { backendId: definition.id, source: { kind: 'account_configured' }, name: definition.id, title: definition.title,
          launch: definition.launch, env: {}, capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown', supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' } },
        launchEnv: { HAPPIER_HOME_DIR: join(root, 'definition-authored-home') },
      });
      const options = (backend as unknown as { options: { command: string; env: NodeJS.ProcessEnv } }).options;
      expect(options.command).toBe(command);
      expect(options.env.HAPPIER_HOME_DIR).toBe(join(root, 'definition-authored-home'));
      await rm(bin);
      expect(await resolveAcpLaunch(params)).toMatchObject({ kind: 'needs_install' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(['npx', 'node', 'uvx'])('preserves a configured %s command instead of selecting managed tooling', async (name) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-acp-configured-command-'));
    try {
      const command = join(root, name);
      const pnpm = join(root, 'pnpm');
      const uv = join(root, 'tools', 'uv', 'current', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv');
      await mkdir(dirname(uv), { recursive: true });
      for (const path of [command, pnpm, uv]) {
        await writeFile(path, '#!/bin/sh\nexit 0\n');
        await chmod(path, 0o755);
      }
      const args = ['--package', 'fixture', '--', '--yes'];
      const definition: AcpLaunchDefinition = { id: 'configured', title: 'Configured', launch: { kind: 'command', command: name, args } };
      await expect(resolveAcpLaunch({ definition, platform: process.platform, arch: process.arch,
        env: { HAPPIER_HOME_DIR: root, PATH: '', HAPPIER_PNPM_BIN: pnpm, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        launchEnv: { PATH: root },
      })).resolves.toEqual({ kind: 'ready', command, args, env: {} });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails closed for unsupported or unknown archive targets', async () => {
    const definition: AcpLaunchDefinition = { id: 'archive-agent', title: 'Archive agent', launch: {
      kind: 'archive', version: '1', args: [], assetsByPlatform: {
        'linux-x64': { archiveUrl: 'https://example.com/agent.zip', executableSubpath: 'agent' },
      },
    } };
    expect(await resolveAcpLaunch({ definition, platform: 'win32', arch: 'arm64', env: {} })).toMatchObject({ kind: 'cant_run', fit: { kind: 'cant_run', reason: 'no_build_for_platform' } });
    expect(await resolveAcpLaunch({ definition, platform: 'linux', arch: null, env: {} })).toMatchObject({ kind: 'cant_run', fit: { kind: 'unknown', reason: 'arch_unknown' } });
  });
});
