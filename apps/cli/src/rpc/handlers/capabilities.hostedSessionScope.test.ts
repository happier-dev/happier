import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { invalidateCliSnapshots } from '@/capabilities/snapshots/cliSnapshot';
import { createCliCapabilitiesService } from './capabilities';

describe('hosted Session capability discovery', () => {
  afterAll(async () => { await pluginReloadController.shutdown(); });
  it.skipIf(process.platform === 'win32')('resolves identical relative PATH entries in each registering Session directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-capability-cwd-'));
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController });
    try {
      const environment = { NODE_ENV: 'test' as const, PATH: 'bin', HOME: root, USERPROFILE: root };
      const createService = async (name: string) => {
        const cwd = join(root, name);
        await mkdir(join(cwd, 'bin'), { recursive: true });
        for (const command of ['claude', 'tmux', 'az', 'gh']) {
          const executable = join(cwd, 'bin', command);
          await writeFile(executable, '#!/bin/sh\necho 1.0.0\n'); await chmod(executable, 0o755);
        }
        const service = await runAddedHostedSession({ environment, workingDirectory: cwd, end() {} }, () => createCliCapabilitiesService());
        return { cwd, service };
      };
      const [first, second] = await Promise.all([createService('first'), createService('second')]);
      const request = { requests: [{ id: 'cli.claude' as const, params: { includeVersion: false } }, { id: 'tool.tmux' as const },
        { id: 'dep.az' as const }, { id: 'dep.gh' as const }] };
      for (const session of [first, second]) {
        const result = await session.service.detect(request);
        expect.soft(result.results['cli.claude']).toMatchObject({ ok: true, data: { installed: true, resolvedPath: join(session.cwd, 'bin', 'claude') } });
        expect.soft(result.results['tool.tmux']).toMatchObject({ ok: true, data: { available: true, resolvedPath: join(session.cwd, 'bin', 'tmux') } });
        for (const command of ['az', 'gh']) expect.soft(result.results[`dep.${command}`]).toMatchObject({ ok: true,
          data: { installed: true, binPath: join(session.cwd, 'bin', command) } });
      }
      const sharedCli = join(root, 'shared-claude');
      await writeFile(sharedCli, '#!/bin/sh\ncase "$PWD" in */first) echo 1.2.3;; *) echo 4.5.6;; esac\n');
      await chmod(sharedCli, 0o755);
      const sharedEnvironment = { ...environment, HAPPIER_CLAUDE_PATH: sharedCli };
      for (const [session, version] of [[first, '1.2.3'], [second, '4.5.6']] as const) {
        const service = await runAddedHostedSession({ environment: sharedEnvironment, workingDirectory: session.cwd, end() {} },
          () => createCliCapabilitiesService());
        const result = await service.detect({ requests: [{ id: 'cli.claude' }] });
        expect.soft(result.results['cli.claude']).toMatchObject({ ok: true, data: { installed: true, version } });
      }
      const javascriptCli = join(root, 'shared-claude.js');
      await writeFile(javascriptCli, '// CLI loaded through the selected native runtime.\n');
      const javascriptEnvironment = { ...environment, HAPPIER_CLAUDE_PATH: javascriptCli, HAPPIER_JS_RUNTIME_PATH: 'bin/runtime' };
      for (const [session, version] of [[first, '1.2.3'], [second, '4.5.6']] as const) {
        const runtimePath = join(session.cwd, 'bin', 'runtime');
        await writeFile(runtimePath, `#!/bin/sh\necho ${version}\n`); await chmod(runtimePath, 0o755);
        const service = await runAddedHostedSession({ environment: javascriptEnvironment, workingDirectory: session.cwd, end() {} },
          () => createCliCapabilitiesService());
        const result = await service.detect({ requests: [{ id: 'cli.claude' }] });
        expect.soft(result.results['cli.claude']).toMatchObject({ ok: true, data: { installed: true, version } });
      }
    } finally { invalidateCliSnapshots(); await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('keeps each Session native runtime version when PATH and HOME match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-capability-runtime-'));
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController });
    try {
      const cli = join(root, 'claude.js');
      await writeFile(cli, '// CLI entry resolved by the selected native runtime.\n');
      const createService = async (name: string, version: string) => {
        const executable = join(root, name);
        await writeFile(executable, `#!/bin/sh\necho ${version}\n`); await chmod(executable, 0o755);
        return runAddedHostedSession({ environment: { ...process.env, PATH: root, HOME: root, USERPROFILE: root,
          HAPPIER_CLAUDE_PATH: cli, HAPPIER_JS_RUNTIME_PATH: executable }, workingDirectory: root, end() {},
        }, () => createCliCapabilitiesService());
      };
      const [first, second] = await Promise.all([createService('first-runtime', '1.2.3'), createService('second-runtime', '4.5.6')]);
      const request = { requests: [{ id: 'cli.claude' as const }] };
      const firstResult = await first.detect(request);
      const secondResult = await second.detect(request);
      expect(firstResult.results['cli.claude']).toMatchObject({ ok: true, data: { installed: true, version: '1.2.3' } });
      expect(secondResult.results['cli.claude']).toMatchObject({ ok: true, data: { installed: true, version: '4.5.6' } });
    } finally { invalidateCliSnapshots(); await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('retains each registering Session environment when discovery runs from the transport context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-capabilities-'));
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController });
    try {
      const createService = async (name: string) => {
        const directory = join(root, name);
        await mkdir(directory);
        const cli = join(directory, 'claude');
        const tmux = join(directory, 'tmux');
        await Promise.all([cli, tmux].map(async path => { await writeFile(path, '#!/bin/sh\necho 1.0.0\n'); await chmod(path, 0o755); }));
        for (const [command, script] of [
          ['az', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "azure-cli 2.0.0"; else printf \'{"user":{"name":"%s"}}\\n\' "$AZURE_CONFIG_DIR"; fi\n'],
          ['gh', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version 1.0.0"; else printf \'%s\\n\' "$GH_TOKEN"; fi\n'],
        ]) {
          const path = join(directory, command!); await writeFile(path, script!); await chmod(path, 0o755);
        }
        const environment = { ...process.env, PATH: directory, HAPPIER_CLAUDE_PATH: cli, GH_TOKEN: name, AZURE_CONFIG_DIR: name };
        const service = await runAddedHostedSession({ environment,
          workingDirectory: directory, end() {} }, () => createCliCapabilitiesService());
        return { service, cli, tmux, directory, environment };
      };
      const [first, second] = await Promise.all([createService('first'), createService('second')]);
      const request = { requests: [{ id: 'cli.claude' as const, params: { includeVersion: false } }, { id: 'tool.tmux' as const }] };
      const [firstResult, secondResult] = await Promise.all([first.service.detect(request), second.service.detect(request)]);
      expect(firstResult.results['cli.claude']).toMatchObject({ ok: true, data: { installed: true, resolvedPath: first.cli } });
      expect(secondResult.results['cli.claude']).toMatchObject({ ok: true, data: { installed: true, resolvedPath: second.cli } });
      expect(firstResult.results['tool.tmux']).toMatchObject({ ok: true, data: { available: true, resolvedPath: first.tmux } });
      expect(secondResult.results['tool.tmux']).toMatchObject({ ok: true, data: { available: true, resolvedPath: second.tmux } });
      const dependencyRequest = { requests: [{ id: 'dep.az' as const }, { id: 'dep.gh' as const }] };
      const [firstDeps, secondDeps] = await Promise.all([first.service.detect(dependencyRequest), second.service.detect(dependencyRequest)]);
      for (const [result, session] of [[firstDeps, first], [secondDeps, second]] as const) {
        expect(result.results['dep.az']).toMatchObject({ ok: true, data: { installed: true,
          binPath: join(session.directory, 'az'), authenticated: true, accountName: session.environment.AZURE_CONFIG_DIR } });
        expect(result.results['dep.gh']).toMatchObject({ ok: true, data: { installed: true,
          binPath: join(session.directory, 'gh'), authenticated: true } });
      }
      const ambientAuth = Object.fromEntries((runtime.registry.contributes.agents.find(agent => agent.id === 'claude')
        ?.cliMetadata?.auth.environmentVariables ?? []).map(key => [key, undefined]));
      const authEnvironment = { ...first.environment, ...ambientAuth, HOME: root, USERPROFILE: root,
        CLAUDE_CONFIG_DIR: root, ANTHROPIC_API_KEY: 'fixture-api-key' };
      const createAuthService = (key: string | undefined) => runAddedHostedSession({
        environment: { ...authEnvironment, ANTHROPIC_API_KEY: key }, workingDirectory: root, end() {},
      }, () => createCliCapabilitiesService());
      const [signedIn, signedOut] = await Promise.all([createAuthService('fixture-api-key'), createAuthService(undefined)]);
      const authRequest = { requests: [{ id: 'cli.claude' as const, params: { includeVersion: false, includeLoginStatus: true } }] };
      const signedInResult = await signedIn.detect(authRequest);
      const signedOutResult = await signedOut.detect(authRequest);
      expect(signedInResult.results['cli.claude']).toMatchObject({ ok: true, data: { isLoggedIn: true,
        authStatus: { source: 'env', method: 'api_key_env' } } });
      expect(signedOutResult.results['cli.claude']).not.toMatchObject({ data: { isLoggedIn: true } });
    } finally { invalidateCliSnapshots(); await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
