import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate, PLUGIN_MANIFEST } from '@happier-dev/plugins-claude';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { projectAgentCliAuthCatalogEntry } from './agentCatalogEntryHooks';
import { createNativeAgentCliAuthSpec } from './agentCliMetadata';

afterEach(() => vi.unstubAllEnvs());

describe('Agent CLI auth command environment custody', () => {
  it('admits Claude isolated connected-account credentials without borrowing native-home credentials', async () => {
    const dir = createTempDirSync('happier-claude-auth-home-');
    let activation: Awaited<ReturnType<typeof createPluginTestkit>> | undefined;
    try {
      activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
      const selectedHome = join(dir, 'selected');
      const nativeHome = join(dir, 'native');
      mkdirSync(selectedHome);
      mkdirSync(join(nativeHome, '.claude'), { recursive: true });
      writeFileSync(join(selectedHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }));
      // The external Claude executable is the boundary. Its status output observes
      // CLAUDE_CONFIG_DIR, as Claude Code 2.1.292 does, without printing credentials.
      const script = join(dir, 'status.cjs');
      writeFileSync(script, `const fs = require('node:fs'); const path = require('node:path');
const root = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
const loggedIn = fs.existsSync(path.join(root, '.credentials.json'));
process.stdout.write(JSON.stringify({ loggedIn })); process.exitCode = loggedIn ? 0 : 1;`);
      const runtime = `'${process.execPath.replace(/'/g, `'\\''`)}'`;
      const tool = writeExecutableShimSync({
        dir, fileName: process.platform === 'win32' ? 'claude-fixture.cmd' : 'claude-fixture',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec ${runtime} '${script.replace(/'/g, `'\\''`)}' "$@"\n`,
      });
      const cli = PLUGIN_MANIFEST.contributes.agents[0]?.cli;
      if (!cli) throw new Error('Claude CLI metadata is required');
      const cliAuth = activation.registration('agents', 'claude')?.cliAuth;
      const spec = cliAuth
        ? await projectAgentCliAuthCatalogEntry({
          agentId: 'claude', pluginId: PLUGIN_MANIFEST.id, cli, cliAuth, isCurrent: () => true,
          systemTools: [{ id: 'claude-cli', title: 'Claude fixture', executableNames: [tool] }],
          hostAccess: PLUGIN_MANIFEST.hostAccess,
        }).getCliAuthSpec?.()
        : createNativeAgentCliAuthSpec(cli);
      const processEnv = { ...process.env, HOME: nativeHome, USERPROFILE: nativeHome,
        CLAUDE_CONFIG_DIR: selectedHome, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined };
      await expect(spec?.detectAuthStatus?.({ resolvedPath: tool, processEnv }))
        .resolves.toMatchObject({ state: 'logged_in' });
      writeFileSync(join(nativeHome, '.claude', '.credentials.json'), JSON.stringify({ token: 'ambient-fixture' }));
      await expect(spec?.detectAuthStatus?.({ resolvedPath: tool, processEnv: {
        ...processEnv, CLAUDE_CONFIG_DIR: join(dir, 'empty'),
      } })).resolves.toMatchObject({ state: 'logged_out' });
      writeFileSync(script, "process.stdout.write('incomplete status');");
      await expect(spec?.detectAuthStatus?.({ resolvedPath: tool, processEnv }))
        .resolves.toMatchObject({ state: 'unknown', reason: 'probe_failed' });
    } finally {
      await activation?.dispose();
      removeTempDirSync(dir);
    }
  });

  it('runs an admitted declared tool in the final launch environment without disclosing that environment', async () => {
    const dir = createTempDirSync('happier-auth-command-env-');
    try {
      const runtime = `'${process.execPath.replace(/'/g, `'\\''`)}'`;
      const tool = writeExecutableShimSync({
        dir, fileName: process.platform === 'win32' ? 'auth-fixture.cmd' : 'auth-fixture',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" %*\r\n`
          : `#!/bin/sh\nexec ${runtime} "$@"\n`,
      });
      vi.stubEnv('HAPPIER_AUTH_COMMAND_AMBIENT', 'ambient-key');
      vi.stubEnv('HAPPIER_AUTH_COMMAND_SELECTED', '');
      const projected = projectAgentCliAuthCatalogEntry({
        agentId: 'codex', pluginId: 'acme.auth', isCurrent: () => true,
        cli: {
          executable: { binaryName: 'auth-fixture', sourcePreference: 'system-first' },
          install: { managed: null, manual: { kind: 'none' } },
          auth: { support: 'status_only', nonInteractiveStatusProbe: true, loginLaunches: [] },
        },
        systemTools: [{ id: 'auth-fixture', title: 'Auth fixture', executableNames: [tool] }],
        hostAccess: { required: [{
          id: 'auth-fixture-process', capability: 'process', reason: 'Read native auth status.',
          scope: { executables: [{ kind: 'systemTool', id: 'auth-fixture' }] },
        }], optional: [] },
        cliAuth: { detectAuthStatus: async (context) => {
          expect(Object.keys(context)).toEqual(['runDeclaredSystemToolCommand']);
          const output = await context.runDeclaredSystemToolCommand({
            toolId: 'auth-fixture', args: ['-e',
              "process.stdout.write(process.env.HAPPIER_AUTH_COMMAND_SELECTED && !process.env.HAPPIER_AUTH_COMMAND_AMBIENT ? 'logged_in' : 'logged_out')"],
            timeoutMs: 5_000,
          });
          expect(output.ok).toBe(true);
          return { state: output.stdout === 'logged_in' ? 'logged_in' : 'logged_out' };
        } },
      });
      const spec = await projected.getCliAuthSpec?.();
      const args = { resolvedPath: tool, processEnv: {
        ...process.env, HAPPIER_AUTH_COMMAND_AMBIENT: undefined,
        HAPPIER_AUTH_COMMAND_SELECTED: 'selected-key',
      } };
      await expect(spec?.detectAuthStatus?.(args)).resolves.toEqual({ state: 'logged_in' });
      await expect(spec?.detectAuthStatus?.({ ...args, processEnv: {
        ...args.processEnv, HAPPIER_AUTH_COMMAND_SELECTED: undefined,
      } })).resolves.toEqual({ state: 'logged_out' });
      expect(process.env.HAPPIER_AUTH_COMMAND_AMBIENT).toBe('ambient-key');
    } finally {
      removeTempDirSync(dir);
    }
  });
});
